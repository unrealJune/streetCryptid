#!/usr/bin/env bash
# Android counterparts to the iOS-only pieces of lib/devices.sh. Meant to be `source`d, not
# executed, alongside devices.sh — not a replacement for it. Everything Maestro-driven
# (hierarchy_text, hierarchy_has, ensure_onboarded, send_to_background) is already
# platform-agnostic (Maestro's --udid/--device takes an adb serial exactly like an iOS Simulator
# UDID — verified against `maestro test --help`) and stays in devices.sh, reused as-is. Only
# device control that's genuinely different (permission grants, location injection, app-private
# file access, process termination) gets an `android_` prefixed twin here.
#
# Requires: adb (Android platform-tools), sqlite3, on top of devices.sh's own requirements.
# The app must be a debug build (adb run-as only works for debuggable apps — true for
# `bunx expo run:android`'s default variant, not for a signed release APK).
#
# Deliberately does NOT check for `adb` at source time (unlike devices_require_tools calls in the
# scripts that need it unconditionally) — this file is sourced by run-matrix.sh/soak.sh
# regardless of whether any Android device is actually in play, and an iOS-only user shouldn't
# need adb on PATH at all. Call android_require_tools explicitly once you know it's needed.
android_require_tools() {
  command -v adb >/dev/null 2>&1 || {
    echo "error: adb not found on PATH (set ANDROID_HOME and add platform-tools)" >&2
    exit 1
  }
}

# android_grant_location_privacy <serial> <app_id> — pre-grant EVERY runtime permission the app
# declares, so Android never interrupts a flow with a permission dialog.
#
# Granting only the location trio is not enough, and the failure is indirect enough to be worth
# spelling out. This app also declares POST_NOTIFICATIONS (Android 13+ gates the foreground
# service's own notification on it), ACTIVITY_RECOGNITION (motion), and the BLUETOOTH_* /
# NEARBY_WIFI_DEVICES set for the mesh transport. Leave those ungranted and Android puts
# `GrantPermissionsActivity` on top of the app mid-onboarding; the app's location start then
# resolves to `permission-denied`, and use-location-sharing.tsx's recovery path stops and restarts
# background location on every foreground — observed on-device as the location task registering
# and unregistering ~30 s later, sharing never latching on, and the location icon staying greyed.
#
# So: read the requested permissions straight off the installed package and grant them all. Doing
# it from the manifest rather than a hardcoded list means a newly declared permission is covered
# automatically instead of causing this same puzzle again. `pm grant` refuses non-runtime
# (install-time) permissions, which is why failures are ignored — that is the filter.
#
# The name is kept for call-site compatibility with the iOS twin (grant_location_privacy); the
# iOS side genuinely only needs location, since simctl has no equivalent notion for the rest.
android_grant_location_privacy() {
  local serial="$1" app_id="$2" perm
  for perm in $(adb -s "$serial" shell dumpsys package "$app_id" 2>/dev/null |
    awk '/requested permissions:/{f=1;next} f&&/^ *android\.permission\./{gsub(/[ \r]/,"");sub(/:.*/,"");print} f&&/^ *$/{exit}'); do
    adb -s "$serial" shell pm grant "$app_id" "$perm" >/dev/null 2>&1 || true
  done
}

# android_provision_settings <serial> — OS-level settings that stop Android-only dialogs from
# ever rendering. Preferred over tapping them in .maestro/provisioning/android.yaml: a dialog
# that never appears cannot race the flow or cover an assertion.
#
# `network_location_opt_in` is the one that matters. Unset (null) on a fresh AVD, it makes Google
# Play Services throw up its "For a better experience… Location Accuracy" sheet the first time
# the app asks for location — mid-onboarding, on top of the map, failing every later assertion.
# It is a GMS dialog rather than an Android runtime permission, so `pm grant` has no effect on
# it. iOS has no equivalent layer, which is why this function has no iOS counterpart.
android_provision_settings() {
  local serial="$1"
  adb -s "$serial" shell settings put secure network_location_opt_in 1 >/dev/null 2>&1 || true
  adb -s "$serial" shell settings put global assisted_gps_enabled 1 >/dev/null 2>&1 || true
  # location_mode 3 = high accuracy (GPS + network); a device reporting location off can
  # short-circuit the app's own permission checks before any fix is ever requested.
  adb -s "$serial" shell settings put secure location_mode 3 >/dev/null 2>&1 || true
  # Register the test providers up front so a device is injectable from the moment it is
  # provisioned — the app asks for a fix during startup, long before any route starts.
  android_enable_mock_location "$serial"
}

