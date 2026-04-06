/**
 * Chat module – handles conversation UI, streaming, settings panel.
 */
import { api, toast, state, switchView } from "./main.js";

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

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isAsciiLetter(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function startsWithAt(text, index, token) {
  return String(text || "").slice(index, index + token.length) === token;
}

function collapseEscapedLatex(text) {
  const source = String(text || "");
  const special = "{}_^()[]$";
  let out = "";
  let i = 0;

  while (i < source.length) {
    if (source[i] !== "\\") {
      out += source[i];
      i += 1;
      continue;
    }

    let j = i;
    while (j < source.length && source[j] === "\\") j += 1;
    const slashCount = j - i;
    const next = source[j] || "";
    const looksLikeLatex = isAsciiLetter(next) || special.includes(next);

    if (looksLikeLatex && slashCount > 1) {
      out += "\\";
      i = j;
      continue;
    }

    out += source[i];
    i += 1;
  }

  return out;
}

function repairMalformedMathDelimiters(text) {
  const source = String(text || "");
  const lines = source.split("\n");
  const fixedLines = [];

  for (const line of lines) {
    let fixed = "";
    const stack = [];

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      const prev = i > 0 ? line[i - 1] : "";
      const next = i + 1 < line.length ? line[i + 1] : "";

      if (ch === "\\" && (next === "(" || next === "[")) {
        stack.push(next);
        fixed += ch;
        continue;
      }

      if (ch === "\\" && (next === ")" || next === "]")) {
        if (stack.length) stack.pop();
        fixed += ch;
        continue;
      }

      if (prev !== "\\" && (ch === ")" || ch === "]") && stack.length) {
        const top = stack[stack.length - 1];
        if ((ch === ")" && top === "(") || (ch === "]" && top === "[")) {
          stack.pop();
          fixed += "\\";
        }
      }

      fixed += ch;
    }

    while (stack.length) {
      const open = stack.pop();
      fixed += open === "(" ? "\\)" : "\\]";
    }

    fixedLines.push(fixed);
  }

  return fixedLines.join("\n");
}

function containsLatexCommand(text) {
  const source = String(text || "");
  for (let i = 0; i < source.length - 1; i += 1) {
    if (source[i] === "\\" && isAsciiLetter(source[i + 1])) return true;
  }
  return false;
}

function countLongWordsOutsideCommands(text) {
  const source = String(text || "");
  let count = 0;
  let i = 0;

  while (i < source.length) {
    if (source[i] === "\\") {
      i += 1;
      while (i < source.length && isAsciiLetter(source[i])) i += 1;
      continue;
    }

    if (!isAsciiLetter(source[i])) {
      i += 1;
      continue;
    }

    let j = i;
    while (j < source.length && isAsciiLetter(source[j])) j += 1;
    if (j - i >= 3) count += 1;
    i = j;
  }

  return count;
}

function hasEquationSignal(text) {
  const source = String(text || "");
  const markers = ["=", "^", "_", "\\int", "\\sum", "\\prod", "\\frac", "\\sqrt", "\\times", "\\cdot", "\\rightarrow"];
  return markers.some((marker) => source.includes(marker));
}

function wrapLikelyMathLines(text) {
  const lines = String(text || "").split("\n");
  let inFence = false;
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence || !trimmed) {
      out.push(line);
      continue;
    }

    if (trimmed.includes("$$") || trimmed.includes("\\(") || trimmed.includes("\\[") || trimmed.includes("$") ) {
      out.push(line);
      continue;
    }

    if (!containsLatexCommand(trimmed) || !hasEquationSignal(trimmed)) {
      out.push(line);
      continue;
    }

    if (countLongWordsOutsideCommands(trimmed) > 4) {
      out.push(line);
      continue;
    }

    const leading = line.slice(0, line.length - line.trimStart().length);
    out.push(`${leading}$$${trimmed}$$`);
  }

  return out.join("\n");
}

function preprocessMathText(text) {
  const collapsed = collapseEscapedLatex(text);
  const repaired = repairMalformedMathDelimiters(collapsed);
  return wrapLikelyMathLines(repaired);
}

function findClosing(text, fromIndex, openToken, closeToken, stopAtNewline = false) {
  let i = fromIndex;
  while (i < text.length) {
    if (stopAtNewline && text[i] === "\n") return -1;

    if (startsWithAt(text, i, closeToken)) {
      if (closeToken === "$" && text[i - 1] === "\\") {
        i += 1;
        continue;
      }
      return i;
    }

    i += 1;
  }
  return -1;
}

function canOpenInlineDollar(text, index) {
  const next = text[index + 1] || "";
  if (!next || isWhitespace(next) || next === "$") return false;
  return true;
}

