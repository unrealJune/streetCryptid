# Windows repeater — agent notes

The WinUI 3 app (`app/`), the native-AOT Windows service (`service/`), the C# model they share
(`core/`, tested in `tests/`) and the Rust host (`host/`). Read `README.md` first. The root
`AGENTS.md` still applies.

## How it fits

- The host embeds the repeater server crate (`../server`, crate `trail-stash`) in its
  `Storage::MemoryRepeater` mode and the roster/wire crate (`../protocol`). It is a member of the
  root Cargo workspace: always build with `-p streetcryptid-repeater-host`, from anywhere in the
  repository, against the one `Cargo.lock`. There is no vendored copy or patch any more; a change
  the desktop repeater needs in the stash is a change to `repeater/server`, with its tests there
  (`desktop_*` in `src/repeater_tests.rs`).
- The claim link is `streetcryptid_repeater::wire::claim_url`, the same function the server's
  console QR and the phone's parser use. Never format it again here.
- `scripts/build.ps1` is the one entry point (`just windows::build|test|package`). The host builds
  with the workspace's `desktop-release` profile; the workspace's `release` is the phone's.

## CI and releases

- CI's Windows lane (`.github/workflows/ci-repeater-windows.yml`) runs when this directory, the
  protocol or the workspace's shared files change (`scripts/ci-changes.sh`). About 18 minutes per
  architecture with a warm Rust cache; NuGet restores from cache against the locked-mode
  `packages.lock.json` files, so restore with `-p:RestoreLockedMode=true` and commit lockfile
  changes.
- A push to main that touches what the host is built from cuts `windows-vX.Y.Z-preview.1`
  (`.github/workflows/release-repeater-windows.yml`, `scripts/next-repeater-version.sh windows`).
  Commit types decide it, as for the app and the server. Installers stay unsigned previews until
  `REPEATER_SIGN_PARAMS` is set.
- `scripts/test-service.ps1` installs the real service; run it only on a disposable machine.
