#!/usr/bin/env bash
# Sentinel server entrypoint for launchd.
set -euo pipefail

PROJECT="/Users/tanishkyadav/dev/Sentinel"
PY="${PROJECT}/backend/.venv/bin/python"

cd "$PROJECT/backend"
exec "$PY" -m sentinel.server
