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
- **A backgrounded iOS app is not a suspended one, and that is where the CPU went.**
  `UIBackgroundModes: ["location"]` plus `allowsBackgroundLocationUpdates` means iOS does not
  suspend this process while sharing is on, so a swiped-away app keeps every JS timer it had
  running indefinitely. MetricKit recorded **41 CPU exceptions in 7 days** across three iPhones on
  builds 78-83, each reporting `cpu_time_ms = 48000` over a 49-60 s window — that constant is iOS's
  `MXCPUExceptionDiagnostic` threshold, not a measurement — and the flattened stack is the
  `NSThread`/`CFRunLoop` React Native runs JS on. `onBackground` now stops the pairing poll, and
  `pollingSuspended` is a SECOND guard because `onPairReady`, `rebindNodeInner` and `armBump` all
  re-arm the loop and none of them knows the app is in a pocket. The Skia loops pause through
  `useIsAppActive()`. Note `event-log.ts` stamps a row `background` from `AppState` alone, so
  "background entries" in the journal conflate a cold wake with a mounted app in a pocket — the
  latter was most of them. **Do NOT also stop the heartbeat timer**: it is what fills slots for a
  parked phone while the app is mounted. Android grew a native parked heartbeat of its own in
  v2.15.0 (idempotent per slot, so the overlap is free), but iOS's only runs on the coarse stream
  once the native runtime owns the node — which a mounted app does not. The bump loop needs no guard
  either; it bounds itself against `isBumpActive()` inside a two-minute window a human opened.
- **The background budget is measured now, not inferred.** Every earlier claim about it —
  `SHIP_MAX_BATCHES = 3`, `HEADLESS_TEARDOWN_TIMEOUT_MS`, "throttled into silence" — came from
  reading silence after the fact. `BackgroundWakeLedger.swift` samples `CLOCK_PROCESS_CPUTIME_ID`
  and `CLOCK_MONOTONIC` around each wake into durable UserDefaults counters, surfaced as `wake.*`
  on the next `device.health`. Counters and not spans, for the reason `init-watermark.ts` exists: a
  wake that ends before it can ship cannot describe itself, and on a JS-free wake there is no
  journal to write to. `recordDeviceHealth` is the ONLY caller allowed to reset them — a
  take-and-reset inside the read lets two records in one minute take half the counts each.
  `wake.cpu_ms_max` near 48000 is the exception threshold, not a high reading. `bg.refresh.expired`
  covers the other half: `BGTask.expirationHandler` is the only notice iOS gives, and nothing
  listened to it, so a refresh cut short and one never scheduled both left a span that never ends.
  **Read `wake.cpu_ms_max` against `wake.wall_ms_at_cpu_max`, and the total by thread group.**
  `cpu_ms_js` / `_rust` / `_otel` / `_main` / `_other` sum to `cpu_ms_total`; they exist because
  on 2026-09-29 an iPhone reported 88 s in one window and nothing could say whether that was 88 s
  in a minute (an exception) or across twenty (7%), or whose it was. `rust` is ONE thread: UniFFI's
  tokio runtime is async-compat's current-thread `async-compat/tokio-1`, iroh's endpoint included.
- **`bg.wake` and `bg.backfill` do not exist.** They went dead when capture moved into Rust — the
  location wake is native and emits no JS span at all. Six e2e scenarios asserted them,
  `background-location-e2e.sh` gated its PASS on `bg.wake > 0` so it could never pass, and two
  Grafana panels counted them behind `or vector(0)`, which renders a reassuring **0** forever. Use
  `device.health` (with its `wake.*`) and `bg.refresh`. Check for this shape before trusting any
  tile: a span name nothing emits looks exactly like a fleet that is fine.
