/**
 * Chat module – handles conversation UI, streaming, settings panel.
 */
import { api, toast, state } from "./main.js";

// ── Markdown / math renderer ──────────────────────────────────────────────────
function renderMarkdown(text) {
  if (typeof marked === "undefined") return text;
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight: (code, lang) => {
      if (typeof hljs !== "undefined" && lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return typeof hljs !== "undefined" ? hljs.highlightAuto(code).value : code;
    },
  });
  return marked.parse(text);
}

function renderMath(el) {
  if (typeof renderMathInElement !== "undefined") {
    renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$",  right: "$",  display: false },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
    });
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl   = () => document.getElementById("messages");
const inputEl      = () => document.getElementById("user-input");
const sendBtnEl    = () => document.getElementById("btn-send");
const modelSelect  = () => document.getElementById("model-select");
const loadModelBtn = () => document.getElementById("btn-load-model");
const modelStatus  = () => document.getElementById("model-status");
const welcomeEl    = () => document.getElementById("welcome");

// ── Per-conversation message history ──────────────────────────────────────────
let messages = [];
let isStreaming = false;

// ── Input state ───────────────────────────────────────────────────────────────
// Textarea is always enabled for a responsive feel.
// Sending without a loaded model shows a toast instead of silently doing nothing.
function updateSendBtn() {
  const btn = sendBtnEl();
  if (btn) btn.disabled = isStreaming;
}

// ── Model selector ────────────────────────────────────────────────────────────
async function refreshModelSelector(preselect) {
  try {
    const models = await api("/api/models/local");
    const select = modelSelect();
    const prev = preselect || select.value;
    select.innerHTML = '<option value="">— select a model —</option>';
    models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      select.appendChild(opt);
    });
    if (prev && models.find(m => m.id === prev)) {
      select.value = prev;
      loadModelBtn().disabled = false;
    }
  } catch (e) {
    console.error("Failed to load models:", e);
  }
}

// Restore currently loaded model state from backend (non-blocking)
async function syncLoadedState() {
  try {
    const status = await api("/api/model/loaded");
    if (status.model_id && status.state === "ready") {
      state.currentModelId = status.model_id;
      state.modelLoaded = true;
      modelSelect().value = status.model_id;
      loadModelBtn().disabled = false;
      updateModelStatus("ready", "Model ready");
    }
  } catch (_) {}
}

function updateModelStatus(stateStr, message) {
  const el = modelStatus();
  el.textContent = message || "";
  el.className = "model-status " + (stateStr || "");
}

// ── Message rendering ─────────────────────────────────────────────────────────
function addMessage(role, content, streaming = false) {
  welcomeEl()?.remove();

  const el = document.createElement("div");
  el.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "U" : "AI";

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";

  if (streaming) {
    contentEl.classList.add("streaming-cursor");
  } else {
    contentEl.innerHTML = renderMarkdown(content);
    renderMath(contentEl);
  }

  el.appendChild(avatar);
  el.appendChild(contentEl);
  messagesEl().appendChild(el);
  scrollToBottom();
  return { contentEl, messageEl: el };
}

function scrollToBottom() {
  const el = messagesEl();
  el.scrollTop = el.scrollHeight;
}

// ── Stats bar (appended inside contentEl, below the generated text) ───────────
function renderStats(contentEl, stats, elapsed) {
  contentEl.querySelector(".msg-stats")?.remove();

  const parts = [];
  if (stats && stats.generation_tps != null)
    parts.push(`⚡ ${stats.generation_tps.toFixed(1)} tok/s`);
  if (stats && stats.generation_tokens != null)
    parts.push(`${stats.generation_tokens} tokens`);
  if (stats && stats.prompt_tokens != null)
    parts.push(`${stats.prompt_tokens} prompt`);
  if (stats && stats.peak_memory_gb != null)
    parts.push(`${stats.peak_memory_gb.toFixed(2)} GB`);
  // Always show elapsed time
  if (elapsed != null)
    parts.push(`${elapsed.toFixed(1)}s`);

  if (!parts.length) return;

  const bar = document.createElement("div");
  bar.className = "msg-stats";
  bar.textContent = parts.join("  ·  ");
  contentEl.appendChild(bar);
}

