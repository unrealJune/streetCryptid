#!/usr/bin/env bash
# Simulator smoke test for the iOS background location send path.
#
# This verifies OS location delivery -> TaskManager -> engine/outbox -> native publish -> stash push.
# It cannot reproduce real-device suspension and battery heuristics; keep physical-device soak tests
# for those. The simulator must have a build made from the current source installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
DEVICE="${1:?Usage: ios-background-location-e2e.sh <simulator-udid>}"
USERNAME="${USERNAME:-iosbg$((RANDOM % 10000))}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-180}"
OBSERVER_STATE_DIR="${OBSERVER_STATE_DIR:-$HOME/Library/Application Support/streetcryptid/e2e-stash-observer/$DEVICE}"

command -v maestro >/dev/null 2>&1 || {
  echo "error: maestro not found on PATH (https://maestro.mobile.dev)" >&2
  exit 1
}
command -v sqlite3 >/dev/null 2>&1 || {
  echo "error: sqlite3 not found on PATH" >&2
  exit 1
}

log() { echo "[ios-background-location-e2e] $*" >&2; }

if ! xcrun simctl get_app_container "$DEVICE" "$APP_ID" data >/dev/null 2>&1; then
  log "app is not installed on simulator $DEVICE; build it with: bunx expo run:ios --device $DEVICE"
  exit 1
fi

xcrun simctl privacy "$DEVICE" grant location "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl privacy "$DEVICE" grant location-always "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl location "$DEVICE" set 47.6205,-122.3493

log "Ensuring the simulator is onboarded"
maestro --udid "$DEVICE" test -e USERNAME="$USERNAME" \
  "$REPO_ROOT/.maestro/onboarding/ensure-onboarded.yaml"

app_data="$(xcrun simctl get_app_container "$DEVICE" "$APP_ID" data)"
social_db="$app_data/Documents/SQLite/streetcryptid.social.db"
events_db="$app_data/Documents/SQLite/streetcryptid.events.db"
observer_state="$("$SCRIPT_DIR/ensure-ios-stash-observer.sh" "$DEVICE" "$OBSERVER_STATE_DIR")"
observer_bin="$REPO_ROOT/modules/iroh-location/rust/target/debug/trail-stash-client"

observe_once() {
  perl -e 'alarm shift; exec @ARGV' 45 \
    "$observer_bin" --state-dir "$observer_state" watch --once --json --timeout-seconds 30
}

# Use the fastest supported product cadence and opt into the configured stash. The service reloads
# both values on the launch below. Clear only diagnostic/outbox state, never the simulator profile.
xcrun simctl terminate "$DEVICE" "$APP_ID" >/dev/null 2>&1 || true
sqlite3 "$social_db" "
  INSERT INTO kv(key, value) VALUES('sc.social.shareIntervalMs', '60000')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  INSERT INTO kv(key, value) VALUES('sc.social.stashOptIn', '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  INSERT INTO kv(key, value) VALUES('sc.dev.iosLocationProfile', 'balanced')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  DELETE FROM kv WHERE key = 'sc.social.outbox';
"
sqlite3 "$events_db" "DELETE FROM event_log;"

log "Launching the app, arming sharing, and sending it to the background"
start_ms="$(($(date +%s) * 1000))"
maestro --udid "$DEVICE" test "$REPO_ROOT/.maestro/background-location/background-app.yaml"

cleanup() {
  xcrun simctl location "$DEVICE" clear >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "Driving a simulated walking route for up to ${TIMEOUT_SECONDS}s"
xcrun simctl location "$DEVICE" start --speed=2 --interval=5 \
  47.6205,-122.3493 \
  47.6215,-122.3480 \
  47.6225,-122.3467 \
  47.6235,-122.3454

deadline="$(($(date +%s) + TIMEOUT_SECONDS))"
while [ "$(date +%s)" -lt "$deadline" ]; do
  wake_count="$(sqlite3 "$events_db" \
    "SELECT count(*) FROM event_log WHERE timestamp >= $start_ms AND launch_context = 'background' AND action = 'bg.wake';")"
  publish_count="$(sqlite3 "$events_db" \
    "SELECT count(*) FROM event_log WHERE timestamp >= $start_ms AND action = 'publish.fix' AND status = 'ok';")"
  push_count="$(sqlite3 "$events_db" \
    "SELECT count(*) FROM event_log WHERE timestamp >= $start_ms AND action = 'trail.push.app' AND status = 'ok';")"
  if [ "$wake_count" -gt 0 ] && [ "$publish_count" -gt 0 ] && [ "$push_count" -gt 0 ]; then
    observer_json="$(observe_once || true)"
    if [ -n "$observer_json" ]; then
      log "PASS - background wake, native publish, stash push, and friend decryption completed"
      printf '%s\n' "$observer_json"
      exit 0
    fi
  fi
  sleep 5
done

log "FAIL - background pipeline did not complete through friend-side stash decryption"
sqlite3 -header -column "$events_db" "
  SELECT datetime(timestamp / 1000, 'unixepoch', 'localtime') AS time,
         launch_context, action, status, substr(details, 1, 220) AS details
  FROM event_log
  WHERE timestamp >= $start_ms
    AND action IN ('bg.wake', 'engine.ingest', 'outbox.drain', 'publish.fix', 'trail.push.app')
  ORDER BY timestamp DESC;
" >&2
exit 1
