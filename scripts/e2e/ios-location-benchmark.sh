#!/usr/bin/env bash
# Compare iOS background location policies on one simulator with identical scripted routes.
# Simulator results measure delivery behavior and app wake cost, not physical-device battery drain.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
DEVICE="${1:?Usage: ios-location-benchmark.sh <simulator-udid> [output.tsv]}"
OUTPUT="${2:-$REPO_ROOT/ios-location-benchmark.tsv}"
USERNAME="${USERNAME:-iosbench$((RANDOM % 10000))}"
SCENARIO_SECONDS="${SCENARIO_SECONDS:-360}"
OBSERVER_STATE_DIR="${OBSERVER_STATE_DIR:-$HOME/Library/Application Support/streetcryptid/e2e-stash-observer/$DEVICE}"
PROFILES=(battery balanced fidelity)

command -v maestro >/dev/null 2>&1 || {
  echo "error: maestro not found on PATH" >&2
  exit 1
}
command -v sqlite3 >/dev/null 2>&1 || {
  echo "error: sqlite3 not found on PATH" >&2
  exit 1
}

log() { echo "[ios-location-benchmark] $*" >&2; }
cleanup() { xcrun simctl location "$DEVICE" clear >/dev/null 2>&1 || true; }
trap cleanup EXIT

xcrun simctl privacy "$DEVICE" grant location "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl privacy "$DEVICE" grant location-always "$APP_ID" >/dev/null 2>&1 || true
xcrun simctl location "$DEVICE" set 47.6205,-122.3493
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

observe_scenario() {
  perl -e 'alarm shift; exec @ARGV' "$((SCENARIO_SECONDS + 45))" \
    "$observer_bin" --state-dir "$observer_state" watch --once --json \
    --timeout-seconds "$((SCENARIO_SECONDS + 30))"
}

printf 'profile\tscenario\tseconds\tbg_wakes\tfixes_delivered\tpublishes_ok\tpublish_errors\tstash_pushes\tavg_wake_ms\tmax_fix_age_ms\ttrail_points\tobserver_fixes\tobserver_avg_lag_ms\tobserver_max_lag_ms\n' >"$OUTPUT"

run_scenario() {
  local profile="$1" scenario="$2"
  local start_ms deadline observer_output observer_pid

  xcrun simctl terminate "$DEVICE" "$APP_ID" >/dev/null 2>&1 || true
  sqlite3 "$social_db" "
    INSERT INTO kv(key, value) VALUES('sc.social.shareIntervalMs', '60000')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO kv(key, value) VALUES('sc.social.stashOptIn', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO kv(key, value) VALUES('sc.dev.iosLocationProfile', '$profile')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    DELETE FROM kv WHERE key = 'sc.social.outbox';
    DELETE FROM self_trail;
  "
  sqlite3 "$events_db" "DELETE FROM event_log;"

  # The previous scenario can publish once more after its watcher returns. Consume that current LWW
  # slot before measuring this scenario; a timeout means the observer was already caught up.
  observe_once >/dev/null 2>&1 || true
  start_ms="$(($(date +%s) * 1000))"
  observer_output="$(mktemp)"
  observe_scenario >"$observer_output" &
  observer_pid=$!
  maestro --udid "$DEVICE" test "$REPO_ROOT/.maestro/background-location/background-app.yaml"

  case "$scenario" in
    walking)
      xcrun simctl location "$DEVICE" start --speed=1.4 --interval=5 \
        47.6205,-122.3493 47.6220,-122.3474 47.6235,-122.3455 47.6250,-122.3436
      ;;
    driving)
      xcrun simctl location "$DEVICE" start --speed=13.4 --interval=5 \
        47.6205,-122.3493 47.6300,-122.3370 47.6395,-122.3247 47.6490,-122.3124
      ;;
    *)
      log "unknown scenario: $scenario"
      exit 2
      ;;
  esac

  deadline="$(($(date +%s) + SCENARIO_SECONDS))"
  while [ "$(date +%s)" -lt "$deadline" ]; do sleep 5; done
  xcrun simctl location "$DEVICE" clear
  sleep 10

  local app_metrics observer_metrics
  app_metrics="$(sqlite3 -separator $'\t' "$events_db" "
    ATTACH DATABASE '$social_db' AS social;
    WITH metrics AS (
      SELECT
        count(*) FILTER (WHERE action = 'bg.wake') AS bg_wakes,
        coalesce(sum(CASE WHEN action = 'bg.wake'
          THEN json_extract(details, '$.attributes.fixes') ELSE 0 END), 0) AS fixes_delivered,
        count(*) FILTER (WHERE action = 'publish.fix' AND status = 'ok') AS publishes_ok,
        count(*) FILTER (WHERE action = 'publish.fix' AND status = 'error') AS publish_errors,
        count(*) FILTER (WHERE action = 'trail.push.app' AND status = 'ok') AS stash_pushes,
        round(avg(CASE WHEN action = 'bg.wake'
          THEN json_extract(details, '$.duration_ms') END), 1) AS avg_wake_ms,
        round(max(CASE WHEN action = 'engine.ingest'
          THEN json_extract(details, '$.attributes.fix.age_ms') END), 1) AS max_fix_age_ms
      FROM event_log
      WHERE timestamp >= $start_ms
    )
    SELECT '$profile', '$scenario', $SCENARIO_SECONDS, bg_wakes, fixes_delivered,
           publishes_ok, publish_errors, stash_pushes, coalesce(avg_wake_ms, 0),
           coalesce(max_fix_age_ms, 0), (SELECT count(*) FROM social.self_trail)
    FROM metrics;
  ")"

  wait "$observer_pid" || true
  observer_json="$(cat "$observer_output")"
  rm -f "$observer_output"
  observer_metrics="$(printf '%s\n' "$observer_json" | jq -s -r \
    '[length, ((map(.lag_ms) | add // 0) / (length | if . == 0 then 1 else . end) | floor), (map(.lag_ms) | max // 0)] | @tsv')"

  printf '%s' "$app_metrics" >>"$OUTPUT"
  printf '\t%s' "$observer_metrics" >>"$OUTPUT"
  printf '\n' >>"$OUTPUT"
}

for profile in "${PROFILES[@]}"; do
  for scenario in walking driving; do
    log "Running $profile / $scenario for ${SCENARIO_SECONDS}s"
    run_scenario "$profile" "$scenario"
  done
done

log "Benchmark complete: $OUTPUT"
column -t -s $'\t' "$OUTPUT"