function tokenizeMathSegments(text) {
  // Tokenizer-style math extraction inspired by markdown-it/MathJax parsing flow.
  const source = String(text || "");
  const placeholders = [];

  const stash = (mode, raw) => {
    const idx = placeholders.length;
    const token = `MLXCHATMATH${idx}TOKEN`;
    placeholders.push({ token, mode, raw });
    return token;
  };

  let out = "";
  let i = 0;
  let inFence = false;
  let inInlineCode = false;
  let lineStart = true;

  while (i < source.length) {
    if (lineStart && startsWithAt(source, i, "```")) {
      inFence = !inFence;
      out += "```";
      i += 3;
      lineStart = false;
      continue;
    }

    const ch = source[i];
    if (!inFence && ch === "`") {
      inInlineCode = !inInlineCode;
      out += ch;
      i += 1;
      lineStart = false;
      continue;
    }

    if (!inFence && !inInlineCode) {
      if (startsWithAt(source, i, "$$")) {
        const close = findClosing(source, i + 2, "$$", "$$", false);
        if (close !== -1) {
          out += stash("display", source.slice(i, close + 2));
          i = close + 2;
          lineStart = false;
          continue;
        }
      }

      if (startsWithAt(source, i, "\\[")) {
        const close = findClosing(source, i + 2, "\\[", "\\]", false);
        if (close !== -1) {
          out += stash("display", source.slice(i, close + 2));
          i = close + 2;
          lineStart = false;
          continue;
        }
      }

      if (startsWithAt(source, i, "\\(")) {
        const close = findClosing(source, i + 2, "\\(", "\\)", true);
        if (close !== -1) {
          out += stash("inline", source.slice(i, close + 2));
          i = close + 2;
          lineStart = false;
          continue;
        }
      }

      if (ch === "$" && canOpenInlineDollar(source, i)) {
        const close = findClosing(source, i + 1, "$", "$", true);
        if (close !== -1) {
          const body = source.slice(i + 1, close);
          if (body.trim()) {
            out += stash("inline", source.slice(i, close + 1));
            i = close + 1;
            lineStart = false;
            continue;
          }
        }
      }
    }

    out += ch;
    i += 1;
    lineStart = ch === "\n";
  }

  return { text: out, placeholders };
}

function restoreMathSegments(html, placeholders) {
  let out = String(html || "");
  for (const { token, mode, raw } of placeholders) {
    const wrapper = mode === "display"
      ? `<div class="math-display">${escapeHtml(raw)}</div>`
      : `<span class="math-inline">${escapeHtml(raw)}</span>`;
    out = out.replaceAll(token, wrapper);
  }
  return out;
}

function renderRichText(text) {
  const normalized = preprocessMathText(text);
  const { text: withPlaceholders, placeholders } = tokenizeMathSegments(normalized);
  const html = renderMarkdown(withPlaceholders);
  return restoreMathSegments(html, placeholders);
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

async function copyTextToClipboard(text, successMessage = "Copied") {
  const value = String(text || "");
  if (!value) {
    toast("Nothing to copy", "info", 1200);
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    toast(successMessage, "success", 1100);
  } catch (_) {
    toast("Copy failed", "error", 1500);
  }
}

function attachPromptCopyButton(contentEl, promptText) {
  if (!contentEl || contentEl.querySelector(".prompt-copy-btn")) return;

  const btn = document.createElement("button");
  btn.className = "message-copy-btn prompt-copy-btn";
  btn.type = "button";
  btn.textContent = "Copy";
  btn.title = "Copy prompt";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await copyTextToClipboard(promptText, "Prompt copied");
  });
  contentEl.appendChild(btn);
}

function injectCodeCopyButtons(container) {
  if (!container) return;

  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".code-copy-btn")) return;

    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.type = "button";
    btn.textContent = "Copy";
    btn.title = "Copy code";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const code = pre.querySelector("code");
      const codeText = code ? code.textContent : pre.textContent;
      await copyTextToClipboard(codeText || "", "Code copied");
    });

    pre.appendChild(btn);
  });
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl   = () => document.getElementById("messages");
const inputEl      = () => document.getElementById("user-input");
const sendBtnEl    = () => document.getElementById("btn-send");
const modelSelect  = () => document.getElementById("model-select");
const loadModelBtn = () => document.getElementById("btn-load-model");
const unloadModelBtn = () => document.getElementById("btn-unload-model");
const modelStatus  = () => document.getElementById("model-status");
const welcomeEl    = () => document.getElementById("welcome");
const attachImageBtn = () => document.getElementById("btn-attach-image");
const imageInputEl = () => document.getElementById("image-upload");
const imagePreviewRowEl = () => document.getElementById("image-preview-row");
const imagePreviewCardEl = () => document.getElementById("image-preview-card");

// ── Per-conversation message history ──────────────────────────────────────────
let messages = [];
let isStreaming = false;
let isPreparingSend = false;
let currentStreamController = null;
let currentRequestId = null;
let pendingImageDataUrl = null;
let autoScrollDuringStream = true;
let currentStopReason = null;
const deletedConversationIds = new Set();

const DEFAULT_GEN_SETTINGS = {
  system_prompt: "",
  enforce_thinking_tags: false,
  temperature: 0.7,
  top_p: 0.9,
  max_tokens: 2048,
  repetition_penalty: 1.1,
  repetition_context_size: 20,
  use_turboquant: false,
  kv_bits: 4,
};

const SEND_ICON = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
  </svg>`;

const STOP_ICON = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect>
  </svg>`;

// ── Input state ───────────────────────────────────────────────────────────────
// Textarea is always enabled for a responsive feel.
// Sending without a loaded model shows a toast instead of silently doing nothing.
function updateSendBtn() {
  const btn = sendBtnEl();
  if (!btn) return;

  btn.disabled = isPreparingSend && !isStreaming;
  btn.innerHTML = isStreaming ? STOP_ICON : SEND_ICON;
  btn.title = isStreaming ? "Stop generation" : (isPreparingSend ? "Sending..." : "Send");

  updateModelActionButtons();
}

function updateModelActionButtons() {
  const loadBtn = loadModelBtn();
  const unloadBtn = unloadModelBtn();
  if (loadBtn) {
    loadBtn.disabled = isStreaming || isPreparingSend || !modelSelect().value;
  }
  if (unloadBtn) {
    unloadBtn.disabled = isStreaming || isPreparingSend || !state.modelLoaded;
  }
}

