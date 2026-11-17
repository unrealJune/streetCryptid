#!/usr/bin/env bash

# CMake compiler launcher for the Android builds: take one of SC_COMPILE_SLOTS slots, then run the
# compile through ccache. CMake puts the launcher in front of every compile it emits
# (CMAKE_<LANG>_COMPILER_LAUNCHER, set by .github/actions/eas-local-build-setup), so this is a cap
# on concurrent compilers across EVERY library's CMake build and every ABI at once.
#
# Why it exists: AGP runs each library's CMake build per ABI as its own Gradle worker, and ninja
# inside each one at nproc+2. Two workers on a 4-core runner is still ~12 clang processes, many of
# them on React Native's heaviest C++ (~1 GB each), beside a 5 GB Gradle heap and Metro. The
# 2026-11-16 v4.0.4 store build survived only by pushing 7.7 GB into swap with 0.9 GB of memory
# left; the v4.2.0 one an hour later thrashed for an hour and the runner was lost ("The hosted
# runner lost communication with the server"). Neither Gradle nor ninja has a knob that bounds
# the total: workers.max bounds Gradle, not ninja, and AGP gives no way to pass ninja `-j`.
#
# A slot is an flock on a file. The descriptor is inherited by ccache (exec) and the compiler it
# runs, so the slot is released by the kernel when the compile ends, however it ends.

set -uo pipefail

slots="${SC_COMPILE_SLOTS:-4}"
dir="${SC_COMPILE_SLOT_DIR:-${TMPDIR:-/tmp}/sc-compile-slots}"
compiler_cache="${SC_COMPILE_CCACHE:-/usr/local/bin/ccache}"

mkdir -p "$dir"

while :; do
  for ((slot = 0; slot < slots; slot++)); do
    exec {fd}> "$dir/$slot"
    if flock --nonblock "$fd"; then
      exec "$compiler_cache" "$@"
    fi
    exec {fd}>&-
  done
  sleep 0.1
done
