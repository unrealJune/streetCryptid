#!/usr/bin/env bash

# Decide which CI lanes a change needs: the app, the repeater server, the Windows repeater, the
# Linux repeater, the website.
#
# A path-filtered workflow that does not run leaves a required check pending forever, so `ci.yml`
# always runs and asks this script instead. The rules (docs/MONOREPO.md, "CI"):
#
#   repeater/server/**, .dockerignore (the server image's)   -> server
#   repeater/windows/**                                      -> windows
#   repeater/linux/**                                        -> linux
#   repeater/host/** (the desktop host both link)            -> windows + linux
#   website/**                                               -> website
#   assets/images/mothman-logo*.svg (the Windows icon's source) -> app + windows
#   repeater/protocol/**, Cargo.toml, Cargo.lock,
#   rust-toolchain.toml, third_party/**,
#   any other repeater/ path                               -> every repeater lane + app
#   known workflow/action                                 -> its consumers + workflow lint
#   other .github/** and this script                      -> all checks
#   anything else                                            -> app
#
# "Anything else" is deliberately the app: Prettier checks Markdown and YAML wherever they live,
# so a docs-only change still needs the app lane's Format job. Only a change confined to one
# repeater product, or to the website (whose lane runs Prettier over website/ itself), skips the
# mobile suite.
#
# Usage:
#   scripts/ci-changes.sh <base-sha> [<head-sha>]   diff from the merge base of base and head
#   scripts/ci-changes.sh --paths                   read changed paths from stdin (tests)
#
# A base that is empty, all zeros (a new branch) or not in the local history runs every lane:
# not knowing what changed must never skip a check.
#
# Prints lane and app subcheck flags (true|false) for $GITHUB_OUTPUT.

set -euo pipefail

all() {
  printf 'app=true\nserver=true\nwindows=true\nlinux=true\nwebsite=true\nmacos=true\nnative=true\nble=true\nworkflows=true\n'
}

classify() {
  local app=false server=false windows=false linux=false website=false macos=false
  local native=false ble=false workflows=false path
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in .github/* | scripts/ci-changes.sh) workflows=true ;; esac
    case "$path" in
      .github/workflows/ci-repeater-server.yml | .github/workflows/release-repeater-server.yml)
        server=true ;;
      .github/workflows/ci-repeater-windows.yml | .github/workflows/release-repeater-windows.yml)
        windows=true ;;
      .github/workflows/ci-repeater-linux.yml | .github/workflows/release-repeater-linux.yml)
        linux=true ;;
      .github/workflows/ci-repeater-macos.yml | .github/workflows/release-repeater-macos.yml)
        macos=true ;;
      .github/workflows/ci-website.yml | .github/workflows/release-website.yml)
        website=true ;;
      .github/actions/bun-install/*) app=true; website=true ;;
      .github/workflows/ci-app.yml) app=true; native=true; ble=true ;;
      .github/workflows/release.yml | .github/workflows/pr-development-builds.yml | .github/workflows/cache-warm.yml)
        app=true; native=true ;;
      .github/workflows/copilot-setup-steps.yml | .github/actions/eas-*/*)
        app=true; native=true ;;
      repeater/server/src/* | repeater/server/Cargo.toml) server=true; macos=true ;;
      repeater/server/* | .dockerignore) server=true ;;
      repeater/windows/app/Assets/*) windows=true; macos=true ;;
      repeater/windows/*) windows=true ;;
      repeater/linux/*) linux=true ;;
      repeater/macos/*) macos=true ;;
      repeater/host/*)
        windows=true
        linux=true
        macos=true
        ;;
      website/*) website=true ;;
      assets/images/mothman-logo*.svg)
        app=true
        windows=true
        macos=true
        ;;
      .github/* | scripts/ci-changes.sh)
        app=true; server=true; windows=true; linux=true; website=true; macos=true
        native=true; ble=true
        ;;
      repeater/protocol/* | Cargo.toml | Cargo.lock | rust-toolchain.toml | third_party/* | repeater/*)
        app=true
        server=true
        windows=true
        linux=true
        macos=true
        native=true
        ble=true
        ;;
      src/* | assets/* | docs/* | *.md) app=true ;;
      modules/iroh-location/rust/third_party/*)
        app=true; native=true; ble=true
        ;;
      modules/iroh-location/rust/* | modules/iroh-location/rust-wasm/* | \
      modules/iroh-location/ios/generated/* | modules/iroh-location/android/src/main/java/uniffi/* | \
      scripts/* | .config/* | .cargo/*)
        app=true; native=true
        ;;
      modules/iroh-location/ios/* | modules/iroh-location/android/* | modules/iroh-location/src/*)
        app=true ;;
      *) app=true; native=true; ble=true ;;
    esac
  done
  printf 'app=%s\nserver=%s\nwindows=%s\nlinux=%s\nwebsite=%s\nmacos=%s\nnative=%s\nble=%s\nworkflows=%s\n' \
    "$app" "$server" "$windows" "$linux" "$website" "$macos" "$native" "$ble" "$workflows"
}

if [[ "${1:-}" == '--paths' ]]; then
  classify
  exit 0
fi

base="${1:-}"
head="${2:-HEAD}"

if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "No usable base ('$base'); running every lane." >&2
  all
  exit 0
fi

if ! merge_base="$(git merge-base "$base" "$head" 2>/dev/null)"; then
  echo "No merge base between $base and $head; running every lane." >&2
  all
  exit 0
fi

git diff --name-only --no-renames "$merge_base" "$head" | classify
