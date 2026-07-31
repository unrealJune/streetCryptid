#!/usr/bin/env bash

# Guards the ways the PR build and release pipelines could leak secrets into the
# PUBLIC Actions logs:
#
#   1. eas-local-build-ci.sh must never let EAS's signing-credential output
#      reach stdout/stderr, on success or on any failure path.
#   2. upload-build.sh must never print the internal distribution host or the
#      install URL except inside `::add-mask::` directives, and must hand the URL
#      onward only via $GITHUB_OUTPUT (never a plain log line).
#   3. notify-discord-thread.sh must never print the install URLs, the internal
#      host, or the Discord webhook; it posts the links only into the thread.
#   4. submit-testflight.sh must withhold fastlane's output, keep the App Store
#      Connect API key out of the logs even when the upload fails, and emit only
#      an allow-listed App Store Connect URL.
#   5. submit-play.sh must keep the service-account key and the access token it
#      buys out of the logs, mask the token, and pass the bearer through a curl
#      config file rather than argv.

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

# The release workflow ships whatever the `production` profile produces, so it must stay a store
# build: EAS-managed credentials, remotely auto-incremented build versions, and an .aab on Android
# because Google Play rejects .apk uploads.
if ! jq -e '
  .cli.appVersionSource == "remote" and
  (.build.production | (.autoIncrement == true) and
    (.credentialsSource == "remote") and
    (.distribution == null) and
    (.android.buildType == null)) and
  (.submit.production | (.ios.ascAppId | strings | length > 0) and
    (.android.track | strings | length > 0))
' "$repo_root/eas.json" >/dev/null; then
  echo "The production build and submit profiles must be store-ready." >&2
  exit 1
fi

cleanup() {
  if [[ -d "$test_root" ]]; then
    find "$test_root" -depth -delete
  fi
}
trap cleanup EXIT

# --- 1. eas-local-build-ci.sh withholds EAS signing-credential output --------

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

if [[ "$command" == "submit" ]]; then
  printf 'credential on submit stdout: %s\n' "$FAKE_SIGNING_CREDENTIAL"
  printf 'credential on submit stderr: %s\n' "$FAKE_SIGNING_CREDENTIAL" >&2
  if [[ "${FAKE_EAS_FAIL_SUBMIT:-0}" == "1" ]]; then
    exit 27
  fi
  if [[ "${FAKE_EAS_BAD_SUBMIT_URL:-0}" == "1" ]]; then
    printf 'Submission details: https://evil.example.com/accounts/x/projects/y/submissions/12345678-1234-1234-1234-123456789abc\n'
    exit 0
  fi
  printf 'Submission details: https://expo.dev/accounts/streetcryptid/projects/streetCryptid/submissions/abcdef01-2345-6789-abcd-ef0123456789\n'
  exit 0
fi

exit 2
EOF
chmod 700 "$test_root/bin/eas"

success_transcript="$(
  PATH="$test_root/bin:$PATH" \
    DEBUG=1 \
    EAS_DEBUG=1 \
    EXPO_TOKEN=fake-token \
    EXPO_DEBUG=1 \
    FAKE_SIGNING_CREDENTIAL="$sentinel" \
    RUNNER_TEMP="$test_root" \
    bash "$repo_root/scripts/eas-local-build-ci.sh" \
    ios production-internal-ios "$test_root/app.ipa" \
    2>&1
)"

if [[ "$success_transcript" == *"$sentinel"* ]]; then
  echo "The signing credential sentinel escaped into successful build output." >&2
  exit 1
fi
if [[ ! -f "$test_root/app.ipa" ]]; then
  echo "The local build did not produce the expected app archive." >&2
  exit 1
fi

run_build_failure() {
  local label="$1" expected="$2"
  shift 2
  local status transcript
  set +e
  transcript="$(
    PATH="$test_root/bin:$PATH" \
      EXPO_TOKEN=fake-token \
      FAKE_SIGNING_CREDENTIAL="$sentinel" \
      RUNNER_TEMP="$test_root" \
      "$@" \
      bash "$repo_root/scripts/eas-local-build-ci.sh" \
      android production-internal-android "$test_root/$label.apk" \
      2>&1
  )"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    echo "The simulated $label unexpectedly succeeded." >&2
    exit 1
  fi
  if [[ "$transcript" == *"$sentinel"* ]]; then
    echo "The signing credential sentinel escaped from $label output." >&2
    exit 1
  fi
  if [[ "$transcript" != *"$expected"* ]]; then
    echo "The $label did not emit its fixed error." >&2
    exit 1
  fi
}

