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

# Reads to the END of the input and keeps the last match, rather than returning on the first one.
# Returning early abandons the process substitution while sanitize is still writing to it, and
# sanitize then dies of SIGPIPE -- "printf: write error: Broken pipe" on stderr, and a non-zero
# status that `set -o pipefail` turns into a failed report. Whether that happened at all depended
# on the pipe buffer swallowing the rest of the file, so it passed locally and failed in CI.
meta_value() {
  local wanted="$1" key value found=''
  while IFS=$'\t' read -r key value; do
    if [[ "$key" == "$wanted" ]]; then
      found="$value"
    fi
  done < <(sanitize "$meta_file" "$SC_PROFILE_NOTE_VALUE_RE")
  printf '%s' "$found"
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
sample_rows=''
if [[ -s "$sample_file" ]]; then
  # Aggregated once into a variable rather than straight into the table: the same rows go into the
  # uploaded bundle, and the first run without that left no way to review the sampled shape of a
  # build after the fact.
  # Only rows whose bucket is in the closed vocabulary survive; `kind` must be exactly c or w.
  sample_rows="$(
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
    ' "$sample_file" | sort -t$'\t' -k2,2nr
  )"
  printf '### Sampled tool time (%ss resolution)\n\n' "$interval"
  printf '| Tool | Wall | CPU | Cores busy |\n|---|--:|--:|--:|\n'
  while IFS=$'\t' read -r tool wall cpu cores; do
    printf '| `%s` | %s | %s | %s× |\n' "$tool" "$(human "$wall")" "$(human "$cpu")" "$cores"
  done <<< "$sample_rows"
  printf '\n'
  printf '_Wall is time with at least one such process alive; CPU is the sum over processes. '
  printf 'Cores busy below ~1.5× on a long row is a phase that is not using the runner._\n\n'
else
  printf '_No samples were collected._\n\n'
fi

# --- What the tools said about themselves -------------------------------------
#
# The sampler above is a coarse map of the whole build. The three sections below are the build
# tools' OWN instrumentation, which knows things sampling cannot: which crate cost what, whether a
# Gradle task was reused from the cache or actually ran, and where Xcode spent its phases.

crate_rows=''
gradle_rows=''
xcode_rows=''

crate_file="$profile_dir/crates.tsv"
if [[ -s "$crate_file" ]]; then
  # `_`-prefixed rows are the totals the parser computes; the rest are crate names.
  crate_rows="$(
    awk -F'\t' '
      $1 ~ /^_?[a-z0-9][a-z0-9._+-]{0,38}$/ && $2 ~ /^[0-9]{1,12}$/ { print $1 "\t" $2 }
    ' "$crate_file"
  )"
  unit_ms="$(awk -F'\t' '$1 == "_unit_ms" { print $2 }' <<< "$crate_rows" | tail -n 1)"
  wall_ms="$(awk -F'\t' '$1 == "_wall_ms" { print $2 }' <<< "$crate_rows" | tail -n 1)"

  printf '### Rust: slowest crates (`cargo build --timings`)\n\n'
  if [[ "$unit_ms" =~ ^[0-9]+$ && "$wall_ms" =~ ^[0-9]+$ ]] && ((wall_ms > 0)); then
    printf 'Compile time %s across all crates, wall %s — **%s× cores busy**.\n\n' \
      "$(human "$((unit_ms / 1000))")" \
      "$(human "$((wall_ms / 1000))")" \
      "$(awk -v u="$unit_ms" -v w="$wall_ms" 'BEGIN { printf "%.1f", u / w }')"
  fi
  printf '| Crate | Compile time |\n|---|--:|\n'
  awk -F'\t' '$1 !~ /^_/ { print }' <<< "$crate_rows" |
    sort -t$'\t' -k2,2nr |
    # `awk`, not `head`: head exits as soon as it has its lines, the `sort` upstream dies of
    # SIGPIPE, and `set -o pipefail` turns that into a failed report. awk drains its input.
    awk -v n=15 'NR <= n' |
    while IFS=$'\t' read -r name ms; do
      printf '| `%s` | %s |\n' "$name" "$(human "$((ms / 1000))")"
    done
  printf '\n_Every crate, not just these fifteen, is in `crates.tsv` in the `build-profile-%s` '
  printf 'artifact on this run._\n\n' "$platform"
fi

