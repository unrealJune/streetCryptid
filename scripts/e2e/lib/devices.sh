#!/usr/bin/env bash
# Shared iOS Simulator helpers for the e2e harness. Meant to be `source`d, not executed —
# every existing scripts/e2e/*.sh script (pairing-e2e.sh, ios-background-location-e2e.sh,
# ios-location-benchmark.sh, ensure-stash-observer.sh) duplicated this logic; run-matrix.sh
# and soak.sh are built on it instead of re-duplicating it again. Callers must already have
# `set -euo pipefail`, `APP_ID`, and `SCRIPT_DIR`/`REPO_ROOT` set the way the existing scripts do.
#
# Requires: xcrun (simctl), maestro, sqlite3, python3, jq.

DEVICES_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$DEVICES_LIB_DIR/.." && pwd)"

devices_require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "error: $tool not found on PATH" >&2
      exit 1
    }
  done
}

# WHICH MAESTRO RUNNER DRIVES THE DEVICES.
#
# `maestro` is the upstream CLI. `maestro-runner` (github.com/devicelab-dev/maestro-runner) runs
# the SAME flow files through UIAutomator2 / WebDriverAgent and is measurably faster on this repo's
# flows — ensure-onboarded.yaml: Android 16.6s -> 9.2s, iOS 20.5s -> 13.6s; a bare hierarchy dump:
# Android 5.4s -> 2.2s, iOS 8.0s -> 4.0s. Both produce identical pass/fail on our flows.
#
# It is opt-in rather than the default on purpose: it is third-party, younger than the upstream
# CLI, and it drives real devices — so the switch should be a deliberate choice, not something a
# clone inherits silently. Flip it with:  export E2E_MAESTRO=maestro-runner
#
# Everything routes through maestro_cmd/maestro_test, so this is a transport swap only: same YAML,
# same selectors, same assertions on both platforms. Three known differences are handled for you:
#   * hierarchy_text.py reads both hierarchy dialects;
#   * no flow may use `${VAR}` in a `timeout:` (the runner parses it strictly as an int;
#     `maestro-runner lint .maestro/` catches violations);
#   * a flow START restarts the app under BOTH runners (maestro-runner creates a WebDriverAgent
#     session per flow and WDA's create-session defaults `forceAppLaunch` to YES), so anything
#     holding in-app session state — pairing above all — must run as ONE flow. See
#     .maestro/pairing/pair-device.yaml and the rendezvous helpers at the bottom of this file.
E2E_MAESTRO="${E2E_MAESTRO:-maestro}"

# maestro_cmd <udid> <args...> — invoke the configured runner. maestro-runner needs an explicit
# --platform (it does not infer one from a UDID), so resolve it by ASKING the toolchains which of
# them owns this id rather than pattern-matching its shape: an adb serial can be anything
# (`emulator-5554`, a hostname:port, a hardware serial, a physical device's own UDID), and
# guessing wrong sends the flow to the wrong driver with a confusing error.
maestro_cmd() {
  local udid="$1"
  shift
  if [ "$E2E_MAESTRO" != "maestro-runner" ]; then
    maestro --udid "$udid" "$@"
    return
  fi
  local plat
  plat="$(maestro_platform_for "$udid")"
  # maestro-runner writes an HTML/JUnit/Allure report per `test` run into ./reports/<timestamp>
  # of the CURRENT WORKING DIRECTORY. Two problems with the default: the harness now runs flows
  # CONCURRENTLY and that path has one-second resolution, so simultaneous runs can collide in one
  # directory; and the reports land wherever the caller happened to be, scattering untracked
  # output through the repo. Give each device its own directory under one ignored root instead.
  #
  # Written as two whole invocations rather than one built from an optional array: under `set -u`,
  # bash 3.2 (which macOS still ships) treats "${empty[@]}" as an unbound variable and aborts, so
  # the "no extra args" case has to avoid expanding an empty array at all.
  if [ "${1:-}" = "test" ]; then
    shift
    maestro-runner --platform "$plat" --udid "$udid" test \
      --output "$E2E_REPORT_ROOT/$udid" "$@"
  else
    maestro-runner --platform "$plat" --udid "$udid" "$@"
  fi
}

