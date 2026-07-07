# streetCryptid

A slick, cross-platform (iOS · Android · Web) app for people who want to **walk
every street** — track where you've been and watch your map fill in as you
explore. This repo currently holds the app scaffold and tooling; the tracking
features come next.

## Tech stack

| Piece           | Choice                                                                              |
| --------------- | ----------------------------------------------------------------------------------- |
| Framework       | [Expo](https://expo.dev) SDK **57**                                                 |
| Native runtime  | React Native **0.86** (New Architecture, on)                                        |
| UI runtime      | React **19.2** (React Compiler enabled)                                             |
| Routing         | [expo-router](https://docs.expo.dev/router/introduction) (file-based, typed routes) |
| Language        | TypeScript **6** (strict)                                                           |
| Package manager | [bun](https://bun.sh)                                                               |
| Task runner     | [just](https://github.com/casey/just)                                               |
| Cloud builds    | [EAS](https://docs.expo.dev/eas/) (`eas.json`)                                      |
| Lint / format   | ESLint 9 (`eslint-config-expo`) + Prettier                                          |

## Prerequisites

- **Node.js** — LTS (≥ 20) recommended. Anything ≥ 18.13 works.
- **bun** ≥ 1.3 — `bun --version`
- **just** — `just --version` (install: https://github.com/casey/just)
- For local **Android** native builds: Android SDK + JDK 17+ (`ANDROID_HOME` set).
- For local **iOS** native builds: macOS + Xcode. On Windows/Linux, build iOS via
  EAS or run in [Expo Go](https://expo.dev/go).

## Getting started

```bash
bun install      # or: just install
just start       # start the Metro dev server
```

Then press `a` (Android), `i` (iOS, macOS only), or `w` (web) in the terminal,
or scan the QR code with Expo Go.

> First run of `just start` also generates the Expo type files
> (`expo-env.d.ts`, `.expo/types/`). These are git-ignored, so run the dev server
> once before `just typecheck` on a fresh clone.

## Common tasks

Run `just` (or `just --list`) to see everything. Highlights:

```bash
just start           # dev server (a/i/w to open a platform)
just android         # open on Android device / emulator
just web             # open in the browser

just check           # typecheck + lint + format-check (the local gate)
just typecheck       # tsc --noEmit
just lint            # eslint
just lint-fix        # eslint --fix
just format          # prettier --write

just doctor          # expo-doctor health check
just deps-check      # verify deps match the Expo SDK
just deps-fix        # align deps to the Expo SDK

just build ios              # EAS build (defaults: android / preview)
just build android production
just build-dev             # installable development client
just submit ios            # submit latest build to the store
just update "message"      # publish an OTA update
```

## Project structure

```
src/
  app/            # expo-router routes (file-based): index.tsx, explore.tsx, _layout.tsx
  components/     # shared UI components (themed text/view, tabs, icons, ...)
  constants/      # theme tokens
  hooks/          # color scheme / theme hooks
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

## License

See [LICENSE](./LICENSE).
