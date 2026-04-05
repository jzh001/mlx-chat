/**
 * Models module – local model list, HuggingFace search with autocomplete,
 * download with progress.
 */
import { api, toast, state } from "./main.js";

let searchTimeout = null;
let downloadPollers = {};

// Pre-loaded suggestion pool (model names from mlx-community)
let _suggestionPool = [];

// ── GPU label rendering ───────────────────────────────────────────────────────
function gpuBadge(label) {
  const labels = {
    full:      "Full GPU Offload",
    partial:   "Partial GPU Offload",
    too_large: "Likely Too Large",
    unknown:   "Size Unknown",
  };
  return `<span class="gpu-badge ${label}">${labels[label] || label}</span>`;
}

function sizeText(sizeGb) {
  if (sizeGb == null) return "";
  return `${sizeGb.toFixed(1)} GB`;
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
    container.innerHTML = `<div class="empty-state">Failed to load: ${e.message}</div>`;
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
        ${m.size_gb != null ? `<span class="model-card-size">${sizeText(m.size_gb)}</span>` : ""}
        ${gpuBadge(m.gpu_label)}
        ${loaded ? '<span class="gpu-badge full">Loaded</span>' : ""}
      </div>
    </div>
    <div class="model-card-actions">
      <button class="btn-outline btn-load-local" data-id="${m.id}">
        ${loaded ? "Loaded" : "Load"}
      </button>
      <button class="btn-danger btn-delete-local" data-id="${m.id}">Delete</button>
    </div>`;

  card.querySelector(".btn-load-local").addEventListener("click", async e => {
    const btn = e.currentTarget;
    if (btn.textContent.trim() === "Loaded") return;
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      await api("/api/model/load", {
        method: "POST",
        body: JSON.stringify({ model_id: m.id }),
      });
      state.currentModelId = m.id;
      state.modelLoaded = true;

      // Sync chat header
      const sel = document.getElementById("model-select");
      if (sel) sel.value = m.id;
      const ms = document.getElementById("model-status");
      if (ms) { ms.textContent = "Model ready"; ms.className = "model-status ready"; }
      const inp = document.getElementById("user-input");
      if (inp) inp.placeholder = "Message…";

      toast("Model loaded", "success");
      btn.textContent = "Loaded";
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Load";
    }
  });

  card.querySelector(".btn-delete-local").addEventListener("click", async e => {
    if (!confirm(`Delete ${m.name}?`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await api(`/api/models/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      card.remove();
      if (state.currentModelId === m.id) { state.currentModelId = null; state.modelLoaded = false; }
      toast("Model deleted", "success");
      await _refreshChatSelector();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Delete";
    }
  });

  return card;
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
      opt.value = m.id;
      opt.textContent = m.name;
      select.appendChild(opt);
    });
    if (prev && models.find(m => m.id === prev)) select.value = prev;
  } catch (_) {}
}

// ── Search + autocomplete ──────────────────────────────────────────────────────
async function _loadSuggestionPool() {
  if (_suggestionPool.length) return; // already loaded
  try {
    const models = await api("/api/models/search?limit=100");
    _suggestionPool = models.map(m => m.id); // full IDs like "mlx-community/foo"
  } catch (_) {}
}

function _filterSuggestions(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  return _suggestionPool
    .filter(id => id.toLowerCase().includes(q))
    .slice(0, 8);
}

