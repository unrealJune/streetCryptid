#!/usr/bin/env bash

set -euo pipefail
umask 077

platform="${1:-}"
profile="${2:-}"
artifact="${3:-}"

case "$platform" in
  ios | android) ;;
  *)
    echo "Expected platform ios or android." >&2
    exit 2
    ;;
esac

if [[ -z "$profile" || -z "$artifact" ]]; then
  echo "Usage: eas-local-build-ci.sh <ios|android> <profile> <artifact>" >&2
  exit 2
fi

if [[ -z "${EXPO_TOKEN:-}" ]]; then
  echo "The development-builds environment is missing EXPO_TOKEN." >&2
  exit 1
fi

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"

case "$artifact" in
  "$RUNNER_TEMP"/*) ;;
  *)
    echo "The app archive must be inside RUNNER_TEMP." >&2
    exit 2
    ;;
esac

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
    eas "$@"
}

if ! run_eas_privately whoami >/dev/null 2>&1; then
  echo "Expo token authentication failed. EAS output was withheld." >&2
  exit 1
fi

if ! run_eas_privately build \
  --local \
  --platform "$platform" \
  --profile "$profile" \
  --output "$artifact" \
  --non-interactive \
  --freeze-credentials \
  >/dev/null 2>&1; then
  echo "EAS local $platform build failed. Expo output was withheld because it can contain signing credentials." >&2
  exit 1
fi

if [[ ! -f "$artifact" ]]; then
  echo "EAS local $platform build did not produce the expected app archive. Expo output was withheld." >&2
  exit 1
fi

if ! upload_result="$(
  run_eas_privately upload \
    --platform "$platform" \
    --build-path "$artifact" \
    --non-interactive \
    --json \
    2>/dev/null
)"; then
  echo "EAS $platform upload failed. Expo output was withheld because it can contain signing credentials." >&2
  exit 1
fi

if ! install_url="$(jq -er '.url | strings' <<<"$upload_result" 2>/dev/null)"; then
  unset upload_result
  echo "EAS upload returned an unreadable result. Expo output was withheld." >&2
  exit 1
fi
unset upload_result
build_url_pattern='^https://expo\.dev/accounts/[A-Za-z0-9._-]+/projects/[A-Za-z0-9._-]+/builds/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if [[ ! "$install_url" =~ $build_url_pattern ]]; then
  echo "EAS upload returned an unexpected install URL. Expo output was withheld." >&2
  exit 1
fi

printf 'url=%s\n' "$install_url" >> "$GITHUB_OUTPUT"
