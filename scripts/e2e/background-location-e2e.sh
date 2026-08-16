#!/usr/bin/env bash
# Background location pipeline smoke test — ONE script for iOS Simulators and Android emulators.
#
# Verifies OS location delivery -> TaskManager -> engine/outbox -> native publish -> stash push,
# asserting on the same `event_log` actions with the same pass criteria on both platforms. All
# device control goes through lib/device.sh, so there is no platform branching below.
#
# Usage:
#   scripts/e2e/background-location-e2e.sh ios:<simulator-udid>
#   scripts/e2e/background-location-e2e.sh android:<adb-serial>
#   scripts/e2e/background-location-e2e.sh <simulator-udid>        # bare == ios:
#
# It cannot reproduce real-device suspension or battery heuristics; keep physical-device soak
# tests for those (scripts/e2e/PHYSICAL-DEVICE-CHECKLIST.md). The device must already have a
# current build installed (`bunx expo run:ios` / `bunx expo run:android`).
#
# Friend-side decryption through the stash is asserted only where the stash-only observer exists
# (iOS today — see device_supports). On Android the run still asserts the full on-device pipeline
# through `trail.push.app`, and says plainly that it skipped the friend-side check rather than
# quietly reporting a weaker pass as if it were the same test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="com.unrealjune.streetcryptid"
# shellcheck source=lib/device.sh
source "$SCRIPT_DIR/lib/device.sh"

SPEC="${1:?Usage: background-location-e2e.sh <ios:udid | android:serial | udid>}"
USERNAME="${USERNAME:-bg$((RANDOM % 100000))}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-180}"
SHARE_INTERVAL_MS="${SHARE_INTERVAL_MS:-60000}"
PROFILE="${PROFILE:-balanced}"
ROUTE="${ROUTE:-walking}"

log() { echo "[background-location-e2e] $*" >&2; }

device_require_tools "$SPEC"
device_boot "$SPEC"
device_assert_installed "$SPEC"

# Platform-specific setup (permissions, OS settings, any OS-only dialogs) lives entirely behind
# this one call — everything after it is identical on both platforms.
log "Provisioning $SPEC"
device_provision "$SPEC"
device_set_location "$SPEC" 47.6205 -122.3493

log "Ensuring $SPEC is onboarded as @$USERNAME"
device_onboard "$SPEC" "$USERNAME"

log "Arming the fastest supported cadence and clearing diagnostic/outbox state"
device_reset_app_state "$SPEC" "$SHARE_INTERVAL_MS" "$PROFILE"

observer_state=""
if device_supports "$SPEC" stash-observer; then
  log "Preparing the stash-only friend observer"
  observer_state="$(ensure_stash_observer "$SPEC")"
else
  log "NOTE: no stash-only observer on this platform — this run asserts the on-device pipeline"
  log "      through trail.push.app, but NOT friend-side decryption."
fi

start_ms="$(($(date +%s) * 1000))"

log "Launching the app, arming sharing, and sending it to the background"
device_background "$SPEC"

cleanup() { device_stop_route "$SPEC"; }
trap cleanup EXIT

log "Driving a simulated $ROUTE route for up to ${TIMEOUT_SECONDS}s"
device_drive_route "$SPEC" "$ROUTE"

deadline="$(($(date +%s) + TIMEOUT_SECONDS))"
while [ "$(date +%s)" -lt "$deadline" ]; do
  wake_count="$(device_event_log_count "$SPEC" "$start_ms" bg.wake)"
  publish_count="$(device_event_log_count "$SPEC" "$start_ms" publish.fix ok)"
  push_count="$(device_event_log_count "$SPEC" "$start_ms" trail.push.app ok)"
  if [ "$wake_count" -gt 0 ] && [ "$publish_count" -gt 0 ] && [ "$push_count" -gt 0 ]; then
    if [ -n "$observer_state" ]; then
      observer_json="$(stash_observe_once "$observer_state" 30 || true)"
      if [ -n "$observer_json" ]; then
        log "PASS - background wake, native publish, stash push, and friend decryption completed"
        printf '%s\n' "$observer_json"
        exit 0
      fi
      # Pipeline is up but the friend hasn't decrypted a fix yet — keep waiting for it.
    else
      log "PASS - background wake, native publish, and stash push completed (no friend-side check)"
      log "wake=$wake_count publish.ok=$publish_count trail.push.ok=$push_count"
      exit 0
    fi
  fi
  sleep 5
done

log "FAIL - background pipeline did not complete within ${TIMEOUT_SECONDS}s"
device_dump_event_log "$SPEC" "$start_ms" >&2
exit 1
