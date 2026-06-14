#!/usr/bin/env bash
# Sentinel server entrypoint for launchd.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PROJECT}/backend/.venv/bin/python"

cd "$PROJECT/backend"
exec "$PY" -m sentinel.server
