#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The AppImage target must be built on Linux."
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  echo "The Steam Deck AppImage target must be built on x86_64 Linux, got $ARCH."
  exit 1
fi

if [[ "${APPIMAGE_SKIP_BINARY_BUILD:-0}" != "1" ]]; then
  bash scripts/build_linux_release.sh
fi

BINARY="$ROOT_DIR/dist/lego-technic-gamepad-bridge"
if [[ ! -x "$BINARY" ]]; then
  echo "Missing Linux release binary: $BINARY"
  exit 1
fi

APPDIR="$ROOT_DIR/build/appimage/LEGO_Technic_Gamepad_Bridge.AppDir"
OUTPUT="${APPIMAGE_OUTPUT:-$ROOT_DIR/dist/lego-technic-gamepad-bridge.AppImage}"
ICON_SOURCE="$ROOT_DIR/assets/lego-technic-gamepad-bridge.svg"
APPIMAGETOOL="${APPIMAGETOOL:-appimagetool}"

rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/icons/hicolor/scalable/apps"

cp "$BINARY" "$APPDIR/usr/bin/lego-technic-gamepad-bridge"
cp "$ICON_SOURCE" "$APPDIR/lego-technic-gamepad-bridge.svg"
cp "$ICON_SOURCE" "$APPDIR/usr/share/icons/hicolor/scalable/apps/lego-technic-gamepad-bridge.svg"
ln -s "lego-technic-gamepad-bridge.svg" "$APPDIR/.DirIcon"

cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
BINARY="$HERE/usr/bin/lego-technic-gamepad-bridge"

export SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS="${SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS:-1}"
export SDL_JOYSTICK_HIDAPI="${SDL_JOYSTICK_HIDAPI:-1}"
export SDL_JOYSTICK_HIDAPI_STEAM="${SDL_JOYSTICK_HIDAPI_STEAM:-1}"
export SDL_JOYSTICK_HIDAPI_STEAMDECK="${SDL_JOYSTICK_HIDAPI_STEAMDECK:-1}"

if [[ "${LEGO_BRIDGE_NO_TERMINAL_LAUNCH:-0}" == "1" || "${LEGO_BRIDGE_IN_TERMINAL:-0}" == "1" ]]; then
  exec "$BINARY" "$@"
fi

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      exec "$BINARY" "$@"
      ;;
  esac
done

if [[ -t 0 && -t 1 ]]; then
  exec "$BINARY" "$@"
fi

if command -v konsole >/dev/null 2>&1; then
  exec konsole --workdir "$HOME" -e env LEGO_BRIDGE_IN_TERMINAL=1 "$BINARY" "$@"
fi

if command -v x-terminal-emulator >/dev/null 2>&1; then
  exec x-terminal-emulator -e env LEGO_BRIDGE_IN_TERMINAL=1 "$BINARY" "$@"
fi

if command -v xterm >/dev/null 2>&1; then
  exec xterm -e env LEGO_BRIDGE_IN_TERMINAL=1 "$BINARY" "$@"
fi

exec "$BINARY" "$@"
EOF
chmod +x "$APPDIR/AppRun"

cat > "$APPDIR/lego-technic-gamepad-bridge.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=LEGO Technic Gamepad Bridge
Comment=Control a LEGO Technic Move Hub from a gamepad
Exec=lego-technic-gamepad-bridge
Icon=lego-technic-gamepad-bridge
Terminal=false
Categories=Game;Utility;
EOF

mkdir -p "$(dirname "$OUTPUT")"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" "$APPDIR" "$OUTPUT"
chmod +x "$OUTPUT"

echo "Built $OUTPUT"
