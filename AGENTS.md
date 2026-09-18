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
- **A gap in the data has three causes and `sc.run_id` is what separates them.** Every span carries
  a per-JS-context run id, so a process that restarted is visible as one; a suspension is not, since
  the same context resumes. `app.previous_run`, emitted once at foreground launch, reports how the
  LAST run ended — `prev.last_state` is the discriminator (`active` means it was killed out from
  under someone: crash, watchdog or jetsam; `background` means iOS reclaimed it, which is routine)
  and `prev.dark_ms` measures the hole against the journal's newest row. `ui.hang` covers the fourth
  state, alive but frozen: a `requestAnimationFrame` probe reports past 3 s **while the hang is
  still running** and flushes, because a hang that ends in death never recovers to report. None of
  this separates a crash from a force-quit — nothing in-process can, and that lives in MetricKit or
  the device's `.ips`. Both probes are foreground-only: the OS ends headless contexts without
  ceremony every time, and they share one journal with the app.
- **The OS's account of the ending is MetricKit's, and it is the only one there is.**
  `MetricKitDiagnostics.swift` subscribes at module creation — not lazily — because a payload
  arrives shortly after the launch that FOLLOWS the crash and is never redelivered, so a
  subscriber registered when JS first asks would miss every launch that matters. Payloads spool to
  a file for the same reason the telemetry journal exists: a headless wake that ends before
  draining would lose them permanently. `takeCrashDiagnostics` drains it into `ios.diagnostic`
  spans; `termination_reason` is where a jetsam and a watchdog kill name themselves, and a hang's
  `duration_ms` needs no symbolication to be worth reading. Only a BOUNDED flattened stack is
  forwarded (binary+offset, attributed thread first, 48 frames) — a full call-stack tree is
  hundreds of kilobytes and would make telemetry the reason a phone stops shipping telemetry.
  `diag.*` attributes describe the build that DIED, which is routinely not the build reporting it.
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
- **The same rule binds `init()`, and the latch in front of it.** `sharedServiceInit` in
  `use-location-sharing.tsx` is a module-scope, process-lifetime promise, and it used to be cleared
  on _rejection_ only — the identical "absorbs failures, not hangs" hole, at the other end of the
  lifecycle. On 2026-09-18 iOS **froze** an iPhone 128 ms into a BACKGROUND launch, mid-`init()`
  (frozen, not killed: no `cpu_resource`, no `JetsamEvent`, and the app container's newest write
  stayed at 00:36 all night, so there was no crash report either). Nine hours later the user opened
  the app and the SAME JS context resumed — `app.previous_run` never fired because nothing
  relaunched — into a latch that could never settle. `hydrateFromStore()` runs BEFORE it, so the
  chrome and the friend marker drew from disk and looked like an app, while `setServiceReady(true)`
  was never reached: no map, no working controls, no telemetry. Only a force-quit cleared it.
  The wait is now bounded by `INIT_WATCHDOG_MS` (`init-watchdog.ts`), an overrun emits
  `app.init.timeout`, and coming back to the foreground after one discards the wedged service and
  retries rather than waiting again — the in-process equivalent of the force-quit.
- **A stalled `init` names its own step, and only from disk.** `saveInitWatermark` stamps the phase
  (`create-node`, `native-start`, `tickets`, …) before each step that can block, and a later
  context reports it as `app.init.stranded` with `init.phase`. This exists because on 2026-09-18
  the journal simply stopped after `node.create` and NOTHING said what came next: every span the
  launch would have emitted was downstream of the call that never returned, and an in-memory phase
  would have died in exactly the freeze it needed to describe. It is the init-path twin of the
  teardown watermark, and the two are read at the same places. Note the watermark only fires for a
  NEW context, which is why `app.init.timeout` exists alongside it — a suspension that resumes the
  same context keeps its `sc.run_id` and is invisible to the durable record.
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
- **A new friend's first dot comes from an INTRODUCTION, not from the wire.** A sealed envelope is
  readable only by the recipients it was sealed for, so nothing already published can be opened by
  someone who did not exist when it went out, and a new friend would otherwise wait for the next
  scheduled publish (p90 92 min parked). `DrainEngine::publish_introduction` re-seals
  `last_known_fix` once. Do NOT put a fix on the pairing `Accept` alongside the profile record: the
  Accept is sent BEFORE `is_complete()`, so a peer who rejects or times out would still have your
  position, and a fix outside the ratchet is the one payload FORWARD-SECRECY.md exists to protect.
  It is driven from ACKNOWLEDGE rather than `ready` because the reveal screen still offers REJECT,
  and it deliberately does not advance `last_published_slot` (the cadence is what the stash reads),
  does not write `last_state` (pairing says nothing about having parked), and is not battery-
  suspended (one envelope, at a moment the user chose).
- **The PAIRING wire is the opposite, and the rule above does not carry over to it.** `PairMsg` is
  ed25519-signed, and `pair_signing_bytes` signs a re-encode of the DECODED struct — so a peer that
  does not know a newly appended field drops it, reconstructs different bytes, and fails the
  signature. Appending is a BREAKING change there however tolerant postcard is. Bump `PAIR_ALPN`
  (not only `PAIR_WIRE_V`) so the mismatch fails at negotiation rather than as "your friend's phone
  refused the pair". v4 carries the sender's signed `ProfileRecord` on the `Accept`, which is why a
  persona now arrives WITH the pair instead of after a separate iroh-docs dial; the profile ticket
  still rides along, and is now only how later edits arrive.
