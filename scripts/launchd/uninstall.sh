#!/usr/bin/env bash
set -euo pipefail
DST="$HOME/Library/LaunchAgents"
plist="$DST/com.tanishk.sentinel.plist"
if [[ -f "$plist" ]]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "Removed com.tanishk.sentinel"
fi
