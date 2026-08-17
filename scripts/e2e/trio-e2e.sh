#!/usr/bin/env bash
# Three-party validation: device A <-> device B, and a host-side CLI observer against each.
#
# The two-device test proves a pair can talk. The single-device test proves one phone's pipeline
# reaches the stash. Neither shows that a device sustains MORE THAN ONE peer at once — which is
# the case docs/social/FORWARD-SECRECY.md §4.1/§4.5 actually cares about: per-friend ratchet
# sessions, a multi-recipient wrap set, and the single-writer discipline of §4.2. This runs both
# devices with two live peers each and checks every edge independently.
#
# Topology:
#
#     device A  <--- SAS pair --->  device B
#         \                            /
#          \  SAS pair      SAS pair  /
#           \                        /
#            +----  CLI observer ---+     (one host-side trail-stash-client, two peers)
#
# ONE CLI identity, paired to BOTH devices. trail-stash-client keeps a `peers` list, so a single
# state directory can hold several phones at once — the same shape a real user's device has. That
# matters for what this test is for: each device ends up with two live peers (the other device and
# the CLI), which is what actually exercises per-friend ratchet sessions and a multi-recipient
# wrap set rather than a single-friend happy path.
#
# The observer verifies each device end-to-end the strongest way available: it decrypts that
# device's ciphertext out of the stash as a real friend, so a pass means the crypto and the
# durable path both worked, not just that a local row appeared. Because `seq` is per author, the
# CLI tracks a separate cursor per phone; a fix from one can never satisfy the check for the other.
#
# Usage:
#   scripts/e2e/trio-e2e.sh <device-a> <device-b>
#     where each device is ios:<udid>, android:<serial>, or a bare udid (== ios:).
#     A mixed pair is supported and is the most interesting configuration:
#       scripts/e2e/trio-e2e.sh ios:<udid> android:emulator-5554
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
# shellcheck source=lib/device.sh
source "$SCRIPT_DIR/lib/device.sh"

DEVICE_A="${1:?Usage: trio-e2e.sh <device-a> <device-b>  (ios:<udid> | android:<serial> | <udid>)}"
DEVICE_B="${2:?Usage: trio-e2e.sh <device-a> <device-b>  (ios:<udid> | android:<serial> | <udid>)}"
# Wall budget for the observation phase. Two devices must each publish, push to the stash, and
# then be independently decrypted by the observer — and a single observer poll alone costs up to
# OBSERVE_TIMEOUT_SECONDS (see observe_authors), with real fix lag on top.
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-600}"
SHARE_INTERVAL_MS="${SHARE_INTERVAL_MS:-60000}"
PROFILE="${PROFILE:-balanced}"
ROUTE="${ROUTE:-walking}"

log() { echo "[trio-e2e] $*" >&2; }

device_require_tools "$DEVICE_A" "$DEVICE_B"
for spec in "$DEVICE_A" "$DEVICE_B"; do
  device_supports "$spec" pairing || {
    echo "error: $spec does not support pairing (see device_supports in lib/device.sh)" >&2
    exit 1
  }
  device_supports "$spec" stash-observer || {
    echo "error: $spec does not support the stash observer (see device_supports in lib/device.sh)" >&2
    exit 1
  }
  device_boot "$spec"
  device_assert_installed "$spec"
  device_provision "$spec"
done

log "Edge 1/3: pairing $DEVICE_A <-> $DEVICE_B"
bash "$SCRIPT_DIR/pairing-e2e.sh" "$DEVICE_A" "$DEVICE_B" >&2

STASH_CLI="$REPO_ROOT/modules/iroh-location/rust/target/debug/trail-stash-client"
# One retry per edge. The SAS handshake has a real deadline, and the observer's side of it starts
# a fresh CLI process — iroh node, relay discovery, first dial — against a state directory the
# PREVIOUS edge's process has only just released. Back to back, that occasionally misses the
# window and the phone never sees a challenge, while the same pairing run on its own succeeds
# every time (verified). A retry is the honest response to a startup race: it cannot turn a
# genuine failure into a pass, because a pairing that does not complete leaves no friend record
# and every assertion downstream still fails.
pair_observer() {
  local spec="$1" label="$2" attempt=1 dir
  while :; do
    if dir="$(ensure_stash_observer "$spec")"; then
      printf '%s' "$dir"
      return 0
    fi
    [ "$attempt" -ge 2 ] && return 1
    log "  $label did not complete on attempt $attempt; retrying once"
    attempt=$((attempt + 1))
    sleep 10
  done
}

