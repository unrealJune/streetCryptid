#!/usr/bin/env bash

# Upload a locally built release .aab to a Google Play track, straight from this runner.
#
# This replaces `eas submit` on the Android release path. It talks to the Play Developer API
# directly -- a service-account JWT for an access token, then the usual edit/upload/track/commit
# sequence -- so neither the bundle nor a store credential passes through Expo, and the ubuntu
# runner needs nothing beyond curl, jq and openssl (no Ruby/fastlane install per release).
#
# `eas build --local` still signs the bundle with the EAS-managed upload key; only submission
# moved.
#
# Usage: submit-play.sh <aab>
#
# Required environment:
#   PLAY_SERVICE_ACCOUNT_JSON_BASE64  base64 of the Google Cloud service-account key granted
#                                     "Release to testing tracks" in the Play Console
#
# Optional environment:
#   SC_WHAT_TO_TEST                   release notes attached to the track release

set -euo pipefail
umask 077

# shellcheck source=scripts/eas-ci-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/eas-ci-common.sh"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="${1:-}"

if [[ -z "$artifact" ]]; then
  echo "Usage: submit-play.sh <aab>" >&2
  exit 2
fi

sc_ci_require_env PLAY_SERVICE_ACCOUNT_JSON_BASE64

# In CI the bundle must stay inside RUNNER_TEMP, where no cache or artifact step can pick it up.
# Run by hand (`just submit android <aab>`) there is no such constraint.
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  eas_ci_require_runner_temp
  eas_ci_require_temp_artifact "$artifact"
fi
workdir_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

if [[ ! -f "$artifact" ]]; then
  echo "App bundle not found: expected a built .aab at the release path." >&2
  exit 1
fi

# Single source of truth: the same values the EAS submit profile carried.
package="$(jq -r '.expo.android.package // empty' "$repo_root/app.json")"
track="$(jq -r '.submit.production.android.track // empty' "$repo_root/eas.json")"
release_status="$(jq -r '.submit.production.android.releaseStatus // "completed"' "$repo_root/eas.json")"

if [[ -z "$package" ]]; then
  echo "app.json does not declare expo.android.package." >&2
  exit 1
fi
if [[ ! "$track" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "eas.json does not declare a usable submit.production.android.track." >&2
  exit 1
fi

api_base='https://androidpublisher.googleapis.com/androidpublisher/v3'
upload_base='https://androidpublisher.googleapis.com/upload/androidpublisher/v3'

# Absolute, so the bundle is still found no matter where this is invoked from.
artifact="$(cd "$(dirname "$artifact")" && pwd)/$(basename "$artifact")"

workdir="$(mktemp -d "$workdir_root/play.XXXXXX")"
diag="$workdir/diag"
curl_cfg="$workdir/curl.cfg"
edit_id=''
: > "$diag"

# An abandoned edit blocks nothing, but leaving one behind clutters the console and a later run
# has no way to find it, so a failed release gives its edit back on the way out.
cleanup() {
  if [[ -n "$edit_id" && -f "$curl_cfg" ]]; then
    curl --config "$curl_cfg" --request DELETE --output /dev/null \
      "$api_base/applications/$package/edits/$edit_id" >/dev/null 2>&1 || true
  fi
  if [[ -d "$workdir" ]]; then
    find "$workdir" -depth -delete
  fi
}
# A cancelled release must not leave the service-account key behind: bash runs no EXIT trap when it
# dies on an untrapped signal, and job cancellation sends one.
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

fail() {
  echo "$1 The Google Play API output was withheld because it can echo credentialed request state." >&2
  sc_ci_redacted_diagnostic "$diag"
  exit 1
}

# --- Service-account credentials ---------------------------------------------

# The key only ever exists inside RUNNER_TEMP, mode 600 via the umask above, and only until this
# script exits. `openssl base64` rather than `base64` because the BSD and GNU flags disagree.
service_account="$workdir/service-account.json"
if ! tr -d '\r\n' <<<"$PLAY_SERVICE_ACCOUNT_JSON_BASE64" | openssl base64 -d -A > "$service_account" 2>/dev/null; then
  echo "PLAY_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64." >&2
  exit 1
fi

client_email="$(jq -r '.client_email // empty' "$service_account" 2>/dev/null || true)"
key_pem="$workdir/service-account-key.pem"
jq -r '.private_key // empty' "$service_account" 2>/dev/null > "$key_pem" || true

if [[ -z "$client_email" ]] || ! grep -q 'BEGIN PRIVATE KEY' "$key_pem"; then
  echo "PLAY_SERVICE_ACCOUNT_JSON_BASE64 did not decode to a service-account key." >&2
  exit 1
fi

# Before anything can print it. The base64 form is masked by the runner because it arrives as a
# secret; this decoded form would not be.
sc_ci_mask_pem "$key_pem"

# --- Access token -------------------------------------------------------------

b64url() {
  openssl base64 -e -A | tr '+/' '-_' | tr -d '='
}

now="$(date +%s)"
jwt_header="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)"
jwt_claims="$(
  jq -nc \
    --arg iss "$client_email" \
    --argjson iat "$now" \
    --argjson exp "$((now + 3600))" \
    '{
      iss: $iss,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: $iat,
      exp: $exp
    }' | b64url
)"
printf '%s.%s' "$jwt_header" "$jwt_claims" > "$workdir/jwt-input"
if ! jwt_signature="$(openssl dgst -sha256 -sign "$key_pem" -binary "$workdir/jwt-input" 2>/dev/null | b64url)"; then
  echo "Signing the Google service-account assertion failed." >&2
  exit 1