# Where maestro-runner's per-run reports go. Kept out of the tree the app is built from, and
# gitignored — see .gitignore.
E2E_REPORT_ROOT="${E2E_REPORT_ROOT:-$REPO_ROOT/.e2e-reports}"

# maestro_platform_for <device-id> — "android" if adb claims the id, else "ios". Memoised,
# because this is called for every flow and every hierarchy dump and `adb devices` is not free.
#
# The cache is a set of dynamically-named variables rather than an associative array on purpose:
# macOS still ships bash 3.2, which has no `declare -A`. An earlier revision used one, and
# because `declare -A` merely warns rather than failing the script, the lookup silently returned
# the EMPTY STRING — which surfaced as `maestro-runner --platform  --udid emulator-5554`, i.e. a
# runner invoked with no platform at all. Anything added here must stay 3.2-compatible.
maestro_platform_for() {
  local udid="$1" key cached plat
  key="MAESTRO_PLATFORM_CACHE_$(printf '%s' "$udid" | tr -c 'A-Za-z0-9' '_')"
  eval "cached=\${$key:-}"
  if [ -n "$cached" ]; then
    printf '%s' "$cached"
    return 0
  fi
  plat=ios
  if command -v adb >/dev/null 2>&1 && adb devices 2>/dev/null | grep -q "^${udid}[[:space:]]"; then
    plat=android
  fi
  eval "$key=\$plat"
  printf '%s' "$plat"
}

# hierarchy_text <udid> <testID> — same behavior as the copy in pairing-e2e.sh.
hierarchy_text() {
  maestro_cmd "$1" hierarchy 2>/dev/null | python3 "$E2E_DIR/hierarchy_text.py" "$2"
}

# hierarchy_has <udid> <testID> — exit 0 if present, 1 if not, no stdout noise.
hierarchy_has() {
  maestro_cmd "$1" hierarchy 2>/dev/null | python3 "$E2E_DIR/hierarchy_text.py" "$2" >/dev/null 2>&1
}

# grant_location_privacy <udid> <app_id>
grant_location_privacy() {
  xcrun simctl privacy "$1" grant location "$2" >/dev/null 2>&1 || true
  xcrun simctl privacy "$1" grant location-always "$2" >/dev/null 2>&1 || true
}

# ensure_nearby_location <udid> <app_id> <lat> <lon> — grants privacy and sets a fixed point.
ensure_nearby_location() {
  grant_location_privacy "$1" "$2"
  xcrun simctl location "$1" set "$3,$4" >/dev/null 2>&1 || true
}

# boot_device <udid> — boots a shutdown simulator and waits until ready; no-op if already booted.
boot_device() {
  local udid="$1" state
  state="$(xcrun simctl list devices -j | python3 -c "
import json, sys
devices = json.load(sys.stdin)['devices']
for runtime in devices.values():
    for d in runtime:
        if d['udid'] == '$udid':
            print(d['state'])
            sys.exit(0)
")"
  if [ "$state" != "Booted" ]; then
    xcrun simctl boot "$udid"
  fi
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true
}

# pick_devices <n> — prints n whitespace-separated UDIDs, preferring already-booted simulators
# (avoids paying a boot per scenario), then booting additional ones from `simctl list available`
# as needed. iPad/watch/tv runtimes are skipped by name. Fails loudly if fewer than n exist.
pick_devices() {
  local n="$1"
  python3 - "$n" <<'PY'
import json
import subprocess
import sys

n = int(sys.argv[1])
data = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"]))
candidates = []
for runtime, devices in data["devices"].items():
    for d in devices:
        name = d.get("name", "")
        if "iPad" in name or "Watch" in name or "TV" in name or "Vision" in name:
            continue
        candidates.append((d["state"] != "Booted", name, d["udid"]))
# Booted devices first (False sorts before True), stable within that by name.
candidates.sort(key=lambda c: c[0])
if len(candidates) < n:
    print(f"error: need {n} iPhone simulators, only {len(candidates)} available", file=sys.stderr)
    sys.exit(1)
print(" ".join(c[2] for c in candidates[:n]))
PY
}