gradle_file="$profile_dir/gradle-tasks.tsv"
if [[ -s "$gradle_file" ]]; then
  # Task paths and outcomes are Gradle's, so they are held to a shape before being printed. The
  # path is checked SEGMENT BY SEGMENT rather than as one long character class: Gradle task names
  # are camelCase identifiers, and the longest in an Expo build is around 24 characters
  # (`bundleReleaseJsAndAssets`), so a 40-character cap per segment is generous for anything real
  # and far too tight for anything that is secretly a base64 blob.
  gradle_rows="$(
    awk -F'\t' '
      function ok_path(p,   n, parts, i) {
        if (p !~ /^:/) return 0
        n = split(substr(p, 2), parts, ":")
        if (n < 1 || n > 8) return 0
        for (i = 1; i <= n; i++) {
          if (parts[i] !~ /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/) return 0
        }
        return 1
      }
      ok_path($1) && $2 ~ /^[A-Z][A-Z-]{0,19}$/ && $3 ~ /^[0-9]{1,12}$/ {
        print $1 "\t" $2 "\t" $3
      }
    ' "$gradle_file"
  )"
  if [[ -n "$gradle_rows" ]]; then
    printf '### Gradle: task outcomes\n\n'
    printf '| Outcome | Tasks | Time |\n|---|--:|--:|\n'
    awk -F'\t' '
      { n[$2]++; ms[$2] += $3 }
      END { for (k in n) printf "%s\t%d\t%d\n", k, n[k], ms[k] }
    ' <<< "$gradle_rows" |
      sort -t$'\t' -k3,3nr |
      while IFS=$'\t' read -r outcome count ms; do
        printf '| `%s` | %s | %s |\n' "$outcome" "$count" "$(human "$((ms / 1000))")"
      done
    printf '\n'
    printf '| Slowest task | Outcome | Time |\n|---|---|--:|\n'
    sort -t$'\t' -k3,3nr <<< "$gradle_rows" |
      # `awk`, not `head`: head exits as soon as it has its lines, the `sort` upstream dies of
      # SIGPIPE, and `set -o pipefail` turns that into a failed report. awk drains its input.
      awk -v n=10 'NR <= n' |
      while IFS=$'\t' read -r path outcome ms; do
        printf '| `%s` | %s | %s |\n' "$path" "$outcome" "$(human "$((ms / 1000))")"
      done
    printf '\n'
    printf '_`FROM-CACHE` is the build cache doing its job. A large `EXECUTED` total next to a hit '
    printf 'on the Gradle cache means the tasks are not cacheable, not that the cache is cold._\n\n'
  fi
fi

# Xcode's own per-phase timing, from `-showBuildTimingSummary` (injected through GYM_XCARGS,
# because EAS runs fastlane gym and there is no other way to reach the xcodebuild command line).
#
# ONLY lines of the summary's fixed shape are read. The surrounding build log holds the CodeSign
# invocations and is never parsed, printed, or uploaded -- it stays under RUNNER_TEMP and is
# deleted with the rest of the build state.
if [[ "$platform" == "ios" && -n "${SC_XCODE_BUILDLOG_DIR:-}" && -d "${SC_XCODE_BUILDLOG_DIR}" ]]; then
  # awk, and awk without interval expressions: BSD sed writes a literal `t` for `\t` in a
  # replacement, and macOS awk has historically not supported {n,m}. This is the one extractor that
  # runs ONLY on macOS, so a GNU-ism here would never be caught anywhere else.
  #
  # Field-splitting is the validation. A real summary line is exactly six fields --
  # `CompileSwiftSources (42 tasks) | 218.443 seconds` -- so a phase name containing a space, a
  # shell metacharacter, or anything else that is not a bare identifier cannot produce a match.
  xcode_rows="$(
    find "$SC_XCODE_BUILDLOG_DIR" -type f -name '*.log' -exec cat {} + 2> /dev/null |
      awk '
        NF == 6 && $4 == "|" && $6 == "seconds" &&
        $1 ~ /^[A-Za-z][A-Za-z0-9]*$/ && length($1) <= 40 &&
        $2 ~ /^\([0-9]+$/ && ($3 == "tasks)" || $3 == "task)") &&
        $5 ~ /^[0-9]+\.[0-9]+$/ {
          split($5, seconds, ".")
          printf "%s\t%s\t%s\n", $1, substr($2, 2), seconds[1]
        }
      '
  )"
  if [[ -z "$xcode_rows" ]]; then
    # Say so rather than omitting the section. This route depends on fastlane honouring GYM_XCARGS
    # and GYM_BUILDLOG_PATH over the Gymfile that EAS generates, which is not something this
    # repository controls -- and on the first real run it silently produced nothing at all. An
    # absent section looks identical to a section that was never wired up; this does not.
    printf '### Xcode: phase timings\n\n'
    printf '_No `-showBuildTimingSummary` output was found in `%s`. ' "$SC_XCODE_BUILDLOG_DIR"
    printf 'EAS generates its own Gymfile, and a `buildlog_path` set there wins over the '
    printf 'environment — so fastlane is most likely writing the log somewhere else._\n\n'
  else
    printf '### Xcode: phase timings (`-showBuildTimingSummary`)\n\n'
    printf '| Phase | Tasks | Time |\n|---|--:|--:|\n'
    sort -t$'\t' -k3,3nr <<< "$xcode_rows" |
      # `awk`, not `head`: head exits as soon as it has its lines, the `sort` upstream dies of
      # SIGPIPE, and `set -o pipefail` turns that into a failed report. awk drains its input.
      awk -v n=12 'NR <= n' |
      while IFS=$'\t' read -r phase tasks seconds; do
        printf '| `%s` | %s | %s |\n' "$phase" "$tasks" "$(human "$seconds")"
      done
    printf '\n'
  fi