async function refreshVisionAvailability(modelId = state.currentModelId) {
  const attachBtn = attachImageBtn();
  if (!attachBtn) return;

  state.modelVisionCapable = false;
  attachBtn.disabled = true;
  attachBtn.title = "Image upload is available for loaded vision models";

  if (!modelId || !state.modelLoaded) return;

  try {
    const caps = await api(`/api/models/capabilities/${encodeURIComponent(modelId)}`);
    state.modelVisionCapable = !!caps.vision;
    attachBtn.disabled = !state.modelVisionCapable;
    attachBtn.title = state.modelVisionCapable
      ? "Attach image"
      : "This model does not advertise vision support";
    if (!state.modelVisionCapable) clearPendingImage();
  } catch (_) {}
}

function clearPendingImage() {
  pendingImageDataUrl = null;
  const row = imagePreviewRowEl();
  const card = imagePreviewCardEl();
  const input = imageInputEl();
  if (card) card.innerHTML = "";
  if (row) row.classList.add("hidden");
  if (input) input.value = "";
}

function renderPendingImage(dataUrl) {
  const row = imagePreviewRowEl();
  const card = imagePreviewCardEl();
  if (!row || !card || !dataUrl) return;

  card.innerHTML = `
    <img src="${dataUrl}" alt="upload preview" class="preview-thumb" />
    <button class="preview-remove" id="btn-remove-image" title="Remove image">×</button>
  `;
  row.classList.remove("hidden");
  document.getElementById("btn-remove-image")?.addEventListener("click", clearPendingImage);
}

async function compressImageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 1280;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Could not process image"));
        ctx.drawImage(img, 0, 0, w, h);

        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };
      img.onerror = () => reject(new Error("Invalid image file"));
      img.src = String(fr.result || "");
    };
    fr.onerror = () => reject(new Error("Failed to read image file"));
    fr.readAsDataURL(file);
  });
}

async function stopCurrentGeneration(reason = "manual") {
  if (!isStreaming) return;

  currentStopReason = reason;

  try {
    if (currentRequestId) {
      await api("/api/chat/stop", {
        method: "POST",
        body: JSON.stringify({ request_id: currentRequestId }),
      });
    }
  } catch (_) {
    // Best effort. We still abort client-side below.
  }

  currentStreamController?.abort();
}

function isNearBottom(threshold = 64) {
  const el = messagesEl();
  if (!el) return true;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= threshold;
}

function scrollToBottom() {
  const el = messagesEl();
  el.scrollTop = el.scrollHeight;
}

function maybeScrollToBottom(force = false) {
  if (force || autoScrollDuringStream || isNearBottom()) {
    scrollToBottom();
  }
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
    }
    updateModelActionButtons();
  } catch (e) {
    console.error("Failed to load models:", e);
  }
}

// Restore currently loaded model state from backend (non-blocking)
async function syncLoadedState() {
  try {
    const status = await api("/api/model/loaded");
    state.loadedModelId = status.model_id || null;
    if (status.model_id && status.state === "ready") {
      state.currentModelId = status.model_id;
      state.modelLoaded = true;
      modelSelect().value = status.model_id;
      updateModelStatus("ready", "Model ready");
      await refreshVisionAvailability(status.model_id);
      updateModelActionButtons();
      return;
    }

    state.modelLoaded = false;
    updateModelStatus("", "Model not loaded");
  } catch (_) {}
}

function updateModelStatus(stateStr, message) {
  const el = modelStatus();
  el.textContent = message || "";
  el.className = "model-status " + (stateStr || "");
}

function findNextTag(lowerText, fromIndex, candidates) {
  let bestIndex = -1;
  let bestTag = null;
  for (const tag of candidates) {
    const idx = lowerText.indexOf(tag, fromIndex);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
      bestTag = tag;
    }
  }
  return { index: bestIndex, tag: bestTag };
}

function stripControlTokens(text) {
  return String(text || "")
    .replace(/<\|[^|>]+\|>/g, "")
    .replace(/<\/?think(?:ing)?>/gi, "")
    .trim();
}

function unwrapJsonCodeFence(text) {
  const source = String(text || "").trim();
  const m = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : source;
}

function splitByStructuredReasoningObjects(rawText) {
  const source = String(rawText || "");
  const trimmed = source.trim();
  if (!trimmed) return null;

  // Fast bail-outs for streaming hot path.
  const startsLikeJson = trimmed[0] === "{" || trimmed[0] === "[" || trimmed.startsWith("```");
  if (!startsLikeJson) return null;

  const lower = trimmed.toLowerCase();
  const hasReasoningKeyHint =
    lower.includes('"reasoning"') ||
    lower.includes('"reasoning_content"') ||
    lower.includes('"type":"reasoning"') ||
    lower.includes('"type": "reasoning"') ||
    lower.includes('"output"');
  if (!hasReasoningKeyHint) return null;

  let parsed;
  try {
    parsed = JSON.parse(unwrapJsonCodeFence(trimmed));
  } catch (_) {
    return null;
  }

  const out = {
    reasoningText: "",
    finalText: "",
    sawReasoningTag: false,
    inThinking: false,
    usedStructuredChannels: true,
  };

  // LM Studio REST shape: { output: [{ type: "reasoning"|"message", content: "..." }, ...] }
  if (parsed && Array.isArray(parsed.output)) {
    for (const item of parsed.output) {
      const t = String(item?.type || "").toLowerCase();
      const c = stripControlTokens(String(item?.content || ""));
      if (!c) continue;
      if (t === "reasoning") {
        out.reasoningText += (out.reasoningText ? "\n\n" : "") + c;
      } else if (t === "message") {
        out.finalText += (out.finalText ? "\n\n" : "") + c;
      }
    }

    if (out.reasoningText || out.finalText) {
      out.sawReasoningTag = Boolean(out.reasoningText);
      return out;
    }
  }

  // OpenAI-compatible shapes seen in LM Studio changelog/docs.
  const firstChoice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const message = firstChoice?.message || null;
  const delta = firstChoice?.delta || null;

  const reasoning =
    message?.reasoning ??
    message?.reasoning_content ??
    delta?.reasoning ??
    delta?.reasoning_content ??
    parsed?.reasoning ??
    parsed?.reasoning_content;
  const finalMessage =
    message?.content ??
    delta?.content ??
    parsed?.message ??
    parsed?.content;

  if (reasoning != null || finalMessage != null) {
    out.reasoningText = stripControlTokens(String(reasoning || ""));
    out.finalText = stripControlTokens(String(finalMessage || ""));
    out.sawReasoningTag = Boolean(out.reasoningText);
    return out;
  }

  return null;
}