# device_platform <device-spec> — "ios" or "android". A spec is a bare UDID (implicitly iOS, for
# backward compatibility with every scenario/script written before Android existed) or
# "ios:<udid>" / "android:<serial>". Mixed pools are entirely opt-in via explicit --devices;
# "auto" pool resolution (pick_devices) only ever selects iOS Simulators.
device_platform() {
  case "$1" in
    android:*) printf 'android' ;;
    *) printf 'ios' ;;
  esac
}

# device_id <device-spec> — strips the "ios:"/"android:" prefix, if any.
device_id() {
  case "$1" in
    android:*) printf '%s' "${1#android:}" ;;
    ios:*) printf '%s' "${1#ios:}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# resolve_devices <spec> <n> — spec is either "auto" (pick_devices n, iOS Simulators only,
# booting as needed) or a comma-separated device-spec list, each optionally "ios:"/"android:"
# prefixed (must have exactly n entries). Prints n whitespace-separated device specs.
resolve_devices() {
  local spec="$1" n="$2" udid
  if [ "$spec" = "auto" ]; then
    pick_devices "$n"
  else
    local IFS=,
    read -ra parts <<<"$spec"
    if [ "${#parts[@]}" -ne "$n" ]; then
      echo "error: scenario needs $n device(s), got ${#parts[@]} in --devices" >&2
      exit 2
    fi
    # NOT "${parts[*]}" — IFS is still "," here (local to this function call), so a `[*]` join
    # would print a comma-joined string that the caller's default-IFS word-splitting can't undo.
    # `[@]` expands each element as its own word regardless of IFS, so print one per line instead.
    printf '%s\n' "${parts[@]}"
  fi
}

# assert_installed <udid> <app_id> — fails with a build hint if the app isn't on the simulator.
assert_installed() {
  xcrun simctl get_app_container "$1" "$2" data >/dev/null 2>&1 || {
    echo "error: app is not installed on simulator $1; build it with: bunx expo run:ios --device $1" >&2
    exit 1
  }
}

# app_data_dir <udid> <app_id>
app_data_dir() {
  xcrun simctl get_app_container "$1" "$2" data
}

# social_db_path / events_db_path <app_data_dir>
social_db_path() { printf '%s/Documents/SQLite/streetcryptid.social.db' "$1"; }
events_db_path() { printf '%s/Documents/SQLite/streetcryptid.events.db' "$1"; }

# terminate_app <udid> <app_id>
terminate_app() {
  xcrun simctl terminate "$1" "$2" >/dev/null 2>&1 || true
}

