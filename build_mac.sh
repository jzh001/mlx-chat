#!/usr/bin/env bash
# Build MLX Chat as a standalone macOS .app using PyInstaller.
set -euo pipefail

APP_NAME="MLX Chat"
ENTRY="app.py"

echo "Installing build dependencies..."
pip install pyinstaller 2>/dev/null || true

echo "Building $APP_NAME..."
pyinstaller_args=(
  --name "$APP_NAME"
  --windowed
  --clean
  --noconfirm
  --add-data "frontend:frontend"
  --add-data "VERSION:."
  --hidden-import "uvicorn.logging"
  --hidden-import "uvicorn.loops.auto"
  --hidden-import "uvicorn.protocols.http.auto"
  --hidden-import "uvicorn.lifespan.on"
  --hidden-import "sse_starlette"
  --collect-all "mlx"
  --collect-all "mlx_lm"
  --collect-all "mlx_vlm"
  "$ENTRY"
)

pyinstaller "${pyinstaller_args[@]}"

echo ""
echo "Done! App is at: dist/$APP_NAME.app"
echo "To distribute: zip -r 'MLX Chat.zip' 'dist/MLX Chat.app'"
