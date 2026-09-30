#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "The Linux release target must be built on Linux."
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  echo "The Linux release target must be built on x86_64 Linux, got $ARCH."
  exit 1
fi

# Install requirements-build.txt in the selected interpreter before invoking.
exec "${PYTHON_BIN:-python3}" "$ROOT_DIR/scripts/build_release.py" "$@"
