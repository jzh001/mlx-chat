/**
 * Chat module – handles conversation UI, streaming, settings panel.
 */
import { api, toast, state } from "./main.js";

// ── Markdown / math renderer ──────────────────────────────────────────────────
function renderMarkdown(text) {
  if (typeof marked === "undefined") return text;

  // Configure marked
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

  let html = marked.parse(text);
  return html;
}

function renderMath(el) {
  if (typeof renderMathInElement !== "undefined") {
    renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
    });
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl = () => document.getElementById("messages");
const inputEl = () => document.getElementById("user-input");
const sendBtn = () => document.getElementById("btn-send");
const modelSelect = () => document.getElementById("model-select");
const loadModelBtn = () => document.getElementById("btn-load-model");
const modelStatus = () => document.getElementById("model-status");
const welcomeEl = () => document.getElementById("welcome");

// ── Per-conversation message history ─────────────────────────────────────────
let messages = [];
let isStreaming = false;

// ── Load local models into selector ──────────────────────────────────────────
async function refreshModelSelector() {
  try {
    const models = await api("/api/models/local");
    const select = modelSelect();
    const prev = select.value;
    select.innerHTML = '<option value="">— select a model —</option>';
    models.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      select.appendChild(opt);
    });
    if (prev && models.find(m => m.id === prev)) select.value = prev;
  } catch (e) {
    console.error("Failed to load models:", e);
  }
}

async function checkCurrentlyLoaded() {
  try {
    const status = await api("/api/model/loaded");
    if (status.model_id) {
      modelSelect().value = status.model_id;
      state.currentModelId = status.model_id;
      state.modelLoaded = status.state === "ready";
      updateModelStatus(status.state, status.message);
      updateInputState();
    }
  } catch (_) {}
}

function updateModelStatus(state_str, message) {
  const el = modelStatus();
  el.textContent = message || "";
  el.className = "model-status " + (state_str || "");
}

function updateInputState() {
  const ready = state.modelLoaded && !isStreaming;
  const input = inputEl();
  const btn = sendBtn();
  if (input) input.disabled = !ready;
  if (btn) btn.disabled = !ready;
}

// ── Message rendering ─────────────────────────────────────────────────────────
function addMessage(role, content, streaming = false) {
  const welcome = welcomeEl();
  if (welcome) welcome.remove();

  const el = document.createElement("div");
  el.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "U" : "AI";

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";

  if (streaming) {
    contentEl.classList.add("streaming-cursor");
    contentEl.textContent = "";
  } else {
    contentEl.innerHTML = renderMarkdown(content);
    renderMath(contentEl);
  }

  el.appendChild(avatar);
  el.appendChild(contentEl);
  messagesEl().appendChild(el);
  scrollToBottom();
  return contentEl;
}

function scrollToBottom() {
  const el = messagesEl();
  el.scrollTop = el.scrollHeight;
}

