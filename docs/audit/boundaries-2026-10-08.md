# Boundary audit: Rust ⇄ native ⇄ JS contracts

_2026-10-08, against `main` at 8d87323 (v2.17.0)._

This is a read of the three-language seam in `modules/iroh-location` and its one JS consumer,
`src/features/social/net/location-sharing.ts`, asking a functional programmer's questions: is
there one type per concept, are the functions total, are the sum types sum types, and does each
piece of logic live in exactly one place. The short answer is that the Rust core is in good shape
and the bridge around it is not: the same API is hand-written six times, dead variants have piled
up on every layer, and the JS service still carries a second copy of a pipeline the Rust
`DrainEngine` replaced.

Nothing here is a bug report. Every item is a place where the code is doing more than the
behaviour needs, and the recommendations are ordered so each one lands as its own green PR.

## The shape of it

| Thing                                                     | Count             |
| --------------------------------------------------------- | ----------------- |
| Rust crate (`rust/src`, excluding tests)                  | 27k lines         |
| `lib.rs` alone (the UniFFI surface)                       | 5,934             |
| Hand-written copies of the bridge API                     | 6                 |
| Methods on `IrohLocationApi`                              | 121               |
| ...of which marked optional (`?`)                         | 73                |
| `typeof mod.x === 'function'` guards in JS                | 57                |
| ...in `location-sharing.ts` alone                         | 36                |
| `LocationSharingService` fields / methods / lines         | 130 / 184 / 4,990 |
| Record→dict mapper functions, Swift + Kotlin              | 19 + 19           |
| UniFFI exports reachable from no binding                  | 22                |
| Rust `publish` / `docs_write` variants for two operations | 12                |
| Orphan JS modules (no importer outside tests)             | 11                |
| Browser build: wasm crate + web stub + `.web.tsx` files   | 759 + 505 + 704   |

The six copies of the contract: the `uniffi::Record` structs in `lib.rs`; the `*Dict()` mappers in
`IrohLocationModule.swift`; the `*Map()` mappers in `IrohLocationModule.kt`; the
`IrohLocationApi` interface in `IrohLocation.types.ts`; the `declare class IrohLocationNativeModule`
in `IrohLocationModule.ts`, which restates every method of the interface it `implements`; and the
web stub. Every record added to Rust is typed by hand four more times, and the drift that
produces is already visible (next section).

## Findings

Ranked by how much code each one removes per unit of risk.

### 1. The contract is hand-mirrored, and the mirrors disagree

Each Rust record crosses the bridge through a hand-written Swift dict mapper and a hand-written
Kotlin map mapper, then is re-typed in TS. Concrete drift this has already produced:

- **`IngestOutcome.rejection` has three spellings.** Rust's own spans say `fix-inaccurate`
  (`gate::FixRejection::as_str`). Swift ships `String(describing:)`, which is `inaccurate` /
  `implausibleJump`. Kotlin ships `.name.lowercase()`, which is `implausiblejump`. The JS
  consumer (`location-engine.ts:202`) stores whichever arrives.
- **Endpoint ids are `Vec<u8>` in some records and hex `String` in others.** `IncomingFix.author`,
  `PairEvent.peer_endpoint_id`, `BumpResolution.endpoint_id` are bytes; `RecipientKey.endpoint_id`,
  `RatchetEvent.via_peer`, and every `peer_endpoint_hex` argument are strings. So each native
  mapper decides field-by-field whether to call `dataToHex`, and the Rust side decodes hex in some
  methods and not others.
- **Sum types leave Rust as strings.** `BumpResolution.status`, `BlePeer.phase`,
  `TransportAddressDiagnostic.kind`, `RatchetEvent.kind` are `String` in Rust and string-literal
  unions in TS, so the compiler checks the TS side against nothing. `PairState` and
  `PairEventKind` are proper `uniffi::Enum`s, and both native modules then hand-write a
  `pairStateName` switch to turn them back into strings.
- **The fix decoders are partial and default to zero.** `locationFix(from:)` (Swift) and
  `locationFixOf` (Kotlin) read `fix["lat"] ?? 0`. A fix dict missing a key is ingested as a
  position at 0°N 0°E with 0 m accuracy rather than refused. Decoding should be total: a
  `Result`, or a throw with the field name.
- **Timestamps and sequence numbers cross as `Double` on iOS and `Long` on Android**, and are
  `u64` in Rust. A seq above 2^53 is not a real concern; the point is that one concept has three
  representations and nobody wrote that down.