run_build_failure auth-failure "Expo token authentication failed" env FAKE_EAS_FAIL_AUTH=1
run_build_failure project-failure "cannot access the configured EAS project" env FAKE_EAS_FAIL_PROJECT=1
run_build_failure build-failure "Expo output was withheld" env FAKE_EAS_FAIL_BUILD=1

# Shared values for the distribution/notify checks below.
internal_base="https://builds.internal.example.test"
internal_host="builds.internal.example.test"
install_url="$internal_base/get/abc123def456"

# Every transcript line mentioning the host or a URL must be an ::add-mask::
# directive — that is what makes the runtime redact any later accidental print.
assert_masked_only() {
  local transcript="$1" label="$2"
  shift 2
  local needle line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    for needle in "$internal_host" "$@"; do
      if [[ "$line" == *"$needle"* && "$line" != "::add-mask::"* ]]; then
        echo "$label leaked '$needle' outside a mask: $line" >&2
        exit 1
      fi
    done
  done <<<"$transcript"
}

# --- 2. upload-build.sh masks the host + emits a masked install-URL output ---

# Distinctive sentinel so a leak of the upload token is unmistakable. (In the
# real run it is a GitHub secret and auto-masked too; this proves the script
# itself never prints it.)
upload_token="UPLOAD_TOKEN_SENTINEL_e3b0c44298fc"
build_output="$test_root/github-output"
: > "$build_output"

# Fake curl for the upload path: the upload call carries --form.
cat > "$test_root/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case " \$* " in
  *" --form "*)
    if [[ "\${FAKE_UPLOAD_FAIL:-0}" == "1" ]]; then
      echo "simulated upload failure" >&2
      exit 22
    fi
    printf '%s' "$install_url"
    exit 0
    ;;
esac
echo "unexpected curl invocation" >&2
exit 99
EOF
chmod 700 "$test_root/bin/curl"

printf 'placeholder ipa\n' > "$test_root/upload.ipa"

upload_transcript="$(
  PATH="$test_root/bin:$PATH" \
    GITHUB_ACTIONS=true \
    GITHUB_OUTPUT="$build_output" \
    DISTRIBUTOR_BASE_URL="$internal_base" \
    DISTRIBUTOR_TOKEN="$upload_token" \
    bash "$repo_root/scripts/upload-build.sh" \
    ios "$test_root/upload.ipa" \
    2>&1
)"

if [[ "$upload_transcript" == *"$upload_token"* ]]; then
  echo "upload-build.sh leaked the upload token into its output." >&2
  exit 1
fi
assert_masked_only "$upload_transcript" "upload-build.sh" "$install_url"

for needle in \
  "::add-mask::$internal_base" \
  "::add-mask::$internal_host" \
  "::add-mask::$install_url"; do
  if [[ "$upload_transcript" != *"$needle"* ]]; then
    echo "upload-build.sh did not register the mask: $needle" >&2
    exit 1
  fi
done

# The non-secret install PATH must be handed onward via $GITHUB_OUTPUT (the full
# URL can't be — GitHub scrubs secret-containing cross-job outputs).
if ! grep -Fq "install_path=/get/abc123def456" "$build_output"; then
  echo "upload-build.sh did not write the install path to GITHUB_OUTPUT." >&2
  exit 1
fi
# ...and the full URL (with the secret host) must NOT be written to the output.
if grep -Fq "$install_url" "$build_output"; then
  echo "upload-build.sh wrote the full (secret-bearing) URL to GITHUB_OUTPUT." >&2
  exit 1
fi

# A failed upload must exit non-zero without leaking the host or token.
set +e
upload_fail_transcript="$(
  PATH="$test_root/bin:$PATH" \
    GITHUB_ACTIONS=true \
    GITHUB_OUTPUT="$build_output" \
    FAKE_UPLOAD_FAIL=1 \
    DISTRIBUTOR_BASE_URL="$internal_base" \
    DISTRIBUTOR_TOKEN="$upload_token" \
    bash "$repo_root/scripts/upload-build.sh" \
    ios "$test_root/upload.ipa" \
    2>&1
)"
upload_fail_status=$?
set -e
if [[ "$upload_fail_status" -eq 0 ]]; then
  echo "upload-build.sh unexpectedly succeeded on a failed upload." >&2
  exit 1
fi
if [[ "$upload_fail_transcript" == *"$upload_token"* ]]; then
  echo "upload-build.sh leaked the upload token on the failure path." >&2
  exit 1
fi
assert_masked_only "$upload_fail_transcript" "upload-build.sh" "$install_url"

# --- 3. notify-discord-thread.sh masks URLs and never prints the webhook -----

