"""
HuggingFace model management: list local, search, download, delete.
All models are from the mlx-community organization.
"""
import contextlib
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import psutil

from . import config as cfg

MLX_ORG = "mlx-community"
_GiB = 1024 ** 3  # bytes → gibibytes (matches Apple's "GB" labelling)
_HF_API  = "https://huggingface.co/api/models"

# Progress tracking for active downloads
_download_status: Dict[str, Dict] = {}
_download_lock = threading.Lock()
_cancel_events: Dict[str, threading.Event] = {}
_DOWNLOAD_STATE_FILE = cfg.APP_DIR / "active_downloads.json"
_recovery_ran = False

# Small LRU-style cache for individual model sizes (usedStorage)
_size_cache: Dict[str, Optional[float]] = {}
_SIZE_CACHE_MAX = 500

# Capability cache (vision/text-only)
_cap_cache: Dict[str, Dict[str, Any]] = {}
_CAP_CACHE_MAX = 500
logger = logging.getLogger("mlx_chat.model_manager")

# ── Publisher detection ──────────────────────────────────────────────────────

# Map HF organization slugs → display names
_ORG_DISPLAY: Dict[str, str] = {
    "google":          "Google",
    "meta-llama":      "Meta",
    "qwen":            "Alibaba",
    "alibaba":         "Alibaba",
    "qwen-vl":         "Alibaba",
    "microsoft":       "Microsoft",
    "mistralai":       "Mistral AI",
    "deepseek-ai":     "DeepSeek",
    "tiiuae":          "TII",
    "cohere":          "Cohere",
    "cohere-ai":       "Cohere",
    "01-ai":           "01.AI",
    "upstage":         "Upstage",
    "bigcode":         "BigCode",
    "apple":           "Apple",
    "allenai":         "Allen AI",
    "stabilityai":     "Stability AI",
    "bigscience":      "BigScience",
    "lmsys":           "LMSYS",
    "nousresearch":    "NousResearch",
    "huggingface":     "HuggingFace",
    "huggingfaceh4":   "HuggingFace",
    "opengvlab":       "OpenGVLab",
    "moonshotai":      "Moonshot AI",
    "anthropic":       "Anthropic",
    "openai":          "OpenAI",
    "llava-hf":        "LLaVA",
    "vikhyatk":        "Moondream",
    "internlm":        "Shanghai AI Lab",
    "baichuan-inc":    "Baichuan",
    "01ai":            "01.AI",
    "thudm":           "Tsinghua",
    "cognitivecomputations": "Cognitive Comp.",
    "teknium":         "NousResearch",
}

# Fallback: keyword scan of model name
_NAME_PUBLISHERS = [
    (["gemma"],          "Google"),
    (["llama", "codellama"], "Meta"),
    (["qwen"],           "Alibaba"),
    (["mistral", "mixtral", "pixtral", "devstral"], "Mistral AI"),
    (["phi-"],           "Microsoft"),
    (["deepseek"],       "DeepSeek"),
    (["falcon"],         "TII"),
    (["command-r"],      "Cohere"),
    (["solar"],          "Upstage"),
    (["starcoder"],      "BigCode"),
    (["openelm"],        "Apple"),
    (["smollm"],         "HuggingFace"),
    (["olmo"],           "Allen AI"),
    (["stablelm"],       "Stability AI"),
    (["hermes"],         "NousResearch"),
    (["dolphin"],        "Cognitive Comp."),
    (["zephyr"],         "HuggingFace"),
    (["wizard"],         "Microsoft"),
    (["kimi"],           "Moonshot AI"),
    (["internvl"],       "OpenGVLab"),
    (["llava"],          "LLaVA"),
    (["moondream"],      "Moondream"),
    (["yi-"],            "01.AI"),
]

_VISION_TAG_HINTS = {
    "image-text-to-text",
    "image-to-text",
    "visual-question-answering",
    "vision",
    "vision-language",
    "multimodal",
    "vlm",
}

# Model types known to fail in mlx_vlm loading path.
_UNSUPPORTED_MODEL_TYPES = set()


def _publisher_from_base_models(base_models: Any) -> Optional[str]:
    """Extract publisher from the HF baseModels expand field."""
    if not base_models:
        return None
    try:
        models_list = base_models.get("models") or []
        if not models_list:
            return None
        base_id = models_list[0].get("id", "")
        org = base_id.split("/")[0].lower() if "/" in base_id else ""
        return _ORG_DISPLAY.get(org)
    except Exception:
        return None


