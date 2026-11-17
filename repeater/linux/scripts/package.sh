#!/usr/bin/env bash

# Package a built `streetcryptid-repeater` for release: a tarball with the binary and its notices,
# the AGPL source archive it was built from, and checksums.
#
#   repeater/linux/scripts/package.sh <binary> <version> <x86_64|aarch64> <out-dir>

set -euo pipefail

bin="${1:?binary}"
version="${2:?version}"
arch="${3:?arch}"
out="${4:?out dir}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

name="streetcryptid-repeater-${version}-${arch}-linux"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$name" "$out"

install -m 0755 "$bin" "$stage/$name/streetcryptid-repeater"
install -m 0644 "$repo_root/repeater/linux/README.md" "$stage/$name/README.md"
install -m 0644 "$repo_root/repeater/linux/NOTICE" "$stage/$name/NOTICE"
install -m 0644 "$repo_root/LICENSE" "$stage/$name/LICENSE"
git -C "$repo_root" rev-parse HEAD > "$stage/$name/SOURCE_COMMIT"

tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$out/$name.tar.gz" "$name"

# Everything the binary is built from, for the AGPL source offer that travels with a release.
git -C "$repo_root" archive --format=tar.gz --prefix="streetcryptid-repeater-${version}-source/" \
  --output="$out/streetcryptid-repeater-${version}-source-${arch}.tar.gz" HEAD \
  repeater/linux repeater/host repeater/server repeater/protocol third_party \
  Cargo.toml Cargo.lock rust-toolchain.toml rustfmt.toml LICENSE

(cd "$out" && sha256sum ./*.tar.gz | sed 's# \./# #' > "SHA256SUMS-${arch}")
ls -l "$out"
