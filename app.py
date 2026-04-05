#!/usr/bin/env python3
"""
MLX Chat – entry point.
Starts a local FastAPI server then opens a native macOS window via PyWebView.
"""
import sys
import threading
import time
import socket


def _find_free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = _find_free_port()
SERVER_URL = f"http://127.0.0.1:{PORT}"


def _start_server():
    import uvicorn
    from backend.server import app
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


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
    # Start FastAPI in a background daemon thread
    server_thread = threading.Thread(target=_start_server, daemon=True)
    server_thread.start()

    if not _wait_for_server():
        print("ERROR: Server failed to start.", file=sys.stderr)
        sys.exit(1)

    # Open native macOS window with PyWebView (uses WKWebView – minimal memory)
    try:
        import webview

        window = webview.create_window(
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
        print(f"PyWebView not found. Opening in browser at {SERVER_URL}")
        webbrowser.open(SERVER_URL)
        # Keep server alive
        try:
            server_thread.join()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
