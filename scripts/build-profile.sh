#!/usr/bin/env bash
# shellcheck shell=bash

# Build profiling for the `eas build --local` pipeline. Source this file; do not execute it.
#
# `eas build --local` is a ~20 minute black box in CI: scripts/eas-local-build-ci.sh discards its
# stdout and stderr because EAS serializes signing credentials into a child-process argv, and
# scripts/test-eas-ci-log-isolation.sh enforces that. So the build cannot be profiled the way a
# build normally is -- by reading its log.
#
# Instead this file collects timings from two sources that never touch EAS output:
#
#   1. Phase marks written by the scripts WE own (scripts/eas-build-pre-install.sh). Exact, and
#      every byte of them is a string this repository wrote.
#   2. A sampler over the process table, for the phases inside EAS that we do not own (prebuild,
#      pod install, Metro, xcodebuild, Gradle).
#
# THE SAMPLER IS THE PART THAT COULD LEAK, so it is safe by construction rather than by filtering:
#
#   * It reads `comm` (the executable name), never `args`. The EAS credential blob lives in a child
#     process's ARGUMENT VECTOR, which is never read here.
#   * Every observed name is mapped through sc_profile_bucket, a closed vocabulary. A name that
#     matches nothing is DROPPED -- there is no default branch that echoes what it saw. So the
#     sample file can only ever contain words that appear literally in this file.
#   * Aggregation is counting. Nothing derived from the process table is ever printed.
#
# scripts/build-report.sh re-validates every record before rendering, so the summary is protected
# even if a producer here were wrong. scripts/test-eas-ci-log-isolation.sh proves both ends by
# running the sampler while a process whose argv carries a credential sentinel is alive.

# How often the sampler looks at the process table. Every duration it reports is a multiple of
# this, so it is a resolution floor, not just a cost knob.
SC_PROFILE_SAMPLE_INTERVAL="${SC_PROFILE_SAMPLE_INTERVAL:-5}"

# Fixed location rather than a variable passed through run_eas_privately: the pre-install hook runs
# as an EAS child, from EAS's own copy of the repository under runner.temp, with an environment we
# only partly control. $HOME is the one thing both sides agree on.
sc_profile_dir() {
  printf '%s' "${SC_BUILD_PROFILE_DIR:-$HOME/.cache/streetcryptid/build-profile}"
}

sc_profile_phase_file() { printf '%s/phases.tsv' "$(sc_profile_dir)"; }
sc_profile_sample_file() { printf '%s/samples.tsv' "$(sc_profile_dir)"; }
sc_profile_meta_file() { printf '%s/meta.tsv' "$(sc_profile_dir)"; }
sc_profile_pid_file() { printf '%s/sampler.pid' "$(sc_profile_dir)"; }

# Phase names reach a PUBLIC job summary, so they are constrained to the same shape the renderer
# will accept. A caller passing anything else is a bug, and is dropped here rather than carried on.
sc_profile_valid_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]
}

sc_profile_reset() {
  local dir
  dir="$(sc_profile_dir)"
  rm -rf -- "$dir"
  mkdir -p -- "$dir"
}

# Record that <phase> took <seconds>. Both fields are validated: the phase against the name shape
# above, the duration as a plain integer. Profiling never fails a build, so every write is
# best-effort.
sc_profile_mark() {
  local phase="$1" seconds="$2" dir

  sc_profile_valid_name "$phase" || return 0
  [[ "$seconds" =~ ^[0-9]{1,9}$ ]] || return 0

  dir="$(sc_profile_dir)"
  mkdir -p -- "$dir" 2>/dev/null || return 0
  printf '%s\t%s\n' "$phase" "$seconds" >> "$(sc_profile_phase_file)" 2>/dev/null || true
}

# A note's value must be an integer or one of a fixed set of outcome tokens, optionally carrying a
# lowercase-hex digest.
#
# This started out as a general "short alphanumeric token" rule, and scripts/test-build-profile-
# isolation.sh rejected it on the first run: a base64 credential IS a short alphanumeric token, so
# that rule would have published one. The vocabulary is closed instead. Adding a new kind of note
# means extending this expression, which is the friction it is here to create.
SC_PROFILE_NOTE_VALUE_RE='^([0-9]{1,12}|(reused|built|skipped|hit|miss)(-[0-9a-f]{6,40})?)$'

# Record a non-timing fact about the run (which native artifacts were reused, sampler bounds).
sc_profile_note() {
  local key="$1" value="$2" dir

  sc_profile_valid_name "$key" || return 0
  [[ "$value" =~ $SC_PROFILE_NOTE_VALUE_RE ]] || return 0

  dir="$(sc_profile_dir)"
  mkdir -p -- "$dir" 2>/dev/null || return 0
  printf '%s\t%s\n' "$key" "$value" >> "$(sc_profile_meta_file)" 2>/dev/null || true
}