# maestro_test <udid> <maestro test args...> — runs `maestro test`, retrying ONLY when the run
# died from a device/transport fault rather than from the flow itself.
#
# This is a thin safety net, NOT the fix for Android flakiness. If you are seeing
# "Device server died"/"device offline" on an Android emulator, the cause is almost certainly an
# under-provisioned AVD, and you should fix that instead of leaning on these retries — see
# scripts/e2e/android/create-avd.sh. `avdmanager`'s defaults give the guest 2 GB RAM with
# hw.gpu.enabled=no; under a React Native dev build the guest hits memory pressure and Android's
# low-memory killer reaps Maestro's ON-DEVICE driver process (dev.mobile.maestro), which the host
# then reports as a dead device server. Measured on this repo's app: 2 GB + software GPU failed
# ~50% of launchApp calls; 6 GB + hw.gpu.mode=host passed 8/8. iOS Simulators cannot hit this at
# all — they share host RAM with no fixed cap, no guest kernel/LMK, and no on-device driver
# process to kill, which is why this whole failure mode is Android-only.
#
# The retry is deliberately narrow: it matches only transport-fault strings, so a genuine
# assertion failure ("Assertion is false", element not found) returns on the first attempt and is
# never retried into a false pass. If you widen these patterns, you risk exactly that.
MAESTRO_MAX_ATTEMPTS="${MAESTRO_MAX_ATTEMPTS:-3}"
maestro_test() {
  local udid="$1"
  shift
  local attempt=1 out rc
  while :; do
    # `if out=$(cmd)` (not a bare `out=$(cmd)`) is the errexit-exempt form — under `set -e` a
    # bare assignment from a failing command substitution aborts the caller immediately, before
    # `rc` can be read, so the retry below would never run and the script would die silently.
    if out="$(maestro_cmd "$udid" test "$@" 2>&1)"; then
      rc=0
    else
      rc=$?
    fi
    # stderr, NOT stdout: this is diagnostic output, and several callers capture a script's
    # stdout as DATA (ensure-stash-observer.sh returns its state dir that way). Printing Maestro's
    # flow log to stdout silently prepends it to that value — the symptom was a state_dir of
    # "Running on streetcryptid-e2e", i.e. the whole Maestro transcript. Keep data on stdout and
    # everything else on stderr, matching log() throughout this harness.
    printf '%s\n' "$out" >&2
    [ "$rc" -eq 0 ] && return 0
    # `Failed to create session ... connection refused` is the iOS equivalent of the Android
    # transport faults above: the driver (WebDriverAgent) was not listening when the flow started,
    # which happens when a previous run left it dying or two devices are brought up at once. It is
    # a fault in the harness's plumbing, not in the flow — the run never reaches step 0 — so it
    # belongs in this list. Kept as narrow as the rest: only the session/connection wording, never
    # a bare "refused" or an assertion message.
    if ! printf '%s' "$out" | grep -qE "device offline|DeviceServerDied|Device server died|UNAVAILABLE|device .* not found|Failed to run flow|Failed to create session|failed to create session|connection refused"; then
      return "$rc" # a real flow/assertion failure — surface it immediately
    fi
    if [ "$attempt" -ge "$MAESTRO_MAX_ATTEMPTS" ]; then
      echo "[devices] maestro: device-transport fault persisted across $attempt attempts on $udid" >&2
      return "$rc"
    fi
    echo "[devices] maestro: device-transport fault on $udid (attempt $attempt/$MAESTRO_MAX_ATTEMPTS) — waiting for device and retrying" >&2
    if command -v adb >/dev/null 2>&1 && adb devices 2>/dev/null | grep -q "^${udid}[[:space:]]"; then
      adb -s "$udid" wait-for-device >/dev/null 2>&1 || true
    fi
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done
}

# ensure_onboarded <udid> <username>
ensure_onboarded() {
  maestro_test "$1" -e USERNAME="$2" "$REPO_ROOT/.maestro/onboarding/ensure-onboarded.yaml"
}

# reset_app_state <udid> <app_id> <share_interval_ms> <profile> — clears outbox/event history and
# arms the fastest supported cadence, exactly like ios-background-location-e2e.sh /
# ios-location-benchmark.sh did inline.
#
# `sc.social.sharingEnabled` is asserted here rather than assumed. Every scenario in this harness
# exists to observe a device that is actively sharing, and sharing is a user-facing toggle that
# persists — so a device left with it OFF produces a run in which nothing publishes, nothing is
# pushed, and no assertion has anything to say. That is precisely what happened: an Android
# emulator sat at `sharingEnabled=0` and the trio test reported "device B pipeline=0" with an
# event log containing no `bg.wake` at all, which reads like a broken background task rather than
# a switch that was never flipped. Stash opt-in is set for the same reason: every scenario here
# exercises the durable path.
reset_app_state() {
  local udid="$1" app_id="$2" share_interval_ms="$3" profile="$4"
  local data social events
  data="$(app_data_dir "$udid" "$app_id")"
  social="$(social_db_path "$data")"
  events="$(events_db_path "$data")"
  terminate_app "$udid" "$app_id"
  sqlite3 "$social" "
    INSERT INTO kv(key, value) VALUES('sc.social.shareIntervalMs', '$share_interval_ms')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO kv(key, value) VALUES('sc.social.stashOptIn', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO kv(key, value) VALUES('sc.social.sharingEnabled', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO kv(key, value) VALUES('sc.dev.iosLocationProfile', '$profile')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    DELETE FROM kv WHERE key = 'sc.social.outbox';
  "
  sqlite3 "$events" "DELETE FROM event_log;"
}

# reset_pairing_state <udid> <app_id> — forget every friend, so a pairing run starts from a
# clean slate.
#
# WHY A PAIRING TEST MUST DO THIS. pairing-e2e.sh asserts that both sides MINT a friend record,
# which only means something if they were not already friends. Left alone, the devices accumulate
# friends across runs, and re-pairing an existing friend does not reliably re-issue a SAS
# challenge — observed directly: a fourth consecutive run had both devices sitting with a live
# friend (`1 friend on the map: @test`), the redeeming device never showed a challenge, and the
# run failed 60s later with the misleading "neither device ever showed the SAS challenge".
# That flake is a test-hygiene artifact, not a product bug, and it also silently weakened the
# assertion — so reset rather than tolerate it.
#
# NOT part of reset_app_state: that one runs AFTER pairing in trio-e2e.sh (to clear the outbox and
# event history without discarding the friend records the run just made). Wiping friends there
# would destroy the topology under test.
reset_pairing_state() {
  local udid="$1" app_id="$2" social
  social="$(social_db_path "$(app_data_dir "$udid" "$app_id")")"
  terminate_app "$udid" "$app_id"
  sqlite3 "$social" "
    DELETE FROM kv WHERE key IN ('sc.social.pool', 'sc.social.ratchetActivity');
    DELETE FROM friend_latest;
  "
}

# drive_route <udid> <route> — starts a scripted location route. `stationary` sets one fixed
# point and returns immediately (tests that low-motion sampling suppression doesn't wedge the
# outbox); `walking`/`driving` mirror ios-location-benchmark.sh's two profiles.
drive_route() {
  local udid="$1" route="$2"
  case "$route" in
    walking)
      xcrun simctl location "$udid" start --speed=1.4 --interval=5 \
        47.6205,-122.3493 47.6220,-122.3474 47.6235,-122.3455 47.6250,-122.3436
      ;;
    driving)
      xcrun simctl location "$udid" start --speed=13.4 --interval=5 \
        47.6205,-122.3493 47.6300,-122.3370 47.6395,-122.3247 47.6490,-122.3124
      ;;
    stationary)
      xcrun simctl location "$udid" set 47.6205,-122.3493
      ;;
    *)
      echo "error: unknown route '$route' (want walking, driving, or stationary)" >&2
      exit 2
      ;;
  esac
}

