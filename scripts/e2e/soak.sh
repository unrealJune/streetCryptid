#!/usr/bin/env bash
# Long-running soak variant of run-matrix.sh: repeatedly drives one scenario (or a rotating set)
# on a single device pool for a configurable duration, sampling event_log + the stash observer
# at intervals rather than asserting once at the end. Meant to catch what a short scenario run
# can't: a slowly growing outbox, a rising drop-reason rate, or a wake-cadence regression that
# only shows up after hours. Built on the same lib/devices.sh helpers as run-matrix.sh — see
# that script for the scenario YAML schema.
#
# Writes incrementally to $OUT_DIR/samples.tsv (one row per sampling interval) so an interrupted
# or killed run still leaves a usable partial result — never buffers the whole soak in memory.
#
# Usage:
#   scripts/e2e/soak.sh --devices auto --scenarios background-walking [--hours 2]
#                        [--sample-minutes 5] [--out DIR]
#   scripts/e2e/soak.sh --devices UDID --scenarios background-walking,background-stationary --hours 12
#
# With more than one --scenarios name, the soak rotates through them in order, restarting each
# from a clean reset_app_state at the top of its slot, for (total duration / number of scenarios)
# each — so a 12h soak over 2 scenarios runs each for ~6h, not each for the full 12h.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
# shellcheck source=lib/devices.sh
source "$SCRIPT_DIR/lib/devices.sh"

devices_require_tools maestro xcrun sqlite3 jq python3

SCENARIOS_DIR="$SCRIPT_DIR/scenarios"
SCENARIO_NAMES=""
DEVICES_SPEC="auto"
HOURS="2"
SAMPLE_MINUTES="5"
OUT_DIR=""
SHARE_INTERVAL_MS="${MATRIX_SHARE_INTERVAL_MS:-60000}"
PROFILE="${MATRIX_PROFILE:-balanced}"

log() { echo "[soak] $*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --devices) DEVICES_SPEC="$2"; shift 2 ;;
    --scenarios) SCENARIO_NAMES="$2"; shift 2 ;;
    --scenarios-dir) SCENARIOS_DIR="$2"; shift 2 ;;
    --hours) HOURS="$2"; shift 2 ;;
    --sample-minutes) SAMPLE_MINUTES="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

[ -n "$SCENARIO_NAMES" ] || {
  echo "error: --scenarios <name[,name...]> is required (single-device scenarios only — see run-matrix.sh for pairing/group)" >&2
  exit 1
}

IFS=',' read -ra WANT_NAMES <<<"$SCENARIO_NAMES"
SCENARIO_FILES=()
for want in "${WANT_NAMES[@]}"; do
  found=""
  for f in "$SCENARIOS_DIR"/*.yaml; do
    n="$(jq -r .name <<<"$(python3 "$SCRIPT_DIR/lib/scenario.py" "$f")")"
    [ "$n" = "$want" ] && found="$f"
  done
  [ -n "$found" ] || {
    echo "error: no scenario named '$want' in $SCENARIOS_DIR" >&2
    exit 1
  }
  kind="$(jq -r .kind <<<"$(python3 "$SCRIPT_DIR/lib/scenario.py" "$found")")"
  [ "$kind" = "single" ] || {
    echo "error: soak.sh only drives kind: single scenarios (got '$kind' for '$want')" >&2
    exit 1
  }
  SCENARIO_FILES+=("$found")
done

TOTAL_SECONDS=$(python3 -c "print(int(float(\"$HOURS\") * 3600))")
SAMPLE_SECONDS=$(python3 -c "print(int(float(\"$SAMPLE_MINUTES\") * 60))")
SLOT_SECONDS=$((TOTAL_SECONDS / ${#SCENARIO_FILES[@]}))
[ "$SLOT_SECONDS" -ge "$SAMPLE_SECONDS" ] || {
  echo "error: --hours too small for --sample-minutes and ${#SCENARIO_FILES[@]} scenario(s) (each slot would sample less than once)" >&2
  exit 1
}

log "Resolving 1 device (--devices $DEVICES_SPEC)"
# shellcheck disable=SC2207
POOL=($(resolve_devices "$DEVICES_SPEC" 1))
[ "${#POOL[@]}" -eq 1 ] || {
  echo "error: failed to resolve a device (see above)" >&2
  exit 1
}
DEVICE="${POOL[0]}"
boot_device "$DEVICE"
assert_installed "$DEVICE" "$APP_ID"
USERNAME="soak$((RANDOM % 100000))"

OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/reports/soak-$(date +%Y%m%dT%H%M%S)}"
mkdir -p "$OUT_DIR"
SAMPLES="$OUT_DIR/samples.tsv"
printf 'scenario\telapsed_s\ttimestamp\tbg_wake\tpublish_ok\tpublish_error\tstash_push_ok\tdrop_reasons\n' >"$SAMPLES"
log "Soak plan: ${#SCENARIO_FILES[@]} scenario(s) x ${SLOT_SECONDS}s each, sampling every ${SAMPLE_SECONDS}s, device $DEVICE"
log "Output: $OUT_DIR"

cleanup() { stop_route "$DEVICE"; }
trap cleanup EXIT

sample_once() {
  local scenario_name="$1" run_start_ms="$2" elapsed="$3" events data
  data="$(app_data_dir "$DEVICE" "$APP_ID")"
  events="$(events_db_path "$data")"
  local bg_wake publish_ok publish_error stash_push_ok drop_reasons
  bg_wake="$(event_log_count "$events" "$run_start_ms" bg.wake)"
  publish_ok="$(event_log_count "$events" "$run_start_ms" publish.fix ok)"
  publish_error="$(event_log_count "$events" "$run_start_ms" publish.fix error)"
  stash_push_ok="$(event_log_count "$events" "$run_start_ms" trail.push.app ok)"
  drop_reasons="$(drop_reason_histogram "$events" "$run_start_ms" | tr '\n' ';')"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$scenario_name" "$elapsed" "$(date -u +%FT%TZ)" \
    "$bg_wake" "$publish_ok" "$publish_error" "$stash_push_ok" "$drop_reasons" >>"$SAMPLES"
  log "  [$scenario_name +${elapsed}s] bg.wake=$bg_wake publish.ok=$publish_ok publish.error=$publish_error stash.push.ok=$stash_push_ok${drop_reasons:+ drops=$drop_reasons}"
}

for f in "${SCENARIO_FILES[@]}"; do
  scenario_json="$(python3 "$SCRIPT_DIR/lib/scenario.py" "$f")"
  name="$(jq -r .name <<<"$scenario_json")"
  route="$(jq -r .route <<<"$scenario_json")"
  background="$(jq -r .background <<<"$scenario_json")"

  log "▶ $name for ${SLOT_SECONDS}s"
  reset_app_state "$DEVICE" "$APP_ID" "$SHARE_INTERVAL_MS" "$PROFILE"
  run_start_ms="$(($(date +%s) * 1000))"
  ensure_onboarded "$DEVICE" "$USERNAME"
  [ "$route" != "none" ] && drive_route "$DEVICE" "$route"
  [ "$background" = "true" ] && send_to_background "$DEVICE"

  elapsed=0
  while [ "$elapsed" -lt "$SLOT_SECONDS" ]; do
    sleep "$SAMPLE_SECONDS"
    elapsed=$((elapsed + SAMPLE_SECONDS))
    sample_once "$name" "$run_start_ms" "$elapsed"
  done
  stop_route "$DEVICE"
done

log "Soak complete: $SAMPLES"
column -t "$SAMPLES" >&2 || cat "$SAMPLES" >&2
