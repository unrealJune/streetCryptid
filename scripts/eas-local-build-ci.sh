#!/usr/bin/env bash

# Build a standalone app archive locally on the CI runner with `eas build
# --local` (no EAS cloud build credits consumed). The finished .ipa/.apk/.aab is
# left at $artifact; shipping it is a separate step -- scripts/upload-build.sh
# for pull requests, scripts/submit-testflight.sh or scripts/submit-play.sh for a
# release -- so this script never touches the network beyond the credential fetch
# EAS needs to sign the build.
#
# Usage: eas-local-build-ci.sh <ios|android> <profile> <artifact> [environment]
#
# `environment` only names the GitHub environment that holds EXPO_TOKEN, so a
# missing token points at the right settings page.

set -euo pipefail
umask 077

# shellcheck source=scripts/eas-ci-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/eas-ci-common.sh"

platform="${1:-}"
profile="${2:-}"
artifact="${3:-}"
environment="${4:-development-builds}"

eas_ci_require_platform "$platform"

if [[ -z "$profile" || -z "$artifact" ]]; then
  echo "Usage: eas-local-build-ci.sh <ios|android> <profile> <artifact> [environment]" >&2
  exit 2
fi

eas_ci_require_token "$environment"
eas_ci_require_runner_temp
eas_ci_require_temp_artifact "$artifact"
eas_ci_verify_access

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

echo "Local $platform build complete."
