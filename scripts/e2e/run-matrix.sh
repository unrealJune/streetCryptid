#!/usr/bin/env bash
# Scenario-matrix orchestrator for the iOS background-sharing e2e harness. Runs a set of
# declarative scenarios (scripts/e2e/scenarios/*.yaml) across a pool of simulators, reusing the
# existing single-purpose scripts (pairing-e2e.sh, ensure-stash-observer.sh) and the shared
# helpers in lib/devices.sh rather than re-implementing device control. Writes a per-scenario
# JSON result plus a summary table to scripts/e2e/reports/<timestamp>/.
#
# Usage:
#   scripts/e2e/run-matrix.sh --devices auto [--scenarios DIR] [--only name1,name2]
#                              [--out DIR] [--strict] [--list]
#   scripts/e2e/run-matrix.sh --devices UDID1,UDID2,UDID3 --only group-share-watch
#
# Requires: maestro, sqlite3, jq, python3, perl, plus xcrun (iOS) and/or adb (Android) for the
# platforms in the pool. Devices must already have a current build installed.
# Deliberately written against bash 3.2 (macOS's stock /bin/bash) — no associative arrays,
# namerefs, or mapfile — matching every other script in this directory; don't reintroduce them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
# shellcheck source=lib/device.sh
source "$SCRIPT_DIR/lib/device.sh"
# shellcheck source=lib/netchaos.sh
source "$SCRIPT_DIR/lib/netchaos.sh"

SCENARIOS_DIR="$SCRIPT_DIR/scenarios"
DEVICES_SPEC="auto"
ONLY=""
OUT_DIR=""
STRICT=false
LIST_ONLY=false
SHARE_INTERVAL_MS="${MATRIX_SHARE_INTERVAL_MS:-60000}"
PROFILE="${MATRIX_PROFILE:-balanced}"
THRASH_INTERVAL_SECONDS=20
# Must match ensure-local-stash.sh's own default; chaos scenarios block this host:port directly
# rather than resolving it from .env.local, since EXPO_PUBLIC_* is build-time inlined (AGENTS.md)
# and can't be read back out of an already-compiled app.
TRAIL_STASH_LOCAL_PORT="${TRAIL_STASH_LOCAL_PORT:-8799}"

log() { echo "[run-matrix] $*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --devices) DEVICES_SPEC="$2"; shift 2 ;;
    --scenarios) SCENARIOS_DIR="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --strict) STRICT=true; shift ;;
    --list) LIST_ONLY=true; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

[ -d "$SCENARIOS_DIR" ] || {
  echo "error: no such scenarios directory: $SCENARIOS_DIR" >&2
  exit 1
}

SCENARIO_FILES=()
while IFS= read -r f; do
  SCENARIO_FILES+=("$f")
done < <(find "$SCENARIOS_DIR" -maxdepth 1 -name '*.yaml' | sort)
[ "${#SCENARIO_FILES[@]}" -gt 0 ] || {
  echo "error: no *.yaml scenarios found in $SCENARIOS_DIR" >&2
  exit 1
}

if [ -n "$ONLY" ]; then
  IFS=',' read -ra only_names <<<"$ONLY"
  filtered=()
  for f in "${SCENARIO_FILES[@]}"; do
    n="$(jq -r .name <<<"$(python3 "$SCRIPT_DIR/lib/scenario.py" "$f")")"
    for want in "${only_names[@]}"; do
      [ "$n" = "$want" ] && filtered+=("$f")
    done
  done
  [ "${#filtered[@]}" -gt 0 ] || {
    echo "error: --only $ONLY matched no scenario (see: $0 --list)" >&2
    exit 1
  }
  # `(${filtered[@]+"${filtered[@]}"})`, not a bare `("${filtered[@]}")` — bash 3.2 (macOS's
  # stock /bin/bash) treats rebuilding an array literal from an empty array as an unbound-
  # variable error under `set -u`. The check above already rules out empty here, but this stays
  # the safe form so the guard can't silently drift out of sync with the assignment beneath it.
  SCENARIO_FILES=(${filtered[@]+"${filtered[@]}"})
fi

if [ "$LIST_ONLY" = true ]; then
  for f in "${SCENARIO_FILES[@]}"; do
    s="$(python3 "$SCRIPT_DIR/lib/scenario.py" "$f")"
    printf '%-24s %-8s devices=%s  %s\n' \
      "$(jq -r .name <<<"$s")" "$(jq -r .kind <<<"$s")" "$(jq -r .devices <<<"$s")" \
      "$(jq -r .description <<<"$s")"
  done
  exit 0