**Recommendation.** Make the bridge type the Rust type. Two workable shapes:

- (a) Keep UniFFI records but give them bridge-ready field types: ids and keys as hex `String`,
  enums as `uniffi::Enum`, and no `Vec<u8>` on anything JS sees. Then the Swift/Kotlin mappers
  become structural (an Expo `Record` conformance, or a generic reflection-free `toDict` per
  record, generated by a small script from the same source) and the TS types are emitted from the
  Rust structs with `ts-rs` or `typeshare` into `IrohLocation.types.ts`, with a CI check that the
  committed file matches, exactly like `check-bindings` already does for Swift and Kotlin.
- (b) Serialise once in Rust: every record crosses as a JSON string (`serde_json` is already a
  dependency) and JS parses it against the generated type. The native layers become pure
  pass-through. This is the smaller change but costs a parse per call, which only matters on
  `readLatest` and `pollPairEvents`.

Either way the `declare class` duplicate goes: it exists so `requireNativeModule<T>` has a class
type, and `NativeModule<IrohLocationEvents> & IrohLocationApi` is the same type without the
restatement.

### 2. Twelve method names for two operations

`publish`, `publish_traced`, `publish_null`, `publish_null_traced`, `docs_write`,
`docs_write_traced`, `docs_write_null`, `docs_write_null_traced`, `docs_write_ratcheted`,
`docs_write_null_ratcheted`, `docs_write_ratcheted_traced`, `docs_write_null_ratcheted_traced`
are a boolean product (`null` × `traced` × `ratcheted`) over `publish_inner` and
`docs_write_ratcheted_inner`. The `_traced` axis exists because the traceparent is optional, and
UniFFI 0.31 passes `Option<String>` fine. The `_null` axis is a payload variant. `push_trail` /
`push_trail_budgeted` is the same shape one more time.

Four of the twelve (the un-ratcheted `docs_write*`, envelope v2) are called from no binding; only
Rust tests reach them.

**Recommendation.** One method each:

```rust
#[derive(uniffi::Enum)]
pub enum Payload { Fix(LocationFix), Null { ts: u64 } }

pub async fn publish(&self, seq: u64, payload: Payload, recipients: Vec<String>,
                     traceparent: Option<String>) -> Result<Vec<String>, LocationError>
pub async fn docs_write(&self, subscription_id: String, seq: u64, payload: Payload,
                        recipients: Vec<String>, traceparent: Option<String>) -> ...
```

The JS side collapses the same way: `publish`/`publishNull` and `docsWrite`/`docsWriteNull` become
one each. See finding 3 for why most of these then disappear entirely.

### 3. The JS publish pipeline is a second engine, kept alive by one button

`LocationSharingService.publishFix` does live gossip, durable docs write, the null-fix watcher
lane, `noteDroppedRecipients`, `runResyncDriver`, a shadow `seq` counter (`seq`, `nativeSeq`,
`reserveSeqAhead`, `adoptNativeSeq`, `nextSeq`) and a watermark stamp. That is about 350 lines of
service code, four bridge methods on three layers, three `seq` exports, and the five resync
exports. `DrainEngine::drain` in Rust does every one of those things natively, including §4.6
session recovery, and AGENTS.md already records `publishResync`/`pollResync`/`clearResync` as
"binding-compatible shims".

`publishFix` has exactly one caller: `forceLocationPush`, the manual "locate now" path. Everything
else goes through `ingestFix` / `heartbeatFix`. The resync driver therefore runs only when a human
presses that button, and `sessionVerdicts` is populated only then.

**Recommendation.** Add `force: bool` to `ingest_fix` (skip the quality gate and the slot cadence,
publish now), point `forceLocationPush` at it, and delete: `publishFix`, `publishNullFix`,
`runResyncDriver`, `noteDroppedRecipients`, `persistDropCounts`, the shadow seq machinery, and on
every layer `publish`, `publishNull`, `docsWrite`, `docsWriteNull`, `nextSeq`, `currentSeq`,
`seedSeq`, `isDesynced`, `resyncCount`, `publishResync`, `pollResync`, `clearResync`. Session
health badges already read `lastSealReport().droppedPeers` (AGENTS.md item 3 of the native-drain
audit), so nothing user-visible depends on the JS verdicts. The `sessionVerdicts` /
`SessionHealth` type can be derived from the seal report in one pure function.

This is the single largest deletion available and it removes a whole class of "which pipeline
published that envelope" questions from the telemetry.

