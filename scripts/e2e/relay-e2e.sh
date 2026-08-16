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
#   * The AUTHOR is force-quit, so it cannot serve its own trail.
#   * The LATE device has stash opt-in turned OFF. That is not cosmetic: `stashEnabled()` gates
#     `stashBootstrap()`, so with it off the stash ticket is not folded into the subscription and
#     the durable server is not a reachable source for that device at all (see
#     location-sharing.ts). Leaving it on would let the stash answer and the test would prove
#     nothing about peers.
#   * The LATE device's stored fix for the author is cleared first, so nothing can be satisfied
#     out of history.
#
# With the author dead and the stash disabled, the relay is the only remaining holder of that
# fix — so a row appearing on `late` can only have come from it.
#
# CURRENT RESULT (2026-08-16, three iOS Release builds, verified both ways):
#
#   STASH_OPT_IN=1  PASS — late recovers `via=sync` with the author force-quit.
#   STASH_OPT_IN=0  PASS once, then intermittent — see PEER-RELAY-STATUS.md.
#
# The control passing is what makes the failure meaningful: the topology, the pairing, the
# publish and the timing are all sound, and the only thing that changes between the two runs is
# whether the durable server is allowed to answer. So offline recovery today works through the
# STASH, and a third pool member cannot serve an absent author's fix.
#
# That is narrower than docs/social/ARCHITECTURE.md §1.3 claims ("B recovers the trail it missed
# from any other device in the sharing pool"). The reason is visible in two places:
#
#   * `subscribeToFriend` bootstraps a friend's topic from `[that friend's ticket, stash]` only —
#     so with the author dead and the stash off there is no reachable entry point into the swarm
#     where the relay is holding their data. Compare `ensureMySubscription`, which bootstraps our
#     OWN topic from every recipient.
#   * `sync_latest_inner` dials only the explicitly passed peer (the stash) — `peers` is otherwise
#     empty, so no pool member is ever contacted for reconciliation.
#
# FIXED — see the commit "recover a friend's fix from any pool member". `sync_latest` now takes a
# list of peers, a friend's topic bootstraps from the whole pool, and the trail namespace is
# imported before subscribing. The property is proven deterministically by
# `a_pool_member_serves_an_absent_authors_fix` in tests/pairing_integration.rs.
#
# THIS test still passes only intermittently, for reasons that are about arranging the scenario on
# two simulators rather than about the property: the relay can only serve what is in its REPLICA,
# and a fix that arrived over live gossip is in app storage only. Read
# scripts/e2e/PEER-RELAY-STATUS.md before spending time on a red run here.
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
# PRESERVE_FRIENDS keeps each pairing from wiping the previous one — pairing-e2e.sh clears friend
# records by default so it can assert they get minted, which is right for that test and fatal here
# on the second and third edge.
log "Edge 1/3: $AUTHOR <-> $RELAY"
bash "$SCRIPT_DIR/pairing-e2e.sh" "$AUTHOR" "$RELAY" >&2
log "Edge 2/3: $AUTHOR <-> $LATE"
PRESERVE_FRIENDS=1 bash "$SCRIPT_DIR/pairing-e2e.sh" "$AUTHOR" "$LATE" >&2
log "Edge 3/3: $RELAY <-> $LATE"
PRESERVE_FRIENDS=1 bash "$SCRIPT_DIR/pairing-e2e.sh" "$RELAY" "$LATE" >&2

# The author's endpoint id is the key its friends file it under — read it from the relay, whose
# only other friend is `late`, and disambiguate by intersecting with what `late` sees.
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
#
# STASH_OPT_IN=1 runs the same scenario with the stash left ON. That is not a weaker version of
# the test, it is the CONTROL for it: everything else is identical, so a pass there and a failure
# here isolates the difference to "can a third pool member serve an absent author's fix" rather
# than to anything about the harness, the pairing, or the timing.
device_set_stash_opt_in "$LATE" "${STASH_OPT_IN:-0}"
device_clear_friend_latest "$LATE"

cleanup() {
  device_stop_route "$AUTHOR"
  # Put the late device back the way the rest of the harness expects to find it.
  device_set_stash_opt_in "$LATE" 1
}
trap cleanup EXIT

START_MS="$(($(date +%s) * 1000))"