- **The native drain lost four things the JS engine did, and each now has an owner.** Audited
  2026-09-30 against v1.6.1. (1) `GateState.last_published_slot` is a slot INDEX; `gate::regrid`
  translates it through time when the interval changes (`slot_interval_ms` records the grid it was
  minted on) and `due_slots` treats an index ahead of the clock as unrecorded — without both,
  lengthening the interval stopped publishing for good. The interval is no longer a setting at all
  (`SHARE_INTERVAL_MS`). (2) The replica keeps one slot per author, so `own_log.rs` records every
  published position and JS drains it (`takeOwnPublished`) into the own trail; without it a stretch
  published with no JS alive reached the trail and the exploration map as one point.
  (3) `lastSealReport().droppedPeers` + `isDesynced`/`resyncCount` feed the per-friend health
  badges (`refreshSessionHealth`); they were written only by the JS publish path. (4)
  `engine.ingest` / `engine.heartbeat` are emitted by `DrainEngine` itself, with the JS
  `sc.drop_reason` spellings (`publish::drop_reason`), so JS-free wakes are observable.
- **Never hold a `CLBackgroundActivitySession`.** Apple documents it as "an object that manages a
  visual indicator", and on our `Always`-authorized iPhones it still put a persistent location
  indicator on screen: v2.16.0/v2.17.0 held one for as long as sharing ran and brought back what
  7550186 had removed in July, while keeping every background process resident (the CPU the native
  rewrite existed to give back). It was added because on 2026-09-30 a background-RELAUNCHED iPhone
  ran ~90 s per wake and was suspended mid stop-dwell (180 s), so it never declared `parked` —
  `allowsBackgroundLocationUpdates` keeps a process running only for updates started in the
  foreground. A relaunched process now finishes the stop through events instead: a `CLVisit`
  arrival (`didVisit`, which also relaunches a terminated app) and `NativeRefreshTask`, the
  `BGProcessingTask` the retired JS refresh used to be, which confirms a dwell the wake windows
  starved (`confirmDwelledCandidate`), heartbeats and pulls. Its identifier must stay in
  `BGTaskSchedulerPermittedIdentifiers` (`app.json`). `location.stop_via` (`dwell` / `visit` /
  `refresh`) says which one parked a phone. Android's `NativeBackgroundRuntime` pulls friends too
  (`pullFriendFixes`), floored at 5 min.
- **One drain run at a time, per node (`publish::DrainLock`).** "Idempotent per slot" held only for
  SEQUENTIAL callers: UniFFI polls each foreign call on the host's thread, so concurrent
  `heartbeat_fix`/`ingest_fix` calls both found the slot due, and two drains peeked the same outbox
  head while the first was on the wire. On 2026-10-01 a parked iPhone (kept alive by the since-removed activity
  session, coarse deliveries arriving in clusters, one `Task` heartbeat each) sealed 3-4 envelopes
  per slot. The lock waits at most `DRAIN_LOCK_WAIT` and then runs unserialized, because a duplicate
  is cheaper than a hung push silencing the phone. `tests/drain.rs` "Concurrent runs" covers it.
- **The iOS location runtime reports itself as `location.runtime`, because nothing else can.** On
  2026-10-01 an iPhone drove 88 minutes with its process alive (Loki) and no location reaching Rust
  (zero `engine.*` spans), and nothing could say why: the Swift state machine wrote only `NSLog`,
  and `device.health` is JS-emitted, which a background-relaunched process never boots.
  `LocationRuntimeReporter` emits a `pulse` every 5 min from a background timer — deliberately not
  from the delivery path, which falls silent exactly when it matters — probing the main thread
  first (`main_stalled` when it cannot answer), plus a span per transition, visit, fence exit and
  Core Location error. Anything new the runtime decides goes on it; see `infra/otel/README.md`.