def _publisher_from_name(name: str) -> Optional[str]:
    """Fallback: detect publisher from model name keywords."""
    name_lower = name.lower()
    for keywords, pub in _NAME_PUBLISHERS:
        if any(kw in name_lower for kw in keywords):
            return pub
    return None


def _has_vision(tags: List[str], name: str = "") -> bool:
    tag_set = {str(t).lower() for t in (tags or [])}
    if any(t in tag_set for t in _VISION_TAG_HINTS):
        return True

    name_l = (name or "").lower()
    name_hints = ("-vl", "vision", "internvl", "llava", "moondream", "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl")
    return any(h in name_l for h in name_hints)


def _compatibility_from_model_type(model_type: Optional[str]) -> Dict[str, Any]:
    mt = (model_type or "").strip().lower()
    if mt in _UNSUPPORTED_MODEL_TYPES:
        return {
            "loadable": False,
            "reason": f"Model type '{model_type}' is not supported by mlx_vlm in this app.",
        }
    return {"loadable": True, "reason": None}


# ── Size estimation ───────────────────────────────────────────────────────────

def _estimate_size_gb(name: str) -> Optional[float]:
    """
    Estimate disk size in GB from model name.
    Uses active param count (a<N>b) for MoE models when available,
    otherwise total param count.
    Returns None if parameters cannot be parsed.
    """
    n = name.lower()

    # For MoE models (e.g. "26b-a4b"), ALL expert weights are loaded into memory
    # at inference time — only the active subset is *used* per token.  Use the
    # total param count for the size estimate so we don't wildly underestimate.
    pm = re.search(r'(\d+(?:\.\d+)?)b(?:[\-_ ]|$|it|instruct|chat|preview|turbo|coder)', n)
    if not pm:
        return None
    params_b = float(pm.group(1))

    # Quantisation bits
    bm = re.search(r'(\d+)[\-_]?bit', n)
    if bm:
        bits = int(bm.group(1))
    elif any(x in n for x in ("f16", "fp16", "bf16", "half")):
        bits = 16
    else:
        bits = 4  # mlx-community default

    size_gb = params_b * (bits / 8) * 1.15  # 15% overhead for tokeniser / configs
    return round(size_gb, 1)


# ── Size cache + lazy fetch ───────────────────────────────────────────────────

