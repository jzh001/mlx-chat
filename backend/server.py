import asyncio
import base64
import json
import logging
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import sys
from time import monotonic
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

_thread_pool = ThreadPoolExecutor(max_workers=4)
_stop_events_lock = threading.Lock()
_stop_events: Dict[str, threading.Event] = {}
_deleted_conversations_lock = threading.Lock()
_deleted_conversations: set[str] = set()

from . import config as cfg
from . import mlx_handler as mlx
from . import model_manager as mm
from . import update_manager as um

def _frontend_dir() -> Path:
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass) / "frontend"
    return Path(__file__).parent.parent / "frontend"


FRONTEND_DIR = _frontend_dir()
logger = logging.getLogger("mlx_chat.server")

app = FastAPI(title="MLX Chat")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def _mark_conversation_deleted(conv_id: str) -> None:
    with _deleted_conversations_lock:
        _deleted_conversations.add(conv_id)


def _is_conversation_deleted(conv_id: Optional[str]) -> bool:
    if not conv_id:
        return False
    with _deleted_conversations_lock:
        return conv_id in _deleted_conversations


@app.on_event("shutdown")
def _shutdown_runtime_resources():
    # Ensure executors and stop flags are released on app shutdown.
    global _thread_pool

    # First signal active streams to stop.
    with _stop_events_lock:
        for ev in _stop_events.values():
            ev.set()
        _stop_events.clear()

    # Drop model references immediately and release caches in the background.
    if mlx.get_loaded_model() is not None:
        mlx.unload_model(background_gc=True)

    try:
        _thread_pool.shutdown(wait=False, cancel_futures=True)
    except Exception:
        pass


@app.get("/")
def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")


# ── System ───────────────────────────────────────────────────────────────────

@app.get("/api/system/memory")
def system_memory():
    return mm.get_system_memory()


@app.get("/api/app/version")
def app_version():
    return {
        "version": cfg.get_app_version(),
        "repo": cfg.GITHUB_REPO,
    }


# ── Model management ─────────────────────────────────────────────────────────

@app.get("/api/models/local")
async def local_models():
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_thread_pool, mm.list_local_models)


@app.get("/api/models/search")
async def search_models(q: str = "", sort: str = "downloads", limit: int = 30):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_thread_pool, lambda: mm.search_models(q, sort, limit))


class DownloadRequest(BaseModel):
    model_id: str


@app.post("/api/models/download")
def start_download(req: DownloadRequest):
    mm.start_download(req.model_id)
    return {"status": "started"}


@app.post("/api/models/download/cancel")
def cancel_download(req: DownloadRequest):
    cancelled = mm.cancel_download(req.model_id)
    return {"cancelled": cancelled}


@app.get("/api/models/download/active")
def active_downloads():
    return mm.get_active_downloads()


@app.get("/api/models/download/status")
def download_status(model_id: str):
    try:
        status = mm.get_download_status(model_id)
        if status is None:
            return {"progress": 0.0, "done": True, "error": "Download state was lost. Please retry.", "current_file": ""}
        return status
    except Exception:
        return {"progress": 0.0, "done": True, "error": "Status unavailable.", "current_file": ""}


@app.get("/api/models/size")
async def model_size(model_id: str):
    """Fetch exact model size from HF usedStorage (cached)."""
    loop = asyncio.get_event_loop()
    size = await loop.run_in_executor(_thread_pool, lambda: mm.fetch_model_size(model_id))
    return {"model_id": model_id, "size_gb": size}


@app.get("/api/updates/check")
def check_updates(force: bool = False):
    return um.check_for_updates(force=force)


@app.get("/api/updates/download/status")
def update_download_status():
    return um.get_download_status()


@app.post("/api/updates/download")
def start_update_download():
    try:
        return um.start_update_download()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/updates/install")
def install_update():
    try:
        result = um.install_update_and_restart(os.getpid())
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    threading.Timer(0.35, os._exit, args=(0,)).start()
    return result


@app.delete("/api/models/{model_id:path}")
def delete_model(model_id: str):
    # Prevent deleting the currently loaded model
    if mlx.get_loaded_model() == model_id:
        mlx.unload_model()
    ok = mm.delete_local_model(model_id)
    return {"deleted": ok}


# ── Model loading ─────────────────────────────────────────────────────────────

class LoadRequest(BaseModel):
    model_id: str


@app.get("/api/settings/last-model")
def get_last_model():
    return {"model_id": cfg.get_last_model()}


