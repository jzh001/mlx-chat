"""
Wrapper around mlx_vlm for model loading and streaming generation.
Keeps one model in memory at a time.
"""
import threading
from typing import Generator, List, Dict, Any, Optional

_lock = threading.Lock()
_current_model_id: Optional[str] = None
_model = None
_processor = None
_config = None
_load_status: Dict[str, Any] = {"state": "idle", "message": ""}


def get_load_status() -> Dict[str, Any]:
    return dict(_load_status)


def get_loaded_model() -> Optional[str]:
    return _current_model_id


def load_model(model_id: str) -> None:
    """Load a model. Blocks until done. Raises on error."""
    global _current_model_id, _model, _processor, _config, _load_status

    with _lock:
        if _current_model_id == model_id and _model is not None:
            return

        _load_status = {"state": "loading", "message": f"Loading {model_id}..."}
        _model = None
        _processor = None
        _config = None
        _current_model_id = None

        try:
            from mlx_vlm import load
            from mlx_vlm.utils import load_config

            model, processor = load(model_id)
            config = load_config(model_id)

            _model = model
            _processor = processor
            _config = config
            _current_model_id = model_id
            _load_status = {"state": "ready", "message": f"Loaded {model_id}"}
        except Exception as e:
            _load_status = {"state": "error", "message": str(e)}
            raise


def unload_model() -> None:
    global _current_model_id, _model, _processor, _config, _load_status
    with _lock:
        _model = None
        _processor = None
        _config = None
        _current_model_id = None
        _load_status = {"state": "idle", "message": ""}


def stream_chat(
    messages: List[Dict[str, str]],
    temperature: float = 0.7,
    top_p: float = 0.9,
    max_tokens: int = 2048,
    repetition_penalty: float = 1.1,
    repetition_context_size: int = 20,
    use_turboquant: bool = False,
    kv_bits: float = 4.0,
) -> Generator[str, None, None]:
    """Yield text chunks for the assistant reply to the given messages."""
    if _model is None or _processor is None or _config is None:
        raise RuntimeError("No model loaded. Please load a model first.")

    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm import stream_generate

    prompt = apply_chat_template(_processor, _config, messages, num_images=0)

    kwargs: Dict[str, Any] = {
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "repetition_penalty": repetition_penalty,
        "repetition_context_size": repetition_context_size,
    }

    if use_turboquant:
        kwargs["kv_bits"] = kv_bits
        kwargs["kv_quant_scheme"] = "turboquant"

    for chunk in stream_generate(_model, _processor, prompt, image=None, **kwargs):
        if hasattr(chunk, "text"):
            yield chunk.text
        elif isinstance(chunk, str):
            yield chunk
        else:
            # Fallback for unknown chunk types
            text = getattr(chunk, "text", None) or str(chunk)
            yield text
