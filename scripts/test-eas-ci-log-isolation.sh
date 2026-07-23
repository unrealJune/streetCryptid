#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/streetcryptid-eas-log-test.XXXXXX")"
sentinel='RkFLRV9BUFBMRV9HT09HTEVfU0lHTklOR19LRVlfTVVTVF9ORVZFUl9BUFBFQVJfSU5fQUNUSU9OU19MT0dT'

if ! jq -e '
  .build["production-internal-ios"] as $ios |
  .build["production-internal-android"] as $android |
  ($ios.extends == "production") and
  ($ios.developmentClient == false) and
  ($ios.distribution == "internal") and
  ($ios.autoIncrement == false) and
  ($ios.ios.simulator == false) and
  ($android.extends == "production") and
  ($android.developmentClient == false) and
  ($android.distribution == "internal") and
  ($android.autoIncrement == false) and
  ($android.android.buildType == "apk")
' "$repo_root/eas.json" >/dev/null; then
  echo "The PR build profiles must produce installable standalone Release apps." >&2
  exit 1
fi

cleanup() {
  if [[ -d "$test_root" ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

mkdir -p "$test_root/bin"
cat > "$test_root/bin/eas" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command="$1"
shift

if [[ -n "${DEBUG:-}${EAS_DEBUG:-}${EXPO_DEBUG:-}" ]]; then
  echo "A debug environment variable reached EAS." >&2
  exit 24
fi
if [[ "${EAS_LOCAL_BUILD_LOGGER_LEVEL:-}" != "error" ]]; then
  echo "The EAS local logger was not restricted to errors." >&2
  exit 24
fi

if [[ "$command" == "whoami" ]]; then
  printf 'credential on auth stdout: %s\n' "$FAKE_SIGNING_CREDENTIAL"
  printf 'credential on auth stderr: %s\n' "$FAKE_SIGNING_CREDENTIAL" >&2
  if [[ "${FAKE_EAS_FAIL_AUTH:-0}" == "1" ]]; then
    exit 25
  fi
  exit 0
fi

if [[ "$command" == "project:info" ]]; then
  printf 'credential on project stdout: %s\n' "$FAKE_SIGNING_CREDENTIAL"
  printf 'credential on project stderr: %s\n' "$FAKE_SIGNING_CREDENTIAL" >&2
  if [[ "${FAKE_EAS_FAIL_PROJECT:-0}" == "1" ]]; then
    exit 26
  fi
  exit 0
fi

if [[ "$command" == "build" ]]; then
  printf 'credential on stdout: %s\n' "$FAKE_SIGNING_CREDENTIAL"
  printf 'credential on stderr: %s\n' "$FAKE_SIGNING_CREDENTIAL" >&2
  if [[ "${FAKE_EAS_FAIL_BUILD:-0}" == "1" ]]; then
    exit 23
  fi
  while (($#)); do
    if [[ "$1" == "--output" ]]; then
      shift
      touch "$1"
      break
    fi
    shift
  done
  exit 0
fi

if [[ "$command" == "upload" ]]; then
  printf 'credential on upload stderr: %s\n' "$FAKE_SIGNING_CREDENTIAL" >&2
  if [[ "${FAKE_EAS_BAD_UPLOAD:-0}" == "1" ]]; then
    printf 'credential on upload stdout: %s\n' "$FAKE_SIGNING_CREDENTIAL"
  fi
  printf '{"url":"https://expo.dev/accounts/streetcryptid/projects/streetCryptid/builds/12345678-1234-1234-1234-123456789abc"}\n'
  exit 0
fi

exit 2
EOF
chmod 700 "$test_root/bin/eas"

success_output="$test_root/success-output"
success_transcript="$(
  PATH="$test_root/bin:$PATH" \
    DEBUG=1 \
    EAS_DEBUG=1 \
    EXPO_TOKEN=fake-token \
    EXPO_DEBUG=1 \
    FAKE_SIGNING_CREDENTIAL="$sentinel" \
    GITHUB_OUTPUT="$success_output" \
    RUNNER_TEMP="$test_root" \
    bash "$repo_root/scripts/eas-local-build-ci.sh" \
    ios production-internal-ios "$test_root/app.ipa" \
    2>&1
)"

if [[ "$success_transcript" == *"$sentinel"* ]]; then
  echo "The signing credential sentinel escaped into successful command output." >&2
  exit 1
fi
grep -Fxq \
  'url=https://expo.dev/accounts/streetcryptid/projects/streetCryptid/builds/12345678-1234-1234-1234-123456789abc' \
  "$success_output"

auth_failure_output="$test_root/auth-failure-output"
set +e
auth_failure_transcript="$(
  PATH="$test_root/bin:$PATH" \
    EXPO_TOKEN=fake-token \
    FAKE_SIGNING_CREDENTIAL="$sentinel" \
    FAKE_EAS_FAIL_AUTH=1 \
    GITHUB_OUTPUT="$auth_failure_output" \
    RUNNER_TEMP="$test_root" \
    bash "$repo_root/scripts/eas-local-build-ci.sh" \
    ios production-internal-ios "$test_root/auth-failure.ipa" \
    2>&1
)"
auth_failure_status=$?
set -e

if [[ "$auth_failure_status" -eq 0 ]]; then
  echo "The simulated failed Expo authentication unexpectedly succeeded." >&2
  exit 1
fi
if [[ "$auth_failure_transcript" == *"$sentinel"* ]]; then
  echo "The signing credential sentinel escaped from authentication output." >&2
  exit 1
fi
if [[ "$auth_failure_transcript" != *"Expo token authentication failed"* ]]; then
  echo "The failed authentication did not emit its fixed error." >&2
  exit 1
fi

project_failure_output="$test_root/project-failure-output"
set +e
project_failure_transcript="$(
  PATH="$test_root/bin:$PATH" \
    EXPO_TOKEN=fake-token \
    FAKE_SIGNING_CREDENTIAL="$sentinel" \
    FAKE_EAS_FAIL_PROJECT=1 \
    GITHUB_OUTPUT="$project_failure_output" \
    RUNNER_TEMP="$test_root" \
    bash "$repo_root/scripts/eas-local-build-ci.sh" \
    android production-internal-android "$test_root/project-failure.apk" \
    2>&1
)"
project_failure_status=$?
set -e

if [[ "$project_failure_status" -eq 0 ]]; then
  echo "The simulated failed EAS project access unexpectedly succeeded." >&2
  exit 1
fi
if [[ "$project_failure_transcript" == *"$sentinel"* ]]; then
  echo "The signing credential sentinel escaped from project access output." >&2
  exit 1
fi
if [[ "$project_failure_transcript" != *"cannot access the configured EAS project"* ]]; then
  echo "The failed project access did not emit its fixed error." >&2
  exit 1
fi

failure_output="$test_root/failure-output"
set +e
failure_transcript="$(
  PATH="$test_root/bin:$PATH" \
    EXPO_TOKEN=fake-token \
    FAKE_SIGNING_CREDENTIAL="$sentinel" \
    FAKE_EAS_FAIL_BUILD=1 \
    GITHUB_OUTPUT="$failure_output" \
    RUNNER_TEMP="$test_root" \
    bash "$repo_root/scripts/eas-local-build-ci.sh" \
    android production-internal-android "$test_root/app.apk" \
    2>&1
)"
failure_status=$?
set -e

if [[ "$failure_status" -eq 0 ]]; then
  echo "The simulated failed EAS build unexpectedly succeeded." >&2
  exit 1
fi
if [[ "$failure_transcript" == *"$sentinel"* ]]; then
  echo "The signing credential sentinel escaped into failed command output." >&2
  exit 1
fi
if [[ "$failure_transcript" != *"Expo output was withheld"* ]]; then
  echo "The failed build did not explain that private output was withheld." >&2
  exit 1
fi

bad_upload_output="$test_root/bad-upload-output"
set +e
bad_upload_transcript="$(
  PATH="$test_root/bin:$PATH" \
    EXPO_TOKEN=fake-token \
    FAKE_SIGNING_CREDENTIAL="$sentinel" \
    FAKE_EAS_BAD_UPLOAD=1 \
    GITHUB_OUTPUT="$bad_upload_output" \
    RUNNER_TEMP="$test_root" \
    bash "$repo_root/scripts/eas-local-build-ci.sh" \
    ios production-internal-ios "$test_root/bad-upload.ipa" \
    2>&1
)"
bad_upload_status=$?
set -e

if [[ "$bad_upload_status" -eq 0 ]]; then
  echo "The simulated malformed EAS upload unexpectedly succeeded." >&2
  exit 1
fi
if [[ "$bad_upload_transcript" == *"$sentinel"* ]]; then
  echo "The signing credential sentinel escaped from malformed upload output." >&2
  exit 1
fi
if [[ "$bad_upload_transcript" != *"Expo output was withheld"* ]]; then
  echo "The malformed upload did not explain that private output was withheld." >&2
  exit 1
fi

echo "EAS CI log isolation withheld simulated signing credentials on build and upload paths."
