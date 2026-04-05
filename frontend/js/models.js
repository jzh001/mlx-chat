/**
 * Models module – local model list, HuggingFace search, download with progress.
 */
import { api, toast, state } from "./main.js";

let searchTimeout = null;
let downloadPollers = {};

// ── GPU label rendering ───────────────────────────────────────────────────────
function gpuBadge(label) {
  const labels = {
    full: "Full GPU Offload",
    partial: "Partial GPU Offload",
    too_large: "Likely Too Large",
    unknown: "Size Unknown",
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
        `RAM: ${mem.available_gb.toFixed(1)} GB available / ${mem.total_gb.toFixed(1)} GB total`;
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
    models.forEach(m => {
      container.appendChild(buildLocalCard(m));
    });
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

  card.querySelector(".btn-load-local").addEventListener("click", async (e) => {
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

      // Update chat model selector too
      const sel = document.getElementById("model-select");
      if (sel) sel.value = m.id;
      const modelStatus = document.getElementById("model-status");
      if (modelStatus) {
        modelStatus.textContent = "Model ready";
        modelStatus.className = "model-status ready";
      }
      const userInput = document.getElementById("user-input");
      if (userInput) userInput.disabled = false;
      const sendBtn = document.getElementById("btn-send");
      if (sendBtn) sendBtn.disabled = false;

      toast("Model loaded", "success");
      btn.textContent = "Loaded";
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Load";
    }
  });

  card.querySelector(".btn-delete-local").addEventListener("click", async (e) => {
    if (!confirm(`Delete ${m.name}?`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await api(`/api/models/${encodeURIComponent(m.id)}`, { method: "DELETE" });
      card.remove();
      if (state.currentModelId === m.id) {
        state.currentModelId = null;
        state.modelLoaded = false;
      }
      toast("Model deleted", "success");
      // Refresh model selector
      await refreshSelectModels();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Delete";
    }
  });

  return card;
}

async function refreshSelectModels() {
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

// ── Search models ──────────────────────────────────────────────────────────────
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

    // Get local model IDs for "already downloaded" indication
    let localIds = new Set();
    try {
      const local = await api("/api/models/local");
      localIds = new Set(local.map(m => m.id));
    } catch (_) {}

    models.forEach(m => {
      container.appendChild(buildSearchCard(m, localIds.has(m.id)));
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Search failed: ${e.message}</div>`;
  }
}

function buildSearchCard(m, alreadyLocal) {
  const card = document.createElement("div");
  card.className = "model-card";
  card.id = `search-card-${CSS.escape(m.id)}`;

  const downloads = m.downloads > 1000
    ? `${(m.downloads / 1000).toFixed(1)}k downloads`
    : `${m.downloads} downloads`;

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
    card.querySelector(".btn-download").addEventListener("click", async (e) => {
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

    // Replace action area with progress bar
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

    // Poll progress
    pollDownload(modelId, card);
  } catch (e) {
    toast(e.message, "error");
  }
}

function pollDownload(modelId, card) {
  if (downloadPollers[modelId]) clearInterval(downloadPollers[modelId]);

  downloadPollers[modelId] = setInterval(async () => {
    try {
      const status = await api(`/api/models/download/status?model_id=${encodeURIComponent(modelId)}`);
      const pct = Math.round(status.progress * 100);

      const bar = document.getElementById(`prog-bar-${CSS.escape(modelId)}`);
      const text = document.getElementById(`prog-text-${CSS.escape(modelId)}`);
      if (bar) bar.style.width = pct + "%";
      if (text) text.textContent = pct + "%";

      if (status.done) {
        clearInterval(downloadPollers[modelId]);
        delete downloadPollers[modelId];

        if (status.error) {
          toast(`Download failed: ${status.error}`, "error");
          const actionsEl = card.querySelector(`#actions-${CSS.escape(modelId)}`);
          if (actionsEl) actionsEl.innerHTML =
            `<button class="btn-primary btn-sm btn-download" data-id="${modelId}">Retry</button>`;
        } else {
          toast(`${modelId.split("/").pop()} downloaded!`, "success");
          await refreshLocalModels();
          await refreshSelectModels();
          // Update the card in search results
          const actionsEl = card.querySelector(`#actions-${CSS.escape(modelId)}`);
          if (actionsEl) actionsEl.innerHTML = '<span class="gpu-badge full">Downloaded</span>';
        }
      }
    } catch (_) {}
  }, 800);
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initModels() {
  await refreshMemoryInfo();
  await refreshLocalModels();

  // Lazy: only search when user interacts
  const searchInput = document.getElementById("model-search");
  const searchBtn = document.getElementById("btn-search");

  if (searchInput && !searchInput.dataset.initialized) {
    searchInput.dataset.initialized = "1";

    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => searchModels(searchInput.value), 400);
    });

    searchInput.addEventListener("keydown", e => {
      if (e.key === "Enter") searchModels(searchInput.value);
    });

    searchBtn.addEventListener("click", () => searchModels(searchInput.value));

    // Initial search to populate
    await searchModels("");
  }
}
