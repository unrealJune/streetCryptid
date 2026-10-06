#!/usr/bin/env bash
# Install (or refresh) the field soak's two LaunchAgents:
#   com.streetcryptid.field-walker  KeepAlive daemon that owns the phone tunnel and drives GPS
#   com.streetcryptid.field-tick    a headless Sonnet tick every TICK_HOURS (default 2)
#   com.streetcryptid.field-listen  polls Discord; a human message wakes a short Sonnet chat tick
# Usage: scripts/field-soak/install.sh [walker|tick|listen|all] ; scripts/field-soak/install.sh uninstall
# The walker needs no root: pymobiledevice3's userspace tunnel replaces `sudo tunneld`.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HOME/.local/share/streetcryptid-field/venv"
STATE="$HOME/.local/state/streetcryptid-field"
AGENTS="$HOME/Library/LaunchAgents"
TICK_HOURS="${TICK_HOURS:-2}"
what="${1:-all}"
mkdir -p "$STATE" "$AGENTS"

if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q pymobiledevice3
fi

load() {
  local label="$1" plist="$AGENTS/$1.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "loaded $label"
}

if [ "$what" = uninstall ]; then
  for l in com.streetcryptid.field-walker com.streetcryptid.field-tick com.streetcryptid.field-listen; do
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
    rm -f "$AGENTS/$l.plist"
  done
  echo "uninstalled (state kept in $STATE)"
  exit 0
fi

if [ "$what" = all ] || [ "$what" = walker ]; then
  cat >"$AGENTS/com.streetcryptid.field-walker.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.streetcryptid.field-walker</string>
  <key>ProgramArguments</key><array>
    <string>$VENV/bin/python</string><string>$HERE/walker.py</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>$STATE/walker.log</string>
  <key>StandardErrorPath</key><string>$STATE/walker.log</string>
</dict></plist>
EOF
  load com.streetcryptid.field-walker
fi

if [ "$what" = all ] || [ "$what" = tick ]; then
  cat >"$AGENTS/com.streetcryptid.field-tick.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.streetcryptid.field-tick</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/tick.sh</string></array>
  <key>StartInterval</key><integer>$((TICK_HOURS * 3600))</integer>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$STATE/tick-launchd.log</string>
  <key>StandardErrorPath</key><string>$STATE/tick-launchd.log</string>
</dict></plist>
EOF
  load com.streetcryptid.field-tick
fi

if [ "$what" = all ] || [ "$what" = listen ]; then
  cat >"$AGENTS/com.streetcryptid.field-listen.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.streetcryptid.field-listen</string>
  <key>ProgramArguments</key><array>
    <string>$VENV/bin/python</string><string>$HERE/listen.py</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$STATE/listen.log</string>
  <key>StandardErrorPath</key><string>$STATE/listen.log</string>
</dict></plist>
EOF
  load com.streetcryptid.field-listen
fi
