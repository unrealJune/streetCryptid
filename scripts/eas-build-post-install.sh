#!/usr/bin/env bash

# EAS runs this after `bun install` and, on iOS, after `pod install`: the one point in a local
# build where the generated Xcode project exists and Xcode has not started. CI only (RUNNER_TEMP);
# nothing here may fail a build.
#
# 1. It records whether React Native's ccache wiring took -- the setting reached
#    Podfile.properties.json, `ccache` was on PATH, and the Pods project's CC points at the ccache
#    wrapper -- because a build that silently compiles without it looks like a cold cache.
#
# 2. It pins the wrapper's ccache. React Native's ccache-clang.sh runs `exec $CCACHE_BINARY clang`,
#    reading CCACHE_BINARY from the environment, where the Podfile put it as a BUILD SETTING. On
#    2026-11-01 (Xcode 27.1) a fully wired build made zero ccache calls: Xcode did not export that
#    setting to its compile tasks, so the variable was empty and every compile ran plain clang.
#    The wrappers in this build's own node_modules copy are rewritten with the absolute ccache path
#    and React Native's ccache.conf baked in. They also append one byte per invocation to a counter
#    (`b` when CCACHE_BINARY did arrive, `n` when it did not), so the report can tell "Xcode never
#    ran the wrapper" from "it ran without ccache".
#
# EAS's output is discarded in CI (it can carry signing credentials), so the answers go to files
# the workflow prints. Only fixed words and counts are written, never anything read from the
# project.

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

ccache_bin="$(command -v ccache 2> /dev/null || true)"
wrapper_dir="node_modules/react-native/scripts/xcode"
counter="$RUNNER_TEMP/ccache-wrapper-calls"
if [[ -n "$ccache_bin" && -f "$wrapper_dir/ccache.conf" ]]; then
  conf="$(cd "$wrapper_dir" && pwd)/ccache.conf"
  : > "$counter"
  for compiler in clang clang++; do
    wrapper="$wrapper_dir/ccache-$compiler.sh"
    [[ -f "$wrapper" ]] || continue
    # Unlink first: a package manager may have hard-linked the file to its global store, and
    # writing through that link would change it for every other project on the machine.
    rm -f -- "$wrapper"
    cat > "$wrapper" << EOF || true
#!/bin/sh
# Rewritten by scripts/eas-build-post-install.sh for this CI build only.
if [ -n "\${CCACHE_BINARY:-}" ]; then printf b >> '$counter'; else printf n >> '$counter'; fi
export CCACHE_CONFIGPATH="\${CCACHE_CONFIGPATH:-$conf}"
export CCACHE_BASEDIR='$RUNNER_TEMP' CCACHE_NOHASHDIR=true CCACHE_LOGFILE='$RUNNER_TEMP/ccache.log'
exec '$ccache_bin' $compiler "\$@"
EOF
    chmod 0755 "$wrapper" 2> /dev/null || true
  done
  printf 'wrapper_pinned=yes\n' >> "$out" 2> /dev/null || true
else
  printf 'wrapper_pinned=no\n' >> "$out" 2> /dev/null || true
fi

exit 0
