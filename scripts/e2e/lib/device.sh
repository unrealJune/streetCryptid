#!/usr/bin/env bash
# ONE platform-agnostic device API for the e2e harness. Meant to be `source`d, not executed.
#
# Every function here takes a DEVICE SPEC and dispatches internally, so no caller — no script, no
# scenario, no orchestrator — ever branches on platform. A spec is:
#
#     ios:<simulator-udid>      an iOS Simulator
#     android:<adb-serial>      an Android device/emulator
#     <simulator-udid>          bare == ios:, for backward compatibility with the older scripts
#
# The platform-specific implementations live in lib/devices.sh (iOS) and lib/android-devices.sh
# (Android) and should be treated as private to this file. Add new capabilities here as a
# `device_*` dispatcher so both platforms stay in lockstep by construction — if a capability only
# exists on one platform, say so loudly (see device_supports) rather than letting callers drift
# into per-platform code paths.
#
# Callers must already have `set -euo pipefail`, `APP_ID`, and `REPO_ROOT` set.

DEVICE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=devices.sh
source "$DEVICE_LIB_DIR/devices.sh"
# shellcheck source=android-devices.sh
source "$DEVICE_LIB_DIR/android-devices.sh"

# device_require_tools — the tools needed for the platforms actually in play. Pass every spec the
# run will touch; Android tooling is only demanded when an Android spec is present, so an
# iOS-only user never needs adb on PATH.
device_require_tools() {
  local spec
  devices_require_tools maestro sqlite3 jq python3
  for spec in "$@"; do
    case "$(device_platform "$spec")" in
      ios) devices_require_tools xcrun ;;
      android) android_require_tools ;;
    esac
  done
}

# device_supports <spec> <capability> — 0 if supported, 1 if not.
#
# Be strict about what goes in here: this table should list capabilities a platform genuinely
# CANNOT do, never ones we merely have not written yet. An earlier revision listed `pairing` and
# `stash-observer` as Android-unsupported, and both were wrong — pairing-e2e.sh was simply written
# against simctl, and the whole port came to four lines (three location/permission calls that
# already had Android equivalents, plus `simctl openurl` -> `adb am start -a VIEW`, which
# trail-stash-client's own `pair --adb` path already did). A false entry here silently removes
# real coverage, which is worse than a missing feature, because it looks deliberate.
#
#   pairing           two-device SAS pairing (pairing-e2e.sh) — both platforms
#   stash-observer    host-side friend decrypting through the stash — both platforms
#                     (trail-stash-client takes --simulator or --adb)
#   net-chaos         host-level reachability chaos (lib/netchaos.sh)
#   location-profile  the dev-only battery/balanced/fidelity sampling override
device_supports() {
  local plat cap
  plat="$(device_platform "$1")"
  cap="$2"
  case "$plat:$cap" in
    ios:*) return 0 ;;
    # `sc.dev.iosLocationProfile` is read only by the iOS sampling policy (see
    # sampling-policy.ts's benchmarkProfileOverrides) — there is no Android equivalent knob to
    # set, so this one is a genuine platform difference rather than unfinished work.
    android:location-profile) return 1 ;;
    # UNVERIFIED, not impossible: netchaos.sh blocks 127.0.0.1:<port> on the host. An Android
    # emulator reaches the host stash via qemu's 10.0.2.2 alias, which NATs to that same host
    # port, so the existing rule may well already cut it — but that has not been tested end to
    # end, and claiming chaos coverage we have not demonstrated would be worse than withholding
    # it. Verify against a real chaos run before flipping this to supported.
    android:net-chaos) return 1 ;;
    android:*) return 0 ;;
  esac
  return 1
}

# device_boot <spec> — ensure the device is up and usable. iOS boots the simulator on demand;
# Android does NOT boot an AVD for you (booting one is slow, needs a display decision, and would
# hide a misconfigured emulator) — it just verifies one is connected.
device_boot() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    adb -s "$id" get-state >/dev/null 2>&1 || {
      echo "error: no Android device/emulator connected as '$id' (check: adb devices)." >&2
      echo "       create/provision one with scripts/e2e/android/create-avd.sh, then boot it." >&2
      exit 1
    }
    adb -s "$id" wait-for-device >/dev/null 2>&1 || true
  else
    boot_device "$id"
  fi
}

# device_assert_installed <spec> — fail with a platform-correct build hint.
device_assert_installed() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    adb -s "$id" shell pm list packages 2>/dev/null | grep -q "$APP_ID" || {
      echo "error: app is not installed on $id; build it with: bunx expo run:android" >&2
      exit 1
    }
  else
    assert_installed "$id" "$APP_ID"
  fi
}

# device_grant_location <spec>
device_grant_location() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_grant_location_privacy "$id" "$APP_ID"
  else
    grant_location_privacy "$id" "$APP_ID"
  fi
}