fi

MAX_DEVICES=1
NEEDS_LOCAL_STASH=false
NEEDS_CHAOS=false
for f in "${SCENARIO_FILES[@]}"; do
  scenario_json="$(python3 "$SCRIPT_DIR/lib/scenario.py" "$f")"
  n="$(jq -r .devices <<<"$scenario_json")"
  [ "$n" -gt "$MAX_DEVICES" ] && MAX_DEVICES="$n"
  [ "$(jq -r '.require_local_stash // false' <<<"$scenario_json")" = "true" ] && NEEDS_LOCAL_STASH=true
  [ "$(jq -r '.chaos // "none"' <<<"$scenario_json")" != "none" ] && NEEDS_CHAOS=true
done

if [ "$NEEDS_LOCAL_STASH" = true ]; then
  log "A selected scenario needs the local trail-stash — ensuring it's up"
  TRAIL_STASH_LOCAL_PORT="$TRAIL_STASH_LOCAL_PORT" bash "$SCRIPT_DIR/ensure-local-stash.sh" start
fi

if [ "$NEEDS_CHAOS" = true ]; then
  # Primed once, up front, in the main (foreground) shell rather than inside a backgrounded
  # run_device_driver — sudo's interactive password prompt needs a real controlling terminal,
  # and a `&`-backgrounded job may not reliably get one. macOS's sudo credential cache (a few
  # minutes by default) then covers the block_host/allow_host calls made later from the
  # background driver without re-prompting.
  log "A selected scenario needs network chaos — priming pf (will prompt for sudo)"
  start_chaos
fi

log "Resolving a pool of $MAX_DEVICES device(s) (--devices $DEVICES_SPEC)"
# shellcheck disable=SC2207
POOL=($(resolve_devices "$DEVICES_SPEC" "$MAX_DEVICES"))
[ "${#POOL[@]}" -eq "$MAX_DEVICES" ] || {
  echo "error: failed to resolve $MAX_DEVICES device(s) (see above)" >&2
  exit 1
}
device_require_tools "${POOL[@]}"
for spec in "${POOL[@]}"; do
  device_boot "$spec"
  device_assert_installed "$spec"
  device_provision "$spec"
done
log "Pool: ${POOL[*]}"

# POOL_USERNAMES is index-aligned with POOL (index i is that device's identity for the whole
# run) — plain indexed array, not a udid-keyed map, since bash 3.2 (macOS's stock /bin/bash) has
# no associative arrays. Every place that slices POOL (run_single_or_group's `devices`) is always
# a prefix POOL[0..k], so the same index into POOL_USERNAMES stays valid without a lookup.
POOL_USERNAMES=()
for udid in "${POOL[@]}"; do
  POOL_USERNAMES+=("mtx$((RANDOM % 100000))")
done

OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/reports/$(date +%Y%m%dT%H%M%S)}"
mkdir -p "$OUT_DIR"
SUMMARY="$OUT_DIR/summary.md"
{
  echo "# e2e matrix run — $(date -u +%FT%TZ)"
  echo
  echo "| scenario | kind | result |"
  echo "|---|---|---|"
} >"$SUMMARY"

cleanup() {
  local spec
  for spec in "${POOL[@]}"; do
    device_stop_route "$spec"
  done
  [ "$NEEDS_CHAOS" = true ] && stop_chaos
}
trap cleanup EXIT

OVERALL_EXIT=0

# clear_event_log <ios-udid> — used before scenarios not covered by reset_app_state (pairing/
# group's pairing phase), so assertions only see this run's activity. iOS-only: pairing-e2e.sh
# (which this precedes) doesn't support Android — see the platform guards in run_pairing_kind and
# run_single_or_group's group branch.
clear_event_log() {
  local udid="$1" data events
  data="$(app_data_dir "$udid" "$APP_ID")"
  events="$(events_db_path "$data")"
  sqlite3 "$events" "DELETE FROM event_log;"
}

now_ms() { echo "$(($(date +%s) * 1000))"; }

