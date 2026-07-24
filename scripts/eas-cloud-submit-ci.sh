#!/usr/bin/env bash

set -euo pipefail
umask 077

platform="${1:-}"
profile="${2:-}"

case "$platform" in
  ios | android) ;;
  *)
    echo "Expected platform ios or android." >&2
    exit 2
    ;;
esac

if [[ -z "$profile" ]]; then
  echo "Usage: eas-cloud-submit-ci.sh <ios|android> <profile>" >&2
  exit 2
fi

if [[ -z "${EXPO_TOKEN:-}" ]]; then
  echo "The app-store-submissions environment is missing EXPO_TOKEN." >&2
  exit 1
fi

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
: "${EAS_PRIVATE_LOG:?EAS_PRIVATE_LOG must be set}"

case "$EAS_PRIVATE_LOG" in
  "$RUNNER_TEMP"/*) ;;
  *)
    echo "The private EAS log must be inside RUNNER_TEMP." >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$EAS_PRIVATE_LOG")"
: >"$EAS_PRIVATE_LOG"
chmod 600 "$EAS_PRIVATE_LOG"

run_eas_privately() {
  env \
    -u DEBUG \
    -u EAS_DEBUG \
    -u EXPO_DEBUG \
    -u GITHUB_ENV \
    -u GITHUB_PATH \
    -u GITHUB_STATE \
    -u GITHUB_STEP_SUMMARY \
    -u GITHUB_OUTPUT \
    EAS_LOCAL_BUILD_LOGGER_LEVEL=error \
    eas "$@" >>"$EAS_PRIVATE_LOG" 2>&1
}

if ! run_eas_privately whoami; then
  echo "Expo token authentication failed. EAS output was withheld." >&2
  exit 1
fi

if ! run_eas_privately project:info; then
  echo "Expo token cannot access the configured EAS project. EAS output was withheld." >&2
  exit 1
fi

if ! run_eas_privately build \
  --platform "$platform" \
  --profile "$profile" \
  --auto-submit-with-profile "$profile" \
  --non-interactive; then
  echo "EAS $platform build or store submission failed. Expo output was withheld because it can contain signing credentials." >&2
  exit 1
fi

echo "EAS $platform build completed and its store submission was started."
