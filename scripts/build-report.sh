#!/usr/bin/env bash

# Render what scripts/build-profile.sh collected as a Markdown job summary.
#
# Usage: build-report.sh <ios|android>
#
# Writes Markdown to stdout. The caller appends it to $GITHUB_STEP_SUMMARY -- which is PUBLIC on
# this repository, exactly like the Actions log -- so this script is the second of the two places
# that decide what may be published.
#
# It trusts nothing it reads. Every record from the profile directory is re-matched against a
# strict shape before it is used, and anything else is counted and discarded. That matters because
# the sampler runs alongside `eas build --local`, whose child processes carry signing credentials
# in their argument vectors: build-profile.sh is written so those bytes are never read, and this
# script is written so that even if they somehow were, they could not be printed.
#
# Cache facts arrive through SC_CACHE_*_HIT, set by the workflow from actions/cache outputs. They
# are booleans; they are validated as booleans.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/build-profile.sh
source "$repo_root/scripts/build-profile.sh"

platform="${1:-}"
case "$platform" in
  ios | android) ;;
  *)
    echo "Usage: build-report.sh <ios|android>" >&2
    exit 2
    ;;
esac

profile_dir="$(sc_profile_dir)"
phase_file="$(sc_profile_phase_file)"
sample_file="$(sc_profile_sample_file)"
meta_file="$(sc_profile_meta_file)"

# sanitize() runs inside command substitutions, so its rejections are counted in a file rather than
# a variable -- a subshell's increments would be lost, and silently reporting zero rejections would
# defeat the point of counting them.
drop_file="$(mktemp "${TMPDIR:-/tmp}/sc-build-report.XXXXXX")"
trap 'rm -f -- "$drop_file"' EXIT

# --- Record validation -------------------------------------------------------

# Copy a TSV file to stdout keeping only records of the accepted shape. This is the choke point:
# nothing that is not <safe-name><TAB><safe-value> can get past it, whatever wrote the file.
sanitize() {
  local file="$1" value_re="$2" key value
  [[ -s "$file" ]] || return 0
  while IFS=$'\t' read -r key value || [[ -n "$key" ]]; do
    if [[ -z "$key" && -z "$value" ]]; then
      continue
    fi
    if ! sc_profile_valid_name "$key" || [[ ! "$value" =~ $value_re ]]; then
      printf 'x\n' >> "$drop_file"
      continue
    fi
    printf '%s\t%s\n' "$key" "$value"
  done < "$file"
}

meta_value() {
  local wanted="$1" key value
  while IFS=$'\t' read -r key value; do
    if [[ "$key" == "$wanted" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done < <(sanitize "$meta_file" "$SC_PROFILE_NOTE_VALUE_RE")
  return 0
}

human() {
  local s="${1:-0}"
  [[ "$s" =~ ^[0-9]+$ ]] || s=0
  if ((s >= 60)); then
    printf '%dm %02ds' "$((s / 60))" "$((s % 60))"
  else
    printf '%ds' "$s"
  fi
}

# A cache output is `true`, `false`, or absent (the step was skipped). Anything else is reported as
# unknown rather than echoed.
cache_state() {
  case "${1:-}" in
    true) printf '✅ hit' ;;
    false) printf '❌ miss' ;;
    '') printf '– not used' ;;
    *) printf '⚠️ unknown' ;;
  esac
}

# --- Report ------------------------------------------------------------------

interval="$(meta_value sampler_interval_s)"
[[ "$interval" =~ ^[0-9]+$ ]] && ((interval > 0)) || interval=5

build_seconds="${SC_BUILD_SECONDS:-}"
[[ "$build_seconds" =~ ^[0-9]{1,9}$ ]] || build_seconds=0

printf '## `eas build --local` profile — %s\n\n' "$platform"
printf 'Total `eas build --local`: **%s**\n\n' "$(human "$build_seconds")"

printf '### Caches\n\n'
printf '| Cache | Result |\n|---|---|\n'
printf '| Bun / npm downloads | %s |\n' "$(cache_state "${SC_CACHE_JS_HIT:-}")"
printf '| Cargo registry + target | %s |\n' "$(cache_state "${SC_CACHE_CARGO_HIT:-}")"
printf '| Prebuilt native artifacts | %s |\n' "$(cache_state "${SC_CACHE_NATIVE_HIT:-}")"
if [[ "$platform" == "ios" ]]; then
  printf '| CocoaPods downloads | %s |\n' "$(cache_state "${SC_CACHE_PODS_HIT:-}")"
else
  printf '| Gradle downloads + build cache | %s |\n' "$(cache_state "${SC_CACHE_GRADLE_HIT:-}")"
fi
printf '\n'

native_reuse="$(meta_value native_artifacts)"
if [[ -n "$native_reuse" ]]; then
  printf 'Native artifacts: `%s`\n\n' "$native_reuse"
fi

# Phases we measured ourselves, from scripts/eas-build-pre-install.sh. Exact, not sampled.
measured="$(sanitize "$phase_file" '^[0-9]{1,9}$')"
if [[ -n "$measured" ]]; then
  printf '### Measured phases (native pre-install)\n\n'
  printf '| Phase | Time |\n|---|--:|\n'
  while IFS=$'\t' read -r key value; do
    printf '| `%s` | %s |\n' "$key" "$(human "$value")"
  done < <(
    printf '%s\n' "$measured" |
      awk -F'\t' '{t[$1] += $2} END {for (k in t) printf "%s\t%s\n", k, t[k]}' |
      sort -t$'\t' -k2,2nr
  )
  printf '\n'
fi

# Sampled tool time, for the phases inside EAS that we do not own.
if [[ -s "$sample_file" ]]; then
  printf '### Sampled tool time (%ss resolution)\n\n' "$interval"
  printf '| Tool | Wall | CPU | Cores busy |\n|---|--:|--:|--:|\n'
  # Only rows whose bucket is in the closed vocabulary survive; `kind` must be exactly c or w.
  awk -F'\t' -v interval="$interval" '
    $1 == "c" && $2 ~ /^[a-z][a-z0-9]{0,31}$/ { cpu[$2]++ }
    $1 == "w" && $2 ~ /^[a-z][a-z0-9]{0,31}$/ { wall[$2]++ }
    END {
      for (k in wall) {
        w = wall[k] * interval
        c = cpu[k] * interval
        printf "%s\t%d\t%d\t%.1f\n", k, w, c, (w > 0 ? c / w : 0)
      }
    }
  ' "$sample_file" |
    sort -t$'\t' -k2,2nr |
    while IFS=$'\t' read -r tool wall cpu cores; do
      printf '| `%s` | %s | %s | %s× |\n' "$tool" "$(human "$wall")" "$(human "$cpu")" "$cores"
    done
  printf '\n'
  printf '_Wall is time with at least one such process alive; CPU is the sum over processes. '
  printf 'Cores busy below ~1.5× on a long row is a phase that is not using the runner._\n\n'
else
  printf '_No samples were collected._\n\n'
fi

dropped="$(wc -l < "$drop_file" | tr -d ' ')"
if [[ "$dropped" =~ ^[0-9]+$ ]] && ((dropped > 0)); then
  printf '> ⚠️ %d malformed profile record(s) were discarded before rendering.\n\n' "$dropped"
fi

rm -rf -- "$profile_dir" 2>/dev/null || true