# device_provision <spec> — put a device into the state the SHARED flows assume, doing whatever
# that platform specifically requires. This is the one seam where the platforms legitimately
# differ, and keeping it explicit is what lets everything downstream (onboarding, backgrounding,
# assertions, scenarios) be identical on both.
#
# Two layers, in order of preference:
#   1. Non-UI setup — permissions and OS settings applied directly (`pm grant` / `settings put`
#      on Android, `simctl privacy` on iOS). Always prefer this: a dialog that never renders
#      costs no time and cannot race the flow.
#   2. A platform provisioning FLOW (.maestro/provisioning/<platform>.yaml) for dialogs with no
#      settings-level off switch. Only Android has one (Google Play Services' "Location Accuracy"
#      sheet, which `pm grant` cannot suppress). There is deliberately NO ios.yaml: iOS needs no
#      UI provisioning, and an empty flow is not free — every `maestro test` costs ~10s of
#      on-device driver startup no matter how trivial the flow, so a no-op file was pure latency
#      on every device, every scenario. Absence of the file is the signal to skip.
#
# Idempotent — safe to call before every scenario.
device_provision() {
  local spec="$1" plat id flow
  plat="$(device_platform "$spec")"
  id="$(device_id "$spec")"

  device_grant_location "$spec"
  if [ "$plat" = "android" ]; then
    android_provision_settings "$id"
  fi

  flow="$REPO_ROOT/.maestro/provisioning/$plat.yaml"
  if [ -f "$flow" ]; then
    maestro_test "$id" -e PROVISION_TIMEOUT="${PROVISION_TIMEOUT:-3000}" "$flow" >/dev/null 2>&1 || {
      echo "[device] provisioning flow reported an issue on $spec (continuing — every step in it is optional)" >&2
    }
  fi
}

# device_open_url <spec> <url> — open a deep link, the way a user tapping it would. This is what
# drives invite-link pairing (the invite token is a streetcryptid:// URL).
device_open_url() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    # Same mechanism modules/iroh-location/rust/src/bin/trail-stash-client.rs already uses for its
    # `pair --adb` path (open_pair_link_with_adb).
    adb -s "$id" shell am start -a android.intent.action.VIEW -d "$2" "$APP_ID" >/dev/null 2>&1
  else
    xcrun simctl openurl "$id" "$2"
  fi
}

# device_set_location <spec> <lat> <lon>
device_set_location() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_set_location "$id" "$2" "$3"
  else
    xcrun simctl location "$id" set "$2,$3" >/dev/null 2>&1 || true
  fi
}

# device_drive_route <spec> <walking|driving|stationary|none>
device_drive_route() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  [ "$2" = "none" ] && return 0
  if [ "$plat" = "android" ]; then
    android_drive_route "$id" "$2"
  else
    drive_route "$id" "$2"
  fi
}

# device_stop_route <spec>
device_stop_route() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_stop_route "$id"
  else
    stop_route "$id"
  fi
}

# device_terminate_app <spec>
device_terminate_app() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_terminate_app "$id" "$APP_ID"
  else
    terminate_app "$id" "$APP_ID"
  fi
}

# device_is_onboarded <spec> — true when the app already has a profile and has accepted the
# location disclosure, i.e. running the onboarding flow would be a no-op.
device_is_onboarded() {
  local spec="$1" plat id data tmp social handle ack
  plat="$(device_platform "$spec")"
  id="$(device_id "$spec")"
  if [ "$plat" = "android" ]; then
    tmp="$(mktemp)"
    android_pull_db "$id" "$APP_ID" \
      "$(android_social_db_path "$(android_app_data_dir "$APP_ID")")" "$tmp"
    social="$tmp"
  else
    data="$(app_data_dir "$id" "$APP_ID" 2>/dev/null)" || return 1
    social="$(social_db_path "$data")"
  fi
  handle="$(sqlite3 "$social" "SELECT count(*) FROM kv WHERE key='sc.account.profile.v1';" 2>/dev/null || echo 0)"
  ack="$(sqlite3 "$social" "SELECT value FROM kv WHERE key='sc.social.locationDisclosureAck';" 2>/dev/null || echo '')"
  [ "$plat" = "android" ] && rm -f "$tmp" "$tmp-wal" "$tmp-shm"
  [ "${handle:-0}" -gt 0 ] && [ "$ack" = "accepted" ]
}

# device_onboard <spec> <username> — idempotent; brings the app to the live map.
#
# Short-circuits on already-onboarded devices by reading the app's own state instead of running
# the Maestro flow. The flow is idempotent, but "idempotent" is not "free": it costs ~10s of
# driver startup every time, on every device, in every scenario. A sqlite read costs well under a
# second. Safe because every caller's next step (create-invite, background-app, …) does its own
# `launchApp`, so nothing depends on this having foregrounded the app.
device_onboard() {
  if device_is_onboarded "$1"; then
    echo "[device] $1 is already onboarded — skipping the onboarding flow" >&2
    return 0
  fi
  ensure_onboarded "$(device_id "$1")" "$2"
}

# device_warm_driver <spec> — start this device's UI driver now, before any concurrent phase.
# See warm_driver in lib/devices.sh for the race this avoids.
device_warm_driver() {
  warm_driver "$(device_id "$1")"
}

# device_background <spec> — foreground the app, assert the map, then send it to the background.
device_background() {
  send_to_background "$(device_id "$1")"
}

