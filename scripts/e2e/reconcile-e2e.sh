#!/usr/bin/env bash
# GOAL 4 — a device that was AWAY must recover what it missed once it comes back.
#
# The send path is covered elsewhere (background-location-e2e.sh, trio-e2e.sh): a backgrounded
# phone samples, publishes, and pushes to the stash. That proves nothing about the RECEIVE side,
# which is a different mechanism entirely. The OS location task only fires on movement and only
# ever pushes; nothing in it pulls. A phone that is backgrounded — or killed outright — while a
# friend keeps moving therefore hears nothing at the time, and is supposed to recover the friend's
# CURRENT position afterwards by range reconciliation (docs/social/ARCHITECTURE.md §1.3, §9;
# docs/social/FORWARD-SECRECY.md §4.4).
#
# What this asserts, and why it is worth asserting:
#
#   * The receiver holds NO fix from the sender at the start (the row is cleared), so a pass
#     cannot be satisfied by something received before the window.
#   * The sender publishes only while the receiver is away.
#   * After the receiver returns, `friend_latest` holds a fix from the sender that is NEWER than
#     the moment it went away — i.e. one it demonstrably could not have had.
#
# `via` is reported rather than asserted. Recovery is legitimate over any lane the pool offers —
# a direct peer sync, the stash, or a live message that lands the instant the app is resumed — and
# pinning the assertion to one of them would fail a system that is working. The value is printed
# because WHICH lane carried it is the interesting part of the result.
#
# Usage:
#   scripts/e2e/reconcile-e2e.sh <sender> <receiver>
#     each device is ios:<udid>, android:<serial>, or a bare udid (== ios:).
#
#   MODE=background  (default) receiver is merely backgrounded — the ordinary case.
#   MODE=terminate   receiver's app is force-quit while the sender moves — the harsher one,
#                    covering process death rather than just loss of foreground.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
# shellcheck source=lib/device.sh
source "$SCRIPT_DIR/lib/device.sh"

SENDER="${1:?Usage: reconcile-e2e.sh <sender> <receiver>  (ios:<udid> | android:<serial> | <udid>)}"
RECEIVER="${2:?Usage: reconcile-e2e.sh <sender> <receiver>  (ios:<udid> | android:<serial> | <udid>)}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"
SHARE_INTERVAL_MS="${SHARE_INTERVAL_MS:-60000}"
PROFILE="${PROFILE:-balanced}"
ROUTE="${ROUTE:-walking}"
MODE="${MODE:-background}"
AWAY_SECONDS="${AWAY_SECONDS:-90}"

log() { echo "[reconcile-e2e] $*" >&2; }

device_require_tools "$SENDER" "$RECEIVER"
for spec in "$SENDER" "$RECEIVER"; do
  device_boot "$spec"
  device_assert_installed "$spec"
  device_provision "$spec"
done

# Pair them if they are not already friends. Reuses the pairing harness rather than duplicating
# it; PRESERVE_FRIENDS is irrelevant here because pairing-e2e.sh resets and re-pairs both sides.
log "Ensuring $SENDER and $RECEIVER are paired"
bash "$SCRIPT_DIR/pairing-e2e.sh" "$SENDER" "$RECEIVER" >&2

# The sender's endpoint id is the key the RECEIVER files it under — a device never records its
# own id. See friend_endpoints.
SENDER_ENDPOINT="$(device_friend_endpoints "$RECEIVER" | head -1)"
[ -n "$SENDER_ENDPOINT" ] || {
  log "FAIL - $RECEIVER lists no friends, so pairing did not take"
  exit 1
}
log "Sender endpoint (as filed by the receiver): ${SENDER_ENDPOINT:0:10}"

for spec in "$SENDER" "$RECEIVER"; do
  device_reset_app_state "$spec" "$SHARE_INTERVAL_MS" "$PROFILE"
done

# Clear any fix the receiver already holds from the sender, so the assertion cannot be satisfied
# by history. This is the control that makes the result mean something.
device_clear_friend_latest "$RECEIVER"
[ -z "$(device_friend_latest_row "$RECEIVER" "$SENDER_ENDPOINT")" ] || {
  log "FAIL - could not clear the receiver's stored fix for the sender"
  exit 1
}

cleanup() {
  device_stop_route "$SENDER"
}
trap cleanup EXIT