# stop_route <udid>
stop_route() {
  xcrun simctl location "$1" clear >/dev/null 2>&1 || true
}

# send_to_background <udid> — runs the shared background-app Maestro flow (launches, dismisses
# dev-menu/backgrounding-permission dialogs if present, asserts the map is up, presses HOME).
send_to_background() {
  maestro_test "$1" "$REPO_ROOT/.maestro/background-location/background-app.yaml"
}

# event_log_count <events_db> <start_ms> <action> [status] — count rows since start_ms.
# event_log_details <events_db> <action> <needle> — the `details` JSON of the newest row of
# `action` whose details contain `needle`, or empty.
#
# The read half of the dev command channel (device_dev_command): the app writes its result into
# `details` and echoes the caller's nonce there, so matching on the nonce is what makes a poller
# wait for ITS invocation rather than accept a row left by an earlier pass.
event_log_details() {
  sqlite3 "$1" \
    "SELECT details FROM event_log WHERE action = '$2' AND details LIKE '%$3%'
     ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null
}

event_log_count() {
  local events="$1" start_ms="$2" action="$3" status="${4:-}"
  if [ -n "$status" ]; then
    sqlite3 "$events" "SELECT count(*) FROM event_log WHERE timestamp >= $start_ms AND action = '$action' AND status = '$status';"
  else
    sqlite3 "$events" "SELECT count(*) FROM event_log WHERE timestamp >= $start_ms AND action = '$action';"
  fi
}

# ensure_stash_observer <udid> — pairs (or reuses) the host-side stash-only friend observer for
# a device, building it if needed. Prints its state dir on stdout, exactly like
# ensure-stash-observer.sh (which this wraps rather than reimplements).
ensure_stash_observer() {
  local spec="$1"
  bash "$E2E_DIR/ensure-stash-observer.sh" "$spec"
}

