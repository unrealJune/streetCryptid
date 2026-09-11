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

## CI build profiling

**`eas build --local` is profiled from the outside, never from its log.** `scripts/eas-local-build-ci.sh`
discards EAS's stdout and stderr because EAS serializes signing credentials into a child-process
argv, and `scripts/test-eas-ci-log-isolation.sh` enforces that — so the ~20-minute step that is 90%
of every build job prints nothing. `scripts/build-profile.sh` recovers the shape of it from two
sources that never touch EAS output: phase marks written by `scripts/eas-build-pre-install.sh`
(which we own), and a sampler over the process table. `scripts/build-report.sh` renders both, plus
the cache hit/miss of all four caches, into the job summary.

- **The sampler reads `comm`, never `args`, and emits only words from a closed vocabulary**
  (`sc_profile_bucket`) — a name matching nothing is dropped, with no default branch that echoes
  what it saw. The renderer then re-validates every record against a strict shape, so a poisoned
  file cannot reach the summary either. Do NOT add a bucket that interpolates an observed name, and
  do NOT widen `SC_PROFILE_NOTE_VALUE_RE` to a general token rule: it was one, and
  `test-build-profile-isolation.sh` immediately caught that a base64 credential IS a short
  alphanumeric token. `scripts/test-build-profile-isolation.sh` proves all of this offline by
  replacing `ps` with a fake that returns a credential sentinel; it runs in CI and in
  `just test-release`.
- **The native artifact cache is keyed by the hook's own digest, not by the Actions cache key.**
  `eas-build-pre-install.sh` hashes the crate sources, `Cargo.lock`, the exact `rustc -V`, and the
  two scripts that decide how they compile; `.github/actions/eas-native-cache` only decides which
  tarball to download. So a key collision or a toolchain bump rebuilds rather than shipping a stale
  `.so`. The paths in that digest are RELATIVE on purpose — the warm job runs from
  `$GITHUB_WORKSPACE` and a real build from EAS's copy under `runner.temp`, and an absolute path
  would make them never agree while looking like it worked. `scripts/test-native-cache.sh` checks
  exactly that, offline, with a fake toolchain.
- **Bindings are cached with the library, never separately.** UniFFI aborts at load when generated
  bindings disagree with the library's API checksums, so restoring one without the other trades
  build time for a crash on device.
- **PR builds are arm64-only; releases are not.** `pr-development-builds.yml` sets
  `SC_ANDROID_ABIS=arm64-v8a` and `ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a`;
  `release.yml` sets neither and still ships all three. The staged cache entry is per-ABI, so the
  narrower pull-request request hits the entry the warm job staged with all three.
- `~/.gradle/caches/build-cache-1` is the only cached Gradle entry that skips work rather than a
  download, and it only fills while `org.gradle.caching` is on — keep it and `GRADLE_OPTS` in step.
- **The build tools' own instrumentation is preferred to sampling wherever it exists**, because it
  knows things sampling cannot. `cargo build --timings` gives per-crate cost and achieved
  parallelism; `scripts/gradle-build-profile.init.gradle` (auto-applied from `~/.gradle/init.d`,
  the only hook available since EAS invokes Gradle itself) gives `FROM-CACHE` vs `EXECUTED` per
  task; `-showBuildTimingSummary`, injected through `GYM_XCARGS` because EAS runs `fastlane gym`,
  gives Xcode's per-phase breakdown. CocoaPods, Metro and hermesc expose nothing, and the sampler
  is the answer for those. **Do not add a Gradle build scan** — `--scan` uploads the build
  environment to `scans.gradle.com`, which is precisely the material this pipeline exists to
  contain.
- **Only validated rows are published, never raw tool output.** The workflows upload
  `SC_PROFILE_BUNDLE_DIR`, which `build-report.sh` builds from the rows that passed validation —
  NOT the collection directory. Cargo's `cargo-timing.html` is deliberately excluded despite being
  the nicest artifact of the lot: it would be clean by argument (cargo runs before any credential
  is fetched) where everything else is clean by construction. `gradle-tasks.tsv` is the reason the
  rule is absolute — Gradle signs the APK, so its raw output is not publishable by default.
- **The macOS runner's `/bin/bash` is 3.2 and its userland is BSD.** The iOS job has already been
  broken once by `local -A`, once by BSD `wc -l` padding its output, and once by BSD `sed` writing
  a literal `t` for `\t` in a replacement. `test-build-profile-isolation.sh` greps for bash 4
  constructs; the rest is on review.
