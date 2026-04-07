"""
GitHub release checking, update download, and macOS app replacement.
"""
from __future__ import annotations

import json
import logging
import os
import re
import stat
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

import requests
from requests import HTTPError

from . import config as cfg

logger = logging.getLogger("mlx_chat.update_manager")

_GITHUB_API = "https://api.github.com"
_CHECK_CACHE_TTL_S = 6 * 60 * 60
_CHECK_TIMEOUT_S = 3.0
_GITHUB_BACKOFF_S = 300.0
_BUF_SIZE = 1024 * 256
_UPDATE_CACHE_FILE = cfg.APP_DIR / "update_check_cache.json"

_check_lock = threading.Lock()
_check_cache: Dict[str, Any] = {"checked_at": 0.0, "result": None}
_github_backoff_until = 0.0

_download_lock = threading.Lock()
_download_status: Dict[str, Any] = {
    "in_progress": False,
    "done": False,
    "error": None,
    "progress": 0.0,
    "bytes_done": 0,
    "total_bytes": 0,
    "version": None,
    "asset_name": None,
    "asset_path": None,
}


def _version_key(value: Optional[str]) -> tuple:
    text = str(value or "").strip().lower().lstrip("v")
    if not text:
        return (0, 0, 0, 0, "")

    if "-" in text:
        main, suffix = text.split("-", 1)
    elif "+" in text:
        main, suffix = text.split("+", 1)
    else:
        main, suffix = text, ""

    nums = [int(part) for part in re.findall(r"\d+", main)]
    while len(nums) < 3:
        nums.append(0)

    stable_rank = 0 if suffix else 1
    return (nums[0], nums[1], nums[2], stable_rank, suffix)


def _is_newer_version(latest: str, current: str) -> bool:
    return _version_key(latest) > _version_key(current)


def _github_headers() -> Dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "User-Agent": "mlx-chat-updater/1.0",
    }


def _release_api_url() -> str:
    return f"{_GITHUB_API}/repos/{cfg.GITHUB_REPO}/releases/latest"


def _release_page_url() -> str:
    return f"https://github.com/{cfg.GITHUB_REPO}/releases"


def _current_version() -> str:
    return cfg.get_app_version()