log "Author publishes for ${PUBLISH_SECONDS}s with the relay online and the late device away"
device_background "$LATE"
device_terminate_app "$LATE" # away for the whole publishing window
# The relay stays in the FOREGROUND for the whole run. It is the one device that has to keep
# serving: a backgrounded iOS app is suspended on the OS's schedule, so asking it to answer a dial
# later is testing something the platform does not offer. A friend with the app open is also the
# realistic shape of peer recovery.
device_foreground "$RELAY"
device_background "$AUTHOR"
device_drive_route "$AUTHOR" "$ROUTE"

deadline="$(($(date +%s) + PUBLISH_SECONDS))"
published=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(device_event_log_count "$AUTHOR" "$START_MS" publish.fix ok)" -gt 0 ]; then
    published=1
  fi
  sleep 10
done
[ "$published" -eq 1 ] || {
  log "FAIL - the author never published, so there is nothing to relay"
  device_dump_location_errors "$AUTHOR" "$START_MS" >&2
  device_dump_event_log "$AUTHOR" "$START_MS" >&2
  exit 1
}

# Make the relay RECONCILE the author's namespace while the author is still up.
#
# This step is not bookkeeping, it is the precondition for the whole test. A fix that arrived over
# live gossip lands in the receiver's own app storage (`friend_latest`, labelled `via=lan`) but NOT
# in its replica of the author's iroh-docs namespace — a friend holds a READ ticket for that
# namespace and cannot write to it; only reconciliation puts entries there. So a relay that has
# only ever heard the author over gossip has the fix on screen and nothing to hand on, and asking
# it to serve one is asking for something it does not have.
#
# Foregrounding runs the app's resume path (drain + syncTrail), which reconciles every imported
# namespace — including the author's, while the author is still reachable. That is exactly what a
# friend with the app open does on its own.
# BOTH ends must be awake for this exchange. The author has been backgrounded while it published
# (which is the realistic shape of sharing), but a backgrounded iOS app is suspended on the OS's
# schedule and may not answer an inbound dial — so leaving it there made this step, and therefore
# the whole test, depend on whether the OS happened to keep it alive. That is what made an earlier
# revision pass once and fail the next run. Foregrounding both removes the ambiguity, and mirrors
# what actually happens in the field: two friends with the app open reconcile, then one leaves.
log "Relay reconciles the author's namespace over docs (both awake)"
device_foreground "$AUTHOR"
device_foreground "$RELAY"
sleep 25
# A second pass: the author publishes on its own cadence, so one reconciliation can legitimately
# land between two of its fixes. Repeating makes the relay's replica reflect a *published* fix
# rather than whatever happened to exist at the first attempt.
device_foreground "$AUTHOR"
device_foreground "$RELAY"
sleep 25

# The relay must genuinely HOLD the author's fix — otherwise a later result on `late` would prove
# nothing about relaying, only that some other path exists.
relay_row="$(device_friend_latest_row "$RELAY" "$author_endpoint")"
[ -n "$relay_row" ] || {
  log "FAIL - the relay never received the author's fix, so it has nothing to hand on"
  device_dump_event_log "$RELAY" "$START_MS" >&2
  exit 1
}
log "Relay holds the author's fix: $relay_row"

log "Author goes dark (route stopped, app force-quit)"
device_stop_route "$AUTHOR"
device_terminate_app "$AUTHOR"

if [ "${STASH_OPT_IN:-0}" = "1" ]; then
  log "Late device returns with the stash ON (control run — the stash may legitimately answer)"
else
  log "Late device returns, with the stash disabled — the relay is its only possible source"
fi
# Make sure the relay is still up and serving before we start waiting on it.
device_foreground "$RELAY"
device_background "$LATE"

deadline="$(($(date +%s) + TIMEOUT_SECONDS))"
row=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  row="$(device_friend_latest_row "$LATE" "$author_endpoint")"
  [ -n "$row" ] && break
  # Keep the author dead: an OS restart of its background task would reopen the very source this
  # test is trying to exclude.
  device_terminate_app "$AUTHOR"
  sleep 10
done

[ -n "$row" ] || {
  log "FAIL - the late device never obtained the author's fix from the relay within ${TIMEOUT_SECONDS}s"
  log "  relay held: $relay_row"
  if [ "${STASH_OPT_IN:-0}" != "1" ]; then
    log "  NOTE: re-run with STASH_OPT_IN=1. If that passes, the scenario is sound and what is"
    log "  missing is specifically peer-to-peer relay — see this script's header."
  fi
  log "--- late device event log ---"
  device_dump_event_log "$LATE" "$START_MS" >&2
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
log "  relay: $relay_row"