@app.post("/api/model/load")
async def load_model(req: LoadRequest):
    loop = asyncio.get_event_loop()
    try:
        logger.info("Loading model requested: %s", req.model_id)
        caps = await loop.run_in_executor(_thread_pool, lambda: mm.get_model_capabilities(req.model_id, allow_network=False))
        if not caps.get("loadable", True):
            raise HTTPException(status_code=400, detail=caps.get("reason") or "Model is not supported in this app.")

        backend = "vlm" if caps.get("vision") else "lm"
        await loop.run_in_executor(_thread_pool, lambda: mlx.load_model(req.model_id, backend=backend))
        cfg.set_last_model(req.model_id)
        logger.info("Model loaded successfully: %s (%s)", req.model_id, backend)
        return {"status": "loaded", "model_id": req.model_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Model load failed for %s", req.model_id)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/model/loaded")
def loaded_model():
    return {
        "model_id": mlx.get_loaded_model(),
        **mlx.get_load_status(),
    }


@app.post("/api/model/unload")
def unload_model():
    logger.info("Model unload requested")
    mlx.unload_model()
    return {"status": "unloaded"}


# ── Settings ──────────────────────────────────────────────────────────────────

@app.get("/api/settings/{model_id:path}")
def get_settings(model_id: str):
    return cfg.load_settings(model_id)


class SettingsPayload(BaseModel):
    settings: Dict[str, Any]


@app.post("/api/settings/{model_id:path}")
def save_settings(model_id: str, payload: SettingsPayload):
    cfg.save_settings(model_id, payload.settings)
    return {"status": "saved"}


# ── Conversations ─────────────────────────────────────────────────────────────

@app.get("/api/conversations")
def list_conversations():
    return cfg.list_conversations()


@app.get("/api/conversations/{conv_id}")
def get_conversation(conv_id: str):
    conv = cfg.load_conversation(conv_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@app.delete("/api/conversations/{conv_id}")
def delete_conversation(conv_id: str):
    _mark_conversation_deleted(conv_id)
    ok = cfg.delete_conversation(conv_id)
    return {"deleted": ok}


class DraftConversationRequest(BaseModel):
    conversation_id: Optional[str] = None
    model_id: str
    messages: List[Dict[str, Any]]


@app.post("/api/conversations/draft")
def save_conversation_draft(req: DraftConversationRequest):
    now = datetime.now(timezone.utc).isoformat()
    conv_id = req.conversation_id or str(uuid.uuid4())

    if _is_conversation_deleted(conv_id):
        return {"conversation_id": conv_id, "status": "deleted"}

    user_messages = [m for m in req.messages if m.get("role") == "user"]
    title = "Chat"
    if user_messages:
        first_content = (user_messages[0].get("content") or "").strip()
        title = first_content[:60] if first_content else "Image chat"

    existing = cfg.load_conversation(conv_id) or {}
    conv = {
        "id": conv_id,
        "model": req.model_id,
        "created_at": existing.get("created_at", now),
        "updated_at": now,
        "title": title,
        "messages": list(req.messages),
    }
    cfg.save_conversation(conv)
    return {"conversation_id": conv_id, "status": "saved"}


# ── Chat streaming ────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    conversation_id: Optional[str] = None
    request_id: Optional[str] = None
    model_id: str
    messages: List[Dict[str, Any]]
    settings: Optional[Dict[str, Any]] = None


class StopRequest(BaseModel):
    request_id: str


REASONING_TAG_HINT = (
    "If you include internal reasoning, wrap it strictly in <thinking>...</thinking>. "
    "Put the final user-facing answer outside those tags."
)


def _decode_data_url_image(data_url: str):
    if not data_url or "," not in data_url:
        return None

    try:
        _, b64 = data_url.split(",", 1)
        raw = base64.b64decode(b64)
        from PIL import Image
        return Image.open(BytesIO(raw)).convert("RGB")
    except Exception:
        return None


@app.get("/api/models/capabilities/{model_id:path}")
async def model_capabilities(model_id: str):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_thread_pool, lambda: mm.get_model_capabilities(model_id))