- **A heartbeat states what it knows about motion, and only a proven stop says `parked`.**
  `heartbeat_fix` takes `parked: Option<bool>` (`publish::Motion`): `Some(true)` from a confirmed
  dwell, a visit arrival, a parked coarse tick or Android's no-delivery ticker; `Some(false)` from a
  stop just left (retracts a standing `parked` to `no-fix`); `None` from any clock — the mounted
  JS timer, a refresh while moving — which keeps whatever the last evidence stamped. It used to stamp
  `parked` unconditionally, and on 2026-10-02 the JS timer published four hours of "parked here"
  from an iPhone whose runtime was in `moving`.
  The converse binds `ingest`: a fix is not motion evidence either. An accepted fix within its own
  accuracy plus 100 m of where the stop was declared (`GateState::parked_at`, mirroring Swift's
  `considerDeparture`), or a fix the gate refused, keeps `parked`; only leaving that radius or
  `Some(false)` ends it. On 2026-10-07 opening the app at a stop sealed two `live` envelopes, the
  process was then suspended, and friends read "out of contact" about a phone sitting still.
- **A position Core Location hands back is not a capture.** `didUpdateLocations` drops a location
  whose timestamp is not newer than the last one delivered: on 2026-10-02 one fix came back every
  30 s for 73 minutes, the first two went out `live` 5-9 minutes stale, and the rest read as a
  phone receiving fixes. A redelivery may still confirm a pending dwell, and otherwise drives a
  no-claim heartbeat at most once a minute, since on a JS-free process nothing else ticks while
  `moving`.