# android_enable_mock_location <serial> — register shell-owned test providers for location.
# Idempotent; safe to call before every injection.
#
# WHY NOT `adb emu geo fix`. The emulator console accepts it, answers OK, and then delivers
# nothing unless the GPS provider is already STARTED — i.e. unless some app is subscribed at that
# exact moment (`dumpsys location` shows `mStarted=false` / `ProviderRequest[OFF]` otherwise).
# That is unusable here, because it is circular: expo-location's first `getCurrentPositionAsync`
# has to resolve before `startBackground` will arm sharing, but nothing is subscribed until it
# does — so the request times out, `startBackground` throws "Current location is unavailable",
# and the failed start clears the persisted sharing intent. The device then sits at
# `sharingEnabled=0` with a completely empty event log, which reads like a broken background task.
# Injecting on a fast loop does not reliably fix it either; it only widens the window.
#
# A test provider writes straight into LocationManagerService, so last-known-location updates
# immediately whether or not anything is listening, and `getCurrentPositionAsync` resolves at
# once. It also covers `fused` — the provider Google Play services hands expo-location — which the
# console path only ever reached indirectly.
android_enable_mock_location() {
  local serial="$1" provider
  # uid 2000 is `shell`; the appop is what lets `cmd location` install a test provider at all
  # (without it every subcommand throws SecurityException: not allowed to perform MOCK_LOCATION).
  adb -s "$serial" shell appops set --uid 2000 android:mock_location allow >/dev/null 2>&1 || true
  for provider in gps fused network; do
    adb -s "$serial" shell cmd location providers add-test-provider "$provider" >/dev/null 2>&1 || true
    adb -s "$serial" shell cmd location providers set-test-provider-enabled "$provider" true >/dev/null 2>&1 || true
  done
}

# android_set_location <serial> <lat> <lon>
android_set_location() {
  local serial="$1" lat="$2" lon="$3" provider
  android_enable_mock_location "$serial"
  for provider in gps fused; do
    adb -s "$serial" shell cmd location providers set-test-provider-location "$provider" \
      --location "$lat,$lon" --accuracy 5 >/dev/null 2>&1 || true
  done
  # Keep the console in sync as well: it costs nothing, and it is what the emulator's own UI
  # reflects, so a human watching the screen sees the same position the test provider reports.
  adb -s "$serial" emu geo fix "$lon" "$lat" >/dev/null 2>&1 || true
}

# android_ensure_nearby_location <serial> <app_id> <lat> <lon> — grants privacy and sets a fixed
# point; mirrors devices.sh's ensure_nearby_location.
android_ensure_nearby_location() {
  android_grant_location_privacy "$1" "$2"
  android_set_location "$1" "$3" "$4"
}

_android_route_pid_file() {
  printf '%s/streetcryptid-android-route-%s.pid' "${TMPDIR:-/tmp}" "$1"
}

# android_drive_route <serial> <route> — `walking`/`driving` background their own fix-injection
# loop (there's no built-in scripted-route player like simctl's `location start --speed`), so
# this returns immediately; pair with android_stop_route to kill the loop. `stationary` sets one
# fixed point and returns.
android_drive_route() {
  local serial="$1" route="$2"
  case "$route" in
    walking)
      _android_loop_route "$serial" 5 \
        "-122.3493,47.6205" "-122.3474,47.6220" "-122.3455,47.6235" "-122.3436,47.6250"
      ;;
    driving)
      _android_loop_route "$serial" 5 \
        "-122.3493,47.6205" "-122.3370,47.6300" "-122.3247,47.6395" "-122.3124,47.6490"
      ;;
    stationary)
      android_set_location "$serial" 47.6205 -122.3493
      ;;
    *)
      echo "error: unknown route '$route' (want walking, driving, or stationary)" >&2
      exit 2
      ;;
  esac
}

# _android_loop_route <serial> <interval_seconds> <lon,lat...> — internal: backgrounds a loop
# that cycles through the given points, recording its PID so android_stop_route can kill it.
_android_loop_route() {
  local serial="$1" interval="$2"
  shift 2
  local points=("$@") parent=$$
  (
    while true; do
      local p lon lat
      for p in "${points[@]}"; do
        # Stop if whoever started us is gone. android_stop_route is the normal exit, but a run
        # killed with SIGKILL — or an ad-hoc invocation from a shell that has since closed — never
        # reaches it, and an orphaned loop is genuinely destructive rather than merely untidy:
        # every injected fix wakes the app's background location task, so a stray loop keeps the
        # phone churning headless wakes indefinitely. One left running for an hour was enough to
        # make pairing fail outright (the node stopped servicing handshakes) and looked for a
        # while like a regression in the app.
        kill -0 "$parent" 2>/dev/null || exit 0
        lon="${p%%,*}"
        lat="${p##*,}"
        android_set_location "$serial" "$lat" "$lon"
        sleep "$interval"
      done
    done
  ) &
  echo "$!" >"$(_android_route_pid_file "$serial")"
}

