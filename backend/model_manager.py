"""
HuggingFace model management: list local, search, download, delete.
All models are from the mlx-community organization.
"""
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import psutil

MLX_ORG = "mlx-community"
_GiB = 1024 ** 3  # bytes → gibibytes (matches Apple's "GB" labelling)
_HF_API  = "https://huggingface.co/api/models"

# Progress tracking for active downloads
_download_status: Dict[str, Dict] = {}
_download_lock = threading.Lock()

# Small LRU-style cache for individual model sizes (usedStorage)
_size_cache: Dict[str, Optional[float]] = {}
_SIZE_CACHE_MAX = 500

# Capability cache (vision/text-only)
_cap_cache: Dict[str, Dict[str, Any]] = {}
_CAP_CACHE_MAX = 500

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

    # Active param count takes precedence for MoE  (e.g. "a4b" in "26b-a4b")
    active = re.search(r'[\-_]a(\d+(?:\.\d+)?)b', n)
    if active:
        params_b = float(active.group(1))
    else:
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


def list_local_models() -> List[Dict[str, Any]]:
    from huggingface_hub import scan_cache_dir
    try:
        cache = scan_cache_dir()
    except Exception:
        return []

    results = []
    for repo in cache.repos:
        if not repo.repo_id.startswith(f"{MLX_ORG}/"):
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
    try:
        cache = scan_cache_dir()
        for repo in cache.repos:
            if repo.repo_id == model_id:
                strategy = cache.delete_revisions(*[r.commit_hash for r in repo.revisions])
                strategy.execute()
                return True
    except Exception:
        pass

    safe = model_id.replace("/", "--")
    path = _hf_cache_root() / f"models--{safe}"
    if path.exists():
        shutil.rmtree(path)
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


def get_download_status(model_id: str) -> Optional[Dict]:
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
        elif stalled:
            with _download_lock:
                _download_status[model_id]["done"]  = True
                _download_status[model_id]["error"] = "Download stalled (no progress for 5 minutes)."

    return dict(_download_status[model_id])


def start_download(model_id: str) -> None:
    with _download_lock:
        existing = _download_status.get(model_id)
        if existing and not existing.get("done"):
            return  # already in progress
        now = time.time()
        _download_status[model_id] = {
            "progress":    0.0,
            "done":        False,
            "error":       None,
            "current_file": "",
            "start_time":  now,
            "last_update": now,
        }

    t = threading.Thread(target=_download_worker, args=(model_id,), daemon=True)
    t.start()


def _download_worker(model_id: str) -> None:
    try:
        from huggingface_hub import model_info, hf_hub_download

        info = model_info(model_id)
        siblings = [s for s in info.siblings if s.rfilename]
        total = max(len(siblings), 1)

        for i, sibling in enumerate(siblings):
            with _download_lock:
                if _download_status[model_id].get("done"):
                    return  # cancelled / timed out
                _download_status[model_id]["current_file"] = sibling.rfilename
                _download_status[model_id]["progress"]     = i / total
                _download_status[model_id]["last_update"]  = time.time()

            hf_hub_download(repo_id=model_id, filename=sibling.rfilename)

        with _download_lock:
            _download_status[model_id]["progress"]    = 1.0
            _download_status[model_id]["done"]        = True
            _download_status[model_id]["last_update"] = time.time()

    except Exception as e:
        with _download_lock:
            if model_id in _download_status:
                _download_status[model_id]["error"]       = str(e)
                _download_status[model_id]["done"]        = True
                _download_status[model_id]["last_update"] = time.time()