# run_device_driver <device-spec> <scenario_json> — arms a device for the scenario's duration:
# drives the configured route, backgrounds it if requested, and runs the requested mid-scenario
# action (thrash cycling, a force-quit, or a chaos block/restore window) without blocking the
# caller (invoked with `&`). At most one of thrash / force_quit / chaos is meaningful per
# scenario. Dispatches route-driving and process-termination by platform; send_to_background
# stays a single shared call — Maestro's --udid/--device works identically for an adb serial.
run_device_driver() {
  local spec="$1" scenario_json="$2"
  local route background duration force_quit thrash chaos chaos_after chaos_restore_after
  route="$(jq -r .route <<<"$scenario_json")"
  background="$(jq -r .background <<<"$scenario_json")"
  duration="$(jq -r .duration_seconds <<<"$scenario_json")"
  force_quit="$(jq -r .force_quit_after_seconds <<<"$scenario_json")"
  thrash="$(jq -r .thrash <<<"$scenario_json")"
  chaos="$(jq -r '.chaos // "none"' <<<"$scenario_json")"
  chaos_after="$(jq -r '.chaos_after_seconds // 0' <<<"$scenario_json")"
  chaos_restore_after="$(jq -r '.chaos_restore_after_seconds // 0' <<<"$scenario_json")"

  device_drive_route "$spec" "$route"
  [ "$background" = "true" ] && device_background "$spec"

  if [ "$thrash" = "true" ]; then
    local elapsed=0
    while [ "$elapsed" -lt "$duration" ]; do
      sleep "$THRASH_INTERVAL_SECONDS"
      elapsed=$((elapsed + THRASH_INTERVAL_SECONDS))
      device_background "$spec" || true
    done
  elif [ "$force_quit" -gt 0 ]; then
    sleep "$force_quit"
    device_terminate_app "$spec"
    local remainder=$((duration - force_quit))
    [ "$remainder" -gt 0 ] && sleep "$remainder"
  elif [ "$chaos" != "none" ]; then
    sleep "$chaos_after"
    case "$chaos" in
      stash-unreachable) block_host 127.0.0.1 "$TRAIL_STASH_LOCAL_PORT" ;;
      *) log "  warning: unknown chaos type '$chaos' in scenario JSON, skipping the block" ;;
    esac
    sleep "$chaos_restore_after"
    case "$chaos" in
      stash-unreachable) allow_host 127.0.0.1 "$TRAIL_STASH_LOCAL_PORT" ;;
    esac
    local remainder=$((duration - chaos_after - chaos_restore_after))
    [ "$remainder" -gt 0 ] && sleep "$remainder"
  else
    sleep "$duration"
  fi
}

# eval_assertions <udid> <scenario_json> <start_ms> — prints one compact JSON check object per
# assertion, one per line, on stdout; returns 1 if any assertion failed. (No pass-by-reference
# array here — bash 3.2 has no namerefs — so callers capture stdout and split it themselves.)
eval_assertions() {
  local spec="$1" scenario_json="$2" start_ms="$3"
  local pass_all=0
  local i count
  count="$(jq '.assertions | length' <<<"$scenario_json")"
  for ((i = 0; i < count; i++)); do
    local action status min_count actual pass
    action="$(jq -r ".assertions[$i].action" <<<"$scenario_json")"
    status="$(jq -r ".assertions[$i].status // empty" <<<"$scenario_json")"
    min_count="$(jq -r ".assertions[$i].min_count" <<<"$scenario_json")"
    actual="$(device_event_log_count "$spec" "$start_ms" "$action" "$status")"
    if [ "$actual" -ge "$min_count" ]; then pass=true; else pass=false; fi
    [ "$pass" = false ] && pass_all=1
    local check
    check="$(jq -n -c --arg udid "$spec" --arg action "$action" --arg status "$status" \
      --argjson min_count "$min_count" --argjson actual "$actual" --argjson pass "$pass" \
      '{device: $udid, action: $action, status: (if $status == "" then null else $status end),
        min_count: $min_count, actual: $actual, pass: $pass}')"
    printf '%s\n' "$check"
  done
  return $pass_all
}

