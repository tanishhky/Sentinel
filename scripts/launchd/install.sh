#!/usr/bin/env bash
# Install Sentinel server to launchd (auto-start on login).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/Library/LaunchAgents"
mkdir -p "$DST"

label="com.tanishk.sentinel"
plist="${label}.plist"

if launchctl list | grep -q "$label"; then
    echo "Unloading existing $label..."
    launchctl unload "$DST/$plist" 2>/dev/null || true
fi

cp "$SRC/$plist" "$DST/$plist"
launchctl load "$DST/$plist"

echo "Loaded $label -> $DST/$plist"
echo
echo "Verify:   launchctl list | grep sentinel"
echo "Tail:     tail -f logs/sentinel.out"
echo "Open:     open http://127.0.0.1:8765"
