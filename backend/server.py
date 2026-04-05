import asyncio
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import config as cfg
from . import mlx_handler as mlx
from . import model_manager as mm

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

app = FastAPI(title="MLX Chat")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/")
def serve_index():
    return FileResponse(FRONTEND_DIR / "index.html")


# ── System ───────────────────────────────────────────────────────────────────

@app.get("/api/system/memory")
def system_memory():
    return mm.get_system_memory()


# ── Model management ─────────────────────────────────────────────────────────

@app.get("/api/models/local")
def local_models():
    return mm.list_local_models()


@app.get("/api/models/search")
def search_models(q: str = "", limit: int = 30):
    return mm.search_models(q, limit)


class DownloadRequest(BaseModel):
    model_id: str


@app.post("/api/models/download")
def start_download(req: DownloadRequest):
    mm.start_download(req.model_id)
    return {"status": "started"}


@app.get("/api/models/download/status")
def download_status(model_id: str):
    status = mm.get_download_status(model_id)
    if status is None:
        return {"progress": 0.0, "done": False, "error": None, "current_file": ""}
    return status


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


@app.post("/api/model/load")
def load_model(req: LoadRequest):
    try:
        mlx.load_model(req.model_id)
        return {"status": "loaded", "model_id": req.model_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/model/loaded")
def loaded_model():
    return {
        "model_id": mlx.get_loaded_model(),
        **mlx.get_load_status(),
    }


@app.post("/api/model/unload")
def unload_model():
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
    ok = cfg.delete_conversation(conv_id)
    return {"deleted": ok}


# ── Chat streaming ────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    conversation_id: Optional[str] = None
    model_id: str
    messages: List[Dict[str, str]]
    settings: Optional[Dict[str, Any]] = None


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    # Merge default settings
    base = cfg.load_settings(req.model_id)
    settings = {**base, **(req.settings or {})}

    # Build messages list (include system prompt if set)
    messages = list(req.messages)
    if settings.get("system_prompt") and not any(m.get("role") == "system" for m in messages):
        messages = [{"role": "system", "content": settings["system_prompt"]}] + messages

    conv_id = req.conversation_id or str(uuid.uuid4())

    async def generate():
        full_text = ""
        try:
            loop = asyncio.get_event_loop()

            def _stream():
                return mlx.stream_chat(
                    messages=messages,
                    temperature=float(settings.get("temperature", 0.7)),
                    top_p=float(settings.get("top_p", 0.9)),
                    max_tokens=int(settings.get("max_tokens", 2048)),
                    repetition_penalty=float(settings.get("repetition_penalty", 1.1)),
                    repetition_context_size=int(settings.get("repetition_context_size", 20)),
                    use_turboquant=bool(settings.get("use_turboquant", False)),
                    kv_bits=float(settings.get("kv_bits", 4.0)),
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
                            loop.call_soon_threadsafe(chunk_queue.put_nowait, ("chunk", chunk))
                    except Exception as e:
                        loop.call_soon_threadsafe(chunk_queue.put_nowait, ("error", str(e)))
                    finally:
                        loop.call_soon_threadsafe(chunk_queue.put_nowait, ("done", None))

                reader_future = pool.submit(_reader)

                while True:
                    kind, data = await chunk_queue.get()
                    if kind == "chunk":
                        full_text += data
                        yield {"data": json.dumps({"type": "chunk", "text": data})}
                    elif kind == "error":
                        yield {"data": json.dumps({"type": "error", "message": data})}
                        break
                    else:
                        break

        except Exception as e:
            yield {"data": json.dumps({"type": "error", "message": str(e)})}
            return

        # Persist conversation
        now = datetime.now(timezone.utc).isoformat()
        user_messages = [m for m in req.messages if m.get("role") != "system"]
        title = (user_messages[0]["content"][:60] if user_messages else "Chat")
        all_messages = list(req.messages) + [{"role": "assistant", "content": full_text}]

        conv = cfg.load_conversation(conv_id) or {
            "id": conv_id,
            "model": req.model_id,
            "created_at": now,
        }
        conv["title"] = title
        conv["messages"] = all_messages
        conv["updated_at"] = now
        cfg.save_conversation(conv)

        yield {"data": json.dumps({"type": "done", "conversation_id": conv_id})}

    return EventSourceResponse(generate())