# THE PAIRING RENDEZVOUS.
#
# A pairing handshake has to move values between its two halves while it is in flight: the invite
# link, the SAS figure the displayer is showing, and a "the picker has chosen" barrier. The
# harness used to move them by running a separate `maestro test` per step and passing values
# through the shell — which is exactly what a runner swap broke, because BOTH runners restart the
# app when a flow starts (maestro-runner via its per-flow WDA EnsureSession, whose create-session
# defaults forceAppLaunch to YES) and a live SAS session lives only in PairCore's memory.
#
# So each participant now runs its whole handshake as ONE flow and the values cross through this
# little server instead. Flows read/write it with `runScript`'s http global; shell-side
# participants (the trail-stash CLI observer) use rendezvous_get/rendezvous_put.
#
# runScript's JS runs in the runner PROCESS, on the host — so 127.0.0.1 is correct for iOS and
# Android alike, with no 10.0.2.2 emulator special case.

# rendezvous_start — boots the server and sets RENDEZVOUS_URL. Idempotent per shell; registers an
# EXIT trap that stops the server. Port 0 (kernel-assigned) so concurrent harness runs — the
# matrix runs several — never collide on a fixed port.
RENDEZVOUS_URL="${RENDEZVOUS_URL:-}"
RENDEZVOUS_PID=""
rendezvous_start() {
  [ -n "$RENDEZVOUS_URL" ] && return 0
  local port_file
  port_file="$(mktemp)"
  rm -f "$port_file"
  python3 "$DEVICES_LIB_DIR/rendezvous.py" serve --port-file "$port_file" --parent-pid $$ \
    >/dev/null 2>&1 &
  RENDEZVOUS_PID=$!
  local waited=0
  while [ ! -s "$port_file" ]; do
    kill -0 "$RENDEZVOUS_PID" 2>/dev/null || {
      echo "error: the pairing rendezvous server died on startup" >&2
      exit 1
    }
    sleep 0.1
    waited=$((waited + 1))
    [ "$waited" -gt 100 ] && {
      echo "error: the pairing rendezvous server never reported a port" >&2
      exit 1
    }
  done
  RENDEZVOUS_URL="$(cat "$port_file")"
  rm -f "$port_file"
  # shellcheck disable=SC2064 - PID must be expanded now, not at trap time.
  trap "kill $RENDEZVOUS_PID 2>/dev/null || true" EXIT
  echo "[devices] pairing rendezvous listening on $RENDEZVOUS_URL" >&2
}

# rendezvous_put <key> <value>
rendezvous_put() {
  python3 "$DEVICES_LIB_DIR/rendezvous.py" put "$RENDEZVOUS_URL" "$1" "$2"
}

# rendezvous_get <key> [wait_seconds] — prints the value; exit 1 if it never arrives. The wait is
# a long poll, so a waiter is released the instant the value is published rather than on the next
# tick — which is what keeps a handshake inside the 60s SAS budget.
rendezvous_get() {
  python3 "$DEVICES_LIB_DIR/rendezvous.py" get "$RENDEZVOUS_URL" "$1" --wait "${2:-0}"
}

# stash_observe_once <observer_state_dir> [timeout_seconds] — one poll of the observer for a
# freshly-arrived, decryptable fix; prints its JSON line on success, nothing on timeout. Mirrors
# the `observe_once`/`observe_scenario` helpers duplicated in ios-background-location-e2e.sh and
# ios-location-benchmark.sh. Requires the trail-stash-client debug binary to already be built
# (ensure_stash_observer builds it as a side effect).
stash_observe_once() {
  local state_dir="$1" timeout_seconds="${2:-30}"
  local bin="$REPO_ROOT/modules/iroh-location/rust/target/debug/trail-stash-client"
  perl -e 'alarm shift; exec @ARGV' "$((timeout_seconds + 15))" \
    "$bin" --state-dir "$state_dir" watch --once --json --timeout-seconds "$timeout_seconds"
}

# drop_reason_histogram <events_db> <start_ms> — tab-separated `reason\tcount` rows, for soak
# reports; empty output means no drops in the window. The attribute key is literally
# "sc.drop_reason" (an OTel-style dotted name, not a nested `sc: { drop_reason }` object —
# see telemetry.ts's `span.attributes['sc.drop_reason']`), so the json_extract path must quote
# that whole segment or SQLite reads it as three levels of nesting instead of one dotted key.
drop_reason_histogram() {
  local events="$1" start_ms="$2"
  sqlite3 -separator $'\t' "$events" "
    SELECT json_extract(details, '\$.attributes.\"sc.drop_reason\"') AS reason, count(*)
    FROM event_log
    WHERE timestamp >= $start_ms
      AND json_extract(details, '\$.attributes.\"sc.drop_reason\"') IS NOT NULL
    GROUP BY reason
    ORDER BY 2 DESC;
  " 2>/dev/null || true
}