fi
# The assertion is itself a bearer credential for the next hour, so it is masked like the token it
# buys, and handed to curl through a file rather than argv -- the process table is readable by
# every other process on the runner.
sc_ci_mask_value "$jwt_signature"
printf '%s.%s.%s' "$jwt_header" "$jwt_claims" "$jwt_signature" > "$workdir/jwt"

if ! token_response="$(
  curl --silent --show-error \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
    --data-urlencode "assertion@$workdir/jwt" \
    --write-out $'\n%{http_code}' \
    'https://oauth2.googleapis.com/token' 2>>"$diag"
)"; then
  fail "Requesting a Google Play access token failed."
fi

token_status="${token_response##*$'\n'}"
token_body="${token_response%$'\n'*}"
access_token="$(jq -r '.access_token // empty' <<<"$token_body" 2>/dev/null || true)"
unset token_response token_body

if [[ "$token_status" != 200 || -z "$access_token" ]]; then
  printf 'Token endpoint returned HTTP %s.\n' "$token_status" >> "$diag"
  fail "Google rejected the service-account assertion."
fi

sc_ci_mask_value "$access_token"

# Header via a curl config file rather than --header, for the same argv reason as the assertion.
{
  printf 'silent\n'
  printf 'show-error\n'
  printf 'header = "Authorization: Bearer %s"\n' "$access_token"
} > "$curl_cfg"
unset access_token

# --- Edit / upload / track / commit -------------------------------------------

play_body=''
play_status=''

play_call() {
  local method="$1" url="$2"
  shift 2
  local response

  play_body=''
  play_status=''

  if ! response="$(
    curl --config "$curl_cfg" --request "$method" "$@" \
      --write-out $'\n%{http_code}' "$url" 2>>"$diag"
  )"; then
    return 1
  fi

  play_status="${response##*$'\n'}"
  play_body="${response%$'\n'*}"

  case "$play_status" in
    2??) return 0 ;;
  esac

  printf '%s %s returned HTTP %s\n' "$method" "${url%%\?*}" "$play_status" >> "$diag"
  jq -r '.error | "  \(.status // "error"): \(.message // "no message")"' <<<"$play_body" \
    >> "$diag" 2>/dev/null || true
  return 1
}

if ! play_call POST "$api_base/applications/$package/edits" \
  --header 'Content-Type: application/json' \
  --data '{}'; then
  fail "Opening a Google Play edit failed."
fi
edit_id="$(jq -r '.id // empty' <<<"$play_body" 2>/dev/null || true)"
if [[ -z "$edit_id" ]]; then
  fail "Google Play did not return an edit id."
fi

if ! play_call POST "$upload_base/applications/$package/edits/$edit_id/bundles?uploadType=media" \
  --header 'Content-Type: application/octet-stream' \
  --data-binary "@$artifact"; then
  fail "Uploading the app bundle to Google Play failed."
fi
version_code="$(jq -r '.versionCode // empty' <<<"$play_body" 2>/dev/null || true)"
if [[ ! "$version_code" =~ ^[0-9]+$ ]]; then
  fail "Google Play did not report a version code for the uploaded bundle."
fi

# Play caps release notes at 500 characters per language and rejects the whole release if the
# limit is exceeded, so this truncates rather than trusting the caller.
notes=''
if [[ -n "${SC_WHAT_TO_TEST:-}" ]]; then
  notes="$(head -c 480 <<<"$SC_WHAT_TO_TEST")"
fi

track_payload="$(
  jq -nc \
    --arg track "$track" \
    --arg status "$release_status" \
    --arg version_code "$version_code" \
    --arg notes "$notes" \
    '{
      track: $track,
      releases: [
        {versionCodes: [$version_code], status: $status}
        + (if $notes == "" then {} else {releaseNotes: [{language: "en-US", text: $notes}]} end)
      ]
    }'
)"

if ! play_call PUT "$api_base/applications/$package/edits/$edit_id/tracks/$track" \
  --header 'Content-Type: application/json' \
  --data "$track_payload"; then
  fail "Assigning the bundle to the $track track failed."
fi

if ! play_call POST "$api_base/applications/$package/edits/$edit_id:commit" \
  --header 'Content-Type: application/json' \
  --data ''; then
  fail "Committing the Google Play edit failed."
fi

# Committed: there is no edit left to abandon on the way out.
edit_id=''

printf 'Uploaded version code %s to the Google Play %s track.\n' "$version_code" "$track"