log "Edge 2/3: pairing the CLI observer to $DEVICE_A"
OBSERVER="$(pair_observer "$DEVICE_A" "edge 2")" || {
  echo "error: could not pair the CLI observer to $DEVICE_A" >&2
  exit 1
}
log "Edge 3/3: pairing the SAME CLI observer to $DEVICE_B"
OBSERVER="$(pair_observer "$DEVICE_B" "edge 3")" || {
  echo "error: could not pair the CLI observer to $DEVICE_B" >&2
  exit 1
}

# WHICH OBSERVER PEER IS WHICH DEVICE.
#
# A device's own endpoint id is not recorded on that device — but it IS the key its FRIENDS file
# it under, so device A's id is whatever the observer and device B agree on. Intersecting the two
# gives an unambiguous answer:
#
#   observer peers   = {A, B}
#   B's friend pool  = {A, observer}      =>  peers ∩ pool(B) = {A}
#
# The previous approach — diffing the observer's peer list before and after pairing B — silently
# produced an EMPTY id whenever the observer was already paired to both devices from an earlier
# run, which is the normal case for a reused state dir. Identity, not history.
observer_peer_prefixes() {
  "$STASH_CLI" --state-dir "$1" status 2>/dev/null | sed -n 's/^phone[0-9]*_endpoint=//p' | sort
}

# peer_matching_pool <observer_state_dir> <device-spec> — the observer peer id that the given
# device lists as a friend. Peer ids from `status` are short prefixes; pool keys are full hex, so
# match by prefix in that direction.
peer_matching_pool() {
  local peers pool prefix
  peers="$(observer_peer_prefixes "$1")"
  pool="$(device_friend_endpoints "$2")"
  for prefix in $peers; do
    if printf '%s\n' "$pool" | grep -q "^$prefix"; then
      printf '%s' "$prefix"
      return 0
    fi
  done
  return 1
}

ENDPOINT_A="$(peer_matching_pool "$OBSERVER" "$DEVICE_B")" || true
ENDPOINT_B="$(peer_matching_pool "$OBSERVER" "$DEVICE_A")" || true
[ -n "$ENDPOINT_A" ] && [ -n "$ENDPOINT_B" ] && [ "$ENDPOINT_A" != "$ENDPOINT_B" ] || {
  echo "error: could not identify both device endpoints from observer state" >&2
  echo "  A=$ENDPOINT_A  B=$ENDPOINT_B" >&2
  "$STASH_CLI" --state-dir "$OBSERVER" status >&2 || true
  exit 1
}
log "Endpoints — A=$ENDPOINT_A  B=$ENDPOINT_B"
peer_count="$("$STASH_CLI" --state-dir "$OBSERVER" status 2>/dev/null | sed -n 's/^peer_count=//p')"
[ "${peer_count:-0}" -ge 2 ] || {
  echo "error: observer holds ${peer_count:-0} peer(s), expected 2 — the trio is not actually set up" >&2
  "$STASH_CLI" --state-dir "$OBSERVER" status >&2 || true
  exit 1
}
log "Observer holds $peer_count peers: $("$STASH_CLI" --state-dir "$OBSERVER" status 2>/dev/null | sed -n 's/^phone[0-9]*_endpoint=/ /p' | tr -d '\n')"

# Reset AFTER pairing: the resets clear the outbox and event history so assertions only see this
# run, and doing it before pairing would throw away the friend records we just made.
for spec in "$DEVICE_A" "$DEVICE_B"; do
  device_reset_app_state "$spec" "$SHARE_INTERVAL_MS" "$PROFILE"
done

START_MS="$(($(date +%s) * 1000))"

cleanup() {
  device_stop_route "$DEVICE_A"
  device_stop_route "$DEVICE_B"
}
trap cleanup EXIT

for spec in "$DEVICE_A" "$DEVICE_B"; do
  log "Backgrounding $spec on a $ROUTE route"
  device_background "$spec"
  device_drive_route "$spec" "$ROUTE"
done

