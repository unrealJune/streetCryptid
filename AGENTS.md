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
- **Two gates, and the build-time one is the real one.** `EXPO_PUBLIC_DEV_TELEMETRY=1` compiles
  telemetry in: without it `metro.config.js` resolves `@/features/dev/telemetry` to
  `index.noop.ts` and the whole graph (encoder, shipper, SQLite journal, console bridge) is absent
  from the bundle — the JS counterpart of the crate's `otel` cargo feature.
  `EXPO_PUBLIC_OTEL_ENDPOINT` then decides where it ships. Both are read statically (the
  `stash-config.ts` convention). `index-parity.test.ts` keeps the two barrels in step;
  `scripts/check-release-telemetry.mjs` fails CI if a store profile sets either variable. The
  `production` profile (what `release.yml` builds and `submit.production` uploads) currently sets
  BOTH, deliberately and temporarily: production IS TestFlight for us right now, so the profile we
  install from is the store profile, and a build we cannot observe is not worth shipping while the
  background pipeline is still being diagnosed. The exception is recorded in `ACKNOWLEDGED` in
  `scripts/check-release-telemetry.mjs` — deleting that entry re-arms the CI failure, which is how
  it gets turned back off. **Before the app reaches anyone outside our own TestFlight group**,
  either strip both variables from `production` or declare the collection in App Store Connect and
  the privacy policy.
- **Telemetry ships from the durable journal, not from memory.** Every finished span is mirrored
  into `streetcryptid.events.db` by `recordSpan`, and `shipper.ts` drains it with a
  mark-on-success cursor and backoff. A failed POST leaves entries queued, so a background wake
  with no network no longer destroys the telemetry describing it — and recovered data keeps its
  ORIGINAL timestamps. Anything added on the background path must still `flush()` before
  returning, which now means "persist, then drain".
- **`device.health` is how absence is made visible.** Emitted once per periodic refresh and on
  foreground resume, it records OS truth (permission scope + accuracy, whether each task is
  actually registered and running, background-refresh status) alongside `last_*_age_ms`
  watermarks, the storage backend, and the telemetry backlog. It exists because a phone that has
  stopped waking emits nothing by construction: a gap between records is a thing that can be
  measured and shown, and no other span can be. The device-health dashboard's top row turns those
  gaps into counts; they are deliberately not wired to Alertmanager.
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
- **Never `await` native teardown unbounded.** A headless session holds a process-wide chain
  (`native-runtime-owner.ts`); a promise that never _settles_ — as opposed to one that rejects —
  wedges every later session and hangs the next foreground launch on `awaitNativeRuntimeIdle`, and
  only force-quitting clears it. That cost an iPhone 19 hours of silence on 2026-08-18. Teardown is
  bounded by `HEADLESS_TEARDOWN_TIMEOUT_MS`, the chain by
  `NATIVE_RUNTIME_SESSION_WATCHDOG_MS`, and a stranded teardown is reported by the _next_ session
  as `bg.session.stranded` (the hung one cannot report on itself — it never flushes).
- **UniFFI bindings are regenerated by CI, not by hand.** The `native` job runs
  `scripts/generate-uniffi-bindings.sh all` on Linux and pushes refreshed Kotlin _and_ Swift
  sources back to the pull-request branch, so a Rust API change no longer waits on someone with a
  Mac. Only the compiled artifacts need a platform toolchain: the Android `.so` (NDK, via
  `just bindgen-android`) and the iOS XCFramework (macOS + full Xcode, via `just bindgen-ios`) —
  and EAS iOS builds produce that themselves in `scripts/eas-build-pre-install.sh`. Run the `just`
  recipes locally when you want a local device/simulator build; CI covers the rest.
- **A frozen dot has two possible causes and the wire carries which.** `LocationFix.ts` says when the
  POSITION was measured and deliberately does not advance on a heartbeat; `published_delta_s` says
  when the ENVELOPE was sealed, which is the only proof the sending process was alive. `state`
  (`FIX_STATE_*`) says why the position is what it is. Both are stamped in `DrainEngine::drain`, are
  `None` on capture and in storage, and drive `PresenceState` in `features/social/core/presence.ts`
  — a parked friend is rendered at full opacity with a dashed marker, not dimmed. Do NOT infer
  liveness from contact continuing: on iOS parked publishing rides on `BGProcessing` wakes, measured
  at p50 5 min / p90 92 min / max 17 h between contacts on a phone that was working throughout.
- **The wire is append-only, `Option`-only, and end-only.** `decode_fix_payload` decodes across the
  padding's zero fill, so appended `Option` fields read as `None` on a payload from an older sender
  (postcard writes `None` as `0x00`, and `unpad` has already proven the fill is zero). That is what
  makes appending safe in BOTH directions with no version byte — insert a field anywhere but the end,
  or make it non-`Option`, and older peers decode as garbage or vanish silently. Storage is a
  separate frozen type (`StoredFix`) on purpose: the outbox and gate discard everything on a decode
  failure, so growing the type they persist would wipe `last_known_fix` fleet-wide on upgrade and
  silence every parked phone.
- Guard newly added native exports anyway (`typeof mod.configureTelemetry === 'function'`). Not
  because of bindgen now, but because a phone can be running an older binary than the JS bundle.
