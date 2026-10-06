#!/usr/bin/env bash
# One Sonnet tick of the field soak, run by launchd (com.streetcryptid.field-tick). Headless:
# `claude -p` follows the field-soak skill with a tool allowlist that can drive `fs`, read the repo
# and write only the soak's own state directory.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE="${FIELD_SOAK_STATE:-$HOME/.local/state/streetcryptid-field}"
CLAUDE="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
mkdir -p "$STATE/ticks"

# One tick at a time: a slow tick must not overlap the next. mkdir is atomic; a lock older than
# 90 min belongs to a tick that died.
LOCK="$STATE/tick.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +90 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK"; else exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT

cd "$REPO"
mode="${1:-full}"  # full: the scheduled tick | chat: woken by a Discord message (listen.py)
log="$STATE/ticks/$(date +%Y%m%d-%H%M%S)-$mode.log"
if [ "$mode" = chat ]; then
  timeout_s=$((15 * 60))
  prompt="Someone just wrote to you on Discord. This is a CHAT tick, not a full one: load the field-soak skill for context and its rules, run \`fs inbox\`, and answer each message with \`fs say --reply-to <id>\`. Do what the messages ask if the skill allows it (look at the app, plan or change an outing, check how something is doing), and log anything asked in journal.md. Do not run the full tick checklist. State dir: $STATE."
else
  timeout_s=$((45 * 60))
  prompt="Run one field-soak tick: invoke the field-soak skill and follow it exactly. State dir: $STATE."
fi
# The prompt goes in on stdin: --allowedTools is variadic and would swallow a trailing argument.
# Edit(path) rules cover every file-writing tool, Write included. In permission rules a leading
# `/` is relative to the project, so an absolute state path must be spelled `~/` (or `//`).
echo "$prompt" |
  "$CLAUDE" -p --model sonnet \
    --add-dir "$STATE" \
    --allowedTools "Bash(scripts/field-soak/fs:*)" "Bash(TZ=Asia/Tokyo date:*)" "Bash(date:*)" \
      "Bash(launchctl print:*)" "Bash(tail:*)" "Read" "Grep" "Glob" "Skill" "Edit(~/.local/state/streetcryptid-field/**)" \
    >"$log" 2>&1 &
pid=$!
( sleep "$timeout_s"; kill "$pid" 2>/dev/null ) &
watchdog=$!
wait "$pid" || echo "tick exited $?" >>"$log"
kill "$watchdog" 2>/dev/null || true
# Keep two weeks of tick logs.
find "$STATE/ticks" -name '*.log' -mtime +14 -delete