function _showSuggestions(inputEl, dropdownEl, query) {
  const matches = _filterSuggestions(query);
  if (!matches.length || !query) {
    dropdownEl.classList.add("hidden");
    return;
  }
  dropdownEl.innerHTML = "";
  matches.forEach(id => {
    const name = id.split("/").pop();
    const item = document.createElement("div");
    item.className = "suggestion-item";
    // Bold the matching part
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
      e.preventDefault(); // prevent input blur before click fires
      inputEl.value = name;
      dropdownEl.classList.add("hidden");
      searchModels(name);
    });
    dropdownEl.appendChild(item);
  });
  dropdownEl.classList.remove("hidden");
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── HuggingFace search ────────────────────────────────────────────────────────
async function searchModels(query = "") {
  const container = document.getElementById("search-results");
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';

  try {
    const url = query
      ? `/api/models/search?q=${encodeURIComponent(query)}&limit=30`
      : "/api/models/search?limit=30";
    const models = await api(url);

    if (!models.length) {
      container.innerHTML = '<div class="empty-state">No results found.</div>';
      return;
    }

    container.innerHTML = "";
    let localIds = new Set();
    try { localIds = new Set((await api("/api/models/local")).map(m => m.id)); } catch (_) {}

    models.forEach(m => container.appendChild(buildSearchCard(m, localIds.has(m.id))));
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Search failed: ${e.message}</div>`;
  }
}

function buildSearchCard(m, alreadyLocal) {
  const card = document.createElement("div");
  card.className = "model-card";
  card.id = `search-card-${CSS.escape(m.id)}`;

  const downloads = m.downloads > 1000
    ? `${(m.downloads / 1000).toFixed(1)}k ↓`
    : `${m.downloads} ↓`;

  card.innerHTML = `
    <div class="model-card-info">
      <div class="model-card-name" title="${m.id}">${m.name}</div>
      <div class="model-card-meta">
        ${m.size_gb != null ? `<span class="model-card-size">${sizeText(m.size_gb)}</span>` : ""}
        ${gpuBadge(m.gpu_label)}
        <span class="model-card-size">${downloads}</span>
      </div>
    </div>
    <div class="model-card-actions" id="actions-${CSS.escape(m.id)}">
      ${alreadyLocal
        ? '<span class="gpu-badge full">Downloaded</span>'
        : `<button class="btn-primary btn-sm btn-download" data-id="${m.id}">Download</button>`}
    </div>`;

  if (!alreadyLocal) {
    card.querySelector(".btn-download").addEventListener("click", async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Starting…";
      await startDownload(m.id, card);
    });
  }
  return card;
}

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
  } catch (e) { toast(e.message, "error"); }
}

function pollDownload(modelId, card) {
  if (downloadPollers[modelId]) clearInterval(downloadPollers[modelId]);

  downloadPollers[modelId] = setInterval(async () => {
    try {
      const status = await api(`/api/models/download/status?model_id=${encodeURIComponent(modelId)}`);
      const pct = Math.round(status.progress * 100);

      document.getElementById(`prog-bar-${CSS.escape(modelId)}`)?.style.setProperty("width", pct + "%");
      const txt = document.getElementById(`prog-text-${CSS.escape(modelId)}`);
      if (txt) txt.textContent = status.current_file
        ? `${pct}% — ${status.current_file.split("/").pop()}`
        : pct + "%";

      if (status.done) {
        clearInterval(downloadPollers[modelId]);
        delete downloadPollers[modelId];

        if (status.error) {
          toast(`Download failed: ${status.error}`, "error");
          const actEl = card.querySelector(`#actions-${CSS.escape(modelId)}`);
          if (actEl) actEl.innerHTML =
            `<button class="btn-primary btn-sm btn-download" data-id="${modelId}">Retry</button>`;
        } else {
          toast(`${modelId.split("/").pop()} downloaded!`, "success");
          await refreshLocalModels();
          await _refreshChatSelector();
          const actEl = card.querySelector(`#actions-${CSS.escape(modelId)}`);
          if (actEl) actEl.innerHTML = '<span class="gpu-badge full">Downloaded</span>';
        }
      }
    } catch (_) {}
  }, 800);
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initModels() {
  refreshMemoryInfo();    // fire-and-forget
  refreshLocalModels();   // fire-and-forget

  const searchInput = document.getElementById("model-search");
  const searchBtn   = document.getElementById("btn-search");

  if (searchInput && !searchInput.dataset.initialized) {
    searchInput.dataset.initialized = "1";

    // Create autocomplete dropdown
    const dropdown = document.createElement("div");
    dropdown.className = "suggestion-dropdown hidden";
    searchInput.parentElement.appendChild(dropdown);

    // Pre-load suggestion pool in background
    _loadSuggestionPool().then(() => {
      // Once loaded, re-show suggestions for whatever is currently typed
      if (searchInput.value) _showSuggestions(searchInput, dropdown, searchInput.value);
    });

    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim();
      _showSuggestions(searchInput, dropdown, q);
      clearTimeout(searchTimeout);
      if (q.length >= 2) {
        searchTimeout = setTimeout(() => {
          dropdown.classList.add("hidden");
          searchModels(q);
        }, 400);
      }
    });

    searchInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { dropdown.classList.add("hidden"); searchModels(searchInput.value); }
      if (e.key === "Escape") dropdown.classList.add("hidden");
    });

    searchInput.addEventListener("blur", () => {
      // Delay so mousedown on item fires first
      setTimeout(() => dropdown.classList.add("hidden"), 150);
    });

    searchBtn.addEventListener("click", () => {
      dropdown.classList.add("hidden");
      searchModels(searchInput.value);
    });

    // Initial popular models
    searchModels("");
  }
}