# Each device must get its own fixes onto the wire, and the observer must decrypt a fix from EACH
# of them. Tracked separately so a partial result names the edge that failed instead of just "no".
a_pipeline=0
b_pipeline=0
a_observed=0
b_observed=0

# observe_authors — one `watch --once` poll; prints the short endpoint id of every author whose
# fix the observer decrypted. `watch --once` returns on the first NEW fix from any peer, and the
# CLI keeps a per-author cursor, so repeated calls surface both devices in turn rather than
# re-reporting whichever one is chattiest.
#
# The timeout is generous on purpose. One poll is not a quick request: the observer starts an
# isolated iroh node, then reconciles each paired phone's namespace against the stash and fetches
# blobs over the receipt API — measured at ~45s wall for two peers, with a fix's observed lag
# routinely tens of seconds. An earlier 20s budget could not finish a single cycle, so every poll
# was killed part-way and the run reported "observed=0" for devices that were publishing
# perfectly well. Worse, a poll killed AFTER the ratchet advanced but BEFORE the JSON reached
# stdout consumes that fix permanently — the cursor moves, the harness never sees it, and the
# next poll correctly refuses the same envelope as a replay. Cutting a cycle short does not just
# lose a sample, it can destroy one.
OBSERVE_TIMEOUT_SECONDS="${OBSERVE_TIMEOUT_SECONDS:-90}"
observe_authors() {
  stash_observe_once "$OBSERVER" "$OBSERVE_TIMEOUT_SECONDS" 2>/dev/null |
    python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        print(json.loads(line)["author"][:10])
    except Exception:
        pass
' || true
}

deadline="$(($(date +%s) + TIMEOUT_SECONDS))"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$a_pipeline" -eq 0 ] &&
    [ "$(device_event_log_count "$DEVICE_A" "$START_MS" publish.fix ok)" -gt 0 ] &&
    [ "$(device_event_log_count "$DEVICE_A" "$START_MS" trail.push.app ok)" -gt 0 ]; then
    a_pipeline=1
    log "  device A pipeline: publish + stash push OK"
  fi
  if [ "$b_pipeline" -eq 0 ] &&
    [ "$(device_event_log_count "$DEVICE_B" "$START_MS" publish.fix ok)" -gt 0 ] &&
    [ "$(device_event_log_count "$DEVICE_B" "$START_MS" trail.push.app ok)" -gt 0 ]; then
    b_pipeline=1
    log "  device B pipeline: publish + stash push OK"
  fi

  if [ "$a_observed" -eq 0 ] || [ "$b_observed" -eq 0 ]; then
    for author in $(observe_authors); do
      if [ "$author" = "$ENDPOINT_A" ] && [ "$a_observed" -eq 0 ]; then
        a_observed=1
        log "  observer decrypted a fix from device A ($author)"
      elif [ "$author" = "$ENDPOINT_B" ] && [ "$b_observed" -eq 0 ]; then
        b_observed=1
        log "  observer decrypted a fix from device B ($author)"
      fi
    done
  fi

  if [ "$a_pipeline" -eq 1 ] && [ "$b_pipeline" -eq 1 ] &&
    [ "$a_observed" -eq 1 ] && [ "$b_observed" -eq 1 ]; then
    log "PASS - all three parties verified:"
    log "  A<->B paired; both published to the stash;"
    log "  one CLI observer, friend of both, decrypted a fix from each."
    exit 0
  fi
  # No extra sleep: observe_authors already blocks for a full reconciliation cycle, so this loop
  # is paced by the observer itself rather than by a timer.
  sleep 1
done

log "FAIL - not every edge completed within ${TIMEOUT_SECONDS}s"
log "  A pipeline=$a_pipeline  A observed=$a_observed"
log "  B pipeline=$b_pipeline  B observed=$b_observed"
# Sharing-start failures first: when one of these is present the event log below is EMPTY, and
# the empty log is what misleads. See device_dump_location_errors.
for spec in "$DEVICE_A" "$DEVICE_B"; do
  errors="$(device_dump_location_errors "$spec" "$START_MS")"
  [ -n "$errors" ] && log "--- $spec could not start background sharing ---" && printf '%s\n' "$errors" >&2
done
log "--- device A event log ---"
device_dump_event_log "$DEVICE_A" "$START_MS" >&2
log "--- device B event log ---"
device_dump_event_log "$DEVICE_B" "$START_MS" >&2
exit 1
