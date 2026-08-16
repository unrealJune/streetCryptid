#!/usr/bin/env bash
# End-to-end pairing test: onboards two devices (if they need it), pairs them over an invite link
# exactly the way a real user would (Settings → Share → the other phone opening the link),
# resolves the SAS visual check, and asserts both sides actually mint a friend record.
#
# HOW THIS RUNS, AND WHY
# ----------------------
# Both devices are driven CONCURRENTLY, each by a single `maestro test` of the same flow
# (.maestro/pairing/pair-device.yaml), with the values that have to cross between them — the
# invite link, the displayed SAS figure, and a "the picker has chosen" barrier — passed through a
# host-side rendezvous (lib/rendezvous.py) rather than through this script.
#
# That shape is not a style preference; it is the fix for the bug that blocked the switch to
# maestro-runner. Its flow runner creates a WebDriverAgent session once per flow, and WDA's
# create-session defaults `forceAppLaunch` to YES, so on iOS every `maestro-runner test` against
# an already-running app RESTARTS it. A live SAS session exists only in the native module's
# in-memory PairCore, so the old one-invocation-per-step orchestration destroyed the handshake it
# was trying to drive: pick-figure passed, then confirm-match failed with
# "pairing-confirm-matched not found" against a hierarchy showing the plain map screen.
# The restart is per FLOW, so one flow per device means one restart per device, before any
# pairing state exists. Concurrency then follows for free — and is required, because the two
# devices have to be live at the same time for a handshake on a 60s budget.
#
# It also reads the invite token via a DEBUG-only on-screen mirror (id: debug-invite-link,
# Settings → DEBUG section) rather than the clipboard: the invite link flow has no way to get the
# real token onto a second device without a human relaying it, and the iOS Simulator's pasteboard
# does not reliably reflect what the Share Sheet's Copy action writes (confirmed independently
# twice).
#
# Usage:
#   scripts/e2e/pairing-e2e.sh <device-a> <device-b>
#     where each device is ios:<udid>, android:<serial>, or a bare udid (== ios:).
#     A mixed iOS<->Android pair works the same way — the SAS handshake is identical on both.
#
# Requires: a Maestro runner on PATH (see E2E_MAESTRO in lib/devices.sh) and both devices running
# the app. iOS devices should be running builds from the same IrohLocationFFI.xcframework SDK
# target — a mismatch surfaces as an unrelated crash at launch (missing Network.framework
# symbol), not a pairing failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FLOWS="$REPO_ROOT/.maestro"
APP_ID="com.unrealjune.streetcryptid"
# shellcheck source=lib/device.sh
source "$SCRIPT_DIR/lib/device.sh"

DEVICE_A="${1:?Usage: pairing-e2e.sh <device-a> <device-b>  (ios:<udid> | android:<serial> | <udid>)}"
DEVICE_B="${2:?Usage: pairing-e2e.sh <device-a> <device-b>  (ios:<udid> | android:<serial> | <udid>)}"
USERNAME_A="${USERNAME_A:-e2ealice$((RANDOM % 10000))}"
USERNAME_B="${USERNAME_B:-e2eabob$((RANDOM % 10000))}"

device_require_tools "$DEVICE_A" "$DEVICE_B"

log() { echo "[pairing-e2e] $*" >&2; }

DEVICE_A_ID="$(device_id "$DEVICE_A")"
DEVICE_B_ID="$(device_id "$DEVICE_B")"

# PROVISION FIRST, THEN ONBOARD. Provisioning is what clears the dialogs standing between a
# launch and the app — the Android developer-menu popup, and on iOS the dev-launcher server
# picker plus the dev-menu overlay a fresh install shows over everything (see
# .maestro/provisioning/). Onboarding cannot run until those are gone: it asserts `map-view`, and
# on a simulator that had never run this build it failed there every time while the app itself was
# perfectly fine, just underneath an overlay. The old order only worked because every device in
# the pool had already been through this by hand.
device_provision "$DEVICE_A"
device_provision "$DEVICE_B"

