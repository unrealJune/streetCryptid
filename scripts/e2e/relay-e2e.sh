#!/usr/bin/env bash
# GOAL 5 — a friend that HAS the fix must be able to hand it on after the author goes dark.
#
# docs/social/ARCHITECTURE.md §1.3 states the property directly: "if B was offline, B recovers the
# trail it missed from ANY OTHER DEVICE in the sharing pool when it comes back." Everything else
# in this harness verifies paths that lead back to the author or to the stash; nothing else
# verifies that a third party can carry an author's fix once the author is gone. That is the
# difference between a pool and a set of independent point-to-point links.
#
# Topology — three phones, all in one sharing pool:
#
#       author  ──(publishes, then goes dark)
#         │  \
#         │   \
#      relay    late          author shares with BOTH; relay is online throughout,
#         \     /             late holds nothing from author when the window opens
#          \   /
#        (late must obtain the author's fix)
#
# HOW THE RESULT IS MADE UNAMBIGUOUS. A pass has to mean "it came from the relay", so both other
# sources are removed before the measurement:
#
#   * The AUTHOR is force-quit, and re-quit every pass of the wait loop, so it can never serve its
#     own trail — not even if the OS restarts its background task.
#   * The LATE device has stash opt-in turned OFF. That is not cosmetic: `stashEnabled()` gates
#     `stashBootstrap()`, so with it off the stash ticket is not folded into the subscription and
#     the durable server is not a reachable source for that device at all (see
#     location-sharing.ts). Leaving it on would let the stash answer and the test would prove
#     nothing about peers.
#   * The LATE device's stored fix for the author is cleared after it goes away, so nothing can be
#     satisfied out of history.
#
# ONE PRECONDITION IS NOT ABOUT EXCLUSION, AND IT IS EASY TO MISS. The late device must be up, and
# must have published, BEFORE it leaves. Sealing is per-recipient (FORWARD-SECRECY.md §4.2/§4.5):
# the author can only wrap for a peer whose ratchet session can step, so a late device that never
# ran in this window is dropped from every wrap set the author produces. The relay would then hand
# over an envelope the late device has no key for — a run that looks like a relay failure while
# proving nothing at all. The publish loop asserts a fix went out wrapped for the WHOLE pool, so
# this cannot regress silently.
#
# With the author dead and the stash disabled, the relay is the only remaining holder of that
# fix — so a row appearing on `late` can only have come from it.
#
# STASH_OPT_IN=1 runs the identical scenario with the stash left ON. That is the CONTROL, not a
# weaker test: a pass there and a failure here isolates the difference to "can a third pool member
# serve an absent author's fix" rather than to the topology, the pairing or the timing.
#
# WHAT THE RELAY MUST HOLD, AND WHERE. A relay can only serve what is in its REPLICA of the
# author's iroh-docs namespace. A fix that arrived over live gossip lands in the receiver's app
# storage (`friend_latest`) and never in that replica — a friend holds a READ ticket and cannot
# write there. `friend_latest` therefore cannot answer "can this device serve the author"; the
# `replica-status` dev command can, and is what this test asserts before taking the author away.
# The author's own `pushTrail` is what puts the entry there, as it publishes.
#
# HOW THE APP IS DRIVEN. Through `streetcryptid://dev?cmd=…` deep links (`device_dev_command`),
# never Maestro's `launchApp` — on iOS that force-terminates and relaunches, which would tear the
# iroh node down at every step and leave each assertion racing a cold dial. See
# scripts/e2e/PEER-RELAY-STATUS.md for the history.
#
# Usage:
#   scripts/e2e/relay-e2e.sh <author> <relay> <late>
#     each device is ios:<udid>, android:<serial>, or a bare udid (== ios:).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
# shellcheck source=lib/device.sh
source "$SCRIPT_DIR/lib/device.sh"

AUTHOR="${1:?Usage: relay-e2e.sh <author> <relay> <late>}"
RELAY="${2:?Usage: relay-e2e.sh <author> <relay> <late>}"
LATE="${3:?Usage: relay-e2e.sh <author> <relay> <late>}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-420}"
SHARE_INTERVAL_MS="${SHARE_INTERVAL_MS:-60000}"
PROFILE="${PROFILE:-balanced}"
ROUTE="${ROUTE:-walking}"
PUBLISH_SECONDS="${PUBLISH_SECONDS:-120}"

log() { echo "[relay-e2e] $*" >&2; }

# replica_has_author <details_json> <author_endpoint> — true when a `replica-status` result says
# this device holds a SERVABLE slot for that author (content present, not just a docs record).
replica_has_author() {
  printf '%s' "$1" | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
try:
    slots = (json.loads(raw) or {}).get("authors") or []
except ValueError:
    sys.exit(1)
sys.exit(0 if any(
    str(slot.get("author", "")).startswith(sys.argv[1]) and slot.get("hasContent")
    for slot in slots
) else 1)
' "$2"
}