function splitByStructuredChannelTags(rawText) {
  const source = String(rawText || "");
  const markerRegex = /<\|channel\|>\s*(analysis|final)\s*<\|message\|>/ig;
  const markers = [];
  let m;

  while ((m = markerRegex.exec(source)) !== null) {
    markers.push({
      channel: m[1].toLowerCase(),
      contentStart: markerRegex.lastIndex,
      markerStart: m.index,
    });
  }

  if (!markers.length) return null;

  let reasoningText = "";
  let finalText = "";

  for (let i = 0; i < markers.length; i += 1) {
    const curr = markers[i];
    const next = markers[i + 1];
    const rawSegment = source.slice(curr.contentStart, next ? next.markerStart : source.length);
    const cleaned = stripControlTokens(rawSegment.replace(/<\|end\|>/g, "\n"));
    if (!cleaned) continue;

    if (curr.channel === "analysis") {
      reasoningText += (reasoningText ? "\n\n" : "") + cleaned;
    } else if (curr.channel === "final") {
      finalText += (finalText ? "\n\n" : "") + cleaned;
    }
  }

  return {
    reasoningText,
    finalText,
    sawReasoningTag: Boolean(reasoningText),
    inThinking: false,
    usedStructuredChannels: true,
  };
}

function isLikelyStructuredControlStream(text) {
  const source = String(text || "");
  if (!source) return false;
  const lower = source.toLowerCase();

  // Known gpt-oss style control tokens and partial starts during streaming.
  if (lower.includes("<|channel|>") || lower.includes("<|message|>")) return true;
  if (lower.includes("<|start|>assistant") || lower.includes("<|start|>")) return true;

  const trimmed = source.trimStart();
  if (trimmed.startsWith("<|")) return true;

  // Detect likely partial token prefixes while chunks are still arriving.
  return /<\|[^\n]{0,48}$/.test(source);
}

