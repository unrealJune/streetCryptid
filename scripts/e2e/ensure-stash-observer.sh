#!/usr/bin/env bash
# Create or reuse a host-side friend that reads the simulator's encrypted trail through stash only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
# shellcheck source=lib/device.sh
source "$SCRIPT_DIR/lib/device.sh"
# Device spec: "ios:<udid>", "android:<serial>", or a bare udid (== ios:).
DEVICE_SPEC="${1:?Usage: ensure-stash-observer.sh <ios:udid | android:serial | udid> [state-dir]}"
DEVICE="$(device_id "$DEVICE_SPEC")"
# ONE shared state dir by default, deliberately: trail-stash-client now holds many peers per
# identity, so calling this for several devices builds a single CLI friend that all of them share
# — which is what makes a real multi-peer topology testable (scripts/e2e/trio-e2e.sh). Pass an
# explicit state dir to get an isolated observer instead.
STATE_DIR="${2:-$HOME/Library/Application Support/streetcryptid/e2e-stash-observer/shared}"
# "Already paired" has to mean "paired to THIS device", not "paired to anything" — with a shared
# identity the latter would short-circuit the second device and silently leave it unpaired. The
# CLI's own `paired=` is a whole-state flag, so track per-device with a marker beside the state.
PAIRED_MARKER="$STATE_DIR/paired-$(printf '%s' "$DEVICE" | tr -c 'A-Za-z0-9_.-' '_')"
# The invite is delivered by the phone's own flow (`openLink`), not pushed from here — see the
# pairing block below for why — so this script needs no per-platform invite target at all.
BIN="$REPO_ROOT/modules/iroh-location/rust/target/debug/trail-stash-client"

log() { echo "[stash-observer] $*" >&2; }

status_is_paired() {
  "$BIN" --state-dir "$STATE_DIR" status 2>/dev/null | grep '^paired=true$' >/dev/null
}

# The pairing must still be MUTUAL. `paired=` and the marker file only say what the CLI believes;
# the phone can have dropped us without the CLI ever noticing — pairing-e2e.sh clears friend
# records between runs precisely so it can assert they get minted, and that silently invalidates
# an observer paired in an earlier run. Left unchecked, the run proceeds with a CLI that is a
# friend of nobody and fails much later, as a peer that simply never decrypts a fix.
device_still_lists_observer() {
  local self
  self="$("$BIN" --state-dir "$STATE_DIR" status 2>/dev/null | sed -n 's/^self_endpoint=//p')"
  [ -n "$self" ] || return 1
  device_friend_endpoints "$DEVICE_SPEC" | grep -q "^$self"
}

paired_to_this_device() {
  [ -f "$PAIRED_MARKER" ] && status_is_paired && device_still_lists_observer
}

# The runner is whichever one lib/devices.sh is configured to drive (E2E_MAESTRO), not
# necessarily upstream `maestro`.
devices_require_tools "$E2E_MAESTRO" python3

log "Building the stash-only observer"
cargo build --quiet --manifest-path "$REPO_ROOT/modules/iroh-location/rust/Cargo.toml" \
  --features cli --bin trail-stash-client

if paired_to_this_device; then
  log "Reusing observer already paired to $DEVICE ($STATE_DIR)"
  printf '%s\n' "$STATE_DIR"
  exit 0
fi
if status_is_paired; then
  log "Observer already has peer(s); adding $DEVICE as another peer"
fi

mkdir -p "$STATE_DIR"
device_grant_location "$DEVICE_SPEC"
# Skip the onboarding flow when the app is already onboarded — see device_onboard in
# lib/device.sh for why (every flow run costs driver startup, an already-onboarded run of this
# flow changes nothing, and the pairing flow below launches the app itself anyway).
device_onboard "$DEVICE_SPEC" "scobserver$((RANDOM % 10000))"

log "Pairing a dedicated stash observer through the real SAS flow"
rendezvous_start
SESSION="observer-$$-$RANDOM"

# The phone's whole handshake runs as ONE flow, concurrently with the CLI's — that is the fix for
# the app-restart-mid-handshake bug (see .maestro/pairing/pair-device.yaml).
#
# ROLE=redeem, i.e. the phone opens the invite ITSELF via the flow's `openLink`, rather than the
# CLI pushing it with `adb`/`simctl`. Both are "the same" in principle; in practice the CLI's
# `am start` is silently dropped when the app is already the top-most activity ("Activity not
# started, intent has been delivered to currently running top-most instance") and the handshake
# then never begins, which surfaced as "the observer never reached the SAS verification screen".
# Routing through the flow reuses the exact path pairing-e2e.sh already proves on both platforms,
# and removes the need for a per-platform invite target here.
phone_out="$(mktemp)"
maestro_test "$DEVICE" \
  -e ROLE=redeem -e RENDEZVOUS="$RENDEZVOUS_URL" -e SESSION="$SESSION" \
  "$REPO_ROOT/.maestro/pairing/pair-device.yaml" >"$phone_out" 2>&1 &
