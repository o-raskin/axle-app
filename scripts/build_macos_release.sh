#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The single-file release target must be built on macOS."
  exit 1
fi

PYTHON_BIN="${PYTHON_BIN:-python3}"
BUILD_VENV="${BUILD_VENV:-.venv-release}"

if [[ ! -d "$BUILD_VENV" ]]; then
  "$PYTHON_BIN" -m venv "$BUILD_VENV"
fi

source "$BUILD_VENV/bin/activate"
python -m pip install --upgrade pip
python -m pip install -r requirements-build.txt

python -m PyInstaller \
  --clean \
  --noconfirm \
  --onefile \
  --name lego-technic-gamepad-bridge \
  --specpath build/pyinstaller \
  --add-data "$ROOT_DIR/config/models:config/models" \
  --add-data "$ROOT_DIR/config/gamepads:config/gamepads" \
  --add-data "$ROOT_DIR/beep.mp3:." \
  --collect-all bleak \
  --hidden-import pygame._sdl2.audio \
  --hidden-import pygame._sdl2.sdl2 \
  gamepad_bridge.py

echo "Built dist/lego-technic-gamepad-bridge"