const HIGH_CONF_REASONING_START_PATTERNS = [
  /^\s*(?:#+\s*)?(?:here(?:'|’)s|this is|below is)\s+(?:my\s+)?(?:full\s+|detailed\s+|brief\s+)?(?:thinking|reasoning)\s+process\s*:?/i,
  /^\s*(?:#+\s*)?(?:thinking|reasoning)\s*process\s*:?/i,
  /^\s*(?:#+\s*)?chain\s+of\s+thought\s*:?/i,
  /^\s*(?:internal\s+)?(?:thoughts?|thinking|reasoning)\s*:?/i,
];

const HIGH_CONF_REASONING_LEAD_PATTERNS = [
  /\b(?:thinking|reasoning)\s*process\s*:/i,
  /\bchain\s+of\s+thought\s*:/i,
  /\b(?:analyze|analyse)\s+the\s+request\b/i,
  /\bidentify\s+key\s+concepts\b/i,
  /\bdeconstruct\s+the\s+request\b/i,
];

const STARTS_LIKE_REASONING_PATTERNS = [
  /^(here(?:'|’)s|this is|below is).{0,120}(thinking process|reasoning process|chain of thought|reasoning steps)/i,
  /^(let me think|let(?:'|’)s think|reasoning:|thinking:)/i,
  /^(#+\s*)?(thinking process|reasoning process|chain of thought)/i,
];

const PLANNING_SIGNAL_PATTERNS = [
  /analyze\s+the\s+request/i,
  /identify\s+key\s+concepts/i,
  /deconstruct the request/i,
  /structure the explanation/i,
  /drafting the content/i,
  /key components/i,
  /workflow/i,
  /pros & cons/i,
  /how .* works/i,
  /initial definition/i,
  /step\s*1\s*:/i,
];

const META_REASONING_START_PATTERNS = [
  /^\s*the\s+user\s+is\s+asking\s+about\b/i,
  /^\s*i(?:'|’)ll\s+(?:provide|give|explain)\b/i,
  /^\s*let\s+me\s+(?:provide|structure|break\s+this\s+down|walk\s+through)\b/i,
  /^\s*here(?:'|’)s\s+(?:how\s+i(?:'|’)ll|the\s+plan)\b/i,
];

const META_REASONING_TRANSITION_REGEX = /(?:^|\n)\s*(?:singular\s+value\s+decomposition\s*\(svd\)\s+is\b|in\s+summary\b|to\s+summarize\b|the\s+key\s+idea\s+is\b|now\s+let(?:'|’)s\s+(?:answer|explain)\b)/i;

const REASONING_TRANSITION_REGEX = /(?:^|\n)\s*(?:\*{0,2}\(?\s*end\s+of\s+(?:thought\s+process|thinking|reasoning)\s*\)?\*{0,2}|<\/think(?:ing)?>|ok[,!\s]+ready\s+to\s+generate\b|ready\s+to\s+generate\b|final answer\s*:|answer\s*:|now\s*(?:here(?:'|’)s|is)\s*(?:the\s*)?(?:answer|explanation)\s*:|here(?:'|’)s\s+(?:the\s*)?(?:actual\s*)?(?:answer|response)\s*:|in short\s*:|in summary\s*:)/i;

const REASONING_PREFIX_STRIP_REGEX = /^\s*(?:\*{0,2}\(?\s*end\s+of\s+(?:thought\s+process|thinking|reasoning)\s*\)?\*{0,2}|<\/think(?:ing)?>)+\s*/i;

function splitByReasoningHeuristics(text) {
  const source = String(text || "");
  const normalized = source.trimStart();
  if (!normalized) {
    return { reasoningText: "", finalText: "", usedHeuristic: false };
  }

  const preview = normalized.slice(0, 700).toLowerCase();
  const lead = normalized.slice(0, 260);
  const leadLower = lead.toLowerCase();

  // Cheap lexical gate first, then regex checks only when likely relevant.
  const hasReasoningLexeme =
    leadLower.includes("thinking") ||
    leadLower.includes("reasoning") ||
    leadLower.includes("chain of thought") ||
    leadLower.includes("analyze the request") ||
    leadLower.includes("analyse the request") ||
    leadLower.includes("identify key concepts") ||
    leadLower.includes("deconstruct the request");

  const hasHighConfidenceReasoningStart =
    hasReasoningLexeme && (
      HIGH_CONF_REASONING_START_PATTERNS.some((p) => p.test(normalized))
      || HIGH_CONF_REASONING_LEAD_PATTERNS.some((p) => p.test(lead))
    );

  // Common model phrasing when it dumps internal planning without explicit tags.
  const startsLikeReasoning = hasReasoningLexeme
    && STARTS_LIKE_REASONING_PATTERNS.some((p) => p.test(normalized));

  const planningSignals = PLANNING_SIGNAL_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(preview) ? 1 : 0),
    0,
  );

  const hasMetaReasoningStart = META_REASONING_START_PATTERNS.some((p) => p.test(normalized));
  const leadLines = normalized
    .split(/\r?\n/)
    .slice(0, 16)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasEarlyOutline = leadLines.filter((line) => /^\d+[.)]\s+/.test(line)).length >= 2;
  const metaPlanningLikely = hasMetaReasoningStart && (hasEarlyOutline || planningSignals >= 1);

  if (!startsLikeReasoning && !hasHighConfidenceReasoningStart && planningSignals < 2 && !metaPlanningLikely) {
    return { reasoningText: "", finalText: source, usedHeuristic: false };
  }

  // Split where models typically transition from planning to user-facing answer.
  // Includes explicit end-markers emitted by many reasoning-style prompts.
  const transition = REASONING_TRANSITION_REGEX.exec(source) || META_REASONING_TRANSITION_REGEX.exec(source);

  if (!transition || transition.index < 20) {
    // Strong/meta starts should still be treated as reasoning even without
    // explicit boundary tags.
    if (hasHighConfidenceReasoningStart || metaPlanningLikely) {
      return {
        reasoningText: stripControlTokens(source),
        finalText: "",
        usedHeuristic: true,
      };
    }

    // Also treat likely planning dumps as reasoning-only when they begin with
    // a thinking-style lead and include enough planning cues.
    if (startsLikeReasoning && (planningSignals >= 1 || hasEarlyOutline)) {
      return {
        reasoningText: stripControlTokens(source),
        finalText: "",
        usedHeuristic: true,
      };
    }

    // Otherwise stay strict to avoid false positives.
    return { reasoningText: "", finalText: source, usedHeuristic: false };
  }

  const reasoningText = stripControlTokens(source.slice(0, transition.index));
  const finalText = source
    .slice(transition.index)
    .replace(REASONING_PREFIX_STRIP_REGEX, "")
    .trim();
  const cleanedFinal = stripControlTokens(finalText);

  if (!reasoningText || !cleanedFinal) {
    return { reasoningText: "", finalText: source, usedHeuristic: false };
  }

  return { reasoningText, finalText: cleanedFinal, usedHeuristic: true };
}

function splitReasoningAndFinal(rawText, options = {}) {
  const text = String(rawText || "");
  const streaming = Boolean(options.streaming);

  const structuredObject = splitByStructuredReasoningObjects(text);
  if (structuredObject) {
    return structuredObject;
  }

  const structured = splitByStructuredChannelTags(text);
  if (structured) {
    return structured;
  }

  if (streaming && isLikelyStructuredControlStream(text)) {
    return {
      reasoningText: "",
      finalText: "",
      sawReasoningTag: false,
      inThinking: true,
      pendingStructuredControl: true,
    };
  }

  const lower = text.toLowerCase();
  const openTags = ["<thinking>", "<think>"];
  const closeTags = ["</thinking>", "</think>"];

  let i = 0;
  let inThinking = false;
  let sawReasoningTag = false;
  let reasoningText = "";
  let finalText = "";

  while (i < text.length) {
    if (!inThinking) {
      const nextOpen = findNextTag(lower, i, openTags);
      if (nextOpen.index === -1) {
        finalText += text.slice(i);
        break;
      }

      finalText += text.slice(i, nextOpen.index);
      i = nextOpen.index + nextOpen.tag.length;
      inThinking = true;
      sawReasoningTag = true;
      continue;
    }

    const nextClose = findNextTag(lower, i, closeTags);
    if (nextClose.index === -1) {
      reasoningText += text.slice(i);
      i = text.length;
      break;
    }

    reasoningText += text.slice(i, nextClose.index);
    i = nextClose.index + nextClose.tag.length;
    inThinking = false;
  }

  reasoningText = stripControlTokens(reasoningText);
  finalText = stripControlTokens(finalText);

  if (!sawReasoningTag && !inThinking && !reasoningText.trim()) {
    const heuristic = splitByReasoningHeuristics(text);
    if (heuristic.usedHeuristic) {
      return {
        reasoningText: heuristic.reasoningText,
        finalText: heuristic.finalText,
        sawReasoningTag: false,
        inThinking: false,
      };
    }
  }

  return {
    reasoningText,
    finalText,
    sawReasoningTag,
    inThinking,
  };
}

function createAssistantRenderNodes(contentEl) {
  const reasoningBlock = document.createElement("details");
  reasoningBlock.className = "reasoning-block hidden";

  const reasoningSummary = document.createElement("summary");
  reasoningSummary.textContent = "Reasoning";

  const reasoningContent = document.createElement("div");
  reasoningContent.className = "reasoning-content";

  reasoningBlock.appendChild(reasoningSummary);
  reasoningBlock.appendChild(reasoningContent);

  const finalContent = document.createElement("div");
  finalContent.className = "final-content";

  contentEl.appendChild(reasoningBlock);
  contentEl.appendChild(finalContent);

  return {
    root: contentEl,
    reasoningBlock,
    reasoningSummary,
    reasoningContent,
    finalContent,
  };
}

function renderAssistantFromRaw(nodes, rawText, streaming = false) {
  const parsed = splitReasoningAndFinal(rawText, { streaming });
  const hasReasoning =
    parsed.sawReasoningTag ||
    parsed.inThinking ||
    Boolean(parsed.reasoningText.trim());

  if (hasReasoning) {
    nodes.reasoningBlock.classList.remove("hidden");
    nodes.reasoningSummary.textContent = parsed.inThinking && streaming
      ? (parsed.pendingStructuredControl ? "Reasoning (parsing...)" : "Reasoning (streaming...)")
      : "Reasoning";
    nodes.reasoningContent.innerHTML = renderRichText(parsed.reasoningText || "");

    // Keep it open while reasoning is still streaming so users can inspect it live.
    if (parsed.inThinking && streaming) {
      nodes.reasoningBlock.open = true;
    }
  } else {
    nodes.reasoningBlock.classList.add("hidden");
    nodes.reasoningContent.innerHTML = "";
    nodes.reasoningSummary.textContent = "Reasoning";
  }

  nodes.finalContent.innerHTML = renderRichText(parsed.finalText || "");
  injectCodeCopyButtons(nodes.root);
  renderMath(nodes.root);
}

// ── Message rendering ─────────────────────────────────────────────────────────
function addMessage(role, content, streaming = false, imageDataUrl = null) {
  welcomeEl()?.remove();

  const el = document.createElement("div");
  el.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "U" : "AI";

  const contentEl = document.createElement("div");
  contentEl.className = "message-content";

  let assistantNodes = null;

  if (streaming) {
    contentEl.classList.add("streaming-cursor");
    assistantNodes = createAssistantRenderNodes(contentEl);
    renderAssistantFromRaw(assistantNodes, "", true);
  } else {
    if (imageDataUrl) {
      const img = document.createElement("img");
      img.src = imageDataUrl;
      img.alt = "uploaded image";
      img.className = "chat-inline-image";
      contentEl.appendChild(img);
    }

    if (role === "assistant") {
      assistantNodes = createAssistantRenderNodes(contentEl);
      renderAssistantFromRaw(assistantNodes, content || "", false);
    } else {
      contentEl.innerHTML += renderRichText(content || "");
      attachPromptCopyButton(contentEl, content || "");
      renderMath(contentEl);
    }
  }

  el.appendChild(avatar);
  el.appendChild(contentEl);
  messagesEl().appendChild(el);
  maybeScrollToBottom(true);
  return { contentEl, messageEl: el, assistantNodes };
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
  if (isStreaming) {
    await stopCurrentGeneration("manual");
    return;
  }
  if (isPreparingSend) return;

  if (!text && !pendingImageDataUrl) return;

  const selectedModelId = state.currentModelId || modelSelect().value || null;
  if (!selectedModelId) {
    toast("Select a model first.", "error", 3000);
    return;
  }

  isPreparingSend = true;
  updateSendBtn();

  const requiresLoad = !state.modelLoaded || state.loadedModelId !== selectedModelId;
  if (requiresLoad) {
    updateModelStatus("loading", "Loading model…");
    try {
      await api("/api/model/load", {
        method: "POST",
        body: JSON.stringify({ model_id: selectedModelId }),
      });
      state.currentModelId = selectedModelId;
      state.loadedModelId = selectedModelId;
      state.modelLoaded = true;
      await syncSettingsForModel(selectedModelId);
      await refreshVisionAvailability(selectedModelId);
      updateModelStatus("ready", "Model ready");
      updateModelActionButtons();
      updateSendBtn();
    } catch (e) {
      state.modelLoaded = false;
      state.loadedModelId = null;
      state.modelVisionCapable = false;
      updateModelStatus("error", "Failed to load");
      toast(e.message || "Failed to load selected model", "error");
      return;
    }
  }

  if (pendingImageDataUrl && !state.modelVisionCapable) {
    toast("Selected model does not support image inputs.", "error", 3500);
    return;
  }

  input.value = "";
  input.style.height = "auto";

  const userMsg = { role: "user", content: text };
  if (pendingImageDataUrl) userMsg.image_data_url = pendingImageDataUrl;

  const nextMessages = [...messages, userMsg];
  if (!state.currentConvId) {
    try {
      const draft = await api("/api/conversations/draft", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: null,
          model_id: state.currentModelId,
          messages: nextMessages,
        }),
      });
      state.currentConvId = draft.conversation_id;
      await loadConversationList();
    } catch (_) {
      // Non-fatal: streaming can still proceed and final save will persist it.
    }
  }

  addMessage("user", text, false, pendingImageDataUrl);
  messages = nextMessages;
  clearPendingImage();

  isStreaming = true;
  autoScrollDuringStream = true;
  updateSendBtn();

  const {
    contentEl: assistantContentEl,
    messageEl: assistantMessageEl,
    assistantNodes,
  } = addMessage("assistant", "", true);
  let assistantText = "";
  let pendingStats = null;
  const t0 = performance.now();
  currentRequestId = crypto.randomUUID();
  currentStreamController = new AbortController();
  currentStopReason = null;
  const streamConversationId = state.currentConvId;
  const streamModelId = state.currentModelId;
  const streamBaseMessages = [...messages];

  try {
    const settings = collectSettings();
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: state.currentConvId,
        request_id: currentRequestId,
        model_id: state.currentModelId,
        messages: [...messages],
        settings,
      }),
      signal: currentStreamController.signal,
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.detail || `Server error: ${res.status}`);
    }

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
            if (assistantNodes) {
              renderAssistantFromRaw(assistantNodes, assistantText, true);
            }
            maybeScrollToBottom();
          } else if (event.type === "stats") {
            pendingStats = event;
          } else if (event.type === "done") {
            state.currentConvId = event.conversation_id;
            await loadConversationList();
          } else if (event.type === "stopped") {
            if (currentStopReason === "manual") {
              toast("Generation stopped", "info", 1200);
            }
          } else if (event.type === "error") {
            toast(event.message, "error");
          }
        } catch (_) {}
      }
    }

    // Final clean render
    assistantContentEl.classList.remove("streaming-cursor");
    if (assistantNodes) {
      renderAssistantFromRaw(assistantNodes, assistantText, false);
    }
    maybeScrollToBottom();

    const elapsed = (performance.now() - t0) / 1000;
    renderStats(assistantContentEl, pendingStats, elapsed);

    if (assistantText.trim()) {
      messages.push({ role: "assistant", content: assistantText });
    } else {
      assistantMessageEl.remove();
    }

  } catch (err) {
    if (err.name === "AbortError") {
      assistantContentEl.classList.remove("streaming-cursor");
      const conversationDeleted = Boolean(
        streamConversationId && deletedConversationIds.has(streamConversationId),
      );

      if (conversationDeleted || currentStopReason === "delete-conversation") {
        assistantMessageEl.remove();
        return;
      }

      const partialText = assistantText.trim();
      if (!partialText) {
        assistantMessageEl.remove();
        return;
      }

      if (assistantNodes) {
        renderAssistantFromRaw(assistantNodes, assistantText, false);
      }
      const elapsed = (performance.now() - t0) / 1000;
      renderStats(assistantContentEl, pendingStats, elapsed);

      // Preserve the partial response in-memory when still on this conversation.
      const partialAssistant = { role: "assistant", content: assistantText };
      if (state.currentConvId === streamConversationId) {
        messages.push(partialAssistant);
      }

      // Persist partial text so switching chats does not lose streamed reasoning/content.
      try {
        const draft = await api("/api/conversations/draft", {
          method: "POST",
          body: JSON.stringify({
            conversation_id: streamConversationId,
            model_id: streamModelId,
            messages: [...streamBaseMessages, partialAssistant],
          }),
        });
        if (state.currentConvId === streamConversationId && draft?.conversation_id) {
          state.currentConvId = draft.conversation_id;
        }
        await loadConversationList();
      } catch (_) {}

      return;
    }

    assistantContentEl.classList.remove("streaming-cursor");
    assistantContentEl.innerHTML =
      `<span style="color:var(--danger)">Error: ${err.message}</span>`;
    toast(err.message, "error");
  } finally {
    isPreparingSend = false;
    isStreaming = false;
    currentRequestId = null;
    currentStreamController = null;
    currentStopReason = null;
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
        const deletingActiveConversation = state.currentConvId === conv.id;
        deletedConversationIds.add(conv.id);

        if (deletingActiveConversation && isStreaming) {
          await stopCurrentGeneration("delete-conversation");
        }

        await api(`/api/conversations/${conv.id}`, { method: "DELETE" });
        if (deletingActiveConversation) {
          startNewConversation({ skipStop: true });
        }
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
    if (isStreaming) {
      await stopCurrentGeneration("switch-conversation");
    }

    const conv = await api(`/api/conversations/${convId}`);
    state.currentConvId = convId;
    messages = conv.messages || [];

    const container = messagesEl();
    container.innerHTML = "";
    messages.forEach(m => {
      if (m.role !== "system") addMessage(m.role, m.content, false, m.image_data_url || null);
    });

    document.querySelectorAll(".conv-item").forEach(el =>
      el.classList.toggle("active", el.dataset.id === convId));

    switchView("chat");

    if (conv.model) {
      const select = modelSelect();
      if ([...select.options].some(o => o.value === conv.model)) select.value = conv.model;
      state.currentModelId = conv.model;
      await syncSettingsForModel(conv.model);
      await refreshVisionAvailability(conv.model);
    }
  } catch (e) {
    toast("Failed to load conversation", "error");
  }
}