// ── Streaming chat ────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = inputEl();
  const text = input.value.trim();
  if (!text || isStreaming) return;

  if (!state.modelLoaded) {
    toast("Load a model first — select one and click Load.", "error", 4000);
    return;
  }

  input.value = "";
  input.style.height = "auto";

  addMessage("user", text);
  messages.push({ role: "user", content: text });

  isStreaming = true;
  updateSendBtn();

  const { contentEl: assistantContentEl } = addMessage("assistant", "", true);
  let assistantText = "";
  let pendingStats = null;
  const t0 = performance.now();

  try {
    const settings = collectSettings();
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: state.currentConvId,
        model_id: state.currentModelId,
        messages: [...messages],
        settings,
      }),
    });

    if (!res.ok) throw new Error(`Server error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;
        try {
          const event = JSON.parse(dataStr);
          if (event.type === "chunk") {
            assistantText += event.text;
            assistantContentEl.innerHTML = renderMarkdown(assistantText);
            renderMath(assistantContentEl);
            scrollToBottom();
          } else if (event.type === "stats") {
            pendingStats = event;
          } else if (event.type === "done") {
            state.currentConvId = event.conversation_id;
            await loadConversationList();
          } else if (event.type === "error") {
            toast(event.message, "error");
          }
        } catch (_) {}
      }
    }

    // Final clean render
    assistantContentEl.classList.remove("streaming-cursor");
    assistantContentEl.innerHTML = renderMarkdown(assistantText);
    renderMath(assistantContentEl);
    scrollToBottom();

    const elapsed = (performance.now() - t0) / 1000;
    renderStats(assistantContentEl, pendingStats, elapsed);

    messages.push({ role: "assistant", content: assistantText });

  } catch (err) {
    assistantContentEl.classList.remove("streaming-cursor");
    assistantContentEl.innerHTML =
      `<span style="color:var(--danger)">Error: ${err.message}</span>`;
    toast(err.message, "error");
  } finally {
    isStreaming = false;
    updateSendBtn();
  }
}

// ── Conversation list ─────────────────────────────────────────────────────────
export async function loadConversationList() {
  try {
    const convs = await api("/api/conversations");
    const list = document.getElementById("conversation-list");
    list.innerHTML = "";
    convs.forEach(conv => {
      const item = document.createElement("div");
      item.className = "conv-item" + (conv.id === state.currentConvId ? " active" : "");
      item.dataset.id = conv.id;

      const title = document.createElement("span");
      title.className = "conv-title";
      title.textContent = conv.title || "Untitled";

      const del = document.createElement("button");
      del.className = "conv-delete";
      del.textContent = "×";
      del.title = "Delete";
      del.addEventListener("click", async e => {
        e.stopPropagation();
        await api(`/api/conversations/${conv.id}`, { method: "DELETE" });
        if (state.currentConvId === conv.id) startNewConversation();
        await loadConversationList();
      });

      item.appendChild(title);
      item.appendChild(del);
      item.addEventListener("click", () => loadConversation(conv.id));
      list.appendChild(item);
    });
  } catch (_) {}
}

async function loadConversation(convId) {
  try {
    const conv = await api(`/api/conversations/${convId}`);
    state.currentConvId = convId;
    messages = conv.messages || [];

    const container = messagesEl();
    container.innerHTML = "";
    messages.forEach(m => {
      if (m.role !== "system") addMessage(m.role, m.content);
    });

    document.querySelectorAll(".conv-item").forEach(el =>
      el.classList.toggle("active", el.dataset.id === convId));

    document.getElementById("view-chat").classList.add("active");

    if (conv.model) {
      const select = modelSelect();
      if ([...select.options].some(o => o.value === conv.model)) select.value = conv.model;
    }
  } catch (e) {
    toast("Failed to load conversation", "error");
  }
}

export function startNewConversation() {
  state.currentConvId = null;
  messages = [];
  messagesEl().innerHTML = `
    <div id="welcome" class="welcome">
      <div class="welcome-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/>
          <path d="M2 12l10 5 10-5"/>
        </svg>
      </div>
      <h2>MLX Chat</h2>
      <p>Fast local AI on Apple Silicon.<br>Select and load a model to begin.</p>
    </div>`;
  document.querySelectorAll(".conv-item").forEach(el => el.classList.remove("active"));
}

// ── Settings panel ────────────────────────────────────────────────────────────
function collectSettings() {
  return {
    system_prompt:          document.getElementById("set-system-prompt").value,
    temperature:            parseFloat(document.getElementById("set-temperature").value),
    top_p:                  parseFloat(document.getElementById("set-top-p").value),
    max_tokens:             parseInt(document.getElementById("set-max-tokens").value),
    repetition_penalty:     parseFloat(document.getElementById("set-rep-penalty").value),
    repetition_context_size:parseInt(document.getElementById("set-rep-context").value),
    use_turboquant:         document.getElementById("set-turboquant").checked,
    kv_bits:                parseFloat(document.getElementById("set-kv-bits").value),
  };
}

function applySettings(s) {
  document.getElementById("set-system-prompt").value   = s.system_prompt || "";
  document.getElementById("set-temperature").value     = s.temperature;
  document.getElementById("set-top-p").value           = s.top_p;
  document.getElementById("set-max-tokens").value      = s.max_tokens;
  document.getElementById("set-rep-penalty").value     = s.repetition_penalty;
  document.getElementById("set-rep-context").value     = s.repetition_context_size;
  document.getElementById("set-turboquant").checked    = s.use_turboquant;
  document.getElementById("set-kv-bits").value         = s.kv_bits || 4;
  document.getElementById("val-temperature").textContent = s.temperature;
  document.getElementById("val-top-p").textContent       = s.top_p;
  document.getElementById("val-rep-penalty").textContent = s.repetition_penalty;
  document.getElementById("val-kv-bits").textContent     = s.kv_bits || 4;
  document.getElementById("turboquant-options").classList.toggle("hidden", !s.use_turboquant);
}

async function openSettings() {
  if (state.currentModelId) {
    try {
      const s = await api(`/api/settings/${encodeURIComponent(state.currentModelId)}`);
      applySettings(s);
    } catch (_) {}
  }
  document.getElementById("settings-overlay").classList.remove("hidden");
  document.getElementById("settings-panel").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settings-overlay").classList.add("hidden");
  document.getElementById("settings-panel").classList.add("hidden");
}

// ── Model loading ─────────────────────────────────────────────────────────────
async function loadModel() {
  const modelId = modelSelect().value;
  if (!modelId) return;

  const btn = loadModelBtn();
  btn.disabled = true;
  btn.textContent = "Loading…";
  updateModelStatus("loading", "Loading model…");

  try {
    await api("/api/model/load", {
      method: "POST",
      body: JSON.stringify({ model_id: modelId }),
    });
    state.currentModelId = modelId;
    state.modelLoaded = true;
    updateModelStatus("ready", "Model ready");
    toast("Model loaded", "success");
  } catch (e) {
    state.modelLoaded = false;
    updateModelStatus("error", "Failed to load");
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Load";
    updateSendBtn();
  }
}

// ── Auto-resize textarea ──────────────────────────────────────────────────────
function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initChat() {
  // Enable textarea immediately — no waiting for API
  const input = inputEl();
  input.disabled = false;
  input.placeholder = "Load a model to start chatting…";

  sendBtnEl().addEventListener("click", sendMessage);

  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener("input", e => autoResize(e.target));

  modelSelect().addEventListener("change", () => {
    loadModelBtn().disabled = !modelSelect().value;
  });
  loadModelBtn().addEventListener("click", loadModel);

  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-close-settings").addEventListener("click", closeSettings);
  document.getElementById("settings-overlay").addEventListener("click", closeSettings);

  // Range sliders live display
  [
    ["set-temperature", "val-temperature"],
    ["set-top-p",       "val-top-p"],
    ["set-rep-penalty", "val-rep-penalty"],
    ["set-kv-bits",     "val-kv-bits"],
  ].forEach(([inputId, valId]) => {
    const el = document.getElementById(inputId);
    const vl = document.getElementById(valId);
    if (el && vl) el.addEventListener("input", () => { vl.textContent = el.value; });
  });

  document.getElementById("set-turboquant").addEventListener("change", e => {
    document.getElementById("turboquant-options").classList.toggle("hidden", !e.target.checked);
  });

  document.getElementById("btn-save-settings").addEventListener("click", async () => {
    if (!state.currentModelId) { toast("No model loaded", "error"); return; }
    try {
      await api(`/api/settings/${encodeURIComponent(state.currentModelId)}`, {
        method: "POST",
        body: JSON.stringify({ settings: collectSettings() }),
      });
      toast("Settings saved", "success");
      closeSettings();
    } catch (e) { toast(e.message, "error"); }
  });

  document.getElementById("btn-reset-settings").addEventListener("click", async () => {
    if (!state.currentModelId) return;
    try {
      applySettings(await api(`/api/settings/${encodeURIComponent(state.currentModelId)}`));
    } catch (_) {}
  });

  // Async init — doesn't block the UI
  Promise.all([
    loadConversationList(),
    _asyncInit(),
  ]);
}

async function _asyncInit() {
  // 1. Get last loaded model to pre-select
  let lastModel = null;
  try {
    const r = await api("/api/settings/last-model");
    lastModel = r.model_id || null;
  } catch (_) {}

  // 2. Populate model selector (pre-select last model)
  await refreshModelSelector(lastModel);

  // 3. Check if model is still loaded from a previous session
  await syncLoadedState();

  // Update placeholder based on whether model is ready
  if (state.modelLoaded) {
    inputEl().placeholder = "Message…";
  }
}