- **A pair is complete when `finalize` says so, not when the decision bits agree.** `is_complete()`
  goes true the instant a local accept latches; `finalize` — which installs the ratchet, ingests the
  handed profile record and raises `Ready` — runs after, and can still decline, because a wire
  `Reject` is authoritative and `best_effort_notify` folds the peer's stance response back into the
  session. So `send_accept_and_finalize` finalizes BEFORE that dial when the session is already
  bilateral, and `result_data` is gated on `result_emitted` rather than `is_complete()`. Handing the
  app a result from inside that window produced a friend with no ratchet behind it, whose every
  publish would drop with `no_session`. Do not "simplify" either gate back to `is_complete()`.
- **Nothing that is merely LEAVING a screen may cancel a pair that completed.** The pairing screen's
  abandonable list comes from a snapshot and is always at least one poll behind the handshake, which
  is longer than a pair takes to complete; `standDownPairing` therefore re-reads each session from
  native and spares the terminal ones. A completed pair is torn down by `removeFriend`, deliberately,
  never as a side effect of navigation.
- **A node appearing in the log is not necessarily a REBIND, and assuming it is will cost you a
  day.** Three different things build an endpoint and they are not distinguishable by eye:
  `rebindNode` (deliberate; always `shutdown`s first, so Rust logs `shutdown: taking inner lock`), a
  clobber (a second JS context calls `createNode`, which routes through `clearRuntime()` and logs
  NOTHING), and a duplicate (a second context builds a second LIVE node on the same identity — two
  endpoints answering for one endpoint id, so a dial lands on whichever the relay or BLE picked and
  a pairing session on one node is unknown to the other). Read them apart with the table in
  `infra/otel/README.md`: `node.construct`'s process-wide `node.ordinal` (above 1 is the alarm, and
  it WARNs), whether a shutdown was logged, and how many JS contexts emitted `node.create`. On
  2026-09-13 five constructions with zero shutdowns were misread as rebinds for most of a session.
- **`ensureBleReady` rebuilds the whole iroh endpoint whenever `bleAvailable()` is false**, because
  BLE attaches at CONSTRUCTION and can never be attached to a live node afterwards — which is also
  why `node.start` records `ble_attached`, fixed for that node's whole life. The rebuild drops every
  pairing session and leaves a new endpoint with no paths for seconds, and it sits on the Bump
  button. Before changing it, check whether `node.rebind{trigger="ble-arm"}` is actually firing on
  phones whose Bluetooth is fine: attach is asynchronous, so "not yet" and "no" are the same answer
  at that call site. It was NOT the cause of the 2026-09-13 pairing failures.
- Guard newly added native exports anyway (`typeof mod.configureTelemetry === 'function'`). Not
  because of bindgen now, but because a phone can be running an older binary than the JS bundle.

## Store screenshots

**`just store-shots` photographs the REAL app, not a mockup** — there is no iOS simulator on the
machine this was built on, so it drives the web target (react-native-web + CanvasKit + the
`rust-wasm` build of the location core) in Chrome over a hand-rolled CDP client
(`scripts/cdp.ts`), at the exact pixel sizes App Store Connect demands: iPhone 6.9" 1290×2796 and,
while `ios.supportsTablet` is true, iPad 13" 2064×2752. It then frames each capture with a
headline in the app's own typefaces. Same argument as `map-shot.ts` one level up: use the wasm
path we already ship rather than a device we cannot run.

- **The demo people and the demo walk are compiled out, not switched off.**
  `@/features/dev/fixtures` resolves to `index.noop.ts` unless
  `EXPO_PUBLIC_SCREENSHOT_FIXTURES=1`, by the same `metro.config.js` rule that strips
  `@/features/dev/telemetry`. `scripts/check-release-telemetry.mjs` fails CI if a store profile
  sets the variable — and unlike the telemetry keys there is NO `ACKNOWLEDGED` escape for it,
  because there is no version of a shipping build where fabricated friends on a real user's map
  is a trade-off worth recording.
- **Fixtures are inputs, never outputs.** They go in as `Friend` records, `LocationFix` points and
  a `TrailStorage` decorator, and everything shown is then derived by the shipping code — the
  presence states ("here now", "parked here 2 hr", "out of contact 5 hr"), the distances and the
  marker styling all come out of `buildFriendPresence`. Nothing fakes a rendering, and
  `withFixtureTrailStorage` decorates `selfRange` only, so no invented point is ever persisted.
  Exploration needs its own seam because `createLiveExplorationSource` scans persisted storage
  rather than the trail the UI holds.
- **The walk is tuned between two failure modes and both are easy to re-break.** Too spread out
  and the reveal is a thread that lights nothing (900 points over 1.1 km left coverage at 3%);
  too many points and the one-awaited-`recordFix`-per-point fold starves the JS thread badly
  enough that no tile finishes and the capture comes out blank (3000 did). 400 points inside a
  450 m radius is the middle.
- **Scenes navigate by CLICKING, never by `Page.navigate`.** A navigation reloads the document,
  which reboots CanvasKit, the wasm node and first-run onboarding. Getting back from the pairing
  sheet or the settings modal uses each screen's own dismiss control, never `history.back()` —
  neither pushes a history entry, so going back walks off the origin and kills the CDP target.
- **Anything gated on a native capability photographs its unavailable state.** The pairing screen
  on web renders "PAIRING UNAVAILABLE — installed build required", which is true of a browser and
  nonsense in an iOS listing, so the pairing scene drives the one-time LINK instead — same
  handshake, same crypto, and it works here. Check any new scene for this before trusting it.
- Tiles need `scripts/tile-proxy.ts` in front of the tileset: `/bundle/v2` already sends CORS and
  exposes its `ETag` (the stream decoder refuses a bundle without a strong one), but the coarse
  `/{z}/{x}/{y}` path sends no CORS headers at all. The proxy is transparent on purpose — an
  earlier allowlisting version broke the map twice, once by dropping the ETag and once by
  re-declaring `content-encoding` on a body `fetch` had already decoded.

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