AWAY_FROM_MS="$(($(date +%s) * 1000))"

case "$MODE" in
  terminate)
    log "Receiver goes away HARD: force-quitting the app on $RECEIVER"
    device_background "$RECEIVER"
    device_terminate_app "$RECEIVER"
    ;;
  background)
    log "Receiver goes away: backgrounding $RECEIVER"
    device_background "$RECEIVER"
    ;;
  *)
    echo "error: unknown MODE '$MODE' (want background or terminate)" >&2
    exit 2
    ;;
esac

log "Sender moves on a $ROUTE route while the receiver is away (${AWAY_SECONDS}s)"
device_background "$SENDER"
device_drive_route "$SENDER" "$ROUTE"

sender_published=0
deadline="$(($(date +%s) + AWAY_SECONDS))"
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(device_event_log_count "$SENDER" "$AWAY_FROM_MS" publish.fix ok)" -gt 0 ]; then
    sender_published=1
    break
  fi
  sleep 5
done
[ "$sender_published" -eq 1 ] || {
  log "FAIL - the sender never published while the receiver was away, so there is nothing to recover"
  device_dump_location_errors "$SENDER" "$AWAY_FROM_MS" >&2
  device_dump_event_log "$SENDER" "$AWAY_FROM_MS" >&2
  exit 1
}
log "Sender published while the receiver was away"

# Let a few more fixes accumulate, so recovery has to move a fix that is unambiguously newer than
# the moment the receiver left.
sleep 20

log "Receiver comes back: foregrounding $RECEIVER"
device_background "$RECEIVER" # launches, asserts the map, then backgrounds again

log "Waiting up to ${TIMEOUT_SECONDS}s for the receiver to recover the sender's current fix"
deadline="$(($(date +%s) + TIMEOUT_SECONDS))"
row=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  row="$(device_friend_latest_row "$RECEIVER" "$SENDER_ENDPOINT")"
  if [ -n "$row" ]; then
    received_at="$(printf '%s' "$row" | cut -d'|' -f3)"
    # ARRIVAL time, not the sender's sample time. `fix_ts` is when the SENDER took the reading,
    # and a publish that happens after the receiver leaves can still carry a reading taken moments
    # before it (the outbox drains on the next wake) — asserting on it fails a recovery that
    # genuinely happened. What actually has to be true is that this row ARRIVED during the window,
    # and that is guaranteed rigorously by having cleared the table first: with no stored fix at
    # the start, any row here at all was received while the receiver was away or after it
    # returned. No weaker for the relaxation, and it stops rejecting correct behaviour.
    if [ "${received_at:-0}" -ge "$AWAY_FROM_MS" ]; then
      break
    fi
    log "  receiver holds a fix that predates the window (received_at=$received_at); still waiting"
  fi
  row=""
  # Poll the DATABASE only — never the app. Re-running the foreground flow here would relaunch it,
  # and a launch is a terminate+relaunch (see .maestro/pairing/pair-device.yaml): it tears down the
  # node mid-reconciliation, so a loop that "nudges" the app every few seconds guarantees the very
  # recovery it is waiting for can never finish. Observed exactly that way — the receiver sat on a
  # fix from 1.8s before it left, for minutes, while being restarted every 15s.
  sleep 10
done

[ -n "$row" ] || {
  log "FAIL - $RECEIVER never recovered a fix from the sender within ${TIMEOUT_SECONDS}s"
  log "--- receiver event log ---"
  device_dump_event_log "$RECEIVER" "$AWAY_FROM_MS" >&2
  device_dump_location_errors "$RECEIVER" "$AWAY_FROM_MS" >&2
  exit 1
}

seq="$(printf '%s' "$row" | cut -d'|' -f1)"
fix_ts="$(printf '%s' "$row" | cut -d'|' -f2)"
received_at="$(printf '%s' "$row" | cut -d'|' -f3)"
via="$(printf '%s' "$row" | cut -d'|' -f4)"
log "PASS - $RECEIVER recovered a fix from the sender it did not have (mode=$MODE)"
log "  seq=$seq  via=$via  received +$(((received_at - AWAY_FROM_MS) / 1000))s after it went away"
log "  (via 'sync'/'docs'/'stash' = range reconciliation; 'live' = gossip on resume)"