discord_url="https://discord.invalid/webhook/WEBHOOK_SENTINEL_1d41402abc4b"
ios_url="$internal_base/get/iosAAA"
android_url="$internal_base/get/andBBB"
new_thread="1531400000000000001"
thread_body="$test_root/discord-thread-body"
thread_out="$test_root/thread-id-out"
: > "$thread_out"

# Fake curl for Discord: the create call carries wait=true and returns a
# channel_id; the reply call carries thread_id= and records its posted body.
# Both receive their JSON payload on stdin (--data-binary @-) and, like the real
# --write-out '\n%{http_code}', emit "<body>\n<status>".
cat > "$test_root/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
url=""
for a in "\$@"; do url="\$a"; done
body="\$(cat)"
case "\$url" in
  *"thread_id="*)
    printf '%s' "\$body" > "$thread_body"
    printf '\n204'
    exit 0
    ;;
  *"wait=true"*)
    printf '{"channel_id":"$new_thread"}\n200'
    exit 0
    ;;
esac
echo "unexpected curl invocation: \$url" >&2
exit 99
EOF
chmod 700 "$test_root/bin/curl"

notify_transcript="$(
  PATH="$test_root/bin:$PATH" \
    GITHUB_ACTIONS=true \
    DISCORD_WEBHOOK_URL="$discord_url" \
    PR_NUMBER=42 \
    PR_TITLE="a test pr" \
    PR_URL="https://github.com/o/r/pull/42" \
    COMMIT_SHA=abcdef1234567890 \
    IOS_RESULT=success IOS_URL="$ios_url" \
    ANDROID_RESULT=success ANDROID_URL="$android_url" \
    DISCORD_THREAD_ID_OUT="$thread_out" \
    bash "$repo_root/scripts/notify-discord-thread.sh" \
    2>&1
)"

if [[ "$notify_transcript" == *"$discord_url"* ]]; then
  echo "notify-discord-thread.sh leaked the Discord webhook into its output." >&2
  exit 1
fi
assert_masked_only "$notify_transcript" "notify-discord-thread.sh" "$ios_url" "$android_url"

for needle in "::add-mask::$ios_url" "::add-mask::$android_url"; do
  if [[ "$notify_transcript" != *"$needle"* ]]; then
    echo "notify-discord-thread.sh did not register the mask: $needle" >&2
    exit 1
  fi
done

# Both install links must have been delivered into the thread reply...
if [[ ! -s "$thread_body" ]] || ! grep -Fq "$ios_url" "$thread_body" || ! grep -Fq "$android_url" "$thread_body"; then
  echo "notify-discord-thread.sh did not post both install links into the thread." >&2
  exit 1
fi
# ...and the newly created thread id must be handed back for persistence.
if [[ "$(cat "$thread_out")" != "$new_thread" ]]; then
  echo "notify-discord-thread.sh did not report the created thread id." >&2
  exit 1
fi

# --- 4. submit-testflight.sh withholds fastlane output and the ASC API key ----

asc_key_sentinel='ASC_P8_SENTINEL_9f2c1b7ae4d0'
asc_key_base64="$(
  printf -- '-----BEGIN PRIVATE KEY-----\n%s\n-----END PRIVATE KEY-----\n' "$asc_key_sentinel" |
    openssl base64 -A
)"
printf 'placeholder ipa\n' > "$test_root/release.ipa"

# Fake pilot: proves the key arrived through a file descriptor rather than argv, then echoes it
# on both streams the way a verbose fastlane failure would.
cat > "$test_root/bin/fastlane" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

key_path=''
prev=''
for arg in "$@"; do
  if [[ "$prev" == "--api_key_path" ]]; then
    key_path="$arg"
  fi
  prev="$arg"
done

if [[ -z "$key_path" || ! -f "$key_path" ]]; then
  echo "pilot was not given an API key descriptor." >&2
  exit 30
fi

cat "$key_path"
cat "$key_path" >&2
echo "[!] Could not upload the build: the app record is missing." >&2

if [[ "${FAKE_PILOT_FAIL:-0}" == "1" ]]; then
  exit 31
fi
exit 0
EOF
chmod 700 "$test_root/bin/fastlane"

testflight_output="$test_root/testflight-output"
: > "$testflight_output"
testflight_transcript="$(
  PATH="$test_root/bin:$PATH" \
    GITHUB_ACTIONS=true \
    RUNNER_TEMP="$test_root" \
    GITHUB_OUTPUT="$testflight_output" \
    ASC_API_KEY_ID=FAKEKEYID01 \
    ASC_API_ISSUER_ID=11111111-2222-3333-4444-555555555555 \
    ASC_API_KEY_P8_BASE64="$asc_key_base64" \
    SC_WHAT_TO_TEST="release notes" \
    bash "$repo_root/scripts/submit-testflight.sh" "$test_root/release.ipa" \
    2>&1
)"