# write_report <name> <kind> <simulator_limited> <checks_json_array> <scenario_ok>
write_report() {
  local name="$1" kind="$2" simulator_limited="$3" checks_json="$4" ok="$5"
  jq -n --arg name "$name" --arg kind "$kind" --argjson simulator_limited "$simulator_limited" \
    --argjson checks "$checks_json" --argjson ok "$ok" \
    '{name: $name, kind: $kind, simulator_limited: $simulator_limited, pass: $ok, checks: $checks}' \
    >"$OUT_DIR/$name.json"

  local result
  if [ "$ok" = true ]; then
    result="✅ pass"
  elif [ "$simulator_limited" = true ]; then
    result="⚠️ limited"
  else
    result="❌ fail"
  fi
  printf '| %s | %s | %s |\n' "$name" "$kind" "$result" >>"$SUMMARY"
}

run_single_or_group() {
  local scenario_file="$1" scenario_json devices_needed kind name
  scenario_json="$(python3 "$SCRIPT_DIR/lib/scenario.py" "$scenario_file")"
  name="$(jq -r .name <<<"$scenario_json")"
  kind="$(jq -r .kind <<<"$scenario_json")"
  devices_needed="$(jq -r .devices <<<"$scenario_json")"
  local simulator_limited
  simulator_limited="$(jq -r '.simulator_limited // false' <<<"$scenario_json")"
  local require_observer
  require_observer="$(jq -r .require_stash_observer <<<"$scenario_json")"

  local devices=("${POOL[@]:0:$devices_needed}")
  log "▶ $name ($kind, ${#devices[@]} device(s)): ${devices[*]}"

  # Re-assert the devices before every scenario, not just once at pool setup. A simulator can be
  # shut down mid-suite by memory pressure (observed: macOS reclaimed two sims while an Android
  # emulator was also running), and the next `simctl` call then fails with "Unable to lookup in
  # current state: Shutdown", aborting the whole run under `set -e` — losing every scenario still
  # queued behind it.
  local spec
  for spec in "${devices[@]}"; do
    device_boot "$spec"
  done

  # Capability gate, asked of the devices themselves rather than hardcoded per platform — see
  # device_supports in lib/device.sh, which is the single place those gaps are declared.
  local chaos_kind spec
  chaos_kind="$(jq -r '.chaos // "none"' <<<"$scenario_json")"
  for spec in "${devices[@]}"; do
    if [ "$kind" = "group" ] && ! device_supports "$spec" pairing; then
      echo "error: '$name' is kind: group but $spec has no pairing support (see device_supports)" >&2
      exit 1
    fi
    if [ "$require_observer" = "true" ] && ! device_supports "$spec" stash-observer; then
      echo "error: '$name' needs require_stash_observer but $spec has no stash-observer support (see device_supports); try background-stationary, long-idle-background, or force-quit-relaunch" >&2
      exit 1
    fi
    if [ "$chaos_kind" != "none" ] && ! device_supports "$spec" net-chaos; then
      echo "error: '$name' is a chaos scenario but $spec has no net-chaos support (see device_supports)" >&2
      exit 1
    fi
  done

  if [ "$kind" = "group" ]; then
    local a b
    for ((a = 0; a < ${#devices[@]}; a++)); do
      for ((b = a + 1; b < ${#devices[@]}; b++)); do
        log "  pairing ${devices[$a]} <-> ${devices[$b]}"
        USERNAME_A="${POOL_USERNAMES[$a]}" USERNAME_B="${POOL_USERNAMES[$b]}" \
          bash "$SCRIPT_DIR/pairing-e2e.sh" "${devices[$a]}" "${devices[$b]}" >&2
      done
    done
  fi

  # start_ms / observer_state are index-aligned with `devices` (device i's data lives at index
  # i in each) — plain indexed arrays, not udid-keyed maps; see the POOL_USERNAMES note above.
  local start_ms=() observer_state=() i udid
  for ((i = 0; i < ${#devices[@]}; i++)); do
    udid="${devices[$i]}"
    device_reset_app_state "$udid" "$SHARE_INTERVAL_MS" "$PROFILE"
    start_ms+=("$(now_ms)")
    device_onboard "$udid" "${POOL_USERNAMES[$i]}"
    if [ "$require_observer" = "true" ]; then
      observer_state+=("$(ensure_stash_observer "$udid")")
    else
      observer_state+=("")
    fi
  done

  local pids=()
  for udid in "${devices[@]}"; do
    run_device_driver "$udid" "$scenario_json" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do wait "$pid"; done

  local checks=() ok=true checks_output rc line
  for ((i = 0; i < ${#devices[@]}; i++)); do
    udid="${devices[$i]}"
    # `if var=$(cmd)` (not a bare `var=$(cmd)`) is the errexit-exempt form — a bare assignment
    # would abort the whole script the moment an assertion fails, before `rc` is ever read.
    if checks_output="$(eval_assertions "$udid" "$scenario_json" "${start_ms[$i]}")"; then
      rc=0
    else
      rc=$?
    fi
    if [ -n "$checks_output" ]; then
      while IFS= read -r line; do
        [ -n "$line" ] && checks+=("$line")
      done <<<"$checks_output"
    fi
    [ "$rc" -eq 0 ] || ok=false
    if [ "$require_observer" = "true" ]; then
      stash_observe_once "${observer_state[$i]}" 30 >/dev/null 2>&1 || {
        log "  note: stash observer saw nothing yet for $udid (may need a longer duration)"
      }
    fi
  done
  local checks_json
  # ${checks[@]+"${checks[@]}"}, not a bare "${checks[@]}" — see the bash-3.2 empty-array note
  # near the --only filter above; every authored scenario has >=1 assertion so checks is never
  # actually empty today, but this stays defensive against a future zero-assertion scenario.
  checks_json="$(printf '%s\n' ${checks[@]+"${checks[@]}"} | jq -s '.')"
  write_report "$name" "$kind" "$simulator_limited" "$checks_json" "$ok"

  if [ "$ok" = false ]; then
    if [ "$simulator_limited" = true ] && [ "$STRICT" = false ]; then
      log "  ⚠️ $name failed but is marked simulator_limited (see PHYSICAL-DEVICE-CHECKLIST.md)"
    else
      OVERALL_EXIT=1
    fi
  fi
}

run_pairing_kind() {
  local scenario_file="$1" scenario_json name devices_needed
  scenario_json="$(python3 "$SCRIPT_DIR/lib/scenario.py" "$scenario_file")"
  name="$(jq -r .name <<<"$scenario_json")"
  devices_needed="$(jq -r .devices <<<"$scenario_json")"
  [ "$devices_needed" -eq 2 ] || {
    echo "error: scenario '$name' has kind: pairing but devices != 2" >&2
    exit 1
  }
  local a="${POOL[0]}" b="${POOL[1]}"
  device_boot "$a"
  device_boot "$b"
  if ! device_supports "$a" pairing || ! device_supports "$b" pairing; then
    echo "error: '$name' is kind: pairing but one of $a / $b has no pairing support (see device_supports)" >&2
    exit 1
  fi
  log "▶ $name (pairing): $a <-> $b"

  clear_event_log "$a"
  clear_event_log "$b"
  local start_ms_a
  start_ms_a="$(now_ms)"
  USERNAME_A="${POOL_USERNAMES[0]}" USERNAME_B="${POOL_USERNAMES[1]}" \
    bash "$SCRIPT_DIR/pairing-e2e.sh" "$a" "$b" >&2

  local checks=() ok=true checks_output rc line
  if checks_output="$(eval_assertions "$a" "$scenario_json" "$start_ms_a")"; then
    rc=0
  else
    rc=$?
  fi
  if [ -n "$checks_output" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && checks+=("$line")
    done <<<"$checks_output"
  fi
  [ "$rc" -eq 0 ] || ok=false
  local checks_json
  # ${checks[@]+"${checks[@]}"}, not a bare "${checks[@]}" — see the bash-3.2 empty-array note
  # near the --only filter above; every authored scenario has >=1 assertion so checks is never
  # actually empty today, but this stays defensive against a future zero-assertion scenario.
  checks_json="$(printf '%s\n' ${checks[@]+"${checks[@]}"} | jq -s '.')"
  write_report "$name" "pairing" false "$checks_json" "$ok"
  [ "$ok" = true ] || OVERALL_EXIT=1
}

for f in "${SCENARIO_FILES[@]}"; do
  kind="$(jq -r .kind <<<"$(python3 "$SCRIPT_DIR/lib/scenario.py" "$f")")"
  case "$kind" in
    pairing) run_pairing_kind "$f" ;;
    single|group) run_single_or_group "$f" ;;
    *)
      echo "error: unknown scenario kind '$kind' in $f" >&2
      exit 1
      ;;
  esac
done

log "Report: $OUT_DIR"
column -t -s '|' "$SUMMARY" >&2 || cat "$SUMMARY" >&2
exit "$OVERALL_EXIT"
