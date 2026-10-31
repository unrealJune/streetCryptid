#!/usr/bin/env bash

# EAS runs this after `bun install` and, on iOS, after `pod install`: the one point in a local
# build where the generated Xcode project exists and can be inspected. It records whether
# React Native's ccache wiring took -- the setting reached Podfile.properties.json, `ccache` was
# on PATH, and the Pods project's CC points at the ccache wrapper -- because a build that
# silently compiles without it looks exactly like one with a cold cache.
#
# EAS's output is discarded in CI (it can carry signing credentials), so the answer goes to a
# file the workflow prints. Only fixed words are written, never anything read from the project.
# Nothing here may fail a build.

set -uo pipefail

if [[ "${EAS_BUILD_PLATFORM:-}" != "ios" || -z "${RUNNER_TEMP:-}" ]]; then
  exit 0
fi

out="$RUNNER_TEMP/ccache-wiring.txt"
{
  prop='missing'
  if [[ -f ios/Podfile.properties.json ]]; then
    if grep -q '"apple.ccacheEnabled": *"true"' ios/Podfile.properties.json; then
      prop='true'
    else
      prop='not-true'
    fi
  fi
  printf 'podfile_property=%s\n' "$prop"

  if command -v ccache > /dev/null 2>&1; then
    printf 'ccache_on_path=yes\n'
  else
    printf 'ccache_on_path=no\n'
  fi

  if grep -q 'ccache-clang.sh' ios/Pods/Pods.xcodeproj/project.pbxproj 2> /dev/null; then
    printf 'pods_project_cc=ccache-wrapper\n'
  else
    printf 'pods_project_cc=plain\n'
  fi
} > "$out" 2> /dev/null || true

exit 0