# The decoded key is derived from a secret, so the runner does not mask it on its own: the script
# has to register it. Everything downstream -- including the JSON descriptor, which carries the
# same body lines -- is scrubbed by that registration.
if [[ "$testflight_transcript" != *"::add-mask::$asc_key_sentinel"* ]]; then
  echo "submit-testflight.sh did not mask the decoded App Store Connect key." >&2
  exit 1
fi
assert_masked_only "$testflight_transcript" "submit-testflight.sh" "$asc_key_sentinel"
if ! grep -Fxq \
  'submission_url=https://appstoreconnect.apple.com/apps/6790192277/testflight/ios' \
  "$testflight_output"; then
  echo "submit-testflight.sh did not report the TestFlight URL." >&2
  exit 1
fi

# The decoded .p8 and the descriptor built around it must not outlive the script.
if compgen -G "$test_root/testflight.*" >/dev/null; then
  echo "submit-testflight.sh left the API key on disk." >&2
  exit 1
fi

set +e
pilot_failure_transcript="$(
  PATH="$test_root/bin:$PATH" \
    FAKE_PILOT_FAIL=1 \
    GITHUB_ACTIONS=true \
    RUNNER_TEMP="$test_root" \
    GITHUB_OUTPUT="$testflight_output" \
    ASC_API_KEY_ID=FAKEKEYID01 \
    ASC_API_ISSUER_ID=11111111-2222-3333-4444-555555555555 \
    ASC_API_KEY_P8_BASE64="$asc_key_base64" \
    bash "$repo_root/scripts/submit-testflight.sh" "$test_root/release.ipa" \
    2>&1
)"
pilot_failure_status=$?
set -e

if [[ "$pilot_failure_status" -eq 0 ]]; then
  echo "The simulated failed TestFlight upload unexpectedly succeeded." >&2
  exit 1
fi
# The failure path is the one that prints tool output, so it is the one that has to redact: the
# key is echoed by the fake pilot on both streams and must still not reach the transcript.
assert_masked_only "$pilot_failure_transcript" "submit-testflight.sh" "$asc_key_sentinel"
if [[ "$pilot_failure_transcript" != *"withheld"* ]]; then
  echo "The failed TestFlight upload did not explain that fastlane output was withheld." >&2
  exit 1
fi
# ...while still saying enough to act on. A submission that fails with no diagnosis at all is the
# failure mode this pipeline was rebuilt to get rid of.
if [[ "$pilot_failure_transcript" != *"Could not upload the build"* ]]; then
  echo "The failed TestFlight upload reported no actionable diagnostic." >&2
  exit 1
fi
if compgen -G "$test_root/testflight.*" >/dev/null; then
  echo "submit-testflight.sh left the API key on disk after a failure." >&2
  exit 1
fi

# --- 5. submit-play.sh hides the service-account key and the token it buys ----

play_key="$test_root/play-key.pem"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$play_key" 2>/dev/null
# A middle line of the PEM body: unmistakable if any of the key reaches a log.
play_key_sentinel="$(sed -n '3p' "$play_key")"
play_token_sentinel='PLAY_TOKEN_SENTINEL_5c8d1e'
play_service_account="$(
  jq -n \
    --arg email 'release-bot@example.iam.gserviceaccount.com' \
    --rawfile key "$play_key" \
    '{type: "service_account", client_email: $email, private_key: $key}' |
    openssl base64 -A
)"
printf 'placeholder aab\n' > "$test_root/release.aab"

# Fake Play Developer API. Rejects any authenticated call whose bearer was passed on argv.
cat > "$test_root/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail

url=""
for a in "\$@"; do url="\$a"; done

case "\$url" in
  *oauth2.googleapis.com/token*)
    # Record the assertion exactly as sent, so the test can prove that value was masked. curl
    # reads it from a file via --data-urlencode "assertion@<path>"; anything else means the
    # credential was passed on argv.
    prev=''
    for a in "\$@"; do
      case "\$prev" in
        --data-urlencode)
          case "\$a" in
            assertion@*) cat "\${a#assertion@}" > "$test_root/play-assertion" ;;
            assertion=*) echo "the assertion was passed on argv" >&2; exit 97 ;;
          esac
          ;;
      esac
      prev="\$a"
    done
    printf '{"access_token":"$play_token_sentinel","expires_in":3600}\n200'
    exit 0
    ;;
esac

