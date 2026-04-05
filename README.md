# MLX Chat

A lightweight, professional chat UI for running `mlx-community` vision-language models on Apple Silicon via [`mlx_vlm`](https://github.com/Blaizzy/mlx-vlm). Generates tokens significantly faster than Ollama or LM Studio on the same hardware, with a longer context window and support for modern compression techniques like TurboQuant.

---

## Features

- **Professional chat UI** – ChatGPT-style dark theme with full Markdown, LaTeX (KaTeX), and syntax-highlighted code rendering
- **Streaming responses** – tokens appear in real-time as the model generates them
- **Model management** – browse, download, and delete `mlx-community` models directly in the app
- **GPU compatibility labels** – each model shows whether it fits fully in RAM, partially, or is too large for your Mac
- **Per-model settings** – temperature, top-p, max tokens, repetition penalty, system prompt, all saved automatically per model
- **TurboQuant** – toggle KV-cache quantisation for reduced memory usage during long conversations
- **Conversation history** – conversations are saved locally and listed in the sidebar
- **Minimal memory footprint** – uses a native `WKWebView` window (PyWebView), not Electron; the backend is a lightweight FastAPI server

---

## Requirements

- macOS with Apple Silicon (M1 / M2 / M3 / M4)
- Python 3.11 or later
- Internet connection (first run, to download models)

---

## Installation

### Option A – Developer (clone & run)

```bash
git clone https://github.com/YOUR_USERNAME/mlx_chat.git
cd mlx_chat
pip install -r requirements.txt
python app.py
```

### Option B – Pre-built .app (non-developer users)

Download the latest `MLX Chat.app.zip` from the [Releases](../../releases) page, unzip, and drag to your `/Applications` folder. Double-click to launch.

> **Gatekeeper note:** On first launch, right-click → Open to bypass the unsigned-app warning.

---

## Usage

1. **Launch** `python app.py` (or double-click the .app).
2. **Go to Models tab** to download a model (e.g. `gemma-4-26b-a4b-it-4bit`). Already-cached HuggingFace models appear automatically.
3. **Return to Chat tab**, select the model from the dropdown, and click **Load**.
4. **Start chatting.** Use the ⚙️ button to adjust generation settings at any time.

### Generation Settings

| Setting | Description |
|---|---|
| System Prompt | Instruction prepended to every conversation |
| Temperature | Randomness (0 = deterministic, 1+ = creative) |
| Top-P | Nucleus sampling threshold |
| Max Tokens | Maximum response length |
| Repetition Penalty | Penalises repeated phrases (1.0 = off) |
| TurboQuant | Compresses KV-cache to 2–8 bits; reduces VRAM for long contexts |
| KV Bits | Bit-width for TurboQuant (3.5 = split-channel, best quality/size trade-off) |

---

## Building a Distributable .app

```bash
pip install pyinstaller
bash build_mac.sh
```

The resulting `dist/MLX Chat.app` can be zipped and shared.

---

## Architecture

```
mlx_chat/
├── app.py                  # Entry: starts FastAPI server + PyWebView window
├── requirements.txt
├── backend/
│   ├── server.py           # FastAPI routes (chat SSE, models, settings, conversations)
│   ├── mlx_handler.py      # mlx_vlm wrapper (load / stream_generate)
│   ├── model_manager.py    # HuggingFace search, download, local listing
│   └── config.py           # Per-model settings & conversation persistence
└── frontend/
    ├── index.html           # Single-page app
    ├── css/style.css
    └── js/
        ├── main.js          # App init, view routing, shared state
        ├── chat.js          # Chat UI, streaming, settings panel
        └── models.js        # Model management UI
```

Data is stored at `~/.mlx_chat/` (conversations + settings JSON files).

---

## Privacy

All inference runs **entirely on your Mac**. No data is sent to any external server. Model files are cached in the standard HuggingFace cache at `~/.cache/huggingface/hub/`.
