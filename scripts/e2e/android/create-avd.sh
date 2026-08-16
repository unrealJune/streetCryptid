#!/usr/bin/env bash
# Create (or re-provision) the Android emulator the e2e harness expects, with the memory and GPU
# settings it actually needs. `avdmanager create avd` alone is NOT enough — see below.
#
# Usage:
#   scripts/e2e/android/create-avd.sh              # create if missing, fix config if present
#   scripts/e2e/android/create-avd.sh --recreate   # delete and rebuild from scratch
#
# WHY THIS SCRIPT EXISTS — the defaults are actively broken for this app:
#
#   `avdmanager` defaults an AVD to hw.ramSize=2G and hw.gpu.enabled=no (software rendering).
#   Under a React Native dev build, that guest runs out of memory, and Android's low-memory
#   killer reaps whatever it can — including Maestro's on-device driver process
#   (`dev.mobile.maestro`). The host sees that as "Device server died ... UNAVAILABLE" /
#   "device offline" and Maestro reports it as a failed flow, which looks exactly like a flaky
#   test but is really an under-provisioned VM.
#
#   Measured against this repo's app on an M-series Mac:
#     2 GB RAM + hw.gpu.enabled=no   -> `launchApp` failed ~50% of runs (4/8)
#     6 GB RAM + hw.gpu.mode=host    -> `launchApp` passed 8/8
#
#   iOS Simulators never hit this: they share host RAM with no fixed cap, have no guest kernel or
#   low-memory killer, and Maestro drives them without an on-device helper process to kill. That
#   asymmetry is the whole reason the Android path needed its own provisioning step.
set -euo pipefail

AVD_NAME="${AVD_NAME:-streetcryptid-e2e}"
# API 36 matches the app's compileSdk/targetSdk (see expo-modules-core's ExpoModulesCorePlugin
# defaults). `google_apis_playstore` (not `default`) so Play services are present — the app's
# location stack goes through FusedLocationProvider in the real world.
SYSTEM_IMAGE="${SYSTEM_IMAGE:-system-images;android-36;google_apis_playstore;arm64-v8a}"
DEVICE_PROFILE="${DEVICE_PROFILE:-pixel_7}"
RAM_MB="${RAM_MB:-6144}"
HEAP_MB="${HEAP_MB:-512}"
CORES="${CORES:-4}"

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
CONFIG="$HOME/.android/avd/$AVD_NAME.avd/config.ini"

log() { echo "[create-avd] $*" >&2; }

[ -x "$AVDMANAGER" ] || {
  echo "error: avdmanager not found at $AVDMANAGER (install the Android cmdline-tools and set ANDROID_HOME)" >&2
  exit 1
}

if [ "${1:-}" = "--recreate" ] && [ -f "$CONFIG" ]; then
  log "Deleting existing AVD $AVD_NAME"
  "$AVDMANAGER" delete avd -n "$AVD_NAME" >/dev/null 2>&1 || true
fi

if [ ! -f "$CONFIG" ]; then
  log "Ensuring system image is installed: $SYSTEM_IMAGE"
  yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "$SYSTEM_IMAGE" >/dev/null 2>&1 || true
  log "Creating AVD $AVD_NAME"
  # `avdmanager` prints a "Could not load devices from .../devices.xml" error for some system
  # images even on success — the AVD is still created correctly, so don't treat it as fatal.
  echo no | "$AVDMANAGER" create avd -n "$AVD_NAME" -k "$SYSTEM_IMAGE" -d "$DEVICE_PROFILE" --force >/dev/null 2>&1 || true
  [ -f "$CONFIG" ] || {
    echo "error: AVD creation failed — no config at $CONFIG" >&2
    exit 1
  }
fi

log "Applying harness settings (RAM ${RAM_MB}MB, heap ${HEAP_MB}MB, ${CORES} cores, GPU host)"
python3 - "$CONFIG" "$RAM_MB" "$HEAP_MB" "$CORES" <<'PY'
import io, sys
path, ram, heap, cores = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
want = {
    "hw.ramSize": ram,
    "vm.heapSize": heap,
    "hw.cpu.ncore": cores,
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "host",
}
lines = io.open(path, encoding="utf-8").read().splitlines()
seen, out = set(), []
for line in lines:
    key = line.split("=", 1)[0].strip() if "=" in line else None
    if key in want:
        out.append(f"{key}={want[key]}")
        seen.add(key)
    else:
        out.append(line)
out.extend(f"{k}={v}" for k, v in want.items() if k not in seen)
io.open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY

grep -E "hw.ramSize|vm.heapSize|hw.cpu.ncore|hw.gpu" "$CONFIG" >&2
log "Ready. Boot it with:"
log "  \$ANDROID_HOME/emulator/emulator -avd $AVD_NAME -no-snapshot -no-boot-anim -gpu host"
