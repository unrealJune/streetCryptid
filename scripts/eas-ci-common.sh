#!/usr/bin/env bash
# shellcheck shell=bash

# Shared plumbing for the CI wrappers around EAS CLI and the store submitters.
#
# EAS CLI serializes local build jobs -- including signing credentials -- into a base64
# child-process argument, so any EAS stdout/stderr that reaches the Actions log or the runner disk
# is a credential-disclosure risk. Every EAS invocation in CI therefore goes through
# `run_eas_privately`, and callers must discard or buffer its output in memory rather than echoing
# it. Source this file; do not execute it.

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

eas_ci_require_token() {
  local environment="$1"

  if [[ -z "${EXPO_TOKEN:-}" ]]; then
    echo "The $environment environment is missing EXPO_TOKEN." >&2
    exit 1
  fi
}

eas_ci_require_runner_temp() {
  : "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
}

# Only for wrappers that hand a value forward to a later step. The build wrapper deliberately
# produces no output of its own: publishing is a separate script.
eas_ci_require_output() {
  : "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"
}

# App archives never leave runner.temp: they are not cached, not uploaded as workflow artifacts,
# and are deleted by the job's always-cleanup step.
eas_ci_require_temp_artifact() {
  case "$1" in
    "$RUNNER_TEMP"/*) ;;
    *)
      echo "The app archive must be inside RUNNER_TEMP." >&2
      exit 2
      ;;
  esac
}

eas_ci_verify_access() {
  if ! run_eas_privately whoami >/dev/null 2>&1; then
    echo "Expo token authentication failed. EAS output was withheld." >&2
    exit 1
  fi

  if ! run_eas_privately project:info >/dev/null 2>&1; then
    echo "Expo token cannot access the configured EAS project. EAS output was withheld." >&2
    exit 1
  fi
}

eas_ci_require_platform() {
  case "$1" in
    ios | android) ;;
    *)
      echo "Expected platform ios or android." >&2
      exit 2
      ;;
  esac
}

# --- Store submission helpers ------------------------------------------------

sc_ci_require_env() {
  local name
  local -a missing=()

  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done

  if ((${#missing[@]})); then
    printf 'The production-release environment is missing: %s\n' "${missing[*]}" >&2
    exit 1
  fi
}

# Register a value with the runner's log scrubber so it is replaced with *** anywhere it later
# surfaces -- including from code that never went through sc_ci_redacted_diagnostic.
#
# GitHub masks the exact value of every secret it injects, but nothing DERIVED from one: a base64
# secret decoded back to a PEM, or the access token a signed assertion buys, are different strings
# and would print in the clear.
#
# Values under 16 characters are skipped, because masking a short common substring would blank out
# unrelated log text and hide the diagnostics this pipeline exists to surface. That floor is well
# below anything real: a PEM wraps its body at 64 columns, and the shortest final line across the
# two formats in use here is 24 characters (App Store Connect .p8 keys are EC P-256, 64/64/56;
# Google's service-account RSA keys are 64 x 25 + 24). So every body line of a real key is
# registered, and the floor only ever skips a fragment too short to be a credential.
sc_ci_mask_value() {
  local value="$1"

  [[ -n "${GITHUB_ACTIONS:-}" ]] || return 0
  ((${#value} >= 16)) || return 0

  printf '::add-mask::%s\n' "$value"
}

# ::add-mask:: is line-oriented, so a multi-line credential has to be registered a line at a time.
# Doing so also covers the single-line JSON form of the same key, because the scrubber matches
# substrings: "-----BEGIN PRIVATE KEY-----\nMIG..." contains each body line verbatim.
#
# The delimiter lines are skipped -- they are constants that carry nothing, and masking them would
# only turn "did not decode to a PEM private key" into a line of asterisks.
sc_ci_mask_pem() {
  local file="$1" line

  [[ -n "${GITHUB_ACTIONS:-}" ]] || return 0
  [[ -s "$file" ]] || return 0

  while IFS= read -r line; do
    case "$line" in
      -----BEGIN* | -----END* | '') continue ;;
    esac
    sc_ci_mask_value "$line"
  done < "$file"
}

# Surface just enough of a failed store upload to be actionable without replaying whatever the
# tool happened to print. Anything shaped like key material -- PEM bodies, long base64-ish runs
# (API keys, OAuth tokens, JWTs), and query-string values -- is replaced before the lines are
# echoed, and only the tail is kept so a stack trace cannot push the redaction budget aside.
#
# The complete, unredacted output stays in $1, which lives under RUNNER_TEMP and is deleted by the
# caller's cleanup trap.
sc_ci_redacted_diagnostic() {
  local file="$1" limit="${2:-6}"

  [[ -s "$file" ]] || return 0

  echo "Diagnostic (redacted):" >&2
  sed -E \
    -e 's/-----BEGIN [A-Z ]+-----.*/[redacted key material]/' \
    -e 's#[A-Za-z0-9+/_-]{40,}={0,2}#[redacted]#g' \
    -e 's#([?&])([A-Za-z_]+)=[^[:space:]&]+#\1\2=[redacted]#g' \
    "$file" |
    grep -v '^[[:space:]]*$' |
    tail -n "$limit" |
    cut -c 1-300 |
    sed 's/^/  /' >&2
}
