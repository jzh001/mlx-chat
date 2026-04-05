import json
import os
from pathlib import Path
from typing import Any, Dict

APP_DIR = Path.home() / ".mlx_chat"
CONVERSATIONS_DIR = APP_DIR / "conversations"
SETTINGS_DIR = APP_DIR / "settings"

for d in [APP_DIR, CONVERSATIONS_DIR, SETTINGS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

DEFAULT_SETTINGS = {
    "temperature": 0.7,
    "top_p": 0.9,
    "max_tokens": 2048,
    "repetition_penalty": 1.1,
    "repetition_context_size": 20,
    "system_prompt": "",
    "use_turboquant": False,
    "kv_bits": 4.0,
}


def _settings_path(model_id: str) -> Path:
    safe = model_id.replace("/", "__")
    return SETTINGS_DIR / f"{safe}.json"


def load_settings(model_id: str) -> Dict[str, Any]:
    path = _settings_path(model_id)
    if path.exists():
        with open(path) as f:
            stored = json.load(f)
        return {**DEFAULT_SETTINGS, **stored}
    return dict(DEFAULT_SETTINGS)


def save_settings(model_id: str, settings: Dict[str, Any]) -> None:
    path = _settings_path(model_id)
    merged = {**DEFAULT_SETTINGS, **settings}
    with open(path, "w") as f:
        json.dump(merged, f, indent=2)


def list_conversations():
    convs = []
    for p in sorted(CONVERSATIONS_DIR.glob("*.json"), key=os.path.getmtime, reverse=True):
        try:
            with open(p) as f:
                data = json.load(f)
            convs.append({
                "id": data["id"],
                "title": data.get("title", "Untitled"),
                "model": data.get("model", ""),
                "updated_at": data.get("updated_at", ""),
            })
        except Exception:
            pass
    return convs


def load_conversation(conv_id: str) -> Dict | None:
    p = CONVERSATIONS_DIR / f"{conv_id}.json"
    if not p.exists():
        return None
    with open(p) as f:
        return json.load(f)


def save_conversation(conv: Dict) -> None:
    p = CONVERSATIONS_DIR / f"{conv['id']}.json"
    with open(p, "w") as f:
        json.dump(conv, f, indent=2)


def delete_conversation(conv_id: str) -> bool:
    p = CONVERSATIONS_DIR / f"{conv_id}.json"
    if p.exists():
        p.unlink()
        return True
    return False