device_require_tools "$AUTHOR" "$RELAY" "$LATE"
for spec in "$AUTHOR" "$RELAY" "$LATE"; do
  device_boot "$spec"
  device_assert_installed "$spec"
  device_provision "$spec"
done

# One pool: every device paired with every other. `late` must be a friend of `author` to be able
# to read its fixes at all (it needs a wrap), and a friend of `relay` so it has an address to
# reconcile with once the author is gone.
#
# All three start with NO friend records. Edge 1 clears both its devices, but edges 2 and 3 run
# PRESERVE_FRIENDS=1 (pairing-e2e.sh clears by default so it can assert records get minted, which
# is right for that test and fatal here on the second and third edge) — so `late` would otherwise
# carry friends from a previous run, and the endpoint intersection below could pick the wrong one.
log "Clearing stale friend records on $LATE"
device_reset_pairing_state "$LATE"

log "Edge 1/3: $AUTHOR <-> $RELAY"
bash "$SCRIPT_DIR/pairing-e2e.sh" "$AUTHOR" "$RELAY" >&2
log "Edge 2/3: $AUTHOR <-> $LATE"
PRESERVE_FRIENDS=1 bash "$SCRIPT_DIR/pairing-e2e.sh" "$AUTHOR" "$LATE" >&2
log "Edge 3/3: $RELAY <-> $LATE"
PRESERVE_FRIENDS=1 bash "$SCRIPT_DIR/pairing-e2e.sh" "$RELAY" "$LATE" >&2

# The author's endpoint id is the key its friends file it under — read it from the relay, whose
# only other friend is `late`, and disambiguate by intersecting with what `late` sees. Both lists
# were minted by this run, so the intersection is exactly {author}.
author_endpoint=""
for candidate in $(device_friend_endpoints "$RELAY"); do
  if device_friend_endpoints "$LATE" | grep -q "^$candidate"; then
    author_endpoint="$candidate"
    break
  fi
done
[ -n "$author_endpoint" ] || {
  log "FAIL - could not identify the author's endpoint from the pool"
  exit 1
}
log "Author endpoint (as filed by its friends): ${author_endpoint:0:10}"

for spec in "$AUTHOR" "$RELAY" "$LATE"; do
  device_reset_app_state "$spec" "$SHARE_INTERVAL_MS" "$PROFILE"
done

# Cut the late device off from the durable server, so the relay is the only possible source.
device_set_stash_opt_in "$LATE" "${STASH_OPT_IN:-0}"

cleanup() {
  device_stop_route "$AUTHOR"
  # Put the late device back the way the rest of the harness expects to find it.
  device_set_stash_opt_in "$LATE" 1
}
trap cleanup EXIT

START_MS="$(($(date +%s) * 1000))"

log "Author publishes for up to ${PUBLISH_SECONDS}s with the relay online and the late device away"
# The late device must be UP, and must have published, before it goes away.
#
# This is load-bearing and was the subtlest thing in the whole test. Sealing is per-recipient
# (FORWARD-SECRECY.md §4.2/§4.5): the author can only wrap for a peer whose ratchet session can
# step, which a responder cannot do until it has had the initiator's first envelope, and which
# lapses if the peer stops contributing fresh keys. A late device that was never up in this run is
# dropped from every wrap set the author produces — so the relay would faithfully hand over an
# envelope the late device has no key for, and the run would look like a relay failure while
# actually proving nothing. The assertion after the publish window catches it if it ever regresses.
device_dev_command "$LATE" sync-trail >/dev/null || {
  log "FAIL - the late device never came up, so the author cannot wrap for it"
  device_dump_event_log "$LATE" "$START_MS" >&2
  exit 1
}
device_background "$LATE"
device_terminate_app "$LATE" # away for the whole publishing window
# Cleared only NOW, with the late device down: anything it ingested while it was briefly up is
# history, and a row appearing after this point can only have arrived during the window under test.
device_clear_friend_latest "$LATE"
# The relay stays in the FOREGROUND for the whole run. It is the one device that has to keep
# serving: a backgrounded iOS app is suspended on the OS's schedule, so asking it to answer a dial
# later is testing something the platform does not offer. A friend with the app open is also the
# realistic shape of peer recovery. The dev command both foregrounds it and proves its sharing
# service is live before anything depends on it.
device_dev_command "$RELAY" sync-trail >/dev/null || {
  log "FAIL - the relay never came up, so there is nothing to relay through"
  device_dump_event_log "$RELAY" "$START_MS" >&2
  exit 1
}
device_background "$AUTHOR"
device_drive_route "$AUTHOR" "$ROUTE"

deadline="$(($(date +%s) + PUBLISH_SECONDS))"
published=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(device_publish_to_everyone_count "$AUTHOR" "$START_MS")" -gt 0 ]; then
    published=1
    break # nothing is learned by burning the rest of the window
  fi
  sleep 10