export function startNewConversation(options = {}) {
  const skipStop = Boolean(options.skipStop);
  if (isStreaming && !skipStop) stopCurrentGeneration("new-conversation");
  state.currentConvId = null;
  messages = [];
  clearPendingImage();
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
  const toNum = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const toInt = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    system_prompt:          document.getElementById("set-system-prompt").value,
    enforce_thinking_tags:  document.getElementById("set-enforce-thinking-tags").checked,
    temperature:            toNum(document.getElementById("set-temperature").value, DEFAULT_GEN_SETTINGS.temperature),
    top_p:                  toNum(document.getElementById("set-top-p").value, DEFAULT_GEN_SETTINGS.top_p),
    max_tokens:             toInt(document.getElementById("set-max-tokens").value, DEFAULT_GEN_SETTINGS.max_tokens),
    repetition_penalty:     toNum(document.getElementById("set-rep-penalty").value, DEFAULT_GEN_SETTINGS.repetition_penalty),
    repetition_context_size:toInt(document.getElementById("set-rep-context").value, DEFAULT_GEN_SETTINGS.repetition_context_size),
    use_turboquant:         document.getElementById("set-turboquant").checked,
    kv_bits:                toNum(document.getElementById("set-kv-bits").value, DEFAULT_GEN_SETTINGS.kv_bits),
  };
}

