# shellcheck shell=bash

# What counts toward a release, and how far it bumps. Shared by scripts/next-version.sh (the app,
# `v*` tags) and scripts/next-repeater-version.sh (the repeater server and the Windows repeater), so every
# product in the repository releases by the same rules.

# release_commits <repo> <previous_tag> <pathspec>...
#
# The non-merge commits since <previous_tag> that touch <pathspec> and belong to this product's
# history, one SHA per line. Merge commits carry the branch name, not a Conventional Commit
# subject, so they never decide a bump; squash-merged pull requests keep their subject and do.
#
# "This product's history" is every commit that descends from one of <previous_tag>'s root
# commits. A history merged in with --allow-unrelated-histories (trail-stash, imported in #198)
# lands in a range all at once, because none of it was ever behind that product's tag: the app
# would see trail-stash's whole past, and the server the app's. Checked per commit rather than with
# `--ancestry-path`, which would also drop commits from branches made before the previous tag.
release_commits() {
  local repo="$1" previous_tag="$2"
  shift 2
  local roots=() root commit
  while IFS= read -r root; do
    roots+=("$root")
  done < <(git -C "$repo" rev-list --max-parents=0 "$previous_tag")

  while IFS= read -r commit; do
    for root in "${roots[@]}"; do
      if git -C "$repo" merge-base --is-ancestor "$root" "$commit"; then
        printf '%s\n' "$commit"
        break
      fi
    done
  done < <(git -C "$repo" rev-list --no-merges "$previous_tag..HEAD" -- "$@")
}

# bump_level <repo> [<commit>...]
#
# Prints none | patch | minor | major for the given commits:
#
#   `!` after the type, or a `BREAKING CHANGE:` footer  -> major
#   `feat:`                                             -> minor
#   anything else that is not housekeeping              -> patch
#   only docs/chore/ci/test/style/build/refactor        -> none
#
# Most of this repository's history predates Conventional Commits, so an unrecognized subject is
# treated as a shipping change and earns a patch. Only commits that are explicitly housekeeping
# are ignored, and a push made up entirely of them releases nothing.
bump_level() {
  local repo="$1"
  shift
  if (($# == 0)); then
    echo none
    return
  fi
  local subjects bodies level=none
  local housekeeping='^(docs|chore|ci|test|style|build|refactor)(\([^)]*\))?:'
  subjects="$(git -C "$repo" log --no-walk=unsorted --format='%s' "$@")"
  bodies="$(git -C "$repo" log --no-walk=unsorted --format='%B' "$@")"

  if grep -Evq "$housekeeping" <<<"$subjects"; then
    level=patch
  fi
  if [[ "$level" != none ]] && grep -Eq '^feat(\([^)]*\))?:' <<<"$subjects"; then
    level=minor
  fi
  if grep -Eq '^[a-zA-Z]+(\([^)]*\))?!:' <<<"$subjects" ||
    grep -Eq '^BREAKING[ -]CHANGE:' <<<"$bodies"; then
    level=major
  fi
  echo "$level"
}

# bump_version <x.y.z> <patch|minor|major>
bump_version() {
  local version="$1" level="$2"
  if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "Not a MAJOR.MINOR.PATCH version: $version" >&2
    return 2
  fi
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
  case "$level" in
    major) printf '%s.0.0\n' "$((major + 1))" ;;
    minor) printf '%s.%s.0\n' "$major" "$((minor + 1))" ;;
    patch) printf '%s.%s.%s\n' "$major" "$minor" "$((patch + 1))" ;;
    *)
      echo "Unsupported bump: $level" >&2
      return 2
      ;;
  esac
}
