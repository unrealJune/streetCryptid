# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Project conventions

- Package manager is **bun**. Use `bun install`, `bun add`, `bunx` — never npm/yarn/pnpm.
- Prefer the **just** recipes for common tasks (`just --list`). Run **`just check`**
  (typecheck + lint + format) before committing.
- Keep dependencies SDK-aligned: install native/Expo packages with
  `bunx expo install <pkg>` (not `bun add`) so versions match Expo SDK 57.
- Routes are file-based under `src/app/` (expo-router, typed routes). Import via the
  `@/*` → `src/*` path alias.
- `expo-env.d.ts` and `.expo/types/` are generated (git-ignored). Run `just start`
  once on a fresh clone before `just typecheck`.
- ESLint is pinned to v9 (eslint-config-expo@57's plugins are not yet ESLint 10 ready).

## Developer telemetry (OTEL)

**Read `infra/otel/README.md` before touching the location pipeline** — it documents the span
map, the `sc.*` join-key correlation model (entry-hash based; there is deliberately NO
end-to-end trace because payloads are E2E-encrypted), and the TraceQL cookbook for debugging
dropped location pings across devices and the trail-stash server.

Conventions when changing that code:

- Instrumentation lives at drop-decision points and stamps `sc.author` / `sc.seq` /
  `sc.entry_hash` / `sc.drop_reason`. JS uses `src/features/dev/telemetry/` (a hand-rolled
  OTLP-JSON client — do NOT add the OpenTelemetry JS SDK; it misbehaves in Hermes headless
  contexts). Rust (both `modules/iroh-location/rust` and the trail-stash repo) uses plain
  `tracing` spans; OTLP is a subscriber layer behind the `otel` cargo feature (default-on in
  the mobile crate; keep call sites free of `#[cfg]`).
- Everything is gated on `EXPO_PUBLIC_OTEL_ENDPOINT` (read statically — see the
  `stash-config.ts` convention). **TEMPORARY:** it is currently set on the `production` EAS
  profile too (and so inherited by `production-internal-*`), deliberately, so that builds we
  actually install report traces. That profile is what `release.yml` builds and what
  `submit.production` sends to App Store Connect and the Play internal track — so this ships
  telemetry to `otlp.junephilip.com` from real users' devices, which must be disclosed in the
  privacy policy or stripped before the first public submission. Strip the `env` block from
  `production` in `eas.json` to revert.
- **Do not add a battery-optimisation prompt to "fix" Android background reliability without
  re-checking this first.** Android already restores sharing on its own: expo-task-manager's
  `TaskBroadcastReceiver` is registered for `BOOT_COMPLETED` (and `RECEIVE_BOOT_COMPLETED` is
  declared in `app.json`), its `TaskService` constructor calls `restoreTasks()`, and
  `LocationTaskConsumer.didRegister` restarts location updates — `location` is not one of the FGS
  types Android 15 bars from a boot receiver. Process kills are covered by `LocationTaskService`
  returning `START_REDELIVER_INTENT`. `ensureSharingArmedHeadless` is only a backstop there, and a
  `fgs-start-blocked` on a `backfill` trigger is expected, not a bug. iOS has neither mechanism,
  which is why `revive-task.ts` exists.
- Headless background code that records telemetry must flush before returning
  (`getTelemetry().flush()` / `flushDevTelemetry()`), or the OS freezes the process with the
  batch unexported.
- Changing the Rust UniFFI surface does NOT need a Mac. `scripts/generate-uniffi-bindings.sh`
  generates both the Kotlin and the Swift **source** bindings from the host library on any OS, and
  CI runs it on every pull request and pushes the refreshed bindings back to the branch — so a Rust
  API change lands complete without anyone running `just bindgen-*` by hand. Only the compiled iOS
  **XCFramework** needs macOS + Xcode (`lipo`/`xcodebuild`); it is untracked and rebuilt during the
  iOS build by `scripts/eas-build-pre-install.sh`.
- A JS bundle still routinely runs against an OLDER installed native core, so a newly added native
  export is absent until the device gets a build carrying it — always guard access
  (`typeof mod.configureTelemetry === 'function'`) rather than assuming the binding implies the
  binary.
