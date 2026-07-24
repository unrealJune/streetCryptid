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
  app/            # expo-router routes (map, friends, settings)
  features/map/   # dot-field map engine, rendering, and tests
  features/social/ # P2P pairing, encrypted location sync, profiles, and UI
  features/account/ # local cryptid identity and ASCII profile editor
  components/     # shared UI components (themed text/view, tabs, icons, ...)
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

### PR standalone Release builds

PRs authored by `Cobular`, `ava-ankenbrandt`, or `unrealJune` from branches in this repository
build installable iOS and Android internal Release apps on ephemeral GitHub-hosted runners.
Copilot coding agent PRs are also eligible only when the author is exactly
`copilot-swe-agent[bot]`, the branch is in this repository, and its name starts with `copilot/`.
The jobs run `eas build --local` with the production-internal profiles, so the Hermes bundle is
embedded and the installed apps run without Metro. They upload only the finished IPA/APK with
`eas upload` and post EAS install pages (including QR codes) on the PR without consuming EAS
cloud-build quota.

The build jobs use the `development-builds` GitHub environment. A repository administrator must
configure that environment before enabling the workflow:

1. In **Settings → Environments → development-builds**, add maintainers as required reviewers and
   enable **Prevent self-review**. Ensure **Allow administrators to bypass configured protection
   rules** is unchecked.
2. Add a Developer-role Expo robot-user token named `EXPO_TOKEN` as an environment secret. Do not
   duplicate it as a repository or organization secret.
3. Approve each pending workflow run separately, including every run created after new commits.
   Do not substitute a persistent PR label for this per-run approval.

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

EAS CLI serializes the local build job, including signing credentials, into a base64 child-process
argument. Debug/error output can therefore be sensitive. The CI wrapper never forwards any
`eas build` output to GitHub or disk, and it captures `eas upload` output only in memory. Failures
emit only a fixed message. The wrapper removes GitHub command-file variables from the EAS
subprocess environment and allow-lists the single Expo build-page URL written to the job output.
CI exercises build success, build failure, and malformed upload output with a fake base64
signing-key sentinel to ensure it cannot escape into command output.

## License

The app is MIT-licensed; see [LICENSE](./LICENSE). The vendored experimental
iroh BLE transport is AGPL-3.0-or-later. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) before distributing native
builds.