// ── Streaming chat ────────────────────────────────────────────────────────────
async function sendMessage() {
  const input = inputEl();
  const text = input.value.trim();
  if (!text || isStreaming || !state.modelLoaded) return;

  // Clear input
  input.value = "";
  input.style.height = "auto";

  // Add user message to UI and history
  addMessage("user", text);
  messages.push({ role: "user", content: text });

  isStreaming = true;
  updateInputState();

  // Add assistant placeholder
  const assistantContentEl = addMessage("assistant", "", true);
  let assistantText = "";

  try {
    const settings = collectSettings();
    const body = {
      conversation_id: state.currentConvId,
      model_id: state.currentModelId,
      messages: [...messages],
      settings,
    };

    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
            // Render markdown progressively (re-render on each chunk)
            assistantContentEl.innerHTML = renderMarkdown(assistantText);
            renderMath(assistantContentEl);
            scrollToBottom();
          } else if (event.type === "done") {
            state.currentConvId = event.conversation_id;
            await loadConversationList();
          } else if (event.type === "error") {
            toast(event.message, "error");
          }
        } catch (_) {}
      }
    }

    // Final render
    assistantContentEl.classList.remove("streaming-cursor");
    assistantContentEl.innerHTML = renderMarkdown(assistantText);
    renderMath(assistantContentEl);
    scrollToBottom();

    messages.push({ role: "assistant", content: assistantText });

  } catch (err) {
    assistantContentEl.classList.remove("streaming-cursor");
    assistantContentEl.textContent = "Error: " + err.message;
    toast(err.message, "error");
  } finally {
    isStreaming = false;
    updateInputState();
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
      del.addEventListener("click", async (e) => {
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

    // Re-render messages
    const container = messagesEl();
    container.innerHTML = "";

    messages.forEach(m => {
      addMessage(m.role, m.content);
    });

    // Update active item
    document.querySelectorAll(".conv-item").forEach(el => {
      el.classList.toggle("active", el.dataset.id === convId);
    });

    // Switch view
    document.getElementById("view-chat").classList.add("active");

    // If conv has a model, select it
    if (conv.model) {
      const select = modelSelect();
      if ([...select.options].some(o => o.value === conv.model)) {
        select.value = conv.model;
      }
    }
  } catch (e) {
    toast("Failed to load conversation", "error");
  }
}

export function startNewConversation() {
  state.currentConvId = null;
  messages = [];
  const container = messagesEl();
  container.innerHTML = `
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
    system_prompt: document.getElementById("set-system-prompt").value,
    temperature: parseFloat(document.getElementById("set-temperature").value),
    top_p: parseFloat(document.getElementById("set-top-p").value),
    max_tokens: parseInt(document.getElementById("set-max-tokens").value),
    repetition_penalty: parseFloat(document.getElementById("set-rep-penalty").value),
    repetition_context_size: parseInt(document.getElementById("set-rep-context").value),
    use_turboquant: document.getElementById("set-turboquant").checked,
    kv_bits: parseFloat(document.getElementById("set-kv-bits").value),
  };
}

function applySettings(s) {
  document.getElementById("set-system-prompt").value = s.system_prompt || "";
  document.getElementById("set-temperature").value = s.temperature;
  document.getElementById("set-top-p").value = s.top_p;
  document.getElementById("set-max-tokens").value = s.max_tokens;
  document.getElementById("set-rep-penalty").value = s.repetition_penalty;
  document.getElementById("set-rep-context").value = s.repetition_context_size;
  document.getElementById("set-turboquant").checked = s.use_turboquant;
  document.getElementById("set-kv-bits").value = s.kv_bits || 4;
  // Sync display values
  document.getElementById("val-temperature").textContent = s.temperature;
  document.getElementById("val-top-p").textContent = s.top_p;
  document.getElementById("val-rep-penalty").textContent = s.repetition_penalty;
  document.getElementById("val-kv-bits").textContent = s.kv_bits || 4;
  document.getElementById("turboquant-options").classList.toggle("hidden", !s.use_turboquant);
}

async function openSettings() {
  const modelId = state.currentModelId;
  if (modelId) {
    try {
      const settings = await api(`/api/settings/${encodeURIComponent(modelId)}`);
      applySettings(settings);
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
    toast("Model loaded successfully", "success");
  } catch (e) {
    updateModelStatus("error", "Failed to load");
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Load";
    updateInputState();
  }
}

// ── Auto-resize textarea ──────────────────────────────────────────────────────
function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initChat() {
  await refreshModelSelector();
  await checkCurrentlyLoaded();

  // Send button
  sendBtn().addEventListener("click", sendMessage);

  // Enter to send (Shift+Enter for newline)
  inputEl().addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize
  inputEl().addEventListener("input", e => autoResize(e.target));

  // Model select change
  modelSelect().addEventListener("change", () => {
    loadModelBtn().disabled = !modelSelect().value;
  });

  // Load model button
  loadModelBtn().addEventListener("click", loadModel);

  // Settings button
  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("btn-close-settings").addEventListener("click", closeSettings);
  document.getElementById("settings-overlay").addEventListener("click", closeSettings);

  // Range slider live value display
  const ranges = [
    ["set-temperature", "val-temperature"],
    ["set-top-p", "val-top-p"],
    ["set-rep-penalty", "val-rep-penalty"],
    ["set-kv-bits", "val-kv-bits"],
  ];
  ranges.forEach(([inputId, valId]) => {
    const input = document.getElementById(inputId);
    const val = document.getElementById(valId);
    if (input && val) {
      input.addEventListener("input", () => { val.textContent = input.value; });
    }
  });

  // TurboQuant toggle
  document.getElementById("set-turboquant").addEventListener("change", e => {
    document.getElementById("turboquant-options").classList.toggle("hidden", !e.target.checked);
  });

  // Save settings
  document.getElementById("btn-save-settings").addEventListener("click", async () => {
    if (!state.currentModelId) {
      toast("No model selected", "error");
      return;
    }
    try {
      const settings = collectSettings();
      await api(`/api/settings/${encodeURIComponent(state.currentModelId)}`, {
        method: "POST",
        body: JSON.stringify({ settings }),
      });
      toast("Settings saved", "success");
      closeSettings();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  // Reset settings to defaults
  document.getElementById("btn-reset-settings").addEventListener("click", async () => {
    if (!state.currentModelId) return;
    try {
      const defaults = await api(`/api/settings/${encodeURIComponent(state.currentModelId)}`);
      applySettings(defaults);
    } catch (_) {}
  });
}