done
[ "$published" -eq 1 ] || {
  log "FAIL - the author never published a fix wrapped for the WHOLE pool"
  if [ "$(device_event_log_count "$AUTHOR" "$START_MS" publish.fix ok)" -gt 0 ]; then
    log "  it did publish, but every fix left a recipient out (ratchet.recipients_dropped)."
    log "  A fix nobody can open is not a relay problem — see FORWARD-SECRECY.md §4.2/§4.5 and the"
    log "  note above about the late device having to contribute a ratchet key before it leaves."
  else
    log "  it never published at all, so there is nothing to relay"
  fi
  device_dump_location_errors "$AUTHOR" "$START_MS" >&2
  device_dump_event_log "$AUTHOR" "$START_MS" >&2
  exit 1
}

# THE PRECONDITION, asserted against the replica rather than app storage.
#
# There is no reconciliation window to arrange any more: the author's `pushTrail` addresses every
# pool member, so the relay's replica fills as the author publishes. The explicit `sync-trail`
# below is a nudge that collapses the wait, not the mechanism — if it were the mechanism, this
# test would be back to depending on both devices being awake at the same moment.
log "Checking what the relay can actually SERVE"
relay_status=""
deadline="$(($(date +%s) + 120))"
while [ "$(date +%s)" -lt "$deadline" ]; do
  relay_status="$(device_dev_command "$RELAY" replica-status || true)"
  if replica_has_author "$relay_status" "$author_endpoint"; then
    break
  fi
  device_dev_command "$RELAY" sync-trail >/dev/null || true
  sleep 5
done
replica_has_author "$relay_status" "$author_endpoint" || {
  log "FAIL - the relay's REPLICA holds no servable fix for the author, so it has nothing to give"
  log "  (this is distinct from a failed transfer to the late device — nothing was ever sent to it)"
  log "  relay replica-status: $relay_status"
  device_dump_event_log "$RELAY" "$START_MS" >&2
  device_dump_event_log "$AUTHOR" "$START_MS" >&2
  exit 1
}
log "Relay can serve the author: $relay_status"

log "Author goes dark (route stopped, app force-quit)"
device_stop_route "$AUTHOR"
device_terminate_app "$AUTHOR"

if [ "${STASH_OPT_IN:-0}" = "1" ]; then
  log "Late device returns with the stash ON (control run — the stash may legitimately answer)"
else
  log "Late device returns, with the stash disabled — the relay is its only possible source"
fi

deadline="$(($(date +%s) + TIMEOUT_SECONDS))"
row=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  # Re-drive the late device every pass. Its own `syncTrail` only runs on a resume or during an
  # active live-watch session, so a single cold launch used to be the whole test's one attempt.
  device_dev_command "$LATE" sync-trail >/dev/null || true
  row="$(device_friend_latest_row "$LATE" "$author_endpoint")"
  [ -n "$row" ] && break
  # Keep the author dead: an OS restart of its background task would reopen the very source this
  # test is trying to exclude.
  device_terminate_app "$AUTHOR"
  sleep 10
done

[ -n "$row" ] || {
  log "FAIL - the late device never obtained the author's fix from the relay within ${TIMEOUT_SECONDS}s"
  log "  the relay COULD serve it: $relay_status"
  log "  so this is a transfer failure, not an empty relay"
  # Where it stopped. The replica is what reconciliation writes; `friend_latest` is what the app
  # ingests out of it afterwards. An author present here but absent from `friend_latest` means the
  # transfer worked and the app-side read did not — a different bug in a different place.
  log "  late replica-status: $(device_dev_command "$LATE" replica-status 60 || true)"
  if [ "${STASH_OPT_IN:-0}" != "1" ]; then
    log "  NOTE: re-run with STASH_OPT_IN=1. If that passes, the scenario is sound and what is"
    log "  missing is specifically peer-to-peer relay — see this script's header."
  fi
  log "--- late device event log ---"
  device_dump_event_log "$LATE" "$START_MS" >&2
  log "--- relay event log ---"
  device_dump_event_log "$RELAY" "$START_MS" >&2
  exit 1
}

seq="$(printf '%s' "$row" | cut -d'|' -f1)"
via="$(printf '%s' "$row" | cut -d'|' -f4)"
if [ "${STASH_OPT_IN:-0}" = "1" ]; then
  log "PASS (control) - the late device obtained the author's fix with the author offline."
  log "  The stash was ON, so this does NOT show a peer relayed it — it is the baseline that"
  log "  proves the scenario, the pairing and the timing are all sound."
else
  log "PASS - a POOL MEMBER served the author's fix with the author offline and the stash off"
fi
log "  late:  seq=$seq via=$via"
log "  relay: $relay_status"