phone_pid=$!

pair_log="$(mktemp)"
pair_fifo="$(mktemp)"
rm -f "$pair_fifo"
mkfifo "$pair_fifo"
exec 3<>"$pair_fifo"
pair_pid=""
cleanup() {
  if [ -n "$pair_pid" ] && kill -0 "$pair_pid" >/dev/null 2>&1; then kill "$pair_pid"; fi
  if [ -n "${phone_pid:-}" ] && kill -0 "$phone_pid" >/dev/null 2>&1; then kill "$phone_pid"; fi
  exec 3>&-
  rm -f "$pair_log" "$pair_fifo" "$phone_out"
}
trap cleanup EXIT

# Don't mint the invite until the phone flow has launched the app: that launch RESTARTS it, and an
# invite delivered beforehand would die with the process that received it.
rendezvous_get "$SESSION.ready.redeem" 120 >/dev/null || {
  log "the phone flow never came up"
  cat "$phone_out" >&2
  exit 1
}

# No --adb/--simulator: the CLI just prints the link, and the phone flow opens it (see above).
"$BIN" --state-dir "$STATE_DIR" pair --force \
  <"$pair_fifo" >"$pair_log" 2>&1 &
pair_pid="$!"

# Hand the freshly minted link to the waiting flow.
invite=""
for _ in $(seq 1 60); do
  invite="$(awk '/^Pairing invite:$/ { getline; print; exit }' "$pair_log")"
  [ -n "$invite" ] && break
  kill -0 "$pair_pid" >/dev/null 2>&1 || break
  sleep 1
done
[ -n "$invite" ] || {
  cat "$pair_log" >&2
  log "the observer never printed a pairing invite"
  exit 1
}
rendezvous_put "$SESSION.invite" "$invite"

# Both sides now discover their own role independently and meet at the rendezvous: the phone flow
# branches on what rendered, this script branches on what the CLI printed. Whichever is the
# displayer publishes `<session>.figure`; the picker publishes `<session>.picked` once it has
# chosen, and the displayer confirms only after seeing that.
role=""
# Matches the flow's own patience for the challenge (see pair-device.yaml): the CLI has to boot an
# iroh node, reach a relay, and be dialled before either side can show a figure.
deadline="$(($(date +%s) + 150))"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -q 'Show the phone user this figure:' "$pair_log"; then
    role="displayer"
    break
  fi
  if grep -q '^Option [1-4]:$' "$pair_log"; then
    role="picker"
    break
  fi
  if ! kill -0 "$pair_pid" >/dev/null 2>&1; then
    cat "$pair_log" >&2
    log "observer pairing exited before reaching SAS verification"
    exit 1
  fi
  sleep 1
done
[ -n "$role" ] || {
  cat "$pair_log" >&2
  log "the observer never reached the SAS verification screen"
  exit 1
}
log "Observer is the $role"

if [ "$role" = "displayer" ]; then
  # The CLI is showing the figure; the phone has to pick it.
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
  rendezvous_put "$SESSION.figure" "$target"
  rendezvous_get "$SESSION.picked" 60 >/dev/null || {
    cat "$pair_log" >&2
    log "the phone never picked a figure"
    exit 1
  }
  printf 'y\n' >&3
else
  # The phone is showing the figure; the CLI has to pick it out of its own options.
  target="$(rendezvous_get "$SESSION.figure" 60)" || {
    cat "$pair_log" >&2
    log "the phone never published its displayed SAS figure"
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
    log "the phone's SAS figure ($target) was not among the observer's choices"
    exit 1
  }
  printf '%s\n' "$option" >&3
  # Release the phone's displayer branch, which is holding off on "THEY MATCHED" until the picker
  # has actually chosen — the same ordering a real pair of humans follows.
  rendezvous_put "$SESSION.picked" "yes"
fi

wait "$pair_pid"
pair_pid=""
phone_rc=0
wait "$phone_pid" || phone_rc=$?
phone_pid=""
if [ "$phone_rc" -ne 0 ]; then
  cat "$phone_out" >&2
  cat "$pair_log" >&2
  log "the phone side of the observer pairing failed"
  exit 1
fi
touch "$PAIRED_MARKER"
status_is_paired || {
  cat "$pair_log" >&2
  log "observer state was not persisted as paired"
  exit 1
}

log "Observer paired and stash namespace registered"
printf '%s\n' "$STATE_DIR"
