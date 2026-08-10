#!/usr/bin/env bash

# Assert that a built .ipa carries the expected CFBundleShortVersionString.
#
# The distribution server copies that key into the `bundle-version` of the
# itms-services manifest, and iOS silently declines an OTA install whose
# bundle-version is not greater than the installed copy -- no prompt, no error,
# nothing in any log. A prebuild that failed to pick up SC_PR_BUILD_VERSION would
# therefore upload a build that simply refuses to install for every tester who
# already has the app, and the run would still go green. Fail here instead.
#
# Usage: verify-ipa-version.sh <artifact.ipa> <expected-version>
#
# iOS only. Android reinstalls an APK with an unchanged versionCode as long as
# the signing certificate matches, so the marketing version does not gate
# installs there.

set -euo pipefail

artifact="${1:-}"
expected="${2:-}"

if [[ -z "$artifact" || -z "$expected" ]]; then
  echo "Usage: verify-ipa-version.sh <artifact.ipa> <expected-version>" >&2
  exit 2
fi

if [[ ! -f "$artifact" ]]; then
  echo "App archive not found: $artifact" >&2
  exit 1
fi

# Anchor the match to the top-level app bundle: unzip's `*` also matches `/`, so
# a bare Payload/*.app/Info.plist glob would additionally catch any nested .app
# (a WatchKit companion, say) and could pick the wrong plist.
plist_entry="$(
  unzip -Z1 "$artifact" 'Payload/*.app/Info.plist' |
    grep -E '^Payload/[^/]+\.app/Info\.plist$' |
    head -n 1
)"

if [[ -z "$plist_entry" ]]; then
  echo "No Payload/<app>.app/Info.plist inside the archive." >&2
  exit 1
fi

# Info.plist ships as a binary plist, so it has to land on disk before plutil
# will read a key out of it.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unzip -p "$artifact" "$plist_entry" > "$tmp/Info.plist"

actual="$(plutil -extract CFBundleShortVersionString raw -o - "$tmp/Info.plist")"

if [[ "$actual" != "$expected" ]]; then
  echo "The archive carries CFBundleShortVersionString $actual, expected $expected." >&2
  echo "app.config.ts did not pick up SC_PR_BUILD_VERSION, so this build would not" >&2
  echo "install over an existing copy on any tester's device." >&2
  exit 1
fi

printf 'Archive version is %s.\n' "$actual"
