/**
 * Models module – local model list, HuggingFace search with autocomplete,
 * download with progress, lazy size fetch.
 */
import { api, toast, state } from "./main.js";

let searchTimeout = null;
let downloadPollers = {};
let _currentSort = "downloads";
let _suggestionPool = [];

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
      state.modelLoaded = true;
      _syncChatHeader(m.id);
      toast("Model loaded", "success");
      btn.textContent = "Loaded";
    } catch (err) {
      clearTimeout(timeout);
      const msg = err.name === "AbortError" ? "Load timed out" : err.message;
      toast(msg, "error");
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

  card.innerHTML = `
    <div class="model-card-info">
      <div class="model-card-name" title="${m.id}">${escHtml(m.name)}</div>
      <div class="model-card-meta">
        <span class="model-card-size size-display">${sizeStr}</span>
        <span class="gpu-badge ${m.gpu_label} gpu-badge-dynamic">${GPU_LABELS[m.gpu_label] || ""}</span>
        ${unsupportedChip(m)}
        ${m.publisher ? `<span class="publisher-badge">${escHtml(m.publisher)}</span>` : ""}
        <span class="model-card-size">${downloads}</span>
      </div>
      <div class="model-tag-row">${renderTagChips(m)}</div>
    </div>
    <div class="model-card-actions" id="actions-${CSS.escape(m.id)}">
      ${alreadyLocal
        ? '<span class="gpu-badge full">Downloaded</span>'
        : (m.loadable === false
            ? `<button class="btn-outline btn-sm" title="${escHtml(m.reason || 'Unsupported by current loader')}" disabled>Unsupported</button>`
            : `<button class="btn-primary btn-sm btn-download" data-id="${m.id}">Download</button>`)}
    </div>`;

  if (!alreadyLocal && m.loadable !== false) {
    card.querySelector(".btn-download").addEventListener("click", async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Starting…";
      await startDownload(m.id, card);
    });
  }
  return card;
}

// ── Download + poller ─────────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = 800;
const POLL_TIMEOUT_MS   = 32 * 60 * 1000; // 32 min frontend safety net

async function startDownload(modelId, card) {
  try {
    await api("/api/models/download", {
      method: "POST",
      body: JSON.stringify({ model_id: modelId }),
    });
    toast(`Downloading ${modelId.split("/").pop()}…`, "info", 5000);

    const actionsEl = card.querySelector(`#actions-${CSS.escape(modelId)}`);
    if (actionsEl) {
      actionsEl.innerHTML = `
        <div class="download-progress-wrap">
          <div class="progress-bar-outer">
            <div class="progress-bar-inner" id="prog-bar-${CSS.escape(modelId)}" style="width:0%"></div>
          </div>
          <span class="progress-text" id="prog-text-${CSS.escape(modelId)}">0%</span>
        </div>`;
    }
    pollDownload(modelId, card);
  } catch (e) {
    toast(e.message, "error");
    // Restore download button
    const actionsEl = card.querySelector(`#actions-${CSS.escape(modelId)}`);
    if (actionsEl) actionsEl.innerHTML =
      `<button class="btn-primary btn-sm btn-download" data-id="${modelId}">Retry</button>`;
  }
}

function pollDownload(modelId, card) {
  if (downloadPollers[modelId]) clearInterval(downloadPollers[modelId]);
  const pollStart = Date.now();

  downloadPollers[modelId] = setInterval(async () => {
    // Frontend safety timeout
    if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
      clearInterval(downloadPollers[modelId]);
      delete downloadPollers[modelId];
      _setDownloadError(modelId, card, "Timed out waiting for download.");
      return;
    }

    let status;
    try {
      status = await api(`/api/models/download/status?model_id=${encodeURIComponent(modelId)}`);
    } catch (_) {
      return; // network hiccup – retry next tick
    }

    const pct = Math.round((status.progress || 0) * 100);

    // Update progress bar (guard: DOM might be gone if user navigated)
    const bar  = document.getElementById(`prog-bar-${CSS.escape(modelId)}`);
    const text = document.getElementById(`prog-text-${CSS.escape(modelId)}`);
    if (bar)  bar.style.width = pct + "%";
    if (text) text.textContent = status.current_file
      ? `${pct}% — ${status.current_file.split("/").pop()}`
      : `${pct}%`;

    if (!status.done) return;

    // Download finished (success or error)
    clearInterval(downloadPollers[modelId]);
    delete downloadPollers[modelId];

    if (status.error) {
      _setDownloadError(modelId, card, status.error);
    } else {
      toast(`${modelId.split("/").pop()} downloaded!`, "success");
      await refreshLocalModels();
      _refreshChatSelector();

      const actEl = card?.querySelector(`#actions-${CSS.escape(modelId)}`);
      if (actEl) actEl.innerHTML = '<span class="gpu-badge full">Downloaded</span>';
    }
  }, POLL_INTERVAL_MS);
}

function _setDownloadError(modelId, card, message) {
  toast(`Download failed: ${message}`, "error", 6000);
  const actEl = card?.querySelector(`#actions-${CSS.escape(modelId)}`);
  if (actEl) {
    actEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
        <span style="font-size:11px;color:var(--danger)">${escHtml(message)}</span>
        <button class="btn-primary btn-sm btn-download" data-id="${modelId}">Retry</button>
      </div>`;
    actEl.querySelector(".btn-download")?.addEventListener("click", async e => {
      e.currentTarget.disabled = true;
      await startDownload(modelId, card);
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initModels() {
  // Cache memory for client-side GPU label updates
  api("/api/system/memory").then(mem => {
    window._memTotal = mem.total_gb;
    window._memAvail = mem.available_gb;
    refreshMemoryInfo();
  }).catch(() => {});

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
