"""
HuggingFace model management: list local, search, download, delete.
All models are from the mlx-community organization.
"""
import os
import shutil
import threading
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

import psutil

MLX_ORG = "mlx-community"

# Progress tracking for active downloads: model_id → {"progress": 0.0, "done": False, "error": None}
_download_status: Dict[str, Dict] = {}
_download_lock = threading.Lock()


# ── Memory helpers ──────────────────────────────────────────────────────────

def get_system_memory() -> Dict[str, float]:
    vm = psutil.virtual_memory()
    return {
        "total_gb": vm.total / 1e9,
        "available_gb": vm.available / 1e9,
        "used_gb": vm.used / 1e9,
        "percent": vm.percent,
    }


def _gpu_label(model_size_gb: Optional[float]) -> str:
    if model_size_gb is None:
        return "unknown"
    mem = get_system_memory()
    available = mem["available_gb"]
    total = mem["total_gb"]
    if model_size_gb < available * 0.85:
        return "full"
    if model_size_gb < total:
        return "partial"
    return "too_large"


# ── Local model helpers ──────────────────────────────────────────────────────

def _hf_cache_root() -> Path:
    return Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"


def list_local_models() -> List[Dict[str, Any]]:
    """Return mlx-community models already in the HF cache."""
    from huggingface_hub import scan_cache_dir
    try:
        cache = scan_cache_dir()
    except Exception:
        return []

    results = []
    for repo in cache.repos:
        if not repo.repo_id.startswith(f"{MLX_ORG}/"):
            continue
        size_gb = repo.size_on_disk / 1e9
        results.append({
            "id": repo.repo_id,
            "name": repo.repo_id.split("/", 1)[-1],
            "size_gb": round(size_gb, 2),
            "gpu_label": _gpu_label(size_gb),
        })
    return results


def delete_local_model(model_id: str) -> bool:
    """Remove a model from the HF cache. Returns True if removed."""
    from huggingface_hub import scan_cache_dir
    try:
        cache = scan_cache_dir()
        for repo in cache.repos:
            if repo.repo_id == model_id:
                delete_strategy = cache.delete_revisions(*[r.commit_hash for r in repo.revisions])
                delete_strategy.execute()
                return True
    except Exception:
        pass

    # Fallback: manual directory removal
    safe = model_id.replace("/", "--")
    path = _hf_cache_root() / f"models--{safe}"
    if path.exists():
        shutil.rmtree(path)
        return True
    return False


# ── HuggingFace search ───────────────────────────────────────────────────────

def _model_size_from_info(info) -> Optional[float]:
    """Estimate model size in GB from HF ModelInfo."""
    try:
        total = sum(s.size for s in info.siblings if s.size is not None)
        if total:
            return round(total / 1e9, 2)
    except Exception:
        pass
    return None


def search_models(query: str = "", limit: int = 30) -> List[Dict[str, Any]]:
    from huggingface_hub import list_models
    try:
        kwargs = dict(author=MLX_ORG, sort="downloads", direction=-1, limit=limit, full=True)
        if query:
            kwargs["search"] = query
        models = list(list_models(**kwargs))
    except Exception as e:
        return []

    mem = get_system_memory()
    results = []
    for m in models:
        size_gb = _model_size_from_info(m)
        results.append({
            "id": m.modelId,
            "name": m.modelId.split("/", 1)[-1],
            "downloads": getattr(m, "downloads", 0) or 0,
            "size_gb": size_gb,
            "gpu_label": _gpu_label(size_gb),
            "tags": list(getattr(m, "tags", []) or [])[:8],
        })
    return results


# ── Download ─────────────────────────────────────────────────────────────────

def get_download_status(model_id: str) -> Optional[Dict]:
    return _download_status.get(model_id)


def start_download(model_id: str) -> None:
    """Begin downloading a model in a background thread."""
    with _download_lock:
        if model_id in _download_status and not _download_status[model_id].get("done"):
            return  # Already in progress
        _download_status[model_id] = {"progress": 0.0, "done": False, "error": None, "current_file": ""}

    t = threading.Thread(target=_download_worker, args=(model_id,), daemon=True)
    t.start()


def _download_worker(model_id: str) -> None:
    try:
        from huggingface_hub import model_info, hf_hub_download

        info = model_info(model_id)
        siblings = [s for s in info.siblings if s.rfilename]
        total = len(siblings)

        for i, sibling in enumerate(siblings):
            with _download_lock:
                _download_status[model_id]["current_file"] = sibling.rfilename
                _download_status[model_id]["progress"] = i / max(total, 1)

            hf_hub_download(repo_id=model_id, filename=sibling.rfilename)

        with _download_lock:
            _download_status[model_id]["progress"] = 1.0
            _download_status[model_id]["done"] = True

    except Exception as e:
        with _download_lock:
            _download_status[model_id]["error"] = str(e)
            _download_status[model_id]["done"] = True
