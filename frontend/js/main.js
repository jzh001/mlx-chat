/**
 * MLX Chat – main application entry point (ES module).
 * Coordinates view switching, toast notifications, and shared state.
 */

import { initChat, loadConversationList, startNewConversation } from "./chat.js";
import { initModels } from "./models.js";

// ── Global state ──────────────────────────────────────────────────────────────
export const state = {
  currentModelId: null,
  modelLoaded: false,
  currentConvId: null,
};

// ── View routing ──────────────────────────────────────────────────────────────
function switchView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add("active");
}

// ── Toast notifications ───────────────────────────────────────────────────────
export function toast(message, type = "info", duration = 3000) {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    el.style.transition = "opacity 0.3s, transform 0.3s";
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ── API helpers ───────────────────────────────────────────────────────────────
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

// ── Initialise ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Nav buttons
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      switchView(btn.dataset.view);
      if (btn.dataset.view === "models") initModels();
    });
  });

  // New chat button
  document.getElementById("btn-new-chat").addEventListener("click", () => {
    switchView("chat");
    startNewConversation();
  });

  // Init modules
  await initChat();
  await loadConversationList();

  // Poll model load status periodically
  setInterval(async () => {
    try {
      const status = await api("/api/model/loaded");
      state.currentModelId = status.model_id;
      state.modelLoaded = status.state === "ready";
    } catch (_) {}
  }, 5000);
});