@app.post("/api/chat/stop")
def stop_chat(req: StopRequest):
    with _stop_events_lock:
        ev = _stop_events.get(req.request_id)
    if ev:
        ev.set()
    return {"stopped": bool(ev)}


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest, request: Request):
    # Merge default settings
    base = cfg.load_settings(req.model_id)
    settings = {**base, **(req.settings or {})}

    # Build messages list (include system prompt if set), and peel image payload from latest user turn
    raw_messages = list(req.messages)
    image_data_url = None
    for m in reversed(raw_messages):
        if m.get("role") == "user" and m.get("image_data_url"):
            image_data_url = m.get("image_data_url")
            break

    # Enforce capability guard server-side so image uploads cannot be sent to
    # text-only models via crafted requests or stale client state.
    if image_data_url:
        loop = asyncio.get_event_loop()
        caps = await loop.run_in_executor(_thread_pool, lambda: mm.get_model_capabilities(req.model_id, allow_network=False))
        if not caps.get("vision", False):
            raise HTTPException(
                status_code=400,
                detail="Selected model does not support vision/image inputs.",
            )

    model_messages: List[Dict[str, str]] = []
    for m in raw_messages:
        role = m.get("role")
        content = m.get("content", "")
        if role in ("system", "user", "assistant"):
            model_messages.append({"role": role, "content": content})

    if settings.get("system_prompt") and not any(m.get("role") == "system" for m in model_messages):
        model_messages = [{"role": "system", "content": settings["system_prompt"]}] + model_messages

    # Optional last-resort fallback for models that do not naturally emit explicit
    # reasoning boundaries. Off by default.
    if settings.get("enforce_thinking_tags"):
        model_messages = [{"role": "system", "content": REASONING_TAG_HINT}] + model_messages

    conv_id = req.conversation_id or str(uuid.uuid4())
    req_id = req.request_id or str(uuid.uuid4())
    stop_event = threading.Event()
    with _stop_events_lock:
        _stop_events[req_id] = stop_event

    async def generate():
        full_text = ""
        stopped = False
        try:
            loop = asyncio.get_event_loop()

            pil_image = _decode_data_url_image(image_data_url) if image_data_url else None
            num_images = 1 if pil_image is not None else 0

            # Guard against malformed client values and keep explicit bounds.
            try:
                max_tokens = int(settings.get("max_tokens", 2048))
            except Exception:
                max_tokens = 2048
            max_tokens = max(64, min(max_tokens, 131072))

            def _stream():
                return mlx.stream_chat(
                    messages=model_messages,
                    temperature=float(settings.get("temperature", 0.7)),
                    top_p=float(settings.get("top_p", 0.9)),
                    max_tokens=max_tokens,
                    repetition_penalty=float(settings.get("repetition_penalty", 1.1)),
                    repetition_context_size=int(settings.get("repetition_context_size", 20)),
                    use_turboquant=bool(settings.get("use_turboquant", False)),
                    kv_bits=float(settings.get("kv_bits", 4.0)),
                    image=pil_image,
                    num_images=num_images,
                    stop_event=stop_event,
                )

            # Run synchronous generator in thread pool
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                gen = await loop.run_in_executor(pool, _stream)
                # Stream chunks
                chunk_queue: asyncio.Queue = asyncio.Queue()

                def _reader():
                    try:
                        for chunk in gen:
                            if isinstance(chunk, dict) and "__stats__" in chunk:
                                loop.call_soon_threadsafe(
                                    chunk_queue.put_nowait, ("stats", chunk["__stats__"])
                                )
                            else:
                                loop.call_soon_threadsafe(chunk_queue.put_nowait, ("chunk", chunk))
                    except Exception as e:
                        loop.call_soon_threadsafe(chunk_queue.put_nowait, ("error", str(e)))
                    finally:
                        loop.call_soon_threadsafe(chunk_queue.put_nowait, ("done", None))

                reader_future = pool.submit(_reader)

                gen_stats = None
                disconnected_since = None
                while True:
                    if await request.is_disconnected():
                        if disconnected_since is None:
                            disconnected_since = monotonic()
                        elif monotonic() - disconnected_since > 3.0:
                            # Brief disconnects can happen when switching tabs/views.
                            stop_event.set()
                    else:
                        disconnected_since = None

                    kind, data = await chunk_queue.get()
                    if kind == "chunk":
                        full_text += data
                        yield {"data": json.dumps({"type": "chunk", "text": data})}
                    elif kind == "stats":
                        gen_stats = data
                    elif kind == "error":
                        yield {"data": json.dumps({"type": "error", "message": data})}
                        break
                    else:
                        break

                    if stop_event.is_set():
                        stopped = True
                        break

                if gen_stats:
                    yield {"data": json.dumps({"type": "stats", **gen_stats})}

            if stop_event.is_set():
                stopped = True

        except Exception as e:
            yield {"data": json.dumps({"type": "error", "message": str(e)})}
            return
        finally:
            with _stop_events_lock:
                _stop_events.pop(req_id, None)

        # Persist conversation
        now = datetime.now(timezone.utc).isoformat()
        user_messages = [m for m in req.messages if m.get("role") != "system"]
        title = "Chat"
        if user_messages:
            first_content = (user_messages[0].get("content") or "").strip()
            title = first_content[:60] if first_content else "Image chat"

        all_messages = list(req.messages)
        if full_text.strip():
            all_messages.append({"role": "assistant", "content": full_text})

        if not _is_conversation_deleted(conv_id):
            conv = cfg.load_conversation(conv_id) or {
                "id": conv_id,
                "model": req.model_id,
                "created_at": now,
            }
            conv["title"] = title
            conv["messages"] = all_messages
            conv["updated_at"] = now
            cfg.save_conversation(conv)

        if stopped:
            yield {"data": json.dumps({"type": "stopped"})}

        yield {"data": json.dumps({"type": "done", "conversation_id": conv_id})}

    return EventSourceResponse(generate())
