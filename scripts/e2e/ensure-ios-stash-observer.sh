#!/usr/bin/env bash
# Create or reuse a host-side friend that reads the simulator's encrypted trail through stash only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
DEVICE="${1:?Usage: ensure-ios-stash-observer.sh <simulator-udid> [state-dir]}"
STATE_DIR="${2:-$HOME/Library/Application Support/streetcryptid/e2e-stash-observer/$DEVICE}"
BIN="$REPO_ROOT/modules/iroh-location/rust/target/debug/trail-stash-client"

log() { echo "[ios-stash-observer] $*" >&2; }

hierarchy() {
  maestro --udid "$DEVICE" hierarchy 2>/dev/null
}

hierarchy_has_id() {
  hierarchy | python3 "$SCRIPT_DIR/hierarchy_text.py" "$1" >/dev/null 2>&1
}

status_is_paired() {
  "$BIN" --state-dir "$STATE_DIR" status 2>/dev/null | grep '^paired=true$' >/dev/null
}

command -v maestro >/dev/null 2>&1 || {
  echo "error: maestro not found on PATH" >&2
  exit 1
}

log "Building the stash-only observer"
cargo build --quiet --manifest-path "$REPO_ROOT/modules/iroh-location/rust/Cargo.toml" \
  --features cli --bin trail-stash-client

if status_is_paired; then
  log "Reusing paired observer state at $STATE_DIR"
  printf '%s\n' "$STATE_DIR"
  exit 0
fi

mkdir -p "$STATE_DIR"
xcrun simctl privacy "$DEVICE" grant location "$APP_ID" >/dev/null 2>&1 || true
if hierarchy | grep -q 'Open in .streetCryptid'; then
  maestro --udid "$DEVICE" test "$REPO_ROOT/.maestro/pairing/dismiss-deep-link.yaml" \
    >/dev/null
fi
maestro --udid "$DEVICE" test -e USERNAME="iosobserver$((RANDOM % 10000))" \
  "$REPO_ROOT/.maestro/onboarding/ensure-onboarded.yaml"

pair_log="$(mktemp)"
pair_fifo="$(mktemp)"
rm -f "$pair_fifo"
mkfifo "$pair_fifo"
exec 3<>"$pair_fifo"
pair_pid=""
cleanup() {
  if [ -n "$pair_pid" ] && kill -0 "$pair_pid" >/dev/null 2>&1; then kill "$pair_pid"; fi
  exec 3>&-
  rm -f "$pair_log" "$pair_fifo"
}
trap cleanup EXIT

log "Pairing a dedicated stash observer through the real SAS flow"
"$BIN" --state-dir "$STATE_DIR" pair --force --simulator "$DEVICE" \
  <"$pair_fifo" >"$pair_log" 2>&1 &
pair_pid="$!"

role=""
deadline="$(($(date +%s) + 80))"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if hierarchy | grep -q 'Open in .streetCryptid'; then
    maestro --udid "$DEVICE" test "$REPO_ROOT/.maestro/pairing/open-deep-link.yaml" \
      >/dev/null
    sleep 1
  fi
  if hierarchy_has_id pairing-target-figure; then
    role="displayer"
    break
  fi
  if hierarchy | grep -q 'pairing-figure-option-'; then
    role="picker"
    break
  fi
  if ! kill -0 "$pair_pid" >/dev/null 2>&1; then
    cat "$pair_log" >&2
    log "observer pairing exited before the phone reached SAS verification"
    exit 1
  fi
  sleep 1
done
[ -n "$role" ] || {
  cat "$pair_log" >&2
  log "phone never reached the SAS verification screen"
  exit 1
}

if [ "$role" = "picker" ]; then
  target=""
  for _ in $(seq 1 30); do
    target="$(awk '
      /Show the phone user this figure:/ {
        getline
        if ($0 ~ /^#[0-9]+ /) {
          sub(/^#[0-9]+ /, "")
          print
          exit
        }
      }' "$pair_log")"
    [ -n "$target" ] && break
    sleep 1
  done
  [ -n "$target" ] || {
    cat "$pair_log" >&2
    log "could not read the observer's SAS figure"
    exit 1
  }
  maestro --udid "$DEVICE" test -e TARGET_NAME="$target" \
    "$REPO_ROOT/.maestro/pairing/pick-figure.yaml"
  printf 'y\n' >&3
else
  target=""
  for _ in $(seq 1 30); do
    target="$(hierarchy | python3 -c '
import json, sys
tree = json.load(sys.stdin)
stack = [tree]
while stack:
    node = stack.pop()
    attrs = node.get("attributes", {})
    if attrs.get("resource-id") == "pairing-target-figure":
        print(attrs.get("accessibilityText", "").removesuffix(" ASCII pairing figure"))
        break
    stack.extend(node.get("children", []))
')"
    [ -n "$target" ] && break
    sleep 1
  done
  [ -n "$target" ] || {
    cat "$pair_log" >&2
    log "could not read the phone's displayed SAS figure"
    exit 1
  }
  option="$(awk -v target="$target" '
    /^Option [1-4]:$/ {
      option = $2
      sub(/:/, "", option)
      getline
      name = $0
      sub(/^#[0-9]+ /, "", name)
      if (name == target) {
        print option
        exit
      }
    }' "$pair_log")"
  [ -n "$option" ] || {
    cat "$pair_log" >&2
    log "phone's SAS figure was not among the observer's choices"
    exit 1
  }
  printf '%s\n' "$option" >&3

  confirmed=false
  for _ in $(seq 1 20); do
    if maestro --udid "$DEVICE" test "$REPO_ROOT/.maestro/pairing/confirm-match.yaml" \
      >/dev/null 2>&1; then
      confirmed=true
      break
    fi
    sleep 1
  done
  [ "$confirmed" = true ] || {
    cat "$pair_log" >&2
    log "phone could not confirm the observer's SAS choice"
    exit 1
  }
fi

wait "$pair_pid"
pair_pid=""
maestro --udid "$DEVICE" test "$REPO_ROOT/.maestro/pairing/acknowledge-friend.yaml"
status_is_paired || {
  cat "$pair_log" >&2
  log "observer state was not persisted as paired"
  exit 1
}

log "Observer paired and stash namespace registered"
printf '%s\n' "$STATE_DIR"
