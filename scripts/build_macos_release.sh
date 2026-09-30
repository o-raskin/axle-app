#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The single-file release target must be built on macOS."
  exit 1
fi

# Install requirements-build.txt in the selected interpreter before invoking.
exec "${PYTHON_BIN:-python3}" "$ROOT_DIR/scripts/build_release.py" "$@"