# android_stop_route <serial> — kills the background loop started by android_drive_route, if any.
android_stop_route() {
  local serial="$1" pid_file pid
  pid_file="$(_android_route_pid_file "$serial")"
  if [ -f "$pid_file" ]; then
    pid="$(cat "$pid_file")"
    kill "$pid" 2>/dev/null || true
    rm -f "$pid_file"
  fi
}

# android_terminate_app <serial> <app_id>
android_terminate_app() {
  adb -s "$1" shell am force-stop "$2" >/dev/null 2>&1 || true
}

# android_pull_file <serial> <app_id> <remote_absolute_path> <local_dest> — the app's private
# data dir isn't reachable by plain `adb pull` (permission denied); `run-as` is the standard
# workaround and only works because expo run:android's default build is debuggable.
android_pull_file() {
  local serial="$1" app_id="$2" remote="$3" local_dest="$4"
  adb -s "$serial" exec-out run-as "$app_id" cat "$remote" >"$local_dest" 2>/dev/null
}

# android_pull_db <serial> <app_id> <remote_db> <local_db> — pull a SQLite database COMPLETE,
# including its `-wal` / `-shm` sidecars.
#
# This matters for correctness, not tidiness. expo-sqlite runs in WAL mode, so recent commits
# live in `<db>-wal` until a checkpoint. Pulling only the `.db`:
#   * READS silently miss the newest rows — exactly the background-wake events an assertion is
#     looking for — so a working pipeline reports as a failure.
#   * WRITES are worse: editing that partial copy and pushing it back over a device-side `-wal`
#     that no longer matches it can lose the app's own writes or corrupt the file outright.
# Pulling all three lets the local sqlite3 replay the WAL and see exactly what the app sees.
# iOS needs none of this: the simulator's container is a host directory, so sqlite3 opens the
# real database in place, sidecars and all.
android_pull_db() {
  local serial="$1" app_id="$2" remote="$3" local_db="$4" suffix
  android_pull_file "$serial" "$app_id" "$remote" "$local_db"
  for suffix in -wal -shm; do
    rm -f "$local_db$suffix"
    if adb -s "$serial" exec-out run-as "$app_id" test -f "$remote$suffix" 2>/dev/null; then
      android_pull_file "$serial" "$app_id" "$remote$suffix" "$local_db$suffix"
    fi
  done
}

# android_push_db <serial> <app_id> <local_db> <remote_db> — push a database back and drop the
# device-side `-wal`/`-shm`. The local sqlite3 edit already folded the WAL into the main file
# (see the checkpoint in android_reset_app_state), so leaving the old sidecars in place would let
# SQLite replay stale frames over what we just wrote.
android_push_db() {
  local serial="$1" app_id="$2" local_db="$3" remote="$4" suffix
  android_push_file "$serial" "$app_id" "$local_db" "$remote"
  for suffix in -wal -shm; do
    adb -s "$serial" shell "run-as '$app_id' rm -f '$remote$suffix'" >/dev/null 2>&1 || true
  done
}

# android_push_file <serial> <app_id> <local_src> <remote_absolute_path> — same run-as
# requirement as android_pull_file; `adb push` can't write into app-private dirs either, so this
# pipes the local file through `adb shell`'s stdin into a `run-as`-wrapped `cat >`.
android_push_file() {
  local serial="$1" app_id="$2" local_src="$3" remote="$4"
  adb -s "$serial" shell "run-as '$app_id' sh -c 'cat > $remote'" <"$local_src"
}

# android_app_data_dir <app_id> — no `<serial>` needed (unlike the iOS equivalent's
# `xcrun simctl get_app_container`, the path is a fixed convention, not looked up per-device).
android_app_data_dir() {
  printf '/data/data/%s' "$1"
}

# android_social_db_path / android_events_db_path <app_data_dir> — expo-sqlite's Android
# convention is `context.filesDir/SQLite/<name>` (`context.filesDir.canonicalPath + "/SQLite"` in
# expo-sqlite's SQLiteModule.kt), unlike iOS's `Documents/SQLite/`.
android_social_db_path() { printf '%s/files/SQLite/streetcryptid.social.db' "$1"; }
android_events_db_path() { printf '%s/files/SQLite/streetcryptid.events.db' "$1"; }