fi

dropped="$(wc -l < "$drop_file" | tr -d ' ')"
if [[ "$dropped" =~ ^[0-9]+$ ]] && ((dropped > 0)); then
  printf '> ⚠️ %d malformed profile record(s) were discarded before rendering.\n\n' "$dropped"
fi

# --- The uploaded bundle ------------------------------------------------------
#
# What the workflow uploads is built HERE, from the rows that survived validation above -- never
# the collection directory itself.
#
# That distinction was not in the first version of this change, and a dry run caught it: the
# renderer was careful and the artifact upload walked straight past it, publishing the raw files.
# gradle-tasks.tsv is the reason it matters. It is written by Gradle, and Gradle is a process that
# signs the APK; its task paths are harmless but "raw output from a process that handles signing"
# is exactly what this pipeline refuses to publish.
#
# Cargo's own cargo-timing.html is deliberately NOT among them, even though its interactive gantt
# is the nicest thing in this whole change to look at. It is raw tool output, so it would be clean
# by ARGUMENT -- cargo runs in the pre-install hook, long before any credential is fetched -- while
# every other published byte here is clean by CONSTRUCTION, having been through a validator. A dry
# run with a credential planted in that file made the difference concrete. crates.tsv carries the
# same numbers for every crate in the graph, and it is generated from validated rows.
if [[ -n "${SC_PROFILE_BUNDLE_DIR:-}" ]]; then
  mkdir -p -- "$SC_PROFILE_BUNDLE_DIR" 2> /dev/null || true
  if [[ -d "$SC_PROFILE_BUNDLE_DIR" ]]; then
    # `if`, not `[[ ... ]] && printf`: under `set -e` a false guard on the LAST line makes this
    # script exit 1 after having rendered a perfectly good report. An Android build always has an
    # empty xcode_rows, so that form failed every Android run, and the workflow's `|| printf
    # 'could not be rendered'` fallback appended a contradiction under the report it just wrote.
    if [[ -n "$measured" ]]; then
      printf '%s\n' "$measured" > "$SC_PROFILE_BUNDLE_DIR/phases.tsv"
    fi
    if [[ -n "$crate_rows" ]]; then
      printf '%s\n' "$crate_rows" > "$SC_PROFILE_BUNDLE_DIR/crates.tsv"
    fi
    if [[ -n "$gradle_rows" ]]; then
      printf '%s\n' "$gradle_rows" > "$SC_PROFILE_BUNDLE_DIR/gradle-tasks.tsv"
    fi
    if [[ -n "$xcode_rows" ]]; then
      printf '%s\n' "$xcode_rows" > "$SC_PROFILE_BUNDLE_DIR/xcode-phases.tsv"
    fi
    if [[ -n "$sample_rows" ]]; then
      printf '%s\n' "$sample_rows" > "$SC_PROFILE_BUNDLE_DIR/sampled-tools.tsv"
    fi
  fi
fi