# device_reset_app_state <spec> <share_interval_ms> <profile> — clear outbox + event history and
# arm the fastest supported cadence with stash opt-in on.
device_reset_app_state() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_reset_app_state "$id" "$APP_ID" "$2" "$3"
  else
    reset_app_state "$id" "$APP_ID" "$2" "$3"
  fi
}

# device_reset_pairing_state <spec> — forget every friend record, so a pairing run starts clean.
# See reset_pairing_state in lib/devices.sh for why this is required rather than optional.
device_reset_pairing_state() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_reset_pairing_state "$id" "$APP_ID"
  else
    reset_pairing_state "$id" "$APP_ID"
  fi
}

# device_friend_endpoints <spec> — one friend endpointId (full hex) per line. See
# friend_endpoints in lib/devices.sh for why this is the reliable way to identify a device.
device_friend_endpoints() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_friend_endpoints "$id" "$APP_ID"
  else
    friend_endpoints "$(social_db_path "$(app_data_dir "$id" "$APP_ID")")"
  fi
}

# device_event_log_count <spec> <start_ms> <action> [status] — rows since start_ms.
device_event_log_count() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_event_log_count "$id" "$APP_ID" "$2" "$3" "${4:-}"
  else
    local data events
    data="$(app_data_dir "$id" "$APP_ID")"
    events="$(events_db_path "$data")"
    event_log_count "$events" "$2" "$3" "${4:-}"
  fi
}

# device_dump_event_log <spec> <start_ms> — human-readable tail of the pipeline actions, for
# failure diagnostics. Same columns and same action set on both platforms.
device_dump_event_log() {
  local plat id events tmp
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    tmp="$(mktemp)"
    android_pull_db "$id" "$APP_ID" "$(android_events_db_path "$(android_app_data_dir "$APP_ID")")" "$tmp"
    events="$tmp"
  else
    events="$(events_db_path "$(app_data_dir "$id" "$APP_ID")")"
  fi
  sqlite3 -header -column "$events" "
    SELECT datetime(timestamp / 1000, 'unixepoch', 'localtime') AS time,
           launch_context, action, status, substr(details, 1, 200) AS details
    FROM event_log
    WHERE timestamp >= $2
      AND action IN ('bg.wake', 'engine.ingest', 'outbox.drain', 'publish.fix', 'trail.push.app')
    ORDER BY timestamp DESC;
  " 2>/dev/null || true
  [ "$plat" = "android" ] && rm -f "$tmp" "$tmp-wal" "$tmp-shm"
  return 0
}

# device_dump_location_errors <spec> <start_ms> — any background-sharing start failure the app
# recorded since start_ms, newest first.
#
# This is the signal that actually explains an empty pipeline. A device that cannot start sharing
# logs the reason and nothing else: no bg.wake, no engine.ingest, no publish.fix — so the usual
# event-log dump is blank and the failure looks like the background task never firing. The one
# line here ("Current location is unavailable…", a permission refusal, …) is the difference
# between a diagnosis and a guess.
device_dump_location_errors() {
  local plat id events tmp
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    tmp="$(mktemp)"
    android_pull_db "$id" "$APP_ID" "$(android_events_db_path "$(android_app_data_dir "$APP_ID")")" "$tmp"
    events="$tmp"
    android_location_wedge_hint "$id" || true
  else
    events="$(events_db_path "$(app_data_dir "$id" "$APP_ID")")"
  fi
  sqlite3 "$events" "
    SELECT datetime(timestamp / 1000, 'unixepoch', 'localtime') || '  ' || substr(summary, 1, 200)
    FROM event_log
    WHERE timestamp >= $2 AND summary LIKE '%[location]%'
    ORDER BY timestamp DESC LIMIT 5;
  " 2>/dev/null || true
  [ "$plat" = "android" ] && rm -f "$tmp" "$tmp-wal" "$tmp-shm"
  return 0
}

# device_friend_latest_row <spec> <author_prefix> — `seq|fix_ts|received_at|via` for the fix this
# device currently holds from that friend, or empty. See friend_latest_row in lib/devices.sh.
device_friend_latest_row() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_friend_latest_row "$id" "$APP_ID" "$2"
  else
    friend_latest_row "$(social_db_path "$(app_data_dir "$id" "$APP_ID")")" "$2"
  fi
}


# device_clear_friend_latest <spec> — forget every friend's current fix (friendships survive).
device_clear_friend_latest() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_clear_friend_latest "$id" "$APP_ID"
  else
    terminate_app "$id" "$APP_ID"
    clear_friend_latest "$(social_db_path "$(app_data_dir "$id" "$APP_ID")")"
  fi
}

# device_set_stash_opt_in <spec> <0|1> — turn the durable stash path on or off for one device.
device_set_stash_opt_in() {
  local plat id
  plat="$(device_platform "$1")"
  id="$(device_id "$1")"
  if [ "$plat" = "android" ]; then
    android_set_stash_opt_in "$id" "$APP_ID" "$2"
  else
    terminate_app "$id" "$APP_ID"
    set_stash_opt_in "$(social_db_path "$(app_data_dir "$id" "$APP_ID")")" "$2"
  fi
}
