/**
 * Models module – local model list, HuggingFace search with autocomplete,
 * download with progress, lazy size fetch.
 */
import { api, toast, state } from "./main.js";

let searchTimeout = null;
let downloadPollers = {};
let _currentSort = "downloads";
let _suggestionPool = [];

// Track model IDs that are actively downloading (survives tab switches + new searches)
const _activeDownloads = new Set();

// ── GPU label ─────────────────────────────────────────────────────────────────
const GPU_LABELS = {
  full:      "Full GPU Offload",
  partial:   "Partial GPU Offload",
  too_large: "Likely Too Large",
  unknown:   "Size Unknown",
};

function gpuBadge(label) {
  return `<span class="gpu-badge ${label || "unknown"}">${GPU_LABELS[label] || label}</span>`;
}

function fmtSize(gb, estimated) {
  if (gb == null) return "";
  return estimated ? `~${gb} GB` : `${gb} GB`;
}

function fmtModelDate(value) {
  if (!value) return "";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function renderTagChips(model) {
  const tags = Array.isArray(model.tags) ? model.tags.slice(0, 4) : [];
  const chips = [];

  if (model.vision) {
    chips.push('<span class="tag-chip vision">Vision</span>');
  }

  tags.forEach(t => {
    if (!t) return;
    const norm = String(t).toLowerCase();
    if (norm === "vision" || norm === "image-text-to-text" || norm === "image-to-text") return;
    chips.push(`<span class="tag-chip">${escHtml(String(t))}</span>`);
  });

  return chips.join("");
}

function unsupportedChip(model) {
  if (model?.loadable !== false) return "";
  const title = escHtml(model.reason || "Unsupported by current loader");
  return `<span class="gpu-badge too_large" title="${title}">Unsupported</span>`;
}

// ── Memory info ────────────────────────────────────────────────────────────────
async function refreshMemoryInfo() {
  try {
    const mem = await api("/api/system/memory");
    const el = document.getElementById("memory-info");
    if (el) {
      el.textContent =
        `RAM: ${mem.available_gb.toFixed(1)} GB free  /  ${mem.total_gb.toFixed(1)} GB total`;
    }
  } catch (_) {}
}

// ── Local models ──────────────────────────────────────────────────────────────
async function refreshLocalModels() {
  const container = document.getElementById("local-models-list");
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

  try {
    const models = await api("/api/models/local");
    if (!models.length) {
      container.innerHTML = '<div class="empty-state">No local models found. Download one below.</div>';
      return;
    }
    container.innerHTML = "";
    models.forEach(m => container.appendChild(buildLocalCard(m)));
  } catch (e) {
    container.innerHTML =
      `<div class="empty-state">Failed to load local models: ${escHtml(e.message)}
       <br><button class="btn-ghost" onclick="location.reload()">Retry</button></div>`;
  }
}

function buildLocalCard(m) {
  const card = document.createElement("div");
  card.className = "model-card";
  card.id = `local-card-${CSS.escape(m.id)}`;

  const loaded = state.currentModelId === m.id && state.modelLoaded;

  card.innerHTML = `
    <div class="model-card-info">
      <div class="model-card-name" title="${m.id}">${m.name}</div>
      <div class="model-card-meta">
        <span class="model-card-size">${fmtSize(m.size_gb, false)}</span>
        ${gpuBadge(m.gpu_label)}
        ${unsupportedChip(m)}
        ${loaded ? '<span class="gpu-badge full">Loaded</span>' : ""}
      </div>
      <div class="model-tag-row">${renderTagChips(m)}</div>
    </div>
    <div class="model-card-actions">
      <button class="btn-outline btn-load-local" data-id="${m.id}">
        ${loaded ? "Loaded" : (m.loadable === false ? "Unsupported" : "Load")}
      </button>
      <button class="btn-danger btn-delete-local" data-id="${m.id}">Delete</button>
    </div>`;

  if (m.loadable === false) {
    const loadBtn = card.querySelector(".btn-load-local");
    loadBtn.disabled = true;
    loadBtn.title = m.reason || "Unsupported by current loader";
  }

  card.querySelector(".btn-load-local").addEventListener("click", async e => {
    const btn = e.currentTarget;
    if (btn.textContent.trim() === "Loaded") return;
    btn.disabled = true;
    btn.textContent = "Loading…";
    state.currentModelId = m.id;
    state.loadedModelId = null;
    state.modelLoaded = false;
    _setChatLoadStatus("loading", "Loading model…", m.id);

    // Guard: abort after 15 min (large models)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900_000);

    try {
      await fetch("/api/model/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: m.id }),
        signal: controller.signal,
      }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

      clearTimeout(timeout);
      state.currentModelId = m.id;
      state.loadedModelId = m.id;
      state.modelLoaded = true;
      _syncChatHeader(m.id);
      toast("Model loaded", "success");
      btn.textContent = "Loaded";
    } catch (err) {
      clearTimeout(timeout);
      const msg = err.name === "AbortError" ? "Load timed out" : err.message;
      toast(msg, "error");
      state.loadedModelId = null;
      state.modelLoaded = false;
      _setChatLoadStatus("error", msg || "Failed to load model", m.id);
      btn.disabled = false;
      btn.textContent = "Load";
    }
  });

  card.querySelector(".btn-delete-local").addEventListener("click", async e => {
    if (!confirm(`Delete ${m.name}? This cannot be undone.`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await api(`/api/models/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      card.remove();
      if (state.currentModelId === m.id) { state.currentModelId = null; state.modelLoaded = false; }
      toast("Model deleted", "success");
      _refreshChatSelector();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Delete";
    }
  });

  return card;
}

function _syncChatHeader(modelId) {
  const sel = document.getElementById("model-select");
  if (sel) sel.value = modelId;
  const ms = document.getElementById("model-status");
  if (ms) { ms.textContent = "Model ready"; ms.className = "model-status ready"; }
  const inp = document.getElementById("user-input");
  if (inp) inp.placeholder = "Message…";
}

function _setChatLoadStatus(stateStr, message, modelId = null) {
  const sel = document.getElementById("model-select");
  if (sel && modelId) sel.value = modelId;

  const ms = document.getElementById("model-status");
  if (ms) {
    ms.textContent = message || "";
    ms.className = "model-status " + (stateStr || "");
  }

  const inp = document.getElementById("user-input");
  if (!inp) return;
  if (stateStr === "ready") {
    inp.placeholder = "Message…";
  } else if (stateStr === "loading") {
    inp.placeholder = "Model is loading…";
  } else {
    inp.placeholder = "Load a model to start chatting…";
  }
}

async function _refreshChatSelector() {
  try {
    const models = await api("/api/models/local");
    const select = document.getElementById("model-select");
    if (!select) return;
    const prev = select.value;
    select.innerHTML = '<option value="">— select a model —</option>';
    models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id; opt.textContent = m.name;
      select.appendChild(opt);
    });
    if (prev && models.find(m => m.id === prev)) select.value = prev;
  } catch (_) {}
}

// ── Autocomplete ──────────────────────────────────────────────────────────────
async function _loadSuggestionPool() {
  if (_suggestionPool.length) return;
  try {
    const models = await api("/api/models/search?sort=downloads&limit=100");
    _suggestionPool = models.map(m => m.name);
  } catch (_) {}
}

function _filterSuggestions(query) {
  if (!query || !_suggestionPool.length) return [];
  const q = query.toLowerCase();
  return _suggestionPool.filter(n => n.toLowerCase().includes(q)).slice(0, 8);
}

function _showSuggestions(inputEl, dropdownEl, query) {
  const matches = _filterSuggestions(query);
  if (!matches.length || !query) { dropdownEl.classList.add("hidden"); return; }
  dropdownEl.innerHTML = "";
  matches.forEach(name => {
    const item = document.createElement("div");
    item.className = "suggestion-item";
    const idx = name.toLowerCase().indexOf(query.toLowerCase());
    if (idx >= 0) {
      item.innerHTML =
        escHtml(name.slice(0, idx)) +
        `<strong>${escHtml(name.slice(idx, idx + query.length))}</strong>` +
        escHtml(name.slice(idx + query.length));
    } else {
      item.textContent = name;
    }
    item.addEventListener("mousedown", e => {
      e.preventDefault();
      inputEl.value = name;
      dropdownEl.classList.add("hidden");
      searchModels(name, _currentSort);
    });
    dropdownEl.appendChild(item);
  });
  dropdownEl.classList.remove("hidden");
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtSpeed(bps) {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function fmtBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function fmtEta(sec) {
  if (!sec || sec < 5) return "";
  if (sec < 60) return `~${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `~${m}m ${sec % 60}s`;
  return `~${Math.floor(m / 60)}h ${m % 60}m`;
}

function friendlyFileLabel(fileName) {
  if (!fileName) return "Preparing download…";
  const clean = String(fileName).split("/").pop() || "";
  if (!clean) return "Preparing download…";
  if (/\.(safetensors|bin|gguf)$/i.test(clean)) return "Downloading model file…";
  if (/\.(json|txt|md)$/i.test(clean)) return "Downloading setup files…";
  return `Downloading ${clean}`;
}

// ── Search results ────────────────────────────────────────────────────────────
async function searchModels(query = "", sort = _currentSort) {
  const container = document.getElementById("search-results");
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

  let models;
  try {
    const params = new URLSearchParams({ sort, limit: 30 });
    if (query) params.set("q", query);
    models = await api(`/api/models/search?${params}`);
  } catch (e) {
    container.innerHTML =
      `<div class="empty-state">Search failed: ${escHtml(e.message)}
       <br><button class="btn-ghost" id="btn-search-retry">Retry</button></div>`;
    document.getElementById("btn-search-retry")?.addEventListener("click",
      () => searchModels(query, sort));
    return;
  }

  if (!models.length) {
    container.innerHTML = '<div class="empty-state">No results found.</div>';
    return;
  }

  container.innerHTML = "";
  let localIds = new Set();
  try { localIds = new Set((await api("/api/models/local")).map(m => m.id)); } catch (_) {}

  models.forEach(m => container.appendChild(buildSearchCard(m, localIds.has(m.id))));

  // Lazily fetch real sizes in background for cards without exact size.
  _fetchSizesLazily(models.filter(m => m.size_gb == null && !localIds.has(m.id)));
  // buildSearchCard already re-attaches pollers for models in _activeDownloads.
}

async function _fetchSizesLazily(models) {
  for (const m of models) {
    await new Promise(r => setTimeout(r, 80));
    try {
      const resp = await api(`/api/models/size?model_id=${encodeURIComponent(m.id)}`);
      if (resp.size_gb == null) continue;

      const card = document.getElementById(`search-card-${CSS.escape(m.id)}`);
      if (!card) continue;

      // Update size text
      const sizeEl = card.querySelector(".size-display");
      if (sizeEl) sizeEl.textContent = fmtSize(resp.size_gb, false);

      // Update GPU badge
      const badgeEl = card.querySelector(".gpu-badge-dynamic");
      if (badgeEl) {
        // Recompute label client-side (backend already cached the size)
        const newLabel = _gpuLabelFromSize(resp.size_gb, window._memTotal, window._memAvail);
        badgeEl.className = `gpu-badge ${newLabel} gpu-badge-dynamic`;
        badgeEl.textContent = GPU_LABELS[newLabel] || newLabel;
      }
    } catch (_) {}
  }
}

// Recompute GPU label client-side using cached memory values
function _gpuLabelFromSize(sizeGb, totalGb, availGb) {
  if (!sizeGb) return "unknown";
  if (availGb && sizeGb < availGb * 0.85) return "full";
  if (totalGb && sizeGb < totalGb) return "partial";
  return "too_large";
}

function buildSearchCard(m, alreadyLocal) {
  const card = document.createElement("div");
  card.className = "model-card";
  card.id = `search-card-${CSS.escape(m.id)}`;

  const downloads = m.downloads > 1000
    ? `${(m.downloads / 1000).toFixed(1)}k ↓`
    : `${m.downloads} ↓`;

  // Size: exact first; estimate only as fallback.
  const sizeStr = m.size_gb != null
    ? fmtSize(m.size_gb, false)
    : (m.est_size_gb != null ? fmtSize(m.est_size_gb, true) : "…");
  const updatedLabel = fmtModelDate(m.last_modified);

  card.innerHTML = `
    <div class="model-card-info">
      <div class="model-card-name" title="${m.id}">${escHtml(m.name)}</div>
      <div class="model-card-meta">
        <span class="model-card-size size-display">${sizeStr}</span>
        <span class="gpu-badge ${m.gpu_label} gpu-badge-dynamic">${GPU_LABELS[m.gpu_label] || ""}</span>
        ${unsupportedChip(m)}
        ${m.publisher ? `<span class="publisher-badge">${escHtml(m.publisher)}</span>` : ""}
        <span class="model-card-size">${downloads}</span>
        ${updatedLabel ? `<span class="model-card-size">Updated ${escHtml(updatedLabel)}</span>` : ""}
      </div>
      <div class="model-tag-row">${renderTagChips(m)}</div>
    </div>
    <div class="model-card-actions" id="actions-${m.id}">
      ${alreadyLocal
        ? '<span class="gpu-badge full">Downloaded</span>'
        : (m.loadable === false
            ? `<button class="btn-outline btn-sm" title="${escHtml(m.reason || 'Unsupported by current loader')}" disabled>Unsupported</button>`
            : `<button class="btn-primary btn-sm btn-download" data-id="${m.id}">Download</button>`)}
    </div>`;

  if (!alreadyLocal && m.loadable !== false) {
    if (_activeDownloads.has(m.id)) {
      // Restore progress UI for this model after a re-render.
      _renderProgressUI(card, m.id);
      pollDownload(m.id, card, Date.now());
    } else {
      card.querySelector(".btn-download").addEventListener("click", async e => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Starting…";
        await startDownload(m.id, card);
      });
    }
  }
  return card;
}

// ── Download + poller ─────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS  = 32 * 60 * 1000; // 32 min frontend safety net

function _renderProgressUI(card, modelId) {
  const actionsEl = card.querySelector(`#actions-${CSS.escape(modelId)}`);
  if (!actionsEl) return;
  actionsEl.innerHTML = `
    <div class="download-progress-wrap">
      <div class="progress-pie" id="prog-pie-${modelId}" style="--progress:0deg">
        <div class="progress-pie-inner">
          <span class="progress-pie-value" id="prog-pct-${modelId}">0%</span>
        </div>
      </div>
      <div class="progress-copy">
        <div class="progress-title" id="prog-title-${modelId}">Preparing download…</div>
        <div class="progress-detail" id="prog-amount-${modelId}">Starting…</div>
        <div class="progress-detail" id="prog-meta-${modelId}">Checking file sizes…</div>
      </div>
      <button class="btn-danger btn-sm btn-stop-download" data-id="${modelId}" title="Stop download">Cancel</button>
    </div>`;
  actionsEl.querySelector(".btn-stop-download")?.addEventListener("click", async () => {
    await stopDownload(modelId, card);
  });
}

function _stopDownloadPolling(modelId) {
  const poller = downloadPollers[modelId];
  if (!poller) return;
  poller.stopped = true;
  if (poller.timer) clearTimeout(poller.timer);
  delete downloadPollers[modelId];
}

function _scheduleDownloadPoll(modelId, run) {
  const poller = downloadPollers[modelId];
  if (!poller || poller.stopped) return;
  poller.timer = setTimeout(run, POLL_INTERVAL_MS);
}

async function startDownload(modelId, card) {
  try {
    await api("/api/models/download", {
      method: "POST",
      body: JSON.stringify({ model_id: modelId }),
    });
    toast(`Downloading ${modelId.split("/").pop()}…`, "info", 5000);
    _activeDownloads.add(modelId);
    _renderProgressUI(card, modelId);
    pollDownload(modelId, card, Date.now());
  } catch (e) {
    toast(e.message, "error");
    const actionsEl = card.querySelector(`#actions-${CSS.escape(modelId)}`);
    if (actionsEl) {
      actionsEl.innerHTML =
        `<button class="btn-primary btn-sm btn-download" data-id="${modelId}">Retry</button>`;
      actionsEl.querySelector(".btn-download")?.addEventListener("click", async e => {
        e.currentTarget.disabled = true;
        await startDownload(modelId, card);
      });
    }
  }
}

async function stopDownload(modelId, card) {
  try {
    await api("/api/models/download/cancel", {
      method: "POST",
      body: JSON.stringify({ model_id: modelId }),
    });
  } catch (_) {}

  _stopDownloadPolling(modelId);
  _activeDownloads.delete(modelId);

  toast(`Download cancelled`, "info");
  const actEl = card?.querySelector(`#actions-${CSS.escape(modelId)}`);
  if (actEl) {
    actEl.innerHTML =
      `<button class="btn-primary btn-sm btn-download" data-id="${modelId}">Download</button>`;
    actEl.querySelector(".btn-download")?.addEventListener("click", async e => {
      e.currentTarget.disabled = true;
      await startDownload(modelId, card);
    });
  }
}

function pollDownload(modelId, card, startTime = Date.now()) {
  const existing = downloadPollers[modelId];
  if (existing?.timer) clearTimeout(existing.timer);
  const pollStart = existing?.pollStart || Date.now();
  const effectiveStartTime = existing?.startTime || startTime;
  const speedSamples = []; // [{t, bytes}]
  downloadPollers[modelId] = { stopped: false, timer: null, pollStart, startTime: effectiveStartTime };

  const run = async () => {
    const poller = downloadPollers[modelId];
    if (!poller || poller.stopped) return;

    // Frontend safety timeout
    if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
      _stopDownloadPolling(modelId);
      _activeDownloads.delete(modelId);
      _setDownloadError(modelId, card, "Timed out waiting for download.");
      return;
    }

    let status;
    try {
      status = await api(`/api/models/download/status?model_id=${encodeURIComponent(modelId)}`);
    } catch (_) {
      _scheduleDownloadPoll(modelId, run);
      return; // network hiccup – retry next tick
    }

    const pct = Math.max(0, Math.min(100, Math.round((status.progress || 0) * 100)));

    // Speed calculation from bytes_done samples (keep 8 s window)
    let speedStr = "";
    if (status.bytes_done != null && status.bytes_done > 0) {
      const now = Date.now();
      speedSamples.push({ t: now, b: status.bytes_done });
      const cutoff = now - 8000;
      while (speedSamples.length > 1 && speedSamples[0].t < cutoff) speedSamples.shift();
      if (speedSamples.length >= 2) {
        const dt = (speedSamples.at(-1).t - speedSamples[0].t) / 1000;
        const db = speedSamples.at(-1).b - speedSamples[0].b;
        if (dt > 0.5 && db > 0) speedStr = fmtSpeed(db / dt);
      }
    }

    // ETA from elapsed vs progress
    const elapsed = (Date.now() - effectiveStartTime) / 1000;
    const prog = status.progress || 0;
    const etaStr = (prog > 0.02 && elapsed > 3)
      ? fmtEta(Math.round(elapsed * (1 - prog) / prog))
      : "";

    const totalBytes = Number.isFinite(status.total_bytes) ? status.total_bytes : 0;
    const doneBytes = Number.isFinite(status.bytes_done) ? status.bytes_done : 0;
    const remainingBytes = totalBytes > 0 ? Math.max(totalBytes - doneBytes, 0) : 0;
    const downloadedText = totalBytes > 0
      ? `${fmtBytes(doneBytes)} of ${fmtBytes(totalBytes)} downloaded`
      : doneBytes > 0
        ? `${fmtBytes(doneBytes)} downloaded`
        : "Starting…";

    const metaParts = [];
    if (remainingBytes > 0) metaParts.push(`${fmtBytes(remainingBytes)} left`);
    if (speedStr) metaParts.push(speedStr);
    if (etaStr) metaParts.push(`About ${etaStr.slice(1)} left`);
    if (!metaParts.length && pct < 100) metaParts.push("Getting things ready…");

    // Update progress UI (guard: DOM might be gone if search was re-run)
    const pie = document.getElementById(`prog-pie-${modelId}`);
    const pctEl = document.getElementById(`prog-pct-${modelId}`);
    const titleEl = document.getElementById(`prog-title-${modelId}`);
    const amountEl = document.getElementById(`prog-amount-${modelId}`);
    const metaEl = document.getElementById(`prog-meta-${modelId}`);
    if (pie) pie.style.setProperty("--progress", `${(pct / 100) * 360}deg`);
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (titleEl) titleEl.textContent = friendlyFileLabel(status.current_file);
    if (amountEl) amountEl.textContent = downloadedText;
    if (metaEl) metaEl.textContent = metaParts.join(" · ");

    if (!status.done) {
      _scheduleDownloadPoll(modelId, run);
      return;
    }

    // Download finished (success or error)
    _stopDownloadPolling(modelId);
    _activeDownloads.delete(modelId);

    if (status.error) {
      _setDownloadError(modelId, card, status.error);
    } else {
      toast(`${modelId.split("/").pop()} downloaded!`, "success");
      await refreshLocalModels();
      _refreshChatSelector();
      const actEl = card?.querySelector(`#actions-${CSS.escape(modelId)}`);
      if (actEl) actEl.innerHTML = '<span class="gpu-badge full">Downloaded</span>';
    }
  };

  run();
}

function _setDownloadError(modelId, card, message) {
  // Don't show error toast for user-initiated cancellations
  if (!message.toLowerCase().includes("cancel")) {
    toast(`Download failed: ${message}`, "error", 6000);
  }
  const actEl = card?.querySelector(`#actions-${CSS.escape(modelId)}`);
  if (actEl) {
    const isCancel = message.toLowerCase().includes("cancel");
    actEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
        ${!isCancel ? `<span style="font-size:11px;color:var(--danger)">${escHtml(message)}</span>` : ""}
        <button class="btn-primary btn-sm btn-download" data-id="${modelId}">${isCancel ? "Download" : "Retry"}</button>
      </div>`;
    actEl.querySelector(".btn-download")?.addEventListener("click", async e => {
      e.currentTarget.disabled = true;
      await startDownload(modelId, card);
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

/** Sync _activeDownloads with backend state and resume polling for any orphaned downloads. */
async function _resumeActiveDownloads() {
  try {
    const active = await api("/api/models/download/active");
    for (const dl of active) {
      if (!_activeDownloads.has(dl.model_id)) {
        _activeDownloads.add(dl.model_id);
      }
      // Re-attach poller if not already running (e.g. after tab switch)
      if (!downloadPollers[dl.model_id]) {
        const card = document.getElementById(`search-card-${CSS.escape(dl.model_id)}`);
        if (card) {
          _renderProgressUI(card, dl.model_id);
          const startTime = dl.start_time ? dl.start_time * 1000 : Date.now();
          pollDownload(dl.model_id, card, startTime);
        }
      }
    }
  } catch (_) {}
}

export async function initModels() {
  // Cache memory for client-side GPU label updates
  api("/api/system/memory").then(mem => {
    window._memTotal = mem.total_gb;
    window._memAvail = mem.available_gb;
    refreshMemoryInfo();
  }).catch(() => {});

  // Restore any downloads that were in progress before this tab became active
  _resumeActiveDownloads();

  refreshLocalModels();

  const searchInput = document.getElementById("model-search");
  const searchBtn   = document.getElementById("btn-search");

  if (searchInput && !searchInput.dataset.initialized) {
    searchInput.dataset.initialized = "1";

    const dropdown = document.createElement("div");
    dropdown.className = "suggestion-dropdown hidden";
    searchInput.parentElement.appendChild(dropdown);

    _loadSuggestionPool().then(() => {
      if (searchInput.value) _showSuggestions(searchInput, dropdown, searchInput.value);
    });

    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim();
      _showSuggestions(searchInput, dropdown, q);
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        dropdown.classList.add("hidden");
        searchModels(q || "", _currentSort);
      }, q ? 400 : 0);
    });

    searchInput.addEventListener("keydown", e => {
      if (e.key === "Enter")  { dropdown.classList.add("hidden"); searchModels(searchInput.value, _currentSort); }
      if (e.key === "Escape") dropdown.classList.add("hidden");
    });

    searchInput.addEventListener("blur", () => {
      setTimeout(() => dropdown.classList.add("hidden"), 150);
    });

    searchBtn.addEventListener("click", () => {
      dropdown.classList.add("hidden");
      searchModels(searchInput.value, _currentSort);
    });

    // Sort buttons
    document.querySelectorAll(".sort-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".sort-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        _currentSort = btn.dataset.sort;
        searchModels(searchInput.value, _currentSort);
      });
    });

    searchModels("", _currentSort);
  }
}
