#!/usr/bin/env bash
# End-to-end pairing test: onboards two simulators (if they need it), pairs them
# over an invite link exactly the way a real user would (Settings → Share → the
# other phone opening the link), resolves the SAS visual check, and asserts both
# sides actually mint a friend record.
#
# This is the harness that found and verified the fix for the "displayer never
# sees the SAS challenge" bug (see git history / PR description): the invite link
# flow has no way to get the real token onto a second device without either a
# human relaying it or reading it straight out of the accessibility tree, and the
# iOS Simulator's pasteboard does not reliably reflect what the Share Sheet's
# Copy action writes (confirmed independently twice) — so this reads the token via
# `maestro hierarchy` against a DEBUG-only on-screen mirror of the invite link
# (id: debug-invite-link, Settings → DEBUG section) instead of the clipboard.
#
# Usage:
#   scripts/e2e/pairing-e2e.sh <device-a-udid> <device-b-udid>
#
# Requires: maestro (https://maestro.mobile.dev) on PATH, both simulators booted
# with the app already installed (see justfile's run-ios / bindgen-ios for a local
# build). Devices should be running iOS versions built from the same
# IrohLocationFFI.xcframework SDK target — a mismatch surfaces as an unrelated
# crash at launch (missing Network.framework symbol), not a pairing failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FLOWS="$REPO_ROOT/.maestro"
APP_ID="com.unrealjune.streetcryptid"

DEVICE_A="${1:?Usage: pairing-e2e.sh <device-a-udid> <device-b-udid>}"
DEVICE_B="${2:?Usage: pairing-e2e.sh <device-a-udid> <device-b-udid>}"
USERNAME_A="${USERNAME_A:-e2ealice$((RANDOM % 10000))}"
USERNAME_B="${USERNAME_B:-e2eabob$((RANDOM % 10000))}"

command -v maestro >/dev/null 2>&1 || {
  echo "error: maestro not found on PATH (https://maestro.mobile.dev)" >&2
  exit 1
}

log() { echo "[pairing-e2e] $*" >&2; }

hierarchy_text() {
  # hierarchy_text <udid> <testID>
  maestro --udid "$1" hierarchy 2>/dev/null | python3 "$SCRIPT_DIR/hierarchy_text.py" "$2"
}

hierarchy_has() {
  # hierarchy_has <udid> <testID> — exit 0 if present, 1 if not (no stdout noise)
  maestro --udid "$1" hierarchy 2>/dev/null | python3 "$SCRIPT_DIR/hierarchy_text.py" "$2" >/dev/null 2>&1
}

ensure_nearby_location() {
  local udid="$1" lat="$2" lon="$3"
  xcrun simctl privacy "$udid" grant location "$APP_ID" >/dev/null 2>&1 || true
  xcrun simctl privacy "$udid" grant location-always "$APP_ID" >/dev/null 2>&1 || true
  xcrun simctl location "$udid" set "$lat,$lon" >/dev/null 2>&1 || true
}

log "Ensuring $DEVICE_A is onboarded as @$USERNAME_A"
maestro --udid "$DEVICE_A" test -e USERNAME="$USERNAME_A" "$FLOWS/onboarding/ensure-onboarded.yaml"

log "Ensuring $DEVICE_B is onboarded as @$USERNAME_B"
maestro --udid "$DEVICE_B" test -e USERNAME="$USERNAME_B" "$FLOWS/onboarding/ensure-onboarded.yaml"

# Not required for pairing itself, but keeps both devices in a realistic,
# consistent state (a real fresh install has no location fix at all otherwise).
ensure_nearby_location "$DEVICE_A" 47.6250 -122.3200
ensure_nearby_location "$DEVICE_B" 47.6255 -122.3195

log "Creating an invite on $DEVICE_A"
maestro --udid "$DEVICE_A" test "$FLOWS/pairing/create-invite.yaml"

TOKEN="$(hierarchy_text "$DEVICE_A" debug-invite-link)"
[ -n "$TOKEN" ] || {
  log "failed to read the invite token off $DEVICE_A"
  exit 1
}
log "Read invite token (${#TOKEN} chars)"

log "Redeeming the invite on $DEVICE_B"
xcrun simctl openurl "$DEVICE_B" "$TOKEN"

# The SAS role (displayer vs. picker) is derived from the two endpoints' raw
# bytes, not from who created the invite or who redeemed it — so which device
# ends up which role is not knowable in advance. Poll both for up to ~20s.
log "Waiting for the SAS challenge to land on both devices"
DISPLAYER=""
PICKER=""
for _ in $(seq 1 10); do
  if [ -z "$DISPLAYER" ] && hierarchy_has "$DEVICE_A" pairing-target-figure; then
    DISPLAYER="$DEVICE_A"; PICKER="$DEVICE_B"
  elif [ -z "$DISPLAYER" ] && hierarchy_has "$DEVICE_B" pairing-target-figure; then
    DISPLAYER="$DEVICE_B"; PICKER="$DEVICE_A"
  fi
  [ -n "$DISPLAYER" ] && break
  sleep 2
done
[ -n "$DISPLAYER" ] || {
  log "neither device ever showed the SAS challenge — pairing handshake did not complete"
  exit 1
}
log "Displayer: $DISPLAYER  Picker: $PICKER"

TARGET_RAW="$(hierarchy_text "$DISPLAYER" pairing-target-figure)"
TARGET_NAME="${TARGET_RAW% ASCII pairing figure}"
[ -n "$TARGET_NAME" ] && [ "$TARGET_NAME" != "$TARGET_RAW" ] || {
  log "couldn't parse a figure name out of: $TARGET_RAW"
  exit 1
}
log "Target figure: $TARGET_NAME"

log "Picker selects the matching figure"
maestro --udid "$PICKER" test -e TARGET_NAME="$TARGET_NAME" "$FLOWS/pairing/pick-figure.yaml"

log "Displayer confirms the match"
maestro --udid "$DISPLAYER" test "$FLOWS/pairing/confirm-match.yaml"

log "Verifying both sides discovered a friend"
maestro --udid "$DEVICE_A" test "$FLOWS/pairing/acknowledge-friend.yaml"
maestro --udid "$DEVICE_B" test "$FLOWS/pairing/acknowledge-friend.yaml"

log "PASS — pairing completed and confirmed on both devices"
