# streetCryptid

A cross-platform (iOS · Android · Web) fog-of-war city atlas for people who want
to **walk every street**. The native app records explored sectors, broadcasts
encrypted location updates directly to paired friends, discovers nearby phones
over BLE, and renders current friend presence on the map.

## Tech stack

| Piece            | Choice                                                                              |
| ---------------- | ----------------------------------------------------------------------------------- |
| Framework        | [Expo](https://expo.dev) SDK **57**                                                 |
| Native runtime   | React Native **0.86** (New Architecture, on)                                        |
| UI runtime       | React **19.2** (React Compiler enabled)                                             |
| Routing          | [expo-router](https://docs.expo.dev/router/introduction) (file-based, typed routes) |
| Language         | TypeScript **6** (strict)                                                           |
| Package manager  | [bun](https://bun.sh)                                                               |
| Task runner      | [just](https://github.com/casey/just)                                               |
| Build/distribute | GitHub Actions + [EAS](https://docs.expo.dev/eas/) (`eas.json`)                     |
| Lint / format    | ESLint 9 (`eslint-config-expo`) + Prettier                                          |

## Prerequisites

- **Node.js** — LTS (≥ 20) recommended. Anything ≥ 18.13 works.
- **bun** ≥ 1.3 — `bun --version`
- **just** — `just --version` (install: https://github.com/casey/just)
- For local **Android** native builds: Android SDK + JDK 17+, Rust, and `cargo-ndk`
  (`ANDROID_HOME` set).
- For local **iOS** native builds: macOS + Xcode. On Windows/Linux, build iOS via
  EAS or run in [Expo Go](https://expo.dev/go).

## Getting started

```bash
bun install      # or: just install
just start       # start the Metro dev server
```

Then press `a` (Android), `i` (iOS, macOS only), or `w` (web) in the terminal.
The decentralized friend layer and BLE pairing require a custom development
client; Expo Go does not include the local `iroh-location` native module.

> First run of `just start` also generates the Expo type files
> (`expo-env.d.ts`, `.expo/types/`). These are git-ignored, so run the dev server
> once before `just typecheck` on a fresh clone.

### Local iOS development

The custom `iroh-location` module means iOS uses a development build rather than Expo Go. Install
Xcode with a simulator runtime, CocoaPods, and current stable Rust, then build the UniFFI
XCFramework before the first Expo build:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
just bindgen-ios
just run-ios
```

After the development client is installed, use `just start` for JavaScript/TypeScript changes.
Re-run `just bindgen-ios` and `just run-ios` after changing Rust or other native code.

EAS builds automatically load the remote environment selected by their profile in `eas.json`.
For a development client, Metro creates the JavaScript bundle locally, so pull the matching
environment into the ignored `.env.local` file before starting Metro in a fresh worktree:

```bash
just env-pull development
just start
```

## Common tasks

Run `just` (or `just --list`) to see everything. Highlights:

```bash
just start           # dev server (a/i/w to open a platform)
just android         # open on Android device / emulator
just web             # open in the browser

just check           # typecheck + lint + format-check + tests (the local gate)
just typecheck       # tsc --noEmit
just lint            # eslint
just lint-fix        # eslint --fix
just format          # prettier --write

just doctor          # expo-doctor health check
just deps-check      # verify deps match the Expo SDK
just deps-fix        # align deps to the Expo SDK
just env-pull        # pull the EAS development environment into .env.local
just bindgen-ios     # rebuild the iOS Rust XCFramework + Swift bindings
just bindgen-android # rebuild the Android Rust libraries + Kotlin bindings

just build ios              # EAS build (defaults: android / preview)
just build android production
just build-dev             # installable development client
just submit ios            # submit latest build to the store
just update "message"      # publish an OTA update
```

EAS pre-install hooks rebuild the git-ignored Rust artifacts for both Android and iOS, so local
and cloud EAS builds always package the native code that matches the committed UniFFI bindings.

### Debugging dropped location pings (developer telemetry)

Dev and preview builds can export OpenTelemetry traces + logs from every component (app JS,
native iroh core, trail-stash server) to a self-hosted collector, correlated across devices by
envelope hash. `docker compose up -d` in `infra/otel/`, set `EXPO_PUBLIC_OTEL_ENDPOINT` in
`.env.local`, and see [infra/otel/README.md](infra/otel/README.md) for the
"follow one ping" cookbook. Production builds contain no active telemetry.

## Project structure

```
src/
  app/            # expo-router routes (map + settings modal)
  features/map/   # dot-field map engine, rendering, and tests
  features/social/ # P2P pairing, encrypted location sync, profiles, and UI
  features/account/ # local cryptid identity and ASCII profile editor
  components/     # shared UI components (themed text/view, icons, ...)
  constants/      # theme tokens
assets/           # icons, splash, images
app.json          # Expo app config (name, scheme, bundle ids, plugins)
eas.json          # EAS build/submit profiles (development / preview / production)
eslint.config.js  # ESLint flat config (expo + prettier)
justfile          # developer task runner
```

Path alias: `@/*` → `src/*`, `@/assets/*` → `assets/*`.

## Building & shipping (EAS)

App identifiers are set in `app.json` (`com.unrealjune.streetcryptid` for both
iOS and Android — change these before your first release if desired).

```bash
just eas-login     # authenticate
just eas-init      # link this repo to an EAS project (writes projectId)
just build         # cloud build (android / preview APK by default)
```

Build profiles live in `eas.json`: `development` (dev client), `preview`
(internal APK), and `production` (auto-incrementing store build).

### Automatic releases

Every push to `main` that passes CI runs `.github/workflows/release.yml`, which cuts a version,
builds both store archives on GitHub-hosted runners, and submits them — iOS to TestFlight, Android
to the Google Play internal track. Nothing is built on EAS infrastructure: the jobs run `eas build
--local`, so no cloud build quota is consumed, and only the finished archive reaches Expo, where
`eas submit --path` forwards it to the store.

The release is gated on CI rather than triggered by the push itself: it starts from a successful
`CI` workflow run and refuses to ship if `main` has moved on since that run, leaving the newer
commit's own CI run to release it.

The user-facing version is derived from the commits since the last `v*` tag, and
`scripts/next-version.sh` decides the bump:

| Commit range since the last tag                            | Result               |
| ---------------------------------------------------------- | -------------------- |
| `!` after the type, or a `BREAKING CHANGE:` footer         | major                |
| a `feat:` commit                                           | minor                |
| anything else that is not housekeeping                     | patch                |
| only `docs`/`chore`/`ci`/`test`/`style`/`build`/`refactor` | no release, no build |

Merge commits are ignored, so a merge subject alone never ships anything. Most of this
repository's history is freeform prose, which is why an unrecognized subject earns a patch instead
of being skipped. Run `just next-version` to see what the next push would do, or dispatch the
workflow manually with a `patch`/`minor`/`major` override.

The version job commits `chore(release): vX.Y.Z` to `main` (updating `app.json` and
`package.json`), tags it, and the build jobs check that exact commit out, so a shipped binary
always reports its own version. The workflow ignores its own `chore(release):` commits, so it
cannot loop. `1.0.0` is the baseline: `app.json`, `package.json`, and the `v1.0.0` tag all agree,
and everything increments from there. `ios.buildNumber` and `android.versionCode` are not in this
repository at all — `cli.appVersionSource` is `remote`, so EAS increments them per build.

A repository administrator must configure the `production-release` GitHub environment before the
first release:

1. Add `EXPO_TOKEN` as an environment secret. Do not add required reviewers unless you want every
   release to block on a human.
2. Upload the App Store Connect API key and the Google Play service account key to the project's
   EAS credentials (`eas credentials`) — EAS Submit reads them from there, so no store credential
   ever enters GitHub.
3. Only if a branch protection rule rejects pushes authenticated with `GITHUB_TOKEN`, add a
   `RELEASE_TOKEN` repository secret that is allowed to push the release commit and tag to `main`.

If a submission fails, the version commit and tag still stand; fix the problem and the next push
releases the following patch. To reship the same code, dispatch the workflow with an explicit
bump.

The release and PR build jobs prepare their runners through the same composite action,
`.github/actions/eas-local-build-setup` (Node, Bun, the JavaScript and Cargo caches, the NDK or
Xcode toolchain, the CocoaPods/Gradle caches, and the EAS CLI). Almost every one of those inputs
lands in a cache key, so keeping them in one file is what stops the two workflows from silently
drifting into permanent cache misses. `cache-warm.yml` uses the same action with
`save-caches: 'true'`.

### PR standalone Release builds

PRs authored by the allow-listed human accounts `Cobular`, `ava-ankenbrandt`, or `unrealJune` from
branches in this repository build installable iOS and Android internal Release apps on ephemeral
GitHub-hosted runners.
Copilot coding agent PRs are also eligible only when the author is exactly
`copilot-swe-agent[bot]`, the branch is in this repository, and its name starts with `copilot/`.
Copilot generates the remainder of that branch name, so it is intentionally not allow-listed; the
exact bot identity and same-repository check are the security boundaries.
The jobs run `eas build --local` with the production-internal profiles, so the Hermes bundle is
embedded and the installed apps run without Metro. They upload only the finished IPA/APK with
`eas upload` and post EAS install pages (including QR codes) on the PR without consuming EAS
cloud-build quota.

The build jobs use the `development-builds` GitHub environment. A repository administrator must
configure that environment before enabling the workflow:

1. In **Settings → Environments → development-builds**, add maintainers as required reviewers and
   enable **Prevent self-review**. **Critical:** uncheck **Allow administrators to bypass configured
   protection rules**.
2. Add a Developer-role Expo robot-user token named `EXPO_TOKEN` as an environment secret. Do not
   duplicate it as a repository or organization secret.
3. Approve each pending workflow run separately, including every run created after new commits.
   Do not substitute a persistent PR label for this per-run approval: a label persists when
   unreviewed commits are added.

Before approving, verify that the pending deployment's commit SHA is the exact revision reviewed.
Pay particular attention to changes in GitHub Actions workflows, package lifecycle scripts, Expo
configuration hooks, and native build scripts: after approval, that revision executes with access
to the environment secret and remote signing credentials.

Remote EAS signing credentials and the iOS ad hoc provisioning profile must already exist. CI
freezes those credentials rather than modifying them; register new iPhones and refresh the profile
outside the PR workflow. Build working directories stay under `runner.temp`, are never cached or
uploaded as GitHub artifacts, and are explicitly removed after the final app archive is uploaded
to EAS. Only package-manager downloads and Cargo compiler outputs are cached; generated native
projects, app archives, keychains, provisioning profiles, and other EAS state remain excluded.

An Actions cache is readable only from the ref that wrote it and that ref's ancestors, so caches
written by a `pull_request` run are invisible to every other PR while still counting against the
repository's 10 GB budget. `cache-warm.yml` therefore runs the Cargo and package-manager half of
these builds on `main` — no `eas build --local`, no credentials — and the PR build jobs restore
those caches without writing their own. Both sides go through
`.github/actions/eas-rust-cache`, which owns `CARGO_TARGET_DIR` and `RUSTUP_TOOLCHAIN`: rust-cache
hashes those variables and the `key` input into its _restore_ prefix, so any drift between the two
workflows — or a source-file hash in the key — silently turns every restore into a miss. The
CocoaPods and Gradle caches are the exception: only `eas build --local` fills them, and
`release.yml` is the one workflow that runs it on `main`, so a release warms both for every pull
request. PR runs still save their own entries — which warms reruns of that same PR — because a
release only happens when something ships.

EAS CLI serializes the local build job, including signing credentials, into a base64 child-process
argument. Debug/error output can therefore be sensitive. The CI wrapper never forwards any
`eas build` output to GitHub or disk, and it captures `eas upload` and `eas submit` output only in
memory. Failures emit only a fixed message. The wrapper removes GitHub command-file variables from
the EAS subprocess environment and allow-lists the single Expo build-page or submission URL written
to the job output. CI exercises build success, build failure, malformed upload output, submission
failure, and an off-host submission URL with a fake base64 signing-key sentinel to ensure it cannot
escape into command output.

## License

The app is MIT-licensed; see [LICENSE](./LICENSE). The vendored experimental
iroh BLE transport is AGPL-3.0-or-later. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) before distributing native
builds.