case " \$* " in
  *" --config "*) ;;
  *)
    echo "a Play API call carried its bearer outside the curl config" >&2
    exit 98
    ;;
esac

case "\$url" in
  */edits)
    if [[ "\${FAKE_PLAY_FAIL_EDIT:-0}" == "1" ]]; then
      printf '{"error":{"status":"PERMISSION_DENIED","code":403,"message":"The caller does not have permission"}}\n403'
      exit 0
    fi
    printf '{"id":"edit-1"}\n200'
    exit 0
    ;;
  *bundles?uploadType=media)
    printf '{"versionCode":4242}\n200'
    exit 0
    ;;
  */tracks/internal)
    printf '{"track":"internal"}\n200'
    exit 0
    ;;
  *:commit)
    printf '{"id":"edit-1"}\n200'
    exit 0
    ;;
  */edits/*)
    printf '\n204'
    exit 0
    ;;
esac
echo "unexpected curl invocation: \$url" >&2
exit 99
EOF
chmod 700 "$test_root/bin/curl"

play_transcript="$(
  PATH="$test_root/bin:$PATH" \
    GITHUB_ACTIONS=true \
    RUNNER_TEMP="$test_root" \
    PLAY_SERVICE_ACCOUNT_JSON_BASE64="$play_service_account" \
    SC_WHAT_TO_TEST="release notes" \
    bash "$repo_root/scripts/submit-play.sh" "$test_root/release.aab" \
    2>&1
)"

# Both the decoded key and the token it buys are derived from a secret, so the runner does not mask
# either on its own -- the script has to register both.
if [[ "$play_transcript" != *"::add-mask::$play_key_sentinel"* ]]; then
  echo "submit-play.sh did not mask the decoded service-account key." >&2
  exit 1
fi
if [[ "$play_transcript" != *"::add-mask::$play_token_sentinel"* ]]; then
  echo "submit-play.sh did not mask the Google Play access token." >&2
  exit 1
fi
assert_masked_only "$play_transcript" "submit-play.sh" "$play_token_sentinel" "$play_key_sentinel"
if [[ "$play_transcript" != *"version code 4242"* ]]; then
  echo "submit-play.sh did not report the uploaded version code." >&2
  exit 1
fi
if compgen -G "$test_root/play.*" >/dev/null; then
  echo "submit-play.sh left the service-account key on disk." >&2
  exit 1
fi

# The signed assertion is a bearer credential in its own right for the next hour, so it has to be
# masked like the token it buys. Its signature depends on the generated key, so rather than
# recomputing it here -- which would reimplement the code under test -- the fake token endpoint
# recorded the assertion it was actually sent, and that exact value must have been registered.
if [[ ! -s "$test_root/play-assertion" ]]; then
  echo "The fake Google token endpoint never received a signed assertion." >&2
  exit 1
fi
play_assertion_signature="$(cut -d. -f3 < "$test_root/play-assertion")"
if [[ -z "$play_assertion_signature" ]]; then
  echo "submit-play.sh sent an unsigned assertion to the token endpoint." >&2
  exit 1
fi
if [[ "$play_transcript" != *"::add-mask::$play_assertion_signature"* ]]; then
  echo "submit-play.sh did not mask the signed service-account assertion." >&2
  exit 1
fi

set +e
play_failure_transcript="$(
  PATH="$test_root/bin:$PATH" \
    GITHUB_ACTIONS=true \
    FAKE_PLAY_FAIL_EDIT=1 \
    RUNNER_TEMP="$test_root" \
    PLAY_SERVICE_ACCOUNT_JSON_BASE64="$play_service_account" \
    bash "$repo_root/scripts/submit-play.sh" "$test_root/release.aab" \
    2>&1
)"
play_failure_status=$?
set -e

if [[ "$play_failure_status" -eq 0 ]]; then
  echo "The simulated failed Google Play upload unexpectedly succeeded." >&2
  exit 1
fi
assert_masked_only "$play_failure_transcript" "submit-play.sh" \
  "$play_token_sentinel" "$play_key_sentinel"
if [[ "$play_failure_transcript" != *"withheld"* ]]; then
  echo "The failed Google Play upload did not explain that API output was withheld." >&2
  exit 1
fi
if [[ "$play_failure_transcript" != *"PERMISSION_DENIED"* ]]; then
  echo "The failed Google Play upload reported no actionable diagnostic." >&2
  exit 1
fi
if compgen -G "$test_root/play.*" >/dev/null; then
  echo "submit-play.sh left the service-account key on disk after a failure." >&2
  exit 1
fi

echo "CI log isolation withheld signing credentials on the build path, kept the store credentials out of both submitters, and masked the internal host, install URLs, and Discord webhook."
