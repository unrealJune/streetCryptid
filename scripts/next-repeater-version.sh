#!/usr/bin/env bash

# Decide a repeater product's next release from the commits since its last tag, by the same
# Conventional Commit rules as the app (scripts/lib/conventional-commits.sh).
#
#   server   `server-vX.Y.Z`             the hosted stash / Linux repeater image and chart
#            (.github/workflows/release-repeater-server.yml)
#   windows  `windows-vX.Y.Z-preview.N`  the Windows repeater's installers and update feed
#            (.github/workflows/release-repeater-windows.yml)
#
# What counts is what each product is built from. A commit that touches only the app never
# releases a repeater, and vice versa; the Windows host links the server crate, so a server change
# releases both.
#
# Windows versions carry `-preview.1` while the installers are unsigned (README in
# repeater/windows): the bump applies to MAJOR.MINOR.PATCH, and every automatic release is the
# first preview of a new one. A tag pushed by hand may use any `-preview.N`.
#
# The tag is the version of record; no manifest is read or written.
#
# Usage:
#   scripts/next-repeater-version.sh <server|windows> [--force auto|patch|minor|major]
#
# Prints `key=value` lines on stdout:
#   release=true|false     whether a release should happen at all
#   bump=<reason>          major | minor | patch | initial | forced-<level> | none
#   version=<version>      the version to release (the previous one when release=false)
#   previous_tag           the tag the commit range started from (empty on the first release)
#   tag=<prefix><version>
#
# Requires the full git history and tags (actions/checkout with fetch-depth: 0).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/conventional-commits.sh
source "$repo_root/scripts/lib/conventional-commits.sh"

product="${1:-}"
shift || true
force='auto'

while (($#)); do
  case "$1" in
    --force)
      shift
      force="${1:-}"
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

case "$force" in
  auto | patch | minor | major) ;;
  '') force='auto' ;;
  *)
    echo "--force expects auto, patch, minor, or major." >&2
    exit 2
    ;;
esac

# What the Rust side of every repeater is built from.
workspace_paths=(repeater/protocol Cargo.toml Cargo.lock rust-toolchain.toml third_party)

case "$product" in
  server)
    prefix='server-v'
    suffix=''
    initial='0.1.0'
    paths=(repeater/server .dockerignore "${workspace_paths[@]}")
    ;;
  windows)
    prefix='windows-v'
    suffix='-preview.1'
    initial='0.1.0'
    # The host links the server crate (not its chart or image), and the icon is drawn from the
    # app's sigil.
    paths=(
      repeater/windows
      repeater/server/src
      repeater/server/Cargo.toml
      "${workspace_paths[@]}"
      'assets/images/mothman-logo*.svg'
    )
    ;;
  *)
    echo "Usage: $0 <server|windows> [--force auto|patch|minor|major]" >&2
    exit 2
    ;;
esac

previous_tag="$(git -C "$repo_root" describe --tags --abbrev=0 --match "${prefix}[0-9]*.[0-9]*.[0-9]*" 2>/dev/null || true)"
previous="${previous_tag#"$prefix"}"
previous_core="${previous%%-*}"

emit() {
  local release="$1" bump="$2" version="$3"
  printf 'release=%s\n' "$release"
  printf 'bump=%s\n' "$bump"
  printf 'version=%s\n' "$version"
  printf 'previous_tag=%s\n' "$previous_tag"
  printf 'tag=%s%s\n' "$prefix" "$version"
}

if [[ -z "$previous_tag" ]]; then
  emit true initial "$initial$suffix"
  exit 0
fi

if [[ "$force" != 'auto' ]]; then
  emit true "forced-$force" "$(bump_version "$previous_core" "$force")$suffix"
  exit 0
fi

commits=()
while IFS= read -r commit; do
  commits+=("$commit")
done < <(release_commits "$repo_root" "$previous_tag" "${paths[@]}")

level="$(bump_level "$repo_root" ${commits[@]+"${commits[@]}"})"
if [[ "$level" == none ]]; then
  emit false none "$previous"
  exit 0
fi

emit true "$level" "$(bump_version "$previous_core" "$level")$suffix"