log "Ensuring $DEVICE_A is onboarded as @$USERNAME_A"
device_onboard "$DEVICE_A" "$USERNAME_A"

log "Ensuring $DEVICE_B is onboarded as @$USERNAME_B"
device_onboard "$DEVICE_B" "$USERNAME_B"

# Not required for pairing itself, but keeps both devices in a realistic, consistent state (a
# real fresh install has no location fix at all otherwise).
device_set_location "$DEVICE_A" 47.6250 -122.3200
device_set_location "$DEVICE_B" 47.6255 -122.3195

# Start from a clean slate. This test's whole assertion is that both sides MINT a friend record,
# which is only meaningful between devices that are not already friends — and re-pairing an
# existing friend does not reliably re-issue a SAS challenge (see reset_pairing_state).
# Skip with PRESERVE_FRIENDS=1 when deliberately exercising a re-pair.
if [ "${PRESERVE_FRIENDS:-0}" != "1" ]; then
  log "Clearing existing friend records on both devices"
  device_reset_pairing_state "$DEVICE_A"
  device_reset_pairing_state "$DEVICE_B"
fi

rendezvous_start
SESSION="pairing-$$-$RANDOM"

log "Pairing $DEVICE_A (invite) <-> $DEVICE_B (redeem), both flows live at once"
PAIR_START="$(date +%s)"

a_out="$(mktemp)"
b_out="$(mktemp)"
cleanup_outputs() { rm -f "$a_out" "$b_out"; }
trap cleanup_outputs EXIT

# Deliberately backgrounded rather than sequential: the SAS exchange is on a HARD 60s budget
# (SAS_TIMEOUT_MS in modules/iroh-location/rust/src/pairing.rs, plus a 10s accepted grace). That
# bound is a security property — it limits how long an attacker has to interfere with the figure
# comparison — so the harness has to fit inside it rather than the bound being widened to fit the
# harness. Both devices must therefore be driven at the same time.
maestro_test "$DEVICE_A_ID" \
  -e ROLE=invite -e RENDEZVOUS="$RENDEZVOUS_URL" -e SESSION="$SESSION" \
  "$FLOWS/pairing/pair-device.yaml" >"$a_out" 2>&1 &
a_pid=$!
maestro_test "$DEVICE_B_ID" \
  -e ROLE=redeem -e RENDEZVOUS="$RENDEZVOUS_URL" -e SESSION="$SESSION" \
  "$FLOWS/pairing/pair-device.yaml" >"$b_out" 2>&1 &
b_pid=$!

a_rc=0
b_rc=0
wait "$a_pid" || a_rc=$?
wait "$b_pid" || b_rc=$?

ELAPSED="$(($(date +%s) - PAIR_START))"

if [ "$a_rc" -ne 0 ] || [ "$b_rc" -ne 0 ]; then
  # Name the side that failed. Both transcripts are printed because a pairing failure is
  # inherently two-sided — the interesting evidence is often on the device that "passed".
  log "FAIL after ${ELAPSED}s — $DEVICE_A exited $a_rc, $DEVICE_B exited $b_rc"
  log "--- $DEVICE_A (invite) ---"
  cat "$a_out" >&2
  log "--- $DEVICE_B (redeem) ---"
  cat "$b_out" >&2
  exit 1
fi

cat "$a_out" >&2
cat "$b_out" >&2

# Belt and braces: the flow only reaches this key after it dismissed the celebration, so a device
# that somehow exited 0 without pairing cannot pass silently.
for role in invite redeem; do
  rendezvous_get "$SESSION.paired.$role" 5 >/dev/null || {
    log "FAIL — the $role side never recorded a completed pairing"
    exit 1
  }
done

log "PASS — pairing completed and confirmed on both devices in ${ELAPSED}s"
