#!/usr/bin/env python3
"""
MLX Chat – entry point.
Starts a local FastAPI server then opens a native macOS window via PyWebView.
"""
import fcntl
import logging
from logging.handlers import RotatingFileHandler
import sys
import threading
import time
import socket

import uvicorn

from backend import config as cfg


def _configure_logging() -> None:
    log_file = cfg.LOG_FILE
    log_file.parent.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger()
    if root.handlers:
        return

    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    stream_handler = logging.StreamHandler(sys.stderr)
    stream_handler.setFormatter(formatter)

    root.setLevel(logging.INFO)
    root.addHandler(file_handler)
    root.addHandler(stream_handler)

    def _log_unhandled_exception(exc_type, exc_value, exc_traceback):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_traceback)
            return
        logging.getLogger("mlx_chat").exception(
            "Unhandled exception",
            exc_info=(exc_type, exc_value, exc_traceback),
        )

    def _log_thread_exception(args):
        logging.getLogger("mlx_chat").exception(
            "Unhandled thread exception",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = _log_unhandled_exception
    threading.excepthook = _log_thread_exception


_instance_lock_fh = None


def _acquire_instance_lock() -> bool:
    """Try to acquire an exclusive process lock. Returns False if another instance is running."""
    global _instance_lock_fh
    lock_path = cfg.APP_DIR / "app.lock"
    fh = open(lock_path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return False
    # Keep the file handle open — closing it releases the lock.
    _instance_lock_fh = fh
    return True


def _find_free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = _find_free_port()
SERVER_URL = f"http://127.0.0.1:{PORT}"

_uvicorn_server = None


def _start_server():
    global _uvicorn_server
    from backend.server import app

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=PORT,
        log_level="warning",
        loop="asyncio",
        lifespan="on",
    )
    _uvicorn_server = uvicorn.Server(config)
    _uvicorn_server.run()


def _stop_server(timeout: float = 2.0):
    global _uvicorn_server
    if _uvicorn_server is None:
        return
    _uvicorn_server.should_exit = True

    deadline = time.time() + timeout
    while time.time() < deadline:
        if getattr(_uvicorn_server, "started", False) is False:
            break
        time.sleep(0.05)

    # Don't let slow shutdown hooks hold the UI close path.
    if getattr(_uvicorn_server, "started", False):
        _uvicorn_server.force_exit = True


def _wait_for_server(timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def main():
    _configure_logging()
    logger = logging.getLogger("mlx_chat")

    if not _acquire_instance_lock():
        logger.warning("Another instance of MLX Chat is already running — exiting.")
        sys.exit(0)

    logger.info("Starting MLX Chat")

    # Run the server in a daemon thread so UI close is never blocked on teardown.
    server_thread = threading.Thread(target=_start_server, daemon=True)
    server_thread.start()

    if not _wait_for_server():
        logger.error("Server failed to start")
        print("ERROR: Server failed to start.", file=sys.stderr)
        sys.exit(1)

    # Open native macOS window with PyWebView (uses WKWebView – minimal memory)
    # Note: Python 3.14 may still be unstable with current PyWebView/Cocoa stacks.
    try:
        import webview

        webview.create_window(
            title="MLX Chat",
            url=SERVER_URL,
            width=1280,
            height=820,
            min_size=(900, 600),
            text_select=True,
        )
        webview.start(debug=("--debug" in sys.argv))

    except ImportError:
        # Fallback: open in system browser if PyWebView not installed
        import webbrowser
        logger.warning("PyWebView not available, falling back to browser mode")
        print(f"PyWebView not found. Opening in browser at {SERVER_URL}")
        webbrowser.open(SERVER_URL)
        # Keep server alive
        try:
            server_thread.join()
        except KeyboardInterrupt:
            pass
    except Exception:
        logger.exception("App failed while launching webview")
        raise
    finally:
        logger.info("Stopping MLX Chat")
        _stop_server(timeout=0.15)


if __name__ == "__main__":
    main()