### 4. Optional methods are a versioning mechanism, and the version cannot happen

73 of the 121 API methods are optional, and 57 `typeof mod.x === 'function'` guards exist to
honour that, 36 of them in the service. The stated reason (AGENTS.md: "a phone can be running an
older binary than the JS bundle") requires over-the-air JS updates. `expo-updates` is not a
dependency. The JS bundle ships inside the binary; the only way to run newer JS on an older native
build is a stale local dev client, which deserves one loud error at `createNode`, not 57 silent
degradations.

The `?` also conflates three unrelated facts, and the TS type cannot tell you which:

- platform absence (`nativeBackgroundState`, `takeBackgroundWakeStats`, `nativeBackgroundAuthorized`,
  `takeCrashDiagnostics`, `resetBackgroundWakeStats` exist only on iOS);
- the web stub (23 methods that throw or return empty);
- methods that exist nowhere: **`handOverNativeBackground` and `nativeNodeOwner` are implemented on
  neither platform.** `native-node.ts` still has a `handOverNativeBackground()` function with its
  own `node.handover` span and a 10 s bounded wait around a method that no binary has.

Two `Record<string, unknown>` returns (`nativeBackgroundState`, `takeBackgroundWakeStats`) are
the same problem one level down: `device-health.ts` loops over the bag and prefixes whatever keys
it finds, so a renamed Swift key silently becomes a new dashboard column.

**Recommendation.**

- Make `IrohLocationApi` fully required. Split what is genuinely per-platform into a
  `PlatformApi` the adapter exposes as `mod.ios?.` / `mod.android?.` with a discriminant, so a
  call site says which platform it means instead of guessing from `typeof`.
- Export one `native_api_version(): u32` from Rust. The adapter compares it to the bundle's
  expected value once in `tryGetIrohLocation` and throws with "rebuild the dev client" on mismatch.
- Delete `handOverNativeBackground`, `nativeNodeOwner`, and the JS handover path. `restartNode`
  is the documented replacement already.
- Make the two health bags `uniffi::Record`s (`LocationRuntimeHealth`, `WakeLedger`). Rust's
  `location_runtime.rs` already names the fields. Android then gets the same record for free
  instead of a different shape.

### 5. `LocationSharingService` is eight services

130 private fields, 184 methods, 4,990 lines, one class. The concerns are visible from the field
list alone: pairing sessions and SAS, invites and codes, Bump, discoveries, trail sync and push,
peer reachability, background lifecycle and native handover, profile backfill, transport
diagnostics polling, delivery and transport config mirroring, stash grants, telemetry. 48
`getTelemetry()` calls are woven through all of it.

The same combinators are hand-rolled repeatedly inside it:

- single-flight (`transportDiagnosticsInFlight`, `bumpResolveInFlight`, `pollInFlight`,
  `trailSyncInFlight`, `inviteMutation`, `poolPersistChain`, `shutdownPromise`, `resyncInFlight`):
  eight copies of "if a run is in flight, join it";
- bounded await: seven `Promise.race` sites across the net layer, two of them in `native-node.ts`
  alone, each with its own `(timer as unknown as { unref?: () => void }).unref?.()` incantation
  (twelve of those in `src/`);
- "poll, diff, emit if changed" (`emitIfPairingChanged`, `transportDiagnosticsChangeCount`,
  `lastPairingSig`, `lastPollErrorSig`, `stableStringify`).

**Recommendation.** Not a rewrite. Extract along the seams the tests already cut:
`pairing.test.ts` is 2,268 lines against a pairing surface that is already ~1,500 lines of the
service and touches almost none of the trail or background fields. Pull `PairingSession` out
first, as a pure reducer over `(state, PairEvent | PollResult | UserAction) -> (state, Effect[])`
in the style `pool.ts` already uses for the friend pool, with the service running the effects.
Then trail, then background. Write `singleFlight`, `withTimeout`, and `changedSince` once in
`src/lib/` and delete the copies as each extraction touches them.

### 6. The motion state machine is in Swift, mirrored in Rust, and absent on Android

`BackgroundLocationRuntime.swift` is 1,649 lines: moving / stopped / candidate states, dwell
confirmation, departure radius, stop-anchor fences, candidate persistence in `UserDefaults`,
cadence selection. Rust `gate.rs` mirrors one piece of it (`parked_at` and `PARKED_HOLD_RADIUS_M`
mirror `considerDeparture`, by comment). Android's `BackgroundLocationService.kt` has a
stationary ticker and no dwell logic. Three of the last four AGENTS.md entries are motion-state
bugs (2026-09-29, 10-02, 10-07), and the Swift machine has no tests.

The tri-state `Motion` crosses the FFI as `Option<bool>` and is decoded back into the enum on the
other side (`Motion::from_parked`).

**Recommendation.** Make the machine a pure Rust function and the platforms sensor adapters:

```rust
pub enum MotionEvent { Delivery(LocationFix), Visit { arrived: bool, at: LocationFix },
                       FenceExit, Tick, Refresh }
pub enum Command { SetCadence(Cadence), ArmFence(LocationFix, f64), ClearFence,
                   Ingest(LocationFix), Heartbeat(Motion) }
pub fn step(state: MotionState, ev: MotionEvent, now_ms: u64) -> (MotionState, Vec<Command>)
```

Swift and Kotlin feed events and execute commands. Both platforms then park identically, the
machine gets the same model-based tests `host/tests.rs` gives `NodeHost`, `heartbeat_fix` takes
`Motion` as a `uniffi::Enum`, and `gate::parked_at` stops being a mirror of something it cannot
see. This is the largest item and should go last, but it is the one the field incidents keep
pointing at.

### 7. Errors are strings, so JS classifies them with regexes

`LocationError` has four variants, three of them `(String)`. JS then decides what happened by
matching the message: `isClaimRefusal` (`/already open|already claimed|writer claim|AlreadyOpen/i`),
`headless-runtime.ts:316` (`/ForegroundServiceStartNotAllowed|not allowed to start/`),
`use-location-sharing.tsx:177` (`/permission|location access/i`), `location-sharing.ts:2193`
(`/did not answer|could not reach/i`). A reworded message in Rust or Swift silently changes the
retry policy in JS.

**Recommendation.** A real sum type (`AlreadyOpen`, `NotStarted`, `Timeout { ms }`,
`PermissionDenied { scope }`, `Unreachable { peer }`, `Decode`, `Crypto`) with a stable `code`
string that the native layers put in `Exception.code`, and JS switches on `error.code`.

### 8. Smaller contract warts

- **`start()` is patched with a `Proxy`.** Native takes five positional arguments (relay URLs,
  token, three toggles); TS takes `TransportConfig`; `withRelayConfig` wraps `start`,
  `setTransportConfig` and `restartNode` in a `Proxy` to splice the build-time relay config in.
  Native should take one `StartConfig` record and the adapter should be a function.
- **Parallel arrays where a record exists.** `setRecipientKeys(endpointsHex[], recvPublicsHex[])`
  while Rust has `RecipientKey`; `setDeliveryConfig(tickets, url, psk)` while TS has
  `DeliveryConfig`; `setSharingRecipients(recipients[], watchers[])`. Pass the record.
- **Anonymous return types** on `lastSealReport` and `publishWatermarks`, and an inline
  `{ level, charging, lowPower }` battery object typed in place twice, while
  `background/types.ts` has `BatteryState`.
- **`LocationFix` and `NativeLocationFix` are the same interface twice**, with a field-by-field
  `toNativeFix` copy between them, and `FIX_STATE_*` is declared in three places. Generated types
  (finding 1) remove both.
- **Event payloads are stringly.** `OnStatusEvent.status`, `OnSyncEvent.status`,
  `OnNativeFixEvent.reason` / `.state` are `string` while Swift holds them as
  `enum MotionState: String` and `enum WakeReason: String`. The health snapshot uses snake_case
  keys; everything else on the bridge is camelCase.
- **Dead exports beyond the publish family.** `read_latest`, `read_latest_ratcheted`,
  `begin_session`, `complete_session`, `has_session`, `sync_latest_via_only`, `new_with_data_dir`,
  and the eight `mesh_*` functions are reachable from no binding. The mesh ones are future work
  for `docs/mesh/DESIGN.md` and belong behind the `cli` feature or in `tests/` until a caller
  exists; the rest can go.
- **24 `*_MS` constants** scattered across `net/` with no single place that says what the
  cadences are relative to each other.

### 9. Dead JS left behind by the native cutover (#147 / #148)

Capture, cadence, the parked heartbeat, friend pulls and node ownership all moved native in
v2.15 to v2.17. The JS that used to do those jobs was not removed with them; it was guarded. Each
item below is reachable from no non-test code on the current binaries, or exists only to serve a
binary that no longer ships.

**Compatibility paths for binaries that predate `NodeHost`.**

- `nativeAdoptsNode()` / `nodeAdoptionSupported` / the `nativeRuntimeAdoptsNode` probe. The probe
  answers "does this binary have `NodeHost`". Every binary since #148 does. Its `false` branch in
  `rebindNodeInner` is `shutdown()` + `createNode()` + `startNativeBounded()`, which is the exact
  sequence AGENTS.md now forbids ("a settings change is `restartNode`, never `shutdown` +
  `createNode`"). Make `restartNode` required and delete the probe, the cache, and the branch.
- `isClaimRefusal` and the handover-and-retry inside `startNativeBounded`. A store claim cannot
  be refused under `NodeHost` ("the app always gets a node... never refused"). The bounded wait
  stays; the regex, the retry, and the `handOver` dependency go. `native-node.test.ts` (244 lines,
  added by #147) is mostly tests of this dead branch.
- `handOverNativeBackground()` in `native-node.ts`, its `node.handover` span, and
  `refusalReason()`'s `nativeNodeOwner?.()` check in `headless-runtime.ts`: both call methods no
  platform implements (finding 4).

**The JS publish pipeline** (finding 3): `publishFix`, `publishNullFix`, `runResyncDriver`,
`noteDroppedRecipients`, `persistDropCounts`, the shadow `seq` (`seq`, `nativeSeq`,
`reserveSeqAhead`, `adoptNativeSeq`, `nextSeq`), `droppedRecipients`, `sessionVerdicts`,
`resyncInFlight`, `RESYNC_ATTEMPT_LIMIT`, and the `RatchetDropReason` / `SessionHealthSnapshot`
types that only they populate. One caller, the manual locate button.

**Headless entry points with no caller.** `ingestFixesHeadless` was the expo-location task
consumer; capture is native, so nothing calls it. Delete with its test.

**Public service methods no screen or hook calls**: `createPairCode`, `pairNearby`,
`refreshBackgroundAccess`, `selfCard`, `deliveryState`, `stashState`, `transportState`. Only
tests reach them. `awaitFriendWiring` is a documented test seam and can stay, named as one.

**A dev knob with no writer.** `loadIosLocationBenchmarkProfile` reads a `__DEV__`-only KV key
(`sc.dev.iosLocationProfile`) that nothing in `src/` or `scripts/` writes. `benchmarkProfileOverrides`,
`IosLocationBenchmarkProfile`, the key, and both call sites are dead.

**Orphan modules** (no importer anywhere outside tests): `pair-link-action.tsx`,
`stash-setting-row.tsx`, `cryptid-discovery-celebration.tsx`, `profile-onboarding-preview.tsx`,
`locator-label.tsx`, `map/core/region-session.ts`, `map/core/hash.ts`, and four Expo-template
leftovers (`web-badge`, `external-link`, `ui/collapsible`, `hint-row`). The
`net/background/index.ts` barrel is imported by nothing.

**The JS engine layer is the next cutover, not a deletion.** `location-engine.ts` (337 lines),
`cadence-controller.ts` (162), `sampling-policy.ts` (143), `battery-source.ts` (101) and about
1,000 lines of their tests survive the cutover, but look at what they still do. `engine.ingest`
computes a battery-only `SamplingDecision`, passes the fix and the battery to `ingestFix` (where
the Rust gate makes the real accept/reject call with that same battery), and feeds the decision to
`cadence-controller`, which calls `setBackgroundCadence`, which the native runtime then overrides
with its own motion-derived cadence (`applyMovingCadence` / `applyStoppedCadence`). What is left
is: a ninth hand-rolled single-flight (`exclusive`), a state snapshot (`lastAcceptedFix`,
`pending`, `decision`) the UI reads, and `onPublished → refreshTrailFromReplica`. The native
runtime already ingests directly whenever the app is not wired. Let it always ingest, make
`onNativeFix` a notification that carries the `IngestOutcome`, move the battery→accuracy-tier
table into Rust as one more output of the motion machine (finding 6), and the "engine" becomes an
event listener. That is the first step of finding 6, and it retires two owners of cadence.

**Android's JS background tasks are now mostly duplicates of its native service.** Since 8abb3b1
(2026-09-18) iOS does not boot React Native on a wake, so `refresh-task.ts` (182),
`revive-task.ts` (444), `headless-runtime.ts` (409), `register-task.ts`, `native-runtime-owner.ts`
and `teardown-watermark.ts` run on Android only. The 45-line header of `revive-task.ts` still
describes it as the "iOS revive tripwire". What they do there: `runBackgroundRefreshHeadless`
self-heals the foreground service, then boots a whole `LocationSharingService` headless to run
`heartbeatNativeFix` + `syncTrail`, then tears it down under a 10 s watchdog. Android's native
`BackgroundLocationService` now has a stationary heartbeat ticker and `pullFriendFixes` (floored
at 5 min), `START_REDELIVER_INTENT` covers process kills, and the boot receiver covers reboot. The
two jobs not duplicated natively are the geofence-triggered self-heal (the one legal window to
start a foreground service from the background) and `recordDeviceHealth`. Keep exactly those,
preferably as a native geofence `BroadcastReceiver` that starts the service with no JS at all, and
delete `runRefresh`, `ingestFixesHeadless`, `teardownBounded`, and the `native-runtime-owner`
session chain. That removes the "boot a 5k-line service inside a background task" shape, which is
the shape behind three of the incidents AGENTS.md records (the stranded teardown, the init-latch
freeze, the 19-hour silence).

### 10. Deprecate wasm, and decide separately about the web target

The browser build exists to run the location core relay-only in a tab. Nothing ships there.
What it costs:

- `modules/iroh-location/rust-wasm/` (759 lines, its own `Cargo.lock`, a second iroh dependency
  set that must track the native one), and the `#[path]`-inclusion of `crypto.rs` and `docs.rs`,
  which pins both files to compile for `wasm32-unknown-unknown` with `default-features = false`.
- `IrohLocationModule.web.ts` (505 lines): 23 methods that throw or return empty. This is the
  third meaning of `?` in finding 4, and removing it makes the API-required change there cleaner.
- The CI `wasm` job in `ci.yml` (lines 63-108): a second Rust toolchain, `wasm-pack`, `binaryen`,
  and three caches, on every run.
- `just web`, `just build-wasm`, the `wasm` asset extension in `metro.config.js`,
  `wasm-assets.d.ts`, the `web/` build output, and the relay-token-in-the-bundle caveat in the
  module README.
- Six `.web.tsx` overrides (704 lines), ten `Platform.OS === 'web'` branches across six files,
  `web-badge.tsx`, and `react-native-web` / `react-dom` in `dependencies`.

**What it breaks, and this is the only thing to plan around:** `just store-shots`, `map-shot.ts`,
`island-preview.ts`, `shot-server.ts`, `cdp.ts` and `tile-proxy.ts` drive the **web target** in
Chrome, because the machine they were built on had no iOS simulator (AGENTS.md, "Store
screenshots"). The map scenes need CanvasKit and tiles, not the node; the friends scenes take
fixtures as `Friend` records and `LocationFix` points, not the node. The one scene that needs the
wasm node is pairing, which drives the one-time LINK handshake through the wasm crypto because
BLE pairing photographs as "PAIRING UNAVAILABLE" in a browser.

So there are two sizes of this:

- **wasm only, now.** Delete `rust-wasm/`, the CI job, `build-wasm`, the `#[path]` sharing, and
  replace `IrohLocationModule.web.ts` with a 20-line stub that reports the node unavailable.
  `store-shots` keeps working for every scene but pairing; the pairing screenshot either moves to
  the field-soak Mac's simulator (`scripts/field-soak` means one exists now) or is retaken from a
  device. Nothing else in the app depends on the browser node.
- **the web target too, later.** Once the screenshot pipeline runs on a simulator, the six
  `.web.tsx` files, the `Platform.OS === 'web'` branches, `react-native-web`, `react-dom`, `just
web` and the CDP tooling go with it. Do not do this half: a web target with no node is still a
  working map, and the screenshot tooling is real work that should be re-homed before it is
  deleted.

The first size is a day and is pure deletion. It should go in step 1.

## What the field does about this seam

Surveyed 2026-10-08: projects with a Rust core under Swift, Kotlin and JavaScript clients, and
what each did about the hand-mirrored-types problem.

**Generate the JavaScript bindings from the same UniFFI annotations.**
[uniffi-bindgen-react-native](https://github.com/jhugman/uniffi-bindgen-react-native) (Mozilla
and Filament, [announced December 2024](https://hacks.mozilla.org/2024/12/introducing-uniffi-for-react-native-rust-powered-turbo-modules/))
reads the `#[uniffi::export]` / `uniffi::Record` / `uniffi::Enum` this crate already has and emits
TypeScript types, the C++ JSI glue, and a Turbo Module that installs them. Records cross by value,
objects by reference, enums and tagged unions map to TS unions, errors to typed exceptions, and
async works in both directions. The generated native glue is Objective-C++ and Java; no Swift or
Kotlin is written for the node path at all. Listed adopters: `@unomed/react-native-matrix-sdk`,
`@fressh/react-native-uniffi-russh`, ChessTiles; [Ferrostar](https://stadiamaps.github.io/ferrostar/architecture.html)
(a navigation SDK with the same shape as this app: Rust state machine, Swift/Kotlin platform
layer for sensors and UI, React Native on top) and [LiveKit](https://github.com/livekit/rust-sdks/pull/1374)
use it. Current release 0.31.0-6 pins UniFFI 0.31, which is the version this crate is on. The same
tool generates a `wasm-bindgen` crate from the same annotations, so a browser build would never
again be a second hand-written crate. Caveats found: pre-1.0; the UniFFI 0.32 upgrade is
[open](https://github.com/jhugman/uniffi-bindgen-react-native/issues/449); the Android turbo-module
compatibility test is [disabled in CI](https://github.com/jhugman/uniffi-bindgen-react-native/issues/475);
nothing documents Expo prebuild coexistence (it is ordinary autolinking, so it should, but nobody
has written it down); and one project [declined it](https://github.com/remcostoeten/skriuw/pull/404)
because synchronous Rust functions become blocking JSI calls, which does not apply to an async
tokio API like this one.

**Generate the types, hand-write the transport.** [1Password's typeshare](https://github.com/1Password/typeshare)
emits Swift, Kotlin and TypeScript types from `#[typeshare]` Rust structs; the call layer stays
theirs. [tauri-specta](https://github.com/specta-rs/tauri-specta) generates typed `invoke` wrappers
and event types for Tauri's single IPC channel. [Bitwarden](https://contributing.bitwarden.com/architecture/sdk/)
runs both patterns side by side: the Secrets Manager SDK uses a JSON `run_command` so each language
binding is one method, while the Password Manager SDK that backs the real mobile apps uses typed
UniFFI clients. The command-envelope pattern (one `dispatch(json)`) is real, and it is what teams
choose when they need many thin bindings fast, not what the teams that own their mobile apps chose.

**Discipline for a hand-written bridge, if one stays.** Mozilla's
[ads-client architecture rules](https://searchfox.org/mozilla-mobile/source/application-services/components/ads-client/ARCHITECTURE.md):
FFI-exposed types live in their own module with a prefix, convert to internal types through
`From`, and a change to an FFI type is a breaking change with a deprecation plan, versioned as
`V1`/`V2` types rather than optional methods. Mozilla's own
[reason for UniFFI](https://hacks.mozilla.org/2023/08/autogenerating-rust-js-bindings-with-uniffi/)
is that hand-written wrappers "were responsible for many serious bugs" and undermined the point of
Rust. Skriuw's Expo module makes every native call an `AsyncFunction` and resolves a
`{ ok, value | error }` envelope because a rejected Expo promise carries only a code and a message,
which is a narrower, better-justified version of finding 7.

**Where logic lives.** [Crux](https://redbadger.github.io/crux/) (Red Badger) is the framework
version of finding 6: the core is side-effect free, the shell calls `process_event(Event) ->
Vec<Request>`, `handle_response(id, Response) -> Vec<Request>` and `view() -> ViewModel`, and
types for Swift, Kotlin and TypeScript are generated from the Rust definitions. Photoroom moved
all editing logic, conflict resolution and the undo stack into such a core across iOS, Android
and web ([their series](https://www.photoroom.com/inside-photoroom/building-live-collaboration-in-rust-for-millions-of-users-part-1));
Proton is reported to use it. Photoroom's [part 3](https://www.photoroom.com/inside-photoroom/building-live-collaboration-in-rust-for-millions-of-users-part-3)
is the relevant warning: replacing a whole view model per update makes reactivity hard, and they
ended up diffing the view model in Rust and shipping patches. `SharingSnapshot` with
`stableStringify` is the same problem one size smaller.

### What this changes in the recommendation

The command-envelope proposal is withdrawn. It solves the mirror problem by discarding the
typed surface, and the field's answer is to keep the typed surface and generate the other side.

- **Transport: UniFFI typed methods, with the TypeScript bindings generated.** Spike
  `uniffi-bindgen-react-native` against this crate for one day: generate into a sibling package,
  confirm `expo prebuild` links it, confirm the async methods and the `with_foreign` listener
  traits come through, and measure `readLatest` / `pollPairEvents` round trips. If it holds, the
  node API leaves the Expo module entirely: the 38 mappers, the TS mirror, the `declare class`
  and the web stub are all generated or gone. The Expo module keeps only what is genuinely
  platform-local (background runtime control, keychain, permissions, MetricKit, wake ledger),
  which is the Ferrostar split.
- **Fallback if the spike fails:** typeshare-style generated types, Mozilla's FFI-type module
  discipline, and Skriuw's result envelope for the error channel only.
- **Contract rules that hold either way**, all from the sources above: FFI types in one module
  with `From` conversions; sum types as enums, never strings; one id type with one encoding;
  errors as a flat enum with stable codes; versioned types instead of optional methods; every
  cross-boundary call async.
- **Architecture: take Crux's shape, not the crate.** This core owns a tokio runtime and an iroh
  endpoint; it is an engine, not a side-effect-free reducer, and `DrainEngine` over a
  `PublishSink` trait is already the right shape for that. Apply `step(state, event) ->
(state, commands)` to the two machines that lack it (motion, pairing orchestration), and keep
  the snapshot-plus-diff reactivity in mind when the view model grows.

## What is right, and should be the pattern

- `pool.ts`: pure functions over an immutable friend-pool value. Every extraction in finding 5
  should look like this.
- `gate.rs` / `publish.rs`: `DrainEngine` over store traits with fakes in tests, `due_slots` and
  `regrid` as pure functions.
- `host.rs`: one owner, every rule a test, including the five-operation model check.
- The append-only, `Option`-only, end-only wire rule and the frozen `StoredFix`. Keep both
  exactly as they are; finding 1 is about the bridge, not the wire.
- `index-parity.test.ts` and `check-bindings`: a committed artifact checked against its source.
  Finding 1 adds the TS types to that list.
- `location_runtime.rs` naming the runtime's health fields in Rust even though Swift emits them.
  Finding 4 just finishes the job.

## Suggested order

Each step is its own PR and leaves `just check-all` green.

1. **Delete what nothing calls.** Rust: four un-ratcheted `docs_write*`, two `read_latest*`,
   three session methods, `sync_latest_via_only`, `new_with_data_dir`, `publishResync`,
   `clearResync`; mesh behind `cli`. TS/JS: `handOverNativeBackground`, `nativeNodeOwner`, the
   `NodeHost` compat paths (`nativeAdoptsNode`, `isClaimRefusal`'s retry, the `shutdown` +
   `createNode` branch), `ingestFixesHeadless`, the seven uncalled service methods, the iOS
   benchmark profile, the eleven orphan modules, the `background/` barrel. **wasm**: the crate,
   the CI job, `build-wasm`, the `#[path]` sharing; `IrohLocationModule.web.ts` becomes a stub.
   CI regenerates the bindings. No behaviour change.
2. **Collapse the boolean-product names** with `Payload` and `Option<String>` traceparent;
   `push_trail` becomes the budgeted one.
3. **`force` on `ingest_fix`**, delete the JS publish pipeline, shadow seq, and resync driver.
   This is the step that removes the most JS.
4. **Version gate at `createNode`**, `IrohLocationApi` fully required, platform split, delete
   the 57 guards. Typed health records.
5. **Spike `uniffi-bindgen-react-native`** (see "What the field does"). On success the node API
   moves out of the Expo module and the 38 mappers, the TS mirror, the `declare class` and the
   web stub are generated or deleted; on failure, generated types plus the FFI-type discipline.
   Ids as hex strings in Rust and total decoders either way.
6. **Typed errors** with codes; delete the regex classifiers.
7. **Android background: native geofence receiver + native device health**, then delete
   `runRefresh`, `teardownBounded` and the `native-runtime-owner` chain. Fix the `revive-task.ts`
   header either way.
8. **Extract `PairingSession`** as a reducer; introduce `singleFlight` / `withTimeout` /
   `changedSince`; then trail.
9. **Native runtime always ingests; the JS engine becomes a listener.** Battery tiers move into
   Rust. This is the first half of the motion machine.
10. **Motion machine into Rust.**
11. **Retire the web target** once `store-shots` runs on a simulator.

Steps 1 to 4 are mechanical and each is a day or less. Step 5 is the one worth designing before starting,
because it decides what every later record looks like.