function applySettings(s) {
  const merged = { ...DEFAULT_GEN_SETTINGS, ...(s || {}) };
  document.getElementById("set-system-prompt").value   = merged.system_prompt || "";
  document.getElementById("set-enforce-thinking-tags").checked = !!merged.enforce_thinking_tags;
  document.getElementById("set-temperature").value     = merged.temperature;
  document.getElementById("set-top-p").value           = merged.top_p;
  document.getElementById("set-max-tokens").value      = merged.max_tokens;
  document.getElementById("set-rep-penalty").value     = merged.repetition_penalty;
  document.getElementById("set-rep-context").value     = merged.repetition_context_size;
  document.getElementById("set-turboquant").checked    = !!merged.use_turboquant;
  document.getElementById("set-kv-bits").value         = merged.kv_bits || 4;
  document.getElementById("val-temperature").textContent = merged.temperature;
  document.getElementById("val-top-p").textContent       = merged.top_p;
  document.getElementById("val-rep-penalty").textContent = merged.repetition_penalty;
  document.getElementById("val-kv-bits").textContent     = merged.kv_bits || 4;
  document.getElementById("turboquant-options").classList.toggle("hidden", !merged.use_turboquant);
}

async function syncSettingsForModel(modelId = state.currentModelId) {
  if (!modelId) {
    applySettings(DEFAULT_GEN_SETTINGS);
    return;
  }

  try {
    const s = await api(`/api/settings/${encodeURIComponent(modelId)}`);
    applySettings(s);
  } catch (_) {
    applySettings(DEFAULT_GEN_SETTINGS);
  }
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
    state.loadedModelId = modelId;
    state.modelLoaded = true;
    await syncSettingsForModel(modelId);
    await refreshVisionAvailability(modelId);
    updateModelStatus("ready", "Model ready");
    toast("Model loaded", "success");
  } catch (e) {
    state.modelLoaded = false;
    state.loadedModelId = null;
    state.modelVisionCapable = false;
    updateModelStatus("error", "Failed to load");
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Load";
    updateModelActionButtons();
    updateSendBtn();
  }
}

