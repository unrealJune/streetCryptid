#!/usr/bin/env bash

# Upload a locally built release .ipa to TestFlight, straight from this runner.
#
# This replaces `eas submit` on the iOS release path: the archive goes to App Store Connect over
# an ASC API key held in this repository's `production-release` environment, so neither the binary
# nor a store credential passes through Expo. (`eas build --local` still signs the build with the
# EAS-managed distribution certificate; only submission moved.)
#
# fastlane's `pilot` is preinstalled on GitHub's macOS runners and is used rather than a bare
# `xcrun altool` upload because it also waits for Apple to finish processing and then writes the
# "What to Test" notes -- altool can upload but cannot touch beta build localizations.
#
# Usage: submit-testflight.sh <ipa>
#
# Required environment:
#   ASC_API_KEY_ID         key id of the App Store Connect API key
#   ASC_API_ISSUER_ID      issuer id the key belongs to
#   ASC_API_KEY_P8_BASE64  base64 of the AuthKey_<id>.p8 downloaded from App Store Connect
#
# Optional environment:
#   SC_WHAT_TO_TEST        release notes shown to TestFlight testers

set -euo pipefail
umask 077

# shellcheck source=scripts/eas-ci-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/eas-ci-common.sh"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="${1:-}"

if [[ -z "$artifact" ]]; then
  echo "Usage: submit-testflight.sh <ipa>" >&2
  exit 2
fi

sc_ci_require_env ASC_API_KEY_ID ASC_API_ISSUER_ID ASC_API_KEY_P8_BASE64

# In CI the archive must stay inside RUNNER_TEMP, where no cache or artifact step can pick it up.
# Run by hand (`just submit ios <ipa>`) there is no such constraint and no step output to write.
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  eas_ci_require_runner_temp
  eas_ci_require_output
  eas_ci_require_temp_artifact "$artifact"
fi
workdir_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

if [[ ! -f "$artifact" ]]; then
  echo "App archive not found: expected a built .ipa at the release path." >&2
  exit 1
fi

# Preinstalled on GitHub's macOS runners; worth naming explicitly rather than letting the upload
# fail with a bare "command not found" behind the withheld-output rule.
if ! command -v fastlane >/dev/null 2>&1; then
  echo "fastlane is not on PATH. Install it (brew install fastlane) or run this on a macOS runner." >&2
  exit 1
fi

# Single source of truth: the same values the EAS submit profile carried.
bundle_id="$(jq -r '.expo.ios.bundleIdentifier // empty' "$repo_root/app.json")"
asc_app_id="$(jq -r '.submit.production.ios.ascAppId // empty' "$repo_root/eas.json")"

if [[ -z "$bundle_id" ]]; then
  echo "app.json does not declare expo.ios.bundleIdentifier." >&2
  exit 1
fi
if [[ ! "$asc_app_id" =~ ^[0-9]+$ ]]; then
  echo "eas.json does not declare a numeric submit.production.ios.ascAppId." >&2
  exit 1
fi

# Absolute, because the upload runs from the work directory rather than the repository.
artifact="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"

workdir="$(mktemp -d "$workdir_root/testflight.XXXXXX")"
cleanup() {
  if [[ -d "$workdir" ]]; then
    find "$workdir" -depth -delete
  fi
}
# A cancelled release must not leave the decoded key behind: bash runs no EXIT trap when it dies on
# an untrapped signal, and job cancellation sends one.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# The .p8 only ever exists inside RUNNER_TEMP, mode 600 via the umask above, and only until this
# script exits. `openssl base64` rather than `base64` because the BSD and GNU flags disagree.
key_pem="$workdir/AuthKey_${ASC_API_KEY_ID}.p8"
if ! tr -d '\r\n' <<<"$ASC_API_KEY_P8_BASE64" | openssl base64 -d -A > "$key_pem" 2>/dev/null; then
  echo "ASC_API_KEY_P8_BASE64 is not valid base64." >&2
  exit 1
fi
if ! grep -q 'BEGIN PRIVATE KEY' "$key_pem"; then
  echo "ASC_API_KEY_P8_BASE64 did not decode to a PEM private key." >&2
  exit 1
fi

# Before anything can print it. The base64 form is masked by the runner because it arrives as a
# secret; this decoded form would not be.
sc_ci_mask_pem "$key_pem"

# fastlane reads the key from a JSON descriptor rather than argv, which keeps it off the process
# table. --rawfile preserves the PEM's newlines exactly.
key_json="$workdir/asc-api-key.json"
if ! jq -n \
  --arg key_id "$ASC_API_KEY_ID" \
  --arg issuer_id "$ASC_API_ISSUER_ID" \
  --rawfile key "$key_pem" \
  '{key_id: $key_id, issuer_id: $issuer_id, key: $key, duration: 1200, in_house: false}' \
  > "$key_json" 2>/dev/null; then
  echo "Could not assemble the App Store Connect API key descriptor." >&2
  exit 1
fi

pilot_args=(
  pilot upload
  --api_key_path "$key_json"
  --app_identifier "$bundle_id"
  --apple_id "$asc_app_id"
  --ipa "$artifact"
  --distribute_external false
  --wait_processing_interval 30
  # Bounded well inside the job timeout: Apple occasionally sits on a build for far longer than
  # the usual few minutes, and a stuck upload should fail the release rather than the runner.
  --wait_processing_timeout_duration 3600
)

# "What to Test" is written after processing completes, so it cannot be combined with
# --skip_waiting_for_build_processing. App Store Connect caps the field; the release workflow
# already truncates, and this is the backstop.
if [[ -n "${SC_WHAT_TO_TEST:-}" ]]; then
  pilot_args+=(--changelog "$(cut -c 1-3500 <<<"$SC_WHAT_TO_TEST")")
fi

# Run from the work directory, not the repository: fastlane drops report.xml and other run state
# into its working directory, and everything it writes should land somewhere the exit trap deletes.
log="$workdir/pilot.log"
if ! (
  cd "$workdir" && env \
    FASTLANE_SKIP_UPDATE_CHECK=1 \
    FASTLANE_DISABLE_COLORS=1 \
    FASTLANE_OPT_OUT_USAGE=1 \
    SKIP_SLOW_FASTLANE_WARNING=1 \
    fastlane "${pilot_args[@]}"
) > "$log" 2>&1; then
  echo "The TestFlight upload failed. fastlane's output was withheld because it echoes the API key descriptor." >&2
  sc_ci_redacted_diagnostic "$log"
  exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'submission_url=https://appstoreconnect.apple.com/apps/%s/testflight/ios\n' "$asc_app_id" \
    >> "$GITHUB_OUTPUT"
fi

echo "Uploaded the iOS archive to TestFlight."
