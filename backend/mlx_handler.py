"""
Wrapper around mlx_vlm for model loading and streaming generation.
Keeps one model in memory at a time.
"""
import threading
import gc
from typing import Generator, List, Dict, Any, Optional

_lock = threading.Lock()
_current_model_id: Optional[str] = None
_model = None
_processor = None
_config = None
_backend_type: Optional[str] = None  # "vlm" | "lm"
_load_status: Dict[str, Any] = {"state": "idle", "message": ""}


def get_load_status() -> Dict[str, Any]:
    return dict(_load_status)


def get_loaded_model() -> Optional[str]:
    return _current_model_id


def get_backend_type() -> Optional[str]:
    return _backend_type


def load_model(model_id: str, backend: Optional[str] = None) -> None:
    """Load a model. Blocks until done. Raises on error."""
    global _current_model_id, _model, _processor, _config, _backend_type, _load_status

    with _lock:
        if _current_model_id == model_id and _model is not None:
            return

        _load_status = {"state": "loading", "message": f"Loading {model_id}..."}
        _model = None
        _processor = None
        _config = None
        _backend_type = None
        _current_model_id = None

        try:
            selected_backend = backend or "vlm"

            if selected_backend == "lm":
                from mlx_lm import load as lm_load

                model, tokenizer = lm_load(model_id)
                _model = model
                _processor = tokenizer
                _config = None
                _backend_type = "lm"
            else:
                from mlx_vlm import load as vlm_load
                from mlx_vlm.utils import load_config

                model, processor = vlm_load(model_id)
                config = load_config(model_id)
                _model = model
                _processor = processor
                _config = config
                _backend_type = "vlm"

            _current_model_id = model_id
            _load_status = {
                "state": "ready",
                "message": f"Loaded {model_id}",
                "backend": _backend_type,
            }
        except Exception as e:
            _load_status = {"state": "error", "message": str(e)}
            raise


def unload_model() -> None:
    global _current_model_id, _model, _processor, _config, _backend_type, _load_status
    with _lock:
        _model = None
        _processor = None
        _config = None
        _backend_type = None
        _current_model_id = None

        # Force Python/MLX cleanup so resident memory drops sooner.
        gc.collect()
        try:
            import mlx.core as mx
            mx.clear_cache()
        except Exception:
            # Cleanup is best-effort; unload should still succeed.
            pass

        _load_status = {"state": "idle", "message": ""}


def _build_lm_prompt(tokenizer: Any, messages: List[Dict[str, Any]]) -> str:
    """Build chat prompt for text-only models using tokenizer chat template when available."""
    tok = getattr(tokenizer, "tokenizer", None) or getattr(tokenizer, "_tokenizer", None) or tokenizer

    if hasattr(tok, "apply_chat_template"):
        try:
            return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        except TypeError:
            # Older tokenizer versions may not support add_generation_prompt.
            return tok.apply_chat_template(messages, tokenize=False)

    # Conservative fallback: plain role-prefixed transcript.
    parts: List[str] = []
    for m in messages:
        role = str(m.get("role", "user")).capitalize()
        content = str(m.get("content", ""))
        parts.append(f"{role}: {content}")
    parts.append("Assistant:")
    return "\n\n".join(parts)


def stream_chat(
    messages: List[Dict[str, Any]],
    temperature: float = 0.7,
    top_p: float = 0.9,
    max_tokens: int = 2048,
    repetition_penalty: float = 1.1,
    repetition_context_size: int = 20,
    use_turboquant: bool = False,
    kv_bits: float = 4.0,
    image: Any = None,
    num_images: int = 0,
    stop_event: Optional[threading.Event] = None,
) -> Generator[str, None, None]:
    """Yield text chunks for the assistant reply to the given messages."""
    if _model is None or _processor is None:
        raise RuntimeError("No model loaded. Please load a model first.")

    last_chunk = None

    if _backend_type == "lm":
        from mlx_lm import stream_generate as lm_stream_generate
        from mlx_lm.sample_utils import make_sampler, make_repetition_penalty

        prompt = _build_lm_prompt(_processor, messages)

        sampler = make_sampler(temp=float(temperature), top_p=float(top_p))
        logits_processors = None
        if repetition_penalty and float(repetition_penalty) > 1.0:
            logits_processors = [
                make_repetition_penalty(float(repetition_penalty), int(repetition_context_size))
            ]

        for chunk in lm_stream_generate(
            _model,
            _processor,
            prompt,
            max_tokens=max_tokens,
            sampler=sampler,
            logits_processors=logits_processors,
        ):
            if stop_event is not None and stop_event.is_set():
                break
            last_chunk = chunk
            if hasattr(chunk, "text"):
                yield chunk.text
            elif isinstance(chunk, str):
                yield chunk
            else:
                yield getattr(chunk, "text", None) or str(chunk)
    else:
        if _config is None:
            raise RuntimeError("Vision model is missing config; reload model.")

        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm import stream_generate as vlm_stream_generate

        prompt = apply_chat_template(_processor, _config, messages, num_images=num_images)

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

        for chunk in vlm_stream_generate(_model, _processor, prompt, image=image, **kwargs):
            if stop_event is not None and stop_event.is_set():
                break
            last_chunk = chunk
            if hasattr(chunk, "text"):
                yield chunk.text
            elif isinstance(chunk, str):
                yield chunk
            else:
                yield getattr(chunk, "text", None) or str(chunk)

    # Yield final generation statistics from the last chunk
    if last_chunk is not None:
        stats = {
            "prompt_tokens": getattr(last_chunk, "prompt_tokens", None),
            "generation_tokens": getattr(last_chunk, "generation_tokens", None),
            "generation_tps": getattr(last_chunk, "generation_tps", None),
            "prompt_tps": getattr(last_chunk, "prompt_tps", None),
            "peak_memory_gb": getattr(last_chunk, "peak_memory", None),
        }
        if any(v is not None for v in stats.values()):
            yield {"__stats__": stats}