# android_reset_app_state <serial> <app_id> <share_interval_ms> <profile> — same effect as
# devices.sh's reset_app_state (clear outbox/event history, arm the fastest cadence, opt into
# stash), achieved by pull -> local sqlite3 edit -> push, since there's no direct remote sqlite3
# access to a debuggable app's private files.
android_reset_app_state() {
  local serial="$1" app_id="$2" share_interval_ms="$3" profile="$4"
  local data social_remote events_remote tmp_social tmp_events
  data="$(android_app_data_dir "$app_id")"
  social_remote="$(android_social_db_path "$data")"
  events_remote="$(android_events_db_path "$data")"
  android_terminate_app "$serial" "$app_id"

  # `wal_checkpoint(TRUNCATE)` folds the pulled -wal into the main file before we edit, so the
  # single file we push back is the whole truth and the device-side sidecars can be dropped.
  # Without it we would push a file that still needs a WAL we are about to delete.
  tmp_social="$(mktemp)"
  android_pull_db "$serial" "$app_id" "$social_remote" "$tmp_social"
  sqlite3 "$tmp_social" "
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO kv(key, value) VALUES('sc.social.shareIntervalMs', '$share_interval_ms')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO kv(key, value) VALUES('sc.social.stashOptIn', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    INSERT INTO kv(key, value) VALUES('sc.social.sharingEnabled', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    DELETE FROM kv WHERE key = 'sc.social.outbox';
  "
  android_push_db "$serial" "$app_id" "$tmp_social" "$social_remote"
  rm -f "$tmp_social" "$tmp_social-wal" "$tmp_social-shm"

  tmp_events="$(mktemp)"
  android_pull_db "$serial" "$app_id" "$events_remote" "$tmp_events"
  sqlite3 "$tmp_events" "PRAGMA wal_checkpoint(TRUNCATE); DELETE FROM event_log;"
  android_push_db "$serial" "$app_id" "$tmp_events" "$events_remote"
  rm -f "$tmp_events" "$tmp_events-wal" "$tmp_events-shm"
}

# android_event_log_count <serial> <app_id> <start_ms> <action> [status] — pulls a fresh copy of
# the events db (it's being written concurrently by the app) and counts, mirroring devices.sh's
# event_log_count. There is deliberately no `sc.dev.iosLocationProfile`-equivalent kv write here:
# Android has no per-scenario location-profile override in the app today (that's an iOS-only dev
# knob per ios-location-benchmark.sh); Android scenarios run the app's normal default profile.
# android_event_log_details <serial> <app_id> <action> <needle> — Android half of
# event_log_details. Same pull_db reason as android_event_log_count: the row the caller is waiting
# for is the newest one, so it is exactly the one still sitting in the -wal.
android_event_log_details() {
  local serial="$1" app_id="$2" action="$3" needle="$4"
  local data events_remote tmp details
  data="$(android_app_data_dir "$app_id")"
  events_remote="$(android_events_db_path "$data")"
  tmp="$(mktemp)"
  android_pull_db "$serial" "$app_id" "$events_remote" "$tmp"
  details="$(sqlite3 "$tmp" \
    "SELECT details FROM event_log WHERE action = '$action' AND details LIKE '%$needle%'
     ORDER BY timestamp DESC LIMIT 1;" 2>/dev/null)"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
  printf '%s' "$details"
}

android_event_log_count() {
  local serial="$1" app_id="$2" start_ms="$3" action="$4" status="${5:-}"
  local data events_remote tmp
  data="$(android_app_data_dir "$app_id")"
  events_remote="$(android_events_db_path "$data")"
  tmp="$(mktemp)"
  # pull_db, not pull_file: the app is running and its newest event_log rows are still in the
  # -wal, so a bare .db copy would under-report and turn a healthy pipeline into a false failure.
  android_pull_db "$serial" "$app_id" "$events_remote" "$tmp"
  local count
  if [ -n "$status" ]; then
    count="$(sqlite3 "$tmp" "SELECT count(*) FROM event_log WHERE timestamp >= $start_ms AND action = '$action' AND status = '$status';" 2>/dev/null)"
  else
    count="$(sqlite3 "$tmp" "SELECT count(*) FROM event_log WHERE timestamp >= $start_ms AND action = '$action';" 2>/dev/null)"
  fi
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
  printf '%s' "${count:-0}"
}

# android_reset_pairing_state <serial> <app_id> — see reset_pairing_state in devices.sh for what
# this is for and why a pairing test needs it. Same pull -> edit -> push shape as
# android_reset_app_state, for the same reason (no remote sqlite3 against a private data dir).
android_reset_pairing_state() {
  local serial="$1" app_id="$2" data social_remote tmp
  data="$(android_app_data_dir "$app_id")"
  social_remote="$(android_social_db_path "$data")"
  android_terminate_app "$serial" "$app_id"
  tmp="$(mktemp)"
  android_pull_db "$serial" "$app_id" "$social_remote" "$tmp"
  sqlite3 "$tmp" "
    PRAGMA wal_checkpoint(TRUNCATE);
    DELETE FROM kv WHERE key IN ('sc.social.pool', 'sc.social.ratchetActivity');
    DELETE FROM friend_latest;
  "
  android_push_db "$serial" "$app_id" "$tmp" "$social_remote"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
}

# android_friend_endpoints <serial> <app_id> — see friend_endpoints in devices.sh.
android_friend_endpoints() {
  local serial="$1" app_id="$2" tmp
  tmp="$(mktemp)"
  android_pull_db "$serial" "$app_id" \
    "$(android_social_db_path "$(android_app_data_dir "$app_id")")" "$tmp"
  friend_endpoints "$tmp"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
}

# android_location_wedge_hint <serial> — a NON-FATAL note when the emulator looks like it is not
# delivering locations.
#
# Deliberately advisory. The tempting check — inject a fix and watch `dumpsys location` change —
# is not sound: the gps provider only retains a `last location` while some client is actively
# subscribed (`ProviderRequest[OFF]` otherwise), so on an idle device it reads empty no matter how
# healthy the emulator is. It reports a wedge even immediately after a cold boot.
#
# The trustworthy signal comes from the app itself, which is why the harness surfaces
# `[location] startBackground failed: ...` from the event log on failure (see
# device_dump_location_errors). expo-location raises "Current location is unavailable. Make sure
# that location services are enabled" when the emulator will not produce a fix — and because a
# failed start clears the persisted sharing intent, the device then sits at `sharingEnabled=0`
# publishing nothing, with an event log that is simply empty. That combination is what makes this
# worth calling out at all: it looks like a broken background task, not a dead GPS.
android_location_wedge_hint() {
  local serial="$1" request
  request="$(adb -s "$serial" shell dumpsys location 2>/dev/null | sed -n '/gps provider/,/^$/p' | sed -n 's/.*service: ProviderRequest\[\([A-Z]*\).*/\1/p' | head -1)"
  [ "$request" = "OFF" ] || return 0
  echo "[android] note: $serial gps provider has no active request; if sharing never starts, the" >&2
  echo "          emulator may not be delivering fixes — cold-boot it with:" >&2
  echo "          emulator -avd <name> -no-snapshot-load" >&2
}

# android_friend_latest_row <serial> <app_id> <author_prefix> — see friend_latest_row.
android_friend_latest_row() {
  local serial="$1" app_id="$2" author="$3" tmp
  tmp="$(mktemp)"
  android_pull_db "$serial" "$app_id" \
    "$(android_social_db_path "$(android_app_data_dir "$app_id")")" "$tmp"
  friend_latest_row "$tmp" "$author"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
}

# android_clear_friend_latest <serial> <app_id> — see clear_friend_latest in devices.sh.
android_clear_friend_latest() {
  local serial="$1" app_id="$2" remote tmp
  remote="$(android_social_db_path "$(android_app_data_dir "$app_id")")"
  android_terminate_app "$serial" "$app_id"
  tmp="$(mktemp)"
  android_pull_db "$serial" "$app_id" "$remote" "$tmp"
  sqlite3 "$tmp" "PRAGMA wal_checkpoint(TRUNCATE); DELETE FROM friend_latest;"
  android_push_db "$serial" "$app_id" "$tmp" "$remote"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
}

# android_set_stash_opt_in <serial> <app_id> <0|1> — see set_stash_opt_in in devices.sh.
android_set_stash_opt_in() {
  local serial="$1" app_id="$2" value="$3" remote tmp
  remote="$(android_social_db_path "$(android_app_data_dir "$app_id")")"
  android_terminate_app "$serial" "$app_id"
  tmp="$(mktemp)"
  android_pull_db "$serial" "$app_id" "$remote" "$tmp"
  sqlite3 "$tmp" "PRAGMA wal_checkpoint(TRUNCATE);"
  set_stash_opt_in "$tmp" "$value"
  android_push_db "$serial" "$app_id" "$tmp" "$remote"
  rm -f "$tmp" "$tmp-wal" "$tmp-shm"
}