def fetch_model_size(model_id: str) -> Optional[float]:
    """Fetch exact model size (GB) via the HF individual model endpoint."""
    if model_id in _size_cache:
        return _size_cache[model_id]

    import requests
    size = None
    try:
        resp = requests.get(
            f"{_HF_API}/{model_id}",
            params={"expand[]": "usedStorage"},
            timeout=8,
            headers={"User-Agent": "mlx-chat/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()
        used = data.get("usedStorage")
        if used and used > 0:
            size = round(used / _GiB, 2)
    except Exception:
        pass

    if len(_size_cache) >= _SIZE_CACHE_MAX:
        del _size_cache[next(iter(_size_cache))]
    _size_cache[model_id] = size
    return size


def get_model_capabilities(model_id: str) -> Dict[str, Any]:
    """Fetch model capabilities from HF metadata (cached)."""
    if model_id in _cap_cache:
        return _cap_cache[model_id]

    import requests

    tags: List[str] = []
    pipeline_tag = None
    model_type = None
    vision = False

    try:
        resp = requests.get(
            f"{_HF_API}/{model_id}",
            params={"expand[]": ["tags", "pipeline_tag", "config"]},
            timeout=8,
            headers={"User-Agent": "mlx-chat/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()
        tags = list(data.get("tags") or [])
        pipeline_tag = data.get("pipeline_tag")
        model_type = (data.get("config") or {}).get("model_type")
        if pipeline_tag:
            tags.append(str(pipeline_tag))
    except Exception:
        pass

    vision = _has_vision(tags, model_id)
    compat = _compatibility_from_model_type(model_type)
    result = {
        "model_id": model_id,
        "vision": vision,
        "model_type": model_type,
        "loadable": compat["loadable"],
        "reason": compat["reason"],
        "tags": sorted(set(tags), key=lambda x: str(x).lower())[:16],
    }

    if len(_cap_cache) >= _CAP_CACHE_MAX:
        del _cap_cache[next(iter(_cap_cache))]
    _cap_cache[model_id] = result
    return result


# ── Memory helpers ───────────────────────────────────────────────────────────

def get_system_memory() -> Dict[str, float]:
    vm = psutil.virtual_memory()
    return {
        "total_gb":     vm.total / _GiB,
        "available_gb": vm.available / _GiB,
        "used_gb":      vm.used / _GiB,
        "percent":      vm.percent,
    }


def _gpu_label(size_gb: Optional[float]) -> str:
    if size_gb is None:
        return "unknown"
    mem = get_system_memory()
    if size_gb < mem["available_gb"] * 0.85:
        return "full"
    if size_gb < mem["total_gb"]:
        return "partial"
    return "too_large"


# ── Local model helpers ───────────────────────────────────────────────────────

def _hf_cache_root() -> Path:
    return Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"


def _download_worker_cmd(model_id: str) -> List[str]:
    root_dir = Path(__file__).resolve().parent.parent
    app_entry = root_dir / "app.py"
    if getattr(sys, "frozen", False):
        return [sys.executable, "--download-worker", model_id]
    return [sys.executable, str(app_entry), "--download-worker", model_id]


def _read_download_state_file() -> Dict[str, Dict[str, Any]]:
    try:
        if not _DOWNLOAD_STATE_FILE.exists():
            return {}
        raw = json.loads(_DOWNLOAD_STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {}

        state: Dict[str, Dict[str, Any]] = {}
        now = time.time()
        for model_id, meta in raw.items():
            if not isinstance(model_id, str) or not model_id:
                continue
            if not isinstance(meta, dict):
                meta = {}
            state[model_id] = {
                "start_time": float(meta.get("start_time") or now),
                "updated_at": float(meta.get("updated_at") or now),
            }
        return state
    except Exception:
        logger.warning("Failed to read persisted download state", exc_info=True)
        return {}


def _write_download_state_file(state: Dict[str, Dict[str, Any]]) -> None:
    tmp_path = _DOWNLOAD_STATE_FILE.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp_path.replace(_DOWNLOAD_STATE_FILE)


def _persist_download_state() -> None:
    with _download_lock:
        active = {
            model_id: {
                "start_time": float(status.get("start_time") or time.time()),
                "updated_at": float(status.get("last_update") or time.time()),
            }
            for model_id, status in _download_status.items()
            if not status.get("done")
        }

    try:
        if active:
            _write_download_state_file(active)
        elif _DOWNLOAD_STATE_FILE.exists():
            _DOWNLOAD_STATE_FILE.unlink()
    except FileNotFoundError:
        pass
    except Exception:
        logger.warning("Failed to persist download state", exc_info=True)


def _is_suspicious_partial_repo_dir(model_id: str) -> bool:
    safe = model_id.replace("/", "--")
    repo_dir = _hf_cache_root() / f"models--{safe}"
    if not repo_dir.exists():
        return False

    try:
        for path in repo_dir.rglob("*"):
            if path.name.endswith(".incomplete"):
                return True
    except Exception:
        logger.debug("Failed scanning %s for incomplete files", model_id, exc_info=True)

    try:
        total_bytes = 0
        file_count = 0
        for path in repo_dir.rglob("*"):
            if not path.is_file():
                continue
            file_count += 1
            try:
                total_bytes += path.stat().st_size
            except OSError:
                continue
        if total_bytes <= 0:
            return True
        if file_count <= 2 and total_bytes < 1_000_000:
            return True
    except Exception:
        logger.debug("Failed sizing recovered repo dir for %s", model_id, exc_info=True)

    return False


def _recover_interrupted_downloads() -> None:
    global _recovery_ran
    with _download_lock:
        if _recovery_ran:
            return
        _recovery_ran = True

    persisted = _read_download_state_file()
    if not persisted:
        return

    for model_id in persisted:
        try:
            if _is_suspicious_partial_repo_dir(model_id):
                logger.info("Cleaning interrupted partial download: %s", model_id)
                _cleanup_partial_download(model_id, delay_s=0.0)
            else:
                logger.info("Recovered persisted download state for %s without cleanup", model_id)
        except Exception:
            logger.warning("Failed recovering interrupted download for %s", model_id, exc_info=True)

    try:
        if _DOWNLOAD_STATE_FILE.exists():
            _DOWNLOAD_STATE_FILE.unlink()
    except Exception:
        logger.warning("Failed to clear persisted download state", exc_info=True)


def list_local_models() -> List[Dict[str, Any]]:
    _recover_interrupted_downloads()

    # Exclude models that are currently being downloaded (partial cache)
    with _download_lock:
        downloading = {mid for mid, s in _download_status.items() if not s.get("done")}

    from huggingface_hub import scan_cache_dir
    try:
        cache = scan_cache_dir()
    except Exception:
        return []

    results = []
    for repo in cache.repos:
        if not repo.repo_id.startswith(f"{MLX_ORG}/"):
            continue
        if repo.repo_id in downloading:
            continue  # Skip partial downloads
        if repo.size_on_disk <= 0:
            logger.info("Skipping zero-byte cached repo entry: %s", repo.repo_id)
            continue
        size_gb = repo.size_on_disk / _GiB
        # Local cards should use the same capability detection as browse cards.
        # Fall back to name-based heuristic if metadata is unavailable.
        caps = get_model_capabilities(repo.repo_id)
        vision = bool(caps.get("vision", False)) or _has_vision([], repo.repo_id)
        results.append({
            "id":        repo.repo_id,
            "name":      repo.repo_id.split("/", 1)[-1],
            "size_gb":   round(size_gb, 2),
            "gpu_label": _gpu_label(size_gb),
            "vision":    vision,
            "model_type": caps.get("model_type"),
            "loadable": bool(caps.get("loadable", True)),
            "reason": caps.get("reason"),
        })
    return results


def delete_local_model(model_id: str) -> bool:
    from huggingface_hub import scan_cache_dir
    cache_logger = logging.getLogger("huggingface_hub.utils._cache_manager")

    @contextlib.contextmanager
    def _suppress_missing_repo_warnings():
        previous_level = cache_logger.level
        cache_logger.setLevel(logging.ERROR)
        try:
            yield
        finally:
            cache_logger.setLevel(previous_level)

    try:
        with _suppress_missing_repo_warnings():
            cache = scan_cache_dir()
            for repo in cache.repos:
                if repo.repo_id == model_id:
                    try:
                        strategy = cache.delete_revisions(*[r.commit_hash for r in repo.revisions])
                        strategy.execute()
                        return True
                    except FileNotFoundError:
                        logger.debug("Model cache already removed during delete: %s", model_id)
                        return True
    except Exception:
        pass

    safe = model_id.replace("/", "--")
    path = _hf_cache_root() / f"models--{safe}"
    if path.exists():
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            logger.debug("Model cache path already removed: %s", path)
        return True
    return False


# ── HuggingFace search ────────────────────────────────────────────────────────

SORT_OPTIONS = {
    "downloads": "downloads",
    "likes":     "likes",
    "recent":    "lastModified",
    "trending":  "trendingScore",
}


def search_models(query: str = "", sort: str = "downloads", limit: int = 30) -> List[Dict[str, Any]]:
    import requests

    hf_sort = SORT_OPTIONS.get(sort, "downloads")
    params = [
        ("author",    MLX_ORG),
        ("sort",      hf_sort),
        ("direction", -1),
        ("limit",     limit),
        ("expand[]",  "baseModels"),
        ("expand[]",  "config"),
        ("expand[]",  "downloads"),
        ("expand[]",  "likes"),
        ("expand[]",  "lastModified"),
        ("expand[]",  "pipeline_tag"),
        ("expand[]",  "tags"),
    ]
    if query:
        params.append(("search", query))

    try:
        resp = requests.get(
            _HF_API, params=params, timeout=15,
            headers={"User-Agent": "mlx-chat/1.0"},
        )
        resp.raise_for_status()
        raw = resp.json()
        if not isinstance(raw, list):
            return []
    except Exception:
        return []

    results = []
    for m in raw:
        model_id = m.get("id") or m.get("modelId", "")
        if not model_id:
            continue

        name = model_id.split("/", 1)[-1]

        # Size: list endpoint does not provide usedStorage reliably.
        # Exact size is fetched lazily via /api/models/size.
        used_storage = m.get("usedStorage")
        size_gb = None
        if isinstance(used_storage, (int, float)) and used_storage > 0:
            size_gb = round(float(used_storage) / _GiB, 2)

        est_size = _estimate_size_gb(name)

        # Publisher: from base_models expand, fallback to name keywords
        publisher = (
            _publisher_from_base_models(m.get("baseModels"))
            or _publisher_from_name(name)
        )

        tags = [str(t) for t in (m.get("tags") or [])[:12]]
        if m.get("pipeline_tag"):
            tags.append(str(m.get("pipeline_tag")))
        model_type = (m.get("config") or {}).get("model_type")
        compat = _compatibility_from_model_type(model_type)
        vision = _has_vision(tags, name)

        results.append({
            "id":            model_id,
            "name":          name,
            "downloads":     m.get("downloads") or 0,
            "likes":         m.get("likes") or 0,
            "last_modified": m.get("lastModified", ""),
            "est_size_gb":   est_size,        # estimated, shown with ~
            "size_gb":       size_gb,
            "gpu_label":     _gpu_label(size_gb if size_gb is not None else est_size),
            "publisher":     publisher,
            "tags":          sorted(set(tags), key=lambda x: x.lower())[:8],
            "vision":        vision,
            "model_type":    model_type,
            "loadable":      compat["loadable"],
            "reason":        compat["reason"],
        })
    return results


# ── Download ──────────────────────────────────────────────────────────────────

_DOWNLOAD_TIMEOUT_S = 1800  # 30 minutes max per download
_STALL_TIMEOUT_S    = 300   # 5 minutes without progress = stalled


def get_active_downloads() -> List[Dict[str, Any]]:
    """Return all currently in-progress (not done) downloads."""
    _recover_interrupted_downloads()
    with _download_lock:
        return [
            {"model_id": mid, **status}
            for mid, status in _download_status.items()
            if not status.get("done")
        ]


def get_download_status(model_id: str) -> Optional[Dict]:
    try:
        with _download_lock:
            status = _download_status.get(model_id)
            if status is None:
                return None

        # Detect stall / global timeout on every poll
        if not status["done"]:
            now = time.time()
            elapsed = now - status["start_time"]
            stalled = now - status["last_update"] > _STALL_TIMEOUT_S

            if elapsed > _DOWNLOAD_TIMEOUT_S:
                with _download_lock:
                    _download_status[model_id]["done"]  = True
                    _download_status[model_id]["error"] = "Download timed out after 30 minutes."
                _persist_download_state()
            elif stalled:
                with _download_lock:
                    _download_status[model_id]["done"]  = True
                    _download_status[model_id]["error"] = "Download stalled (no progress for 5 minutes)."
                _persist_download_state()

        with _download_lock:
            return dict(_download_status[model_id])
    except Exception:
        return {"progress": 0.0, "done": True, "error": "Status unavailable.", "current_file": ""}


def cancel_download(model_id: str) -> bool:
    """Cancel an in-progress download. Returns True if a download was cancelled."""
    with _download_lock:
        status = _download_status.get(model_id)
        if not status or status.get("done"):
            return False
        _download_status[model_id]["done"] = True
        _download_status[model_id]["error"] = "Cancelled by user."
    _persist_download_state()

    ev = _cancel_events.get(model_id)
    if ev:
        ev.set()

    # Clean up partial cache files after a short delay (worker may still be finishing a file)
    threading.Thread(target=_cleanup_partial_download, args=(model_id,), daemon=True).start()
    return True


def _cleanup_partial_download(model_id: str, delay_s: float = 2.0) -> None:
    """Delete partially downloaded model files from HF cache."""
    if delay_s > 0:
        time.sleep(delay_s)  # Give the subprocess time to exit after kill()
    # Try the huggingface_hub cache deletion first
    try:
        delete_local_model(model_id)
    except Exception:
        logger.debug("Best-effort partial download cleanup failed for %s", model_id, exc_info=True)
    # Also nuke the raw cache directory — incomplete downloads leave temp files
    # that scan_cache_dir() doesn't always surface via delete_revisions().
    try:
        safe = model_id.replace("/", "--")
        model_dir = _hf_cache_root() / f"models--{safe}"
        if model_dir.exists():
            shutil.rmtree(model_dir, ignore_errors=True)
    except Exception:
        logger.debug("Raw cache cleanup failed for %s", model_id, exc_info=True)


def start_download(model_id: str) -> None:
    _recover_interrupted_downloads()
    if _is_suspicious_partial_repo_dir(model_id):
        _cleanup_partial_download(model_id, delay_s=0.0)

    with _download_lock:
        existing = _download_status.get(model_id)
        if existing and not existing.get("done"):
            return  # already in progress
        now = time.time()
        _download_status[model_id] = {
            "progress":     0.0,
            "done":         False,
            "error":        None,
            "current_file": "",
            "start_time":   now,
            "last_update":  now,
            "total_bytes":  0,
            "bytes_done":   0,
        }
    _persist_download_state()

    cancel_ev = threading.Event()
    _cancel_events[model_id] = cancel_ev
    t = threading.Thread(target=_download_worker, args=(model_id, cancel_ev), daemon=True)
    t.start()


# Subprocess script that performs the actual download and reports JSON progress to stdout.
# Runs in an isolated Python process so proc.kill() immediately terminates the download.
# Within each file, a background thread polls the .incomplete file in the HF cache so
# the host process receives smooth byte-level progress even for multi-GB shards.
_DOWNLOAD_SCRIPT = r'''
import os, sys, json, threading, time
from pathlib import Path
import requests
from huggingface_hub import model_info, hf_hub_download
from tqdm.auto import tqdm as _tqdm

model_id = sys.argv[1]
hf_home = os.environ.get("HF_HOME", str(Path.home() / ".cache" / "huggingface"))
blobs_dir = Path(hf_home) / "hub" / ("models--" + model_id.replace("/", "--")) / "blobs"
hf_api = "https://huggingface.co/api/models"
total_bytes = 1
current_file = ""
current_file_start_bytes = 0

def _blobs_size():
    # Sum all files in the blobs directory (complete + in-progress).
    # This works regardless of the .incomplete naming convention used by the
    # installed huggingface_hub version.
    try:
        return sum(f.stat().st_size for f in blobs_dir.iterdir() if f.is_file())
    except OSError:
        return 0

def _repo_total_bytes():
    try:
        resp = requests.get(
            f"{hf_api}/{model_id}",
            params={"expand[]": "usedStorage"},
            timeout=8,
            headers={"User-Agent": "mlx-chat/1.0"},
        )
        resp.raise_for_status()
        used = (resp.json() or {}).get("usedStorage")
        if used and used > 0:
            return int(used)
    except Exception:
        pass
    return 0

def _emit_progress(bytes_done, done=False):
    safe_total = max(int(total_bytes), 1)
    safe_done = max(0, min(int(bytes_done), safe_total))
    payload = {
        "progress": safe_done / safe_total,
        "bytes_done": safe_done,
        "total_bytes": safe_total,
        "file": current_file,
    }
    if done:
        payload["done"] = True
    print(json.dumps(payload), flush=True)

class JsonProgressTqdm(_tqdm):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("disable", True)
        super().__init__(*args, **kwargs)
        self._json_last_emit = 0.0

    def display(self, *args, **kwargs):
        return

    def refresh(self, *args, **kwargs):
        out = super().refresh(*args, **kwargs)
        self._emit_json()
        return out

    def update(self, n=1):
        out = super().update(n)
        self._emit_json()
        return out

    def close(self):
        self._emit_json(force=True)
        return super().close()

    def _emit_json(self, force=False):
        now = time.time()
        if not force and now - self._json_last_emit < 0.25:
            return
        self._json_last_emit = now
        initial = int(getattr(self, "initial", 0) or 0)
        current_n = int(getattr(self, "n", 0) or 0)
        computed = current_file_start_bytes + max(0, current_n - initial)
        effective = max(min(_blobs_size(), total_bytes), min(computed, total_bytes))
        _emit_progress(effective)

try:
    info = model_info(model_id)
    siblings = [s for s in info.siblings if s.rfilename]

    total_bytes = _repo_total_bytes()
    sizes = []
    sibling_total = 0
    for s in siblings:
        sz = 0
        if s.lfs is not None:
            if hasattr(s.lfs, "size"):
                sz = s.lfs.size or 0
            elif isinstance(s.lfs, dict):
                sz = s.lfs.get("size", 0) or 0
        if not sz and s.size:
            sz = s.size
        sizes.append(sz)
        sibling_total += sz
    if total_bytes <= 0:
        total_bytes = sibling_total
    if total_bytes == 0:
        total_bytes = max(len(siblings), 1)
        sizes = [1] * len(siblings)

    bytes_done = min(_blobs_size(), total_bytes)
    _emit_progress(bytes_done)

    for sibling, fsize in zip(siblings, sizes):
        current_file = sibling.rfilename
        current_file_start_bytes = min(_blobs_size(), total_bytes)
        _emit_progress(current_file_start_bytes)
        try:
            hf_hub_download(repo_id=model_id, filename=sibling.rfilename, tqdm_class=JsonProgressTqdm)
        except TypeError:
            hf_hub_download(repo_id=model_id, filename=sibling.rfilename)

        _emit_progress(min(_blobs_size(), total_bytes))

    _emit_progress(total_bytes, done=True)
except Exception as e:
    print(json.dumps({"error": str(e)}), flush=True)
    sys.exit(1)
'''


def _download_worker(model_id: str, cancel_ev: threading.Event) -> None:
    """
    Runs the download in a child process. On cancel, proc.kill() is called immediately,
    which truly stops any in-progress HTTP transfer — no waiting for the current file.
    """
    proc = subprocess.Popen(
        _download_worker_cmd(model_id),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,  # suppress huggingface_hub tqdm output
        text=True,
        env=os.environ.copy(),
    )

    # Read stdout in a background thread so we can poll cancel_ev without blocking.
    line_queue: queue.Queue = queue.Queue()

    def _reader():
        assert proc.stdout is not None
        for line in proc.stdout:
            line_queue.put(line)
        line_queue.put(None)  # sentinel

    threading.Thread(target=_reader, daemon=True).start()

    cancelled = False
    try:
        while True:
            if cancel_ev.is_set():
                cancelled = True
                proc.kill()
                proc.wait()
                break

            try:
                line = line_queue.get(timeout=0.3)
            except queue.Empty:
                # Check if proc exited without more output
                if proc.poll() is not None:
                    break
                continue

            if line is None:
                break

            try:
                data = json.loads(line.strip())
            except (json.JSONDecodeError, ValueError):
                continue

            if data.get("error"):
                with _download_lock:
                    if model_id in _download_status and not _download_status[model_id].get("done"):
                        _download_status[model_id]["done"]  = True
                        _download_status[model_id]["error"] = data["error"]
                        _download_status[model_id]["last_update"] = time.time()
                _persist_download_state()
                break

            with _download_lock:
                if _download_status[model_id].get("done"):
                    # cancel_download() was called externally
                    cancelled = True
                    proc.kill()
                    proc.wait()
                    break
                st = _download_status[model_id]
                if "total_bytes" in data:
                    st["total_bytes"] = data["total_bytes"]
                if "progress" in data:
                    st["progress"] = data["progress"]
                if "bytes_done" in data:
                    st["bytes_done"] = data["bytes_done"]
                if "file" in data:
                    st["current_file"] = data["file"]
                st["last_update"] = time.time()

            if data.get("done"):
                with _download_lock:
                    _download_status[model_id]["progress"]  = 1.0
                    _download_status[model_id]["done"]       = True
                    _download_status[model_id]["last_update"] = time.time()
                _persist_download_state()
                break

        proc.wait()

        # If the subprocess exited with an error but we didn't capture it above
        if proc.returncode not in (0, -9, -15, None) and not cancelled:
            with _download_lock:
                if model_id in _download_status and not _download_status[model_id].get("done"):
                    _download_status[model_id]["done"]  = True
                    _download_status[model_id]["error"] = f"Download process exited unexpectedly (code {proc.returncode})."
                    _download_status[model_id]["last_update"] = time.time()
            _persist_download_state()

    except Exception as e:
        try:
            proc.kill()
            proc.wait()
        except Exception:
            pass
        with _download_lock:
            if model_id in _download_status and not _download_status[model_id].get("done"):
                _download_status[model_id]["done"]  = True
                _download_status[model_id]["error"] = str(e)
                _download_status[model_id]["last_update"] = time.time()
        _persist_download_state()
    finally:
        _cancel_events.pop(model_id, None)
        if cancelled:
            threading.Thread(target=_cleanup_partial_download, args=(model_id,), daemon=True).start()
        _persist_download_state()


def run_download_worker_subprocess(model_id: str) -> int:
    old_argv = list(sys.argv)
    try:
        sys.argv = [old_argv[0], model_id]
        exec(_DOWNLOAD_SCRIPT, {"__name__": "__main__"})
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 0
    finally:
        sys.argv = old_argv
    return 0