def _read_update_cache_file() -> Optional[Dict[str, Any]]:
    try:
        if not _UPDATE_CACHE_FILE.exists():
            return None
        data = json.loads(_UPDATE_CACHE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        logger.debug("Failed reading update cache", exc_info=True)
        return None


def _write_update_cache_file(data: Dict[str, Any]) -> None:
    try:
        tmp_path = _UPDATE_CACHE_FILE.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        tmp_path.replace(_UPDATE_CACHE_FILE)
    except Exception:
        logger.debug("Failed writing update cache", exc_info=True)


def _github_request_allowed() -> bool:
    return time.time() >= _github_backoff_until


def _mark_github_failure() -> None:
    global _github_backoff_until
    _github_backoff_until = time.time() + _GITHUB_BACKOFF_S


def _mark_github_success() -> None:
    global _github_backoff_until
    _github_backoff_until = 0.0


def _find_bundle_path() -> Optional[Path]:
    if not getattr(os.sys, "frozen", False):
        return None

    exe = Path(os.sys.executable).resolve()
    for parent in [exe, *exe.parents]:
        if parent.suffix == ".app":
            return parent
    return None


def _can_install_updates() -> bool:
    return _find_bundle_path() is not None


def _updates_dir_for(version: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", str(version or "unknown"))
    path = cfg.UPDATES_DIR / safe
    path.mkdir(parents=True, exist_ok=True)
    return path


def _choose_release_asset(release: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    assets = release.get("assets") or []
    if not isinstance(assets, list):
        return None

    preferred = []
    fallbacks = []
    for asset in assets:
        name = str(asset.get("name") or "")
        if not name.lower().endswith(".zip"):
            continue
        if ".app" in name.lower():
            preferred.append(asset)
        else:
            fallbacks.append(asset)

    return (preferred or fallbacks or [None])[0]


def _notes_preview(body: str, limit: int = 1200) -> str:
    text = str(body or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n…"


def _normalize_release(release: Dict[str, Any]) -> Dict[str, Any]:
    version = str(release.get("tag_name") or release.get("name") or "").strip()
    asset = _choose_release_asset(release)
    current = _current_version()
    downloaded_path = None
    no_releases = bool(release.get("no_releases"))

    with _download_lock:
        if (
            _download_status.get("done")
            and _download_status.get("version") == version
            and _download_status.get("asset_path")
        ):
            candidate = Path(str(_download_status["asset_path"]))
            if candidate.exists():
                downloaded_path = str(candidate)

    return {
        "current_version": current,
        "latest_version": version,
        "release_name": release.get("name") or version,
        "published_at": release.get("published_at"),
        "html_url": release.get("html_url") or _release_page_url(),
        "release_notes": _notes_preview(release.get("body") or ""),
        "update_available": bool(version) and _is_newer_version(version, current),
        "asset_name": asset.get("name") if asset else None,
        "asset_size": asset.get("size") if asset else None,
        "asset_download_url": asset.get("browser_download_url") if asset else None,
        "can_install": _can_install_updates(),
        "downloaded": downloaded_path is not None,
        "downloaded_path": downloaded_path,
        "no_releases": no_releases,
    }


def _fetch_latest_release(ignore_backoff: bool = False) -> Dict[str, Any]:
    if not ignore_backoff and not _github_request_allowed():
        raise RuntimeError("Update checks are temporarily paused after a recent network failure.")

    try:
        resp = requests.get(_release_api_url(), timeout=_CHECK_TIMEOUT_S, headers=_github_headers())
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict):
            raise RuntimeError("GitHub returned an unexpected release payload.")
        _mark_github_success()
        return data
    except HTTPError as exc:
        response = getattr(exc, "response", None)
        if response is not None and response.status_code == 404:
            _mark_github_success()
            return {
                "tag_name": None,
                "name": None,
                "published_at": None,
                "html_url": _release_page_url(),
                "body": "",
                "assets": [],
                "no_releases": True,
            }
        raise


def check_for_updates(force: bool = False) -> Dict[str, Any]:
    now = time.time()
    with _check_lock:
        cached = _check_cache.get("result")
        checked_at = float(_check_cache.get("checked_at") or 0.0)
        if not force and cached and now - checked_at < _CHECK_CACHE_TTL_S:
            return dict(cached)

    try:
        result = _normalize_release(_fetch_latest_release(ignore_backoff=force))
        result["offline"] = False
        result["stale"] = False
    except Exception as exc:
        logger.info("Update check unavailable: %s", exc)
        _mark_github_failure()
        cached_file = _read_update_cache_file()
        if cached_file:
            fallback = dict(cached_file)
            fallback["offline"] = True
            fallback["stale"] = True
            fallback["error"] = str(exc)
            return fallback
        with _download_lock:
            downloaded = (
                _download_status.get("done")
                and _download_status.get("asset_path")
                and Path(str(_download_status["asset_path"])).exists()
            )
            downloaded_version = _download_status.get("version")
        return {
            "current_version": _current_version(),
            "latest_version": downloaded_version,
            "release_name": None,
            "published_at": None,
            "html_url": _release_page_url(),
            "release_notes": "",
            "update_available": False,
            "asset_name": None,
            "asset_size": None,
            "asset_download_url": None,
            "can_install": _can_install_updates(),
            "downloaded": bool(downloaded),
            "downloaded_path": _download_status.get("asset_path"),
            "offline": True,
            "stale": True,
            "error": str(exc),
        }

    with _check_lock:
        _check_cache["checked_at"] = now
        _check_cache["result"] = dict(result)
    _write_update_cache_file(dict(result))
    return result


def get_download_status() -> Dict[str, Any]:
    with _download_lock:
        return dict(_download_status)


def _set_download_status(**updates: Any) -> None:
    with _download_lock:
        _download_status.update(updates)


def _download_update_worker(release_info: Dict[str, Any]) -> None:
    version = str(release_info.get("latest_version") or "")
    asset_url = str(release_info.get("asset_download_url") or "")
    asset_name = str(release_info.get("asset_name") or "")

    if not version or not asset_url or not asset_name:
        _set_download_status(
            in_progress=False,
            done=True,
            error="No downloadable release asset was found.",
        )
        return

    target_dir = _updates_dir_for(version)
    tmp_path = target_dir / f"{asset_name}.part"
    final_path = target_dir / asset_name

    try:
        if final_path.exists():
            final_path.unlink()
        if tmp_path.exists():
            tmp_path.unlink()
    except FileNotFoundError:
        pass

    try:
        with requests.get(asset_url, stream=True, timeout=60, headers=_github_headers()) as resp:
            resp.raise_for_status()
            total_bytes = int(resp.headers.get("Content-Length") or release_info.get("asset_size") or 0)
            _set_download_status(total_bytes=total_bytes)
            with open(tmp_path, "wb") as fh:
                bytes_done = 0
                for chunk in resp.iter_content(chunk_size=_BUF_SIZE):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    bytes_done += len(chunk)
                    progress = (bytes_done / total_bytes) if total_bytes > 0 else 0.0
                    _set_download_status(
                        bytes_done=bytes_done,
                        progress=max(0.0, min(progress, 1.0)),
                    )

        tmp_path.replace(final_path)
        _set_download_status(
            in_progress=False,
            done=True,
            progress=1.0,
            bytes_done=final_path.stat().st_size,
            total_bytes=final_path.stat().st_size,
            asset_path=str(final_path),
            error=None,
        )
    except Exception as exc:
        logger.warning("Failed to download update", exc_info=True)
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass
        _set_download_status(
            in_progress=False,
            done=True,
            error=str(exc),
        )


def start_update_download() -> Dict[str, Any]:
    release_info = check_for_updates(force=True)
    if release_info.get("error"):
        raise RuntimeError(release_info["error"])
    if not release_info.get("update_available"):
        raise RuntimeError("No update is currently available.")
    if not release_info.get("asset_download_url"):
        raise RuntimeError("No downloadable zip asset was found for the latest release.")

    with _download_lock:
        if _download_status.get("in_progress"):
            return dict(_download_status)
        if (
            _download_status.get("done")
            and _download_status.get("version") == release_info.get("latest_version")
            and _download_status.get("asset_path")
            and Path(str(_download_status["asset_path"])).exists()
        ):
            return dict(_download_status)

        _download_status.clear()
        _download_status.update({
            "in_progress": True,
            "done": False,
            "error": None,
            "progress": 0.0,
            "bytes_done": 0,
            "total_bytes": int(release_info.get("asset_size") or 0),
            "version": release_info.get("latest_version"),
            "asset_name": release_info.get("asset_name"),
            "asset_path": None,
        })

    worker = threading.Thread(target=_download_update_worker, args=(release_info,), daemon=True)
    worker.start()
    return get_download_status()


def _install_script_contents() -> str:
    return """#!/bin/bash
set -euo pipefail

PID="$1"
CURRENT_APP="$2"
ARCHIVE_PATH="$3"
STAGE_DIR="$4"

while kill -0 "$PID" 2>/dev/null; do
  sleep 0.25
done

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
ditto -x -k "$ARCHIVE_PATH" "$STAGE_DIR"

NEW_APP="$(find "$STAGE_DIR" -maxdepth 3 -type d -name '*.app' | head -n 1)"
if [ -z "$NEW_APP" ]; then
  echo "No .app bundle found in update archive." >&2
  exit 1
fi

TARGET_DIR="$(dirname "$CURRENT_APP")"
TARGET_APP="$TARGET_DIR/$(basename "$NEW_APP")"
TMP_APP="$TARGET_APP.updating"

rm -rf "$TMP_APP"
mv "$NEW_APP" "$TMP_APP"
rm -rf "$TARGET_APP"
mv "$TMP_APP" "$TARGET_APP"
open "$TARGET_APP"
"""


def install_update_and_restart(pid: int) -> Dict[str, Any]:
    bundle_path = _find_bundle_path()
    if bundle_path is None:
        raise RuntimeError("Automatic install/restart is only available in the packaged .app build.")

    with _download_lock:
        asset_path = _download_status.get("asset_path")
        version = _download_status.get("version")

    if not asset_path:
        raise RuntimeError("No downloaded update is ready to install.")

    archive = Path(str(asset_path))
    if not archive.exists():
        raise RuntimeError("The downloaded update archive is missing.")

    work_dir = Path(tempfile.mkdtemp(prefix="mlx-chat-update-"))
    stage_dir = work_dir / "stage"
    script_path = work_dir / "install_update.sh"
    script_path.write_text(_install_script_contents(), encoding="utf-8")
    script_path.chmod(script_path.stat().st_mode | stat.S_IXUSR)

    subprocess.Popen(
        ["/bin/bash", str(script_path), str(pid), str(bundle_path), str(archive), str(stage_dir)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    return {"status": "restarting", "version": version}