# Run a command, recording how long it took under <phase>. The command's own output is untouched:
# this wrapper logs nothing of its own, so a caller that was discarding output stays that way.
sc_profile_run() {
  local phase="$1"
  shift
  local start status=0
  start="$(date +%s)"
  "$@" || status=$?
  sc_profile_mark "$phase" "$(( $(date +%s) - start ))"
  return "$status"
}

# The closed vocabulary. Every branch assigns a literal written here; an unrecognized name clears
# the result and returns non-zero. Nothing reaches the caller that did not come from this list.
#
# It reports through a variable rather than stdout so the sampler does not need a command
# substitution per process. That is not micro-optimization: a fork for each of several hundred
# processes, every few seconds, for twenty minutes would measurably disturb the build this is
# supposed to be measuring.
#
# Linux's `comm` is truncated to 15 characters, so nothing longer is matched there; the JVM-based
# Android toolchain all reports as `java` anyway. macOS reports a full path, hence the ${1##*/}.
sc_profile_bucket() {
  case "${1##*/}" in
    xcodebuild | XCBBuildService | xcbuild) SC_PROFILE_BUCKET='xcodebuild' ;;
    swift-frontend | swiftc | swift-driver) SC_PROFILE_BUCKET='swift' ;;
    clang | clang++ | cc1 | cc1plus | gcc | cc) SC_PROFILE_BUCKET='clang' ;;
    ld | ld64 | ld64.lld | lld | ld.lld | libtool | ar) SC_PROFILE_BUCKET='link' ;;
    cargo) SC_PROFILE_BUCKET='cargo' ;;
    rustc) SC_PROFILE_BUCKET='rustc' ;;
    pod | ruby | xcodeproj) SC_PROFILE_BUCKET='cocoapods' ;;
    java | kotlin-compiler | kotlinc | gradle) SC_PROFILE_BUCKET='gradle' ;;
    node | bun) SC_PROFILE_BUCKET='node' ;;
    hermesc | hermes-compiler) SC_PROFILE_BUCKET='hermes' ;;
    aapt2 | d8 | r8 | zipalign | apksigner | dx) SC_PROFILE_BUCKET='androidtools' ;;
    *)
      SC_PROFILE_BUCKET=''
      return 1
      ;;
  esac
}

# One pass over the process table. Emits, for the current instant:
#
#   c<TAB><bucket>   once per matching PROCESS  -- summed, this is tool CPU-seconds
#   w<TAB><bucket>   once per bucket PRESENT    -- summed, this is tool WALL-seconds
#
# The ratio of the two is how many cores a phase actually kept busy, which is the number that
# answers "would parallel compilation help here".
# Deliberately no associative array for the present-this-instant set: the iOS build job runs these
# scripts on a macOS runner, whose /bin/bash is 3.2 (Apple never shipped a GPLv3 bash), and
# `local -A` is a bash 4 feature that fails there with a syntax error. `sort -u` over a plain
# accumulated string does the same job everywhere.
sc_profile_sample_once() {
  local name seen='' newline=$'\n'

  while IFS= read -r name; do
    sc_profile_bucket "$name" || continue
    printf 'c\t%s\n' "$SC_PROFILE_BUCKET"
    seen="$seen$SC_PROFILE_BUCKET$newline"
  done < <(ps -Ao comm= 2>/dev/null || true)

  [[ -n "$seen" ]] || return 0
  printf '%s' "$seen" | sort -u | while IFS= read -r name; do
    printf 'w\t%s\n' "$name"
  done
}

# Start sampling in the background. Never fails the caller: a profiler that can break a release
# build is worse than no profiler.
sc_profile_sampler_start() {
  local dir
  dir="$(sc_profile_dir)"
  mkdir -p -- "$dir" 2>/dev/null || return 0

  sc_profile_note 'sampler_interval_s' "$SC_PROFILE_SAMPLE_INTERVAL"
  sc_profile_note 'sampler_started_at' "$(date +%s)"

  (
    while :; do
      sc_profile_sample_once >> "$(sc_profile_sample_file)" 2>/dev/null || true
      sleep "$SC_PROFILE_SAMPLE_INTERVAL"
    done
  ) &

  printf '%s\n' "$!" > "$(sc_profile_pid_file)" 2>/dev/null || true
  return 0
}

sc_profile_sampler_stop() {
  local pidfile pid
  pidfile="$(sc_profile_pid_file)"
  [[ -s "$pidfile" ]] || return 0

  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -f -- "$pidfile" 2>/dev/null || true
  sc_profile_note 'sampler_stopped_at' "$(date +%s)"
  return 0
}