- **There is ONE node per process, and only `NodeHost` builds it** (`rust/src/host.rs`). The
  mounted app (every JS context, through the module's `createNode`/`shutdown`) and the native
  background runtime (`acquireBackground`) take LEASES on it; the last one out shuts it down,
  bounded, on its own task. This replaced two nodes racing for the process-wide store claim and
  every rule that grew up around that race — an iOS owner flag, a claim backoff on both platforms,
  a sink gate, a bounded `handOverNativeBackground` — which existed in three hand-written copies
  with no tests on the two platform copies, and Android was missing one: on 2026-10-03 its service built a
  node in the seconds between the app's `createNode` and `start()`, the app's start met
  `AlreadyOpen`, and a Pixel 10 spent 13.7 h unable to pair ("NOTHING FOUND"). The contract is in
  the module docs and every rule is a test (`src/host/tests.rs` against fakes, including every
  five-operation sequence against a reference model; `tests/node_host.rs` against real claims).
  Rules that matter at the call sites: the app always gets a node (adopt, or REPLACE a different
  identity — never refused); the background runtime never builds over anyone and never mints an
  identity; a settings change is `restartNode`, never `shutdown` + `createNode` (that would only
  return your own lease and adopt the same node back); and platform code caches the node by
  `generation()` and must not `destroy()` a superseded handle (another call may be inside it).
  The own topic is a SLOT on the node (`own_subscription`): a second `subscribe` adopts the live
  one rather than opening a second receive loop, and listeners are swappable so a departing app's
  are detached without stopping what the background runtime publishes through. Every drain on a
  node is serialized (`drain_lock`), because two holders can now both drive one. The sink
  (`eventSink` / `appIsWired()`) is ROUTING, not ownership: a wired app gets the capture because it
  runs the sampling policy and draws the own marker, and both paths end in `ingestFix` on the same
  node. `LocationNode::shutdown` releases every store even when the router fails to close — it
  used to return early with all of them still claimed.
- **A node reopens its namespaces from `state_dir`, never from memory or the cache directory**
  (`rust/src/ns_book.rs`). Until 2026-10-06 a friend's docs namespace was open only if JS had called
  `importDocTicket` on that run, and the own namespace was remembered by an id file beside the
  replica. On 2026-10-05 a Pixel's node started by the native runtime hit both at once: it
  reconciled only its own namespace (so its leader's session restart reached the stash and never
  the Pixel), and the same start rotated its own namespace, because `Docs::open` reports a missing
  namespace as an `Err` and `init` answered every `Err` by minting one — so the iPhone read a
  namespace nobody wrote again. Only a re-pair recovered it. The book holds the own namespace
  SECRET (a wiped replica comes back as the SAME namespace) and every imported friend namespace with
  its read ticket. Rules: an unreadable book fails the start rather than starting over; a
  namespace that is listed but fails to open fails the start rather than being replaced; removing a
  friend must call `forgetDocTicket` / `forgetProfileTicket`, or every later start reopens them.
- **The stash grant belongs to the node** (`rust/src/stash.rs`, span `stash.grant`). The stash keeps
  its namespace list in memory and forgets it on every restart (2026-10-03 18:39, 2026-10-06 03:56);
  JS re-registered only on a foreground launch, so a phone the native runtime drove stayed
  unregistered. The node grants on every start, on a stash opt-in change, per imported friend, and
  (floored, 10 min) when an upload reports `untracked` slots — what a stash that forgot us looks
  like. JS's `syncStashGrants` calls `grantStash()` and keeps its HTTP only for older binaries.
- **`IrohBackgroundBootstrap.swift` runs before React, and must return `true`.**
  `ExpoAppDelegateSubscriberManager` reduces `willFinishLaunchingWithOptions` with
  `?? false || result` and short-circuits to `true` only when NO subscriber implements it; once ours
  does, returning anything else breaks universal-link cold launches, and `applinks:streetcrypt.id`
  is live. `willFinishLaunching` is the only usable hook — `subscriberDidRegister` runs from `+load`
  before `main()`, and a subscriber's `didFinishLaunching` runs after the app delegate's own, which
  is where `startReactNative` already happened. It arms the Core Location ladder but deliberately
  does NOT take ownership, so a foreground launch is byte-for-byte unchanged.
- **`BackgroundLocationRuntime.shared` is built by the launch bootstrap, on main, on every launch.**
  Core Location delivers to the run loop of the thread that created the manager, and a thread
  without one receives nothing and says nothing. Left to JS, the first touch was
  `handOverNativeBackground` — an `AsyncFunction`, so a Swift concurrency worker — and every
  foreground-launched process was armed, authorised, `running` and deaf: on 2026-09-29 an iPhone
  drove for twenty minutes with the app in the background, took zero deliveries, and heartbeated
  its launch position. Its SLC wakes went to the same dead thread, so iOS had no reason to relaunch
  it until the process was reclaimed. `location.delegate_on_main` in `device.health` must read
  `true`; `location.wake_reason` stuck on `seed` with `last_wake_age_ms` climbing on a moving phone
  is what `false` looks like.
- **`start()` claims every durable store before it touches the network, and must keep doing so.**
  Until 2026-09-28 the native runtime's node had never started on either platform: `start_stored`
  read its config from a store only `start` opens, so it was `NotStarted` on every fresh node and
  a JS-free wake dropped everything it captured. Fixing that alone was not enough — with the claims
  taken after the endpoint bind, a refused native start (the app holding the stores) bound a second
  endpoint on our identity and then HUNG on the app's open blob/docs stores. `tests/native_start.rs`
  covers both, and bounds the refusal so that regression fails instead of hanging.
- **A local simulator build needs `just bindgen-ios` when the XCFramework is older than the
  bindings.** CI regenerates `modules/iroh-location/ios/generated/*` on every Rust API change but
  cannot build the XCFramework, so a checkout can carry today's bindings against a weeks-old
  binary. The symptom is not obvious: two `iroh_locationFFI.h` headers disagree and the Swift fails
  with "missing argument for parameter 'onSync'" inside generated code you did not touch.

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
  retries rather than waiting again — the in-process equivalent of the force-quit. A REJECTED init
  (`app.init.failed`) gets the same retry: clearing the latch was never enough, because the
  provider does not remount and so nothing ever asked again.
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
  **The declaration goes out on the delivery that CONFIRMS the stop**, not on a later tick: a
  background-relaunched iOS process is suspended between deliveries, so the parked coarse stream's
  next tick may never come, and on 2026-09-29 waiting for it made the last envelope before the
  silence read `live`.
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
- **Session recovery runs in the native drain, not in JS, and only the leader restarts.**
  `DrainEngine::drain` calls `PublishSink::recover` → `recover_sessions` once per drain (every
  friend, watchers included); its policy is `restart::run_pass`, which `tests/restart_protocol.rs`
  runs verbatim. FORWARD-SECRECY.md §4.6 (revision 4) is the design: the lower endpoint id is the
  pair's **leader** and is the only side that ever restarts a session — against the follower's
  newest signed **prekey** (published in the follower's control record in its `rsy/<author>`
  slot, rotated daily, never used if older than 72 h) — and the restart header rides every wrap
  for that follower (envelope v4) until the leader opens something under the new session. The
  follower adopts it from any one envelope, or **primes** it natively without consuming the fix
  (`SessionManager::prime`), and asks for a restart by putting a request in its control record.
  Records keep the last two replaced sessions for decryption only. This replaced a two-sided
  resync exchange that had no convergence guarantee: on 2026-10-02 it split a working
  iPhone/Pixel pair (one side applied, the other had stopped looking), and on 2026-10-03 the
  follower's process died holding the ephemeral the leader then applied against, after which only
  a re-pair helped. Rules that keep it convergent, each with a test: a miss is a NEW envelope we
  cannot open (re-reads are `SessionError::Replayed`); a follower adopts only a restart newer than
  the session it is on, and the leader makes each one strictly newer; a lapse alone never makes
  the leader restart (§4.5 — a seized phone must not keep tracking by doing nothing), only a
  request does; nothing about a restart lives only in memory. A pair that exchanges nothing for
  `T_lapse` lapses on both sides and heals through the follower's request — a Pixel 9 spent
  2026-09-22..29 publishing 785 envelopes sealed for nobody before recovery ran natively at all.
  An envelope with every recipient dropped is not a publish: it does not stamp
  `last_published_at` or count as `reached`. `publishResync`/`pollResync`/`clearResync` survive
  only as binding-compatible shims.
- **The ratchet acceptance window is sized by how long a READER can stay away.** A sender's
  chain resets only when the reader opens something (on iOS, only while the app is mounted), and
  every tick spends two positions because the gossip and docs lanes each call `next_wraps`. At
  512 (`DEFAULT_ACCEPT_WINDOW`) that ran out after ~21 h: on 2026-10-09 an iPhone whose owner had
  not opened the app for 25 h was 570 positions behind its friend's Pixel, read every new
  envelope as "no wrap in this envelope belongs to us", and showed the Pixel as a day stale until
  the leader restart healed it. It is `2^17` now. Do not shrink it to bound work: the walk is one
  hash per position and the counter is signed, so only a friend can ask for one.
- **A pair is complete when `finalize` says so, not when the decision bits agree.** `is_complete()`
  goes true the instant a local accept latches; `finalize` — which installs the ratchet, ingests the
  handed profile record and raises `Ready` — runs after, and can still decline, because a wire
  `Reject` is authoritative and `best_effort_notify` folds the peer's stance response back into the
  session. So `send_accept_and_finalize` finalizes BEFORE that dial when the session is already
  bilateral, and `result_data` is gated on `result_emitted` rather than `is_complete()`. Handing the
  app a result from inside that window produced a friend with no ratchet behind it, whose every
  publish would drop with `no_session`. Do not "simplify" either gate back to `is_complete()`.
- **The node-wide `inner` lock must never be held across an await, and there is a test that says so.**
  `LocationNode::inner` is the single lock behind every JS-visible native call, so a guard held
  across an `await` does not slow one call — it stops the phone: the pairing poll that opens the SAS
  gate, the BLE reads, `transport_diagnostics`, the publish path and the inbound `PairProtocol`
  handler all queue behind it. Take the handles with `self.live().await?` (or `live_opt()`) and let
  the guard go. `tests/node_lock.rs` scans the source for the violation, because the failure is a
  future that never completes and there is nothing a runtime assertion can wait for. It has been
  introduced twice: `import_profile_ticket` on 2026-09-10 (`pairing.poll` spans of 47-131 s), and
  `import_doc_ticket` + `subscribe` on 2026-09-17, where ACKNOWLEDGE on a long-distance pair wedged
  BOTH Pixels — the acknowledge never returned, `pool.friend_added` never landed, and
  `app.previous_run` recorded three force-quits in three minutes.
- **Every await on the pairing wire is bounded, and ACKNOWLEDGE waits for none of them.**
  `dial_exchange` splits `PAIR_CONNECT_TIMEOUT` from `PAIR_EXCHANGE_TIMEOUT` because the second is
  the PEER building its reply inside our read; `PairProtocol::accept` is bounded end to end and
  lingers on `conn.closed()` only for `PAIR_CLOSE_LINGER`; the optional docs reads on an `Accept`
  and finalize's ticket imports are bounded by `PAIR_DOCS_TIMEOUT` and degrade to empty, which
  every consumer already treats as "not published yet". An unbounded await here is an unbounded
  JS promise, which is a pairing screen stuck on "REACHING THEM" with no error and no end state.
  On the JS side `decideDiscovery` adopts the friend, emits, and hands the subscribe / introduction
  / trail-sync to `connectNewFriend` WITHOUT awaiting it — a friend is a local decision, and nothing
  the network does may stand between a human saying "keep this one" and the app having kept them.
  `awaitFriendWiring()` is what shutdown and the tests use instead.
- **`our_endpoint_ticket` pays the relay wait once per NODE, not once per message.** Four messages
  are built to reach the SAS gate (two per side) and each side's reply is built inside the other's
  dial, so an `Endpoint::online()` wait that is paid per message serializes across both phones.
  Measured 2026-09-17 at a bar: 44 s from arming Bump to the visual gate, which reads as slow BLE
  and is not BLE. `endpoint_was_online` latches; `pair.endpoint_ticket`'s `latched` is how you see
  it. The FIRST wait is still the full budget — that is where the invite-address argument lives.
- **Pairing telemetry is spans, not `tracing::info!`.** Loki's OTLP ingest keeps the message and
  drops the fields, so the core's `connect_ms` / `exchange_ms` / `ticket_ms` existed and answered
  nothing on the one night they were needed. `pair.dial`, `pair.handshake`, `pair.inbound`,
  `pair.accept`, `pair.finalize`, `pair.build_msg` and `pair.endpoint_ticket` are spans; the JS half
  adds `pair.initiate`, `pair.acknowledge` and `pair.connect_friend`. The span map is in
  `infra/otel/README.md`. Anything new on this path goes in as a span.
- **`peer.contact` is the only span that says two PHONES talked, and it must stay honest.** Every
  other delivery span says an envelope moved; a friend's dot updating via the stash hours later
  looks identical to two phones awake at once. `contact.rs` emits one per exchange with a named peer
  at the four places one is visible (gossip send to a recipient neighbour, gossip receive, a FINISHED
  push, a pull that DELIVERED entries), tagged `contact.role` (`friend`/`stash`/`other`) and, on
  receive, `contact.from_author`. Do not emit it for a peer that was merely dialled, or for a
  neighbour dropped from the seal — a contact we cannot observe is how the dashboard row starts
  lying. Its dimensions are in `collector-config.yaml`; see `infra/otel/README.md`.
- **One poll driver.** `pollPairingOnce` is driven by exactly one re-armed timer whose cadence comes
  from `pairingPollDelay()`; Bump's interval only watches for its own window closing. Two 300 ms
  drivers running the same drain produced 6-7 `pairing.poll` per second on 2026-09-17, each one six
  crossings of the bridge taking the same pairing locks the handshake needs.
- **A phone that believes it is sharing and cannot must say so.** `device.health` carries
  `sharing.muted` (`foreground-permission` / `background-permission` / `location-task-stopped` /
  `no-recipients`), and `use-location-sharing` derives `permission-denied` from the LIVE
  `backgroundAccess` snapshot in both directions rather than latching whatever `startBackground`
  read once at launch. A reinstall resets iOS location authorization to "While Using", which is how
  a phone paired at a bar on 2026-09-17, delivered one introduction fix while the app was open, and
  went silent for the night while its owner believed she was sharing.
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