# friend_endpoints <social_db> — one friend endpointId (full hex) per line, from the app's own
# friend pool. Used to identify WHICH device is which without guessing: a device's endpoint id is
# not stored on that device, but it IS the key its friends file it under.
friend_endpoints() {
  sqlite3 "$1" "SELECT value FROM kv WHERE key='sc.social.pool';" 2>/dev/null |
    python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if raw:
    for endpoint in (json.loads(raw).get("friends") or {}):
        print(endpoint)
'
}

# friend_latest_row <social_db> <author_prefix> — the current stored fix for one friend, as
# `seq|fix_ts|received_at|via`, or nothing if this device has never stored a fix from them.
#
# `friend_latest` is one row per friend, overwritten on every receipt (docs/social/ARCHITECTURE.md
# §5–6: a friend's location is a single current fix, never retained history), so its presence is
# the receive-side counterpart to the sender's `publish.fix`. `via` records how the fix actually
# arrived — 'live' for gossip, 'sync'/'docs'/'stash' for range reconciliation — which is what
# distinguishes "was online and heard it" from "was away and recovered it".
friend_latest_row() {
  sqlite3 -separator '|' "$1" \
    "SELECT seq, fix_ts, received_at, COALESCE(via, '?') FROM friend_latest
     WHERE author LIKE '$2%' LIMIT 1;" 2>/dev/null
}

# clear_friend_latest <social_db> — forget every friend's current fix, keeping the friendships.
# The control for a recovery test: with no stored fix, a row appearing afterwards can only have
# arrived during the window under test.
clear_friend_latest() {
  sqlite3 "$1" "DELETE FROM friend_latest;"
}

# set_stash_opt_in <social_db> <0|1> — turn the durable (offline-delivery) path on or off.
#
# With it off, `stashEnabled()` is false, so the stash ticket is not folded into the device's
# subscription bootstrap set and the stash is not a reachable source for it (see
# location-sharing.ts `stashBootstrap`). That is what lets a test prove a fix travelled
# peer-to-peer rather than through the server.
set_stash_opt_in() {
  sqlite3 "$1" "
    INSERT INTO kv(key, value) VALUES('sc.social.stashOptIn', '$2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  "
}

# NOTE ON DEV-CLIENT BUILDS. There used to be a `suppress_dev_menu` here that wrote
# expo-dev-menu's preferences (ShowsAtLaunch / MotionGesture / TouchGesture) to stop the dev menu
# rendering over the app. It is gone because it never actually worked: the app REWRITES that
# plist on exit, so the flags were back to 1 by the next launch, and the menu kept appearing
# mid-flow — the symptom was `scrollUntilVisible: "Share a one-time pairing link"` failing on a
# device whose hierarchy showed "Dev Menu" / "Loading source code..." over the map.
#
# The fix is to test a RELEASE build (see justfile's e2e-build-ios): no dev menu, no shake or
# three-finger gesture, no expo-dev-launcher server picker, and no Metro dependency at all — the
# JS is embedded as main.jsbundle. The DEBUG *section* of Settings that the harness reads the
# invite token from is NOT `__DEV__`-gated, so it survives in Release; verified directly.

# warm_driver <udid> — do this device's FIRST-RUN driver setup now, serially.
#
# It does NOT leave a driver running: WebDriverAgent is a child of the maestro-runner process and
# dies with it (verified — port 8341 is refused the instant a `hierarchy` call returns). What it
# does do is the expensive one-time work: installing the WDA bundle onto the simulator and
# populating the cached build. Doing that once per device, serially, means the concurrent phase
# that follows is only ever *starting* an already-installed driver rather than two processes
# racing to install and build one at the same moment.
#
# Pair it with a stagger between the concurrent launches (see pairing-e2e.sh). Neither alone is
# sufficient: the symptom is `failed to create session: ... connect: connection refused` inside a
# second, on a flow that never reached step 0.
warm_driver() {
  maestro_cmd "$1" hierarchy >/dev/null 2>&1 || true
}
