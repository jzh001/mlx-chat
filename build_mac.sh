#!/usr/bin/env bash
# Build MLX Chat as a standalone macOS .app using PyInstaller.
set -euo pipefail

APP_NAME="MLX Chat"
ENTRY="app.py"

echo "Installing build dependencies..."
pip install pyinstaller 2>/dev/null || true

echo "Building $APP_NAME..."
pyinstaller \
  --name "$APP_NAME" \
  --windowed \
  --noconfirm \
  --add-data "frontend:frontend" \
  --hidden-import "uvicorn.logging" \
  --hidden-import "uvicorn.loops.auto" \
  --hidden-import "uvicorn.protocols.http.auto" \
  --hidden-import "uvicorn.lifespan.on" \
  --hidden-import "sse_starlette" \
  --hidden-import "mlx_vlm" \
  --hidden-import "mlx_vlm.prompt_utils" \
  --hidden-import "mlx_vlm.utils" \
  "$ENTRY"

echo ""
echo "Done! App is at: dist/$APP_NAME.app"
echo "To distribute: zip -r 'MLX Chat.zip' 'dist/MLX Chat.app'"