async function unloadModel() {
  if (isStreaming) {
    toast("Stop generation before ejecting the model.", "error", 2800);
    return;
  }

  const btn = unloadModelBtn();
  if (!btn) return;

  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Ejecting…";

  try {
    await api("/api/model/unload", { method: "POST" });
    state.modelLoaded = false;
    state.loadedModelId = null;
    state.modelVisionCapable = false;
    state.currentModelId = null;
    clearPendingImage();
    updateModelStatus("", "Model unloaded");
    inputEl().placeholder = "Load a model to start chatting…";
    await refreshVisionAvailability(null);
    toast("Model ejected", "success");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    btn.textContent = prevText || "Eject";
    updateModelActionButtons();
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
  const msgPane = messagesEl();
  input.disabled = false;
  input.placeholder = "Load a model to start chatting…";

  msgPane?.addEventListener("scroll", () => {
    if (!isStreaming) return;
    autoScrollDuringStream = isNearBottom();
  });

  msgPane?.addEventListener("click", e => {
    if (!isStreaming) return;
    const t = e.target;
    if (t && t.closest && t.closest(".reasoning-block summary")) {
      autoScrollDuringStream = false;
    }
  });

  sendBtnEl().addEventListener("click", sendMessage);

  attachImageBtn()?.addEventListener("click", () => {
    if (!state.modelLoaded) {
      toast("Load a vision model first", "error", 3000);
      return;
    }
    if (!state.modelVisionCapable) {
      toast("Selected model is not vision-capable", "error", 3000);
      return;
    }
    imageInputEl()?.click();
  });

  imageInputEl()?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      pendingImageDataUrl = await compressImageToDataUrl(file);
      renderPendingImage(pendingImageDataUrl);
    } catch (err) {
      toast(err.message || "Image upload failed", "error");
      clearPendingImage();
    }
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener("input", e => autoResize(e.target));

  modelSelect().addEventListener("change", () => {
    const selectedModelId = modelSelect().value || null;
    state.currentModelId = selectedModelId;

    if (!selectedModelId) {
      updateModelStatus("", "No model selected");
    } else if (state.modelLoaded && state.loadedModelId === selectedModelId) {
      updateModelStatus("ready", "Model ready");
    } else {
      updateModelStatus("", "Selected model not loaded");
    }

    syncSettingsForModel(state.currentModelId);
    refreshVisionAvailability(state.currentModelId);
    updateModelActionButtons();
  });
  loadModelBtn().addEventListener("click", loadModel);
  unloadModelBtn()?.addEventListener("click", unloadModel);

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

  if (state.currentModelId) {
    await syncSettingsForModel(state.currentModelId);
  }

  // Update placeholder based on whether model is ready
  if (state.modelLoaded) {
    inputEl().placeholder = "Message…";
    await refreshVisionAvailability(state.currentModelId);
  }

  updateModelActionButtons();
  updateSendBtn();
}
