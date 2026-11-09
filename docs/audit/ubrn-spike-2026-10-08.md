# Spike: generating the JS bindings from the crate with `uniffi-bindgen-react-native`

_2026-10-08. Follows step 5 of `boundaries-2026-10-08.md`. Reproduce with `scripts/spikes/ubrn/`._

**Verdict: it works, and it is the right shape.** From the crate's existing `#[uniffi::export]`
annotations, with no Rust changes, `ubrn` 0.31.0-6 produced a typed TypeScript API for the whole
`LocationNode` / `Subscription` / `NodeHost` surface in under three seconds, the API typechecks
under `tsc --strict`, and TypeScript drove the real `.so` end to end on Linux: start, a
TypeScript-implemented `FixListener` called back from Rust, `ingestFix` through the native
`DrainEngine`, a typed `FixRejection.Stale`, heartbeat, own-log drain, watermarks and seal report.
Two runtime bugs and one packaging gap were found, all with workarounds. What is still unverified
is the one thing this host cannot do: an Expo prebuild of the generated turbo module.

## What was run

| Step                                               | Result                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `cargo build` of the crate on Linux (debug cdylib) | ok, `libiroh_location.so`, UniFFI 0.31.2 (ubrn pins 0.31)                 |
| `ubrn generate napi bindings --library`            | 2.9 s; `iroh_location.ts` 10,212 lines + `-ffi.ts` 2,214                  |
| `ubrn generate jsi bindings --library`             | same API file (10,178 lines) + 11,940 lines C++ + 1,206 header            |
| `ubrn generate jsi turbo-module`                   | 546 lines of glue: podspec, CMake, gradle, 42-line Kotlin, 65-line ObjC++ |
| `tsc --strict` over the generated API              | 0 errors (after the `@ubjs/node` type augmentation below)                 |
| `bun run spike/call.ts` (pure fns, errors, object) | pass                                                                      |
| `bun run spike/engine.ts` (start, listener, drain) | pass                                                                      |

Measured through the Node runtime (libffi, so an upper bound for Hermes JSI):

| Call                                      | Cost  |
| ----------------------------------------- | ----- |
| sync `node.endpointId()`                  | 8 µs  |
| async `node.isStarted()`                  | 26 µs |
| `node.start([], "", false, true, false)`  | 55 ms |
| `sub.ingestFix(...)` accepted + published | 25 ms |

## What the generated surface looks like

```ts
export type LocationFix = { lat: number; lon: number; accuracyM: number; headingDeg: number;
  ts: bigint; state?: number; publishedDeltaS?: number };
export type IngestOutcome = { accepted: boolean; rejection?: FixRejection; enqueued: number;
  published: number; reached: number; pending: number; slotsSkipped: number;
  overflowDropped: number; suspended: boolean };
export enum FixRejection { Inaccurate, Stale, ImplausibleJump }
export enum PairState { Handshaking, Pending, Verifying, LocalAccepted, PeerAccepted, Complete, Rejected, Failed }
export interface FixListener {
  onFix(author: Uint8Array, seq: bigint, fix: LocationFix, backfill: boolean, via: string, viaPeer: string | undefined): void;
  onOpaque(author: Uint8Array, seq: bigint): void;
  onStatus(status: string): void;
}
export interface LocationNodeLike {            // 90 methods
  start(relayUrls: Array<string>, relayAuthToken: string, relayEnabled: boolean, ipEnabled: boolean,
        bleEnabled: boolean, asyncOpts_?: { signal: AbortSignal }): Promise<void>;
  subscribe(topic: Uint8Array, bootstrap: Array<string>, listener: FixListener, ...): Promise<SubscriptionLike>;
  setRecipientKeys(keys: Array<RecipientKey>, ...): Promise<void>;
  readLatestRatchetedEvents(...): Promise<Array<RatchetEvent>>;
  lastSealReport(...): Promise<SealReport | undefined>;
  endpointId(): Uint8Array;
  // ...
}
export function nodeHost(): NodeHostLike;      // acquireApp / acquireBackground / release / restart / snapshot
```

Errors are classes with a `tag` and `inner`, and an `instanceOf` per variant:

```ts
try {
  endpointIdFromTicket('not-a-ticket');
} catch (e) {
  LocationError.Decode.instanceOf(e); // true; e.tag === "Decode"; e.inner === ["bad endpoint ticket"]
}
```

Against the audit's findings: finding 1 (six hand-mirrored copies) collapses to one, the Rust
records. Finding 4's `?`-as-versioning is replaced by `uniffiEnsureInitialized`, which checks the
contract version and every function's API checksum at load, the same check the Swift and Kotlin
bindings already do. Finding 7 (stringly errors) is half solved by the mechanism: variants are
typed; the payloads are still `String` until the Rust enum changes. Finding 1's native fix
decoders that default to zero cannot exist: records are read from a Rust-written buffer.

## What it would delete and what would remain

Gone from the node path: the 38 `*Dict` / `*Map` mappers, the hand-written `IrohLocationApi`
interface, the `declare class`, the `Proxy` around `start`, the web stub, and every
`AsyncFunction("...")` in both Expo modules that only forwards to the node. `NodeHost` itself is
exported, so `createNode` / `restartNode` / `nodeHostSnapshot` go through the generated bindings
too (same process-wide host, same `.so`).

Remaining in the Expo module, because it is platform-local and not Rust's: the background
runtime controls (`startNativeBackground`, `setBackgroundCadence`, `nativeBackgroundState`, wake
ledger), device secrets in the keychain, notification permission, `bluetoothRadioState`,
MetricKit diagnostics, Android's network callback and multicast lock. About fifteen functions, and
none of them marshal a Rust record.

Swift and Kotlin UniFFI bindings stay for `BackgroundLocationRuntime.swift` and
`NativeBackgroundRuntime.kt`, which are Rust clients in their own right; `ubrn build --native-bindings`
generates them in the same run.

## Bugs and gaps found

1. **`@ubjs/node` 0.31.0-6 ships an `index.d.ts` that declares only `UniffiNativeModule`**, while
   its `lib.js` also exports `FfiType` and `resolveLibPath`, which the generated `-ffi.ts`
   destructures. `tsc` fails on the plumbing file until augmented (`ubjs-node-augment.d.ts`). Node
   only; the JSI flavour imports from `@ubjs/react-native`. Report upstream.
2. **A TypeScript-implemented trait object inside `Option<>` cannot be lowered.**
   `ownSubscription(bootstrap, listener: Option<Arc<dyn FixListener>>)` fails with "Cannot lower
   this object to a pointer": the optional converter serialises through `FfiConverterObject`'s
   pointer path, which rejects a foreign handle. The same listener passed as a direct argument to
   `subscribe(topic, bootstrap, listener)` works and receives callbacks. Workaround on our side:
   make listener parameters non-optional (they are never absent in practice). Report upstream.
3. **`publish_inner` is on the generated surface.** It is a non-`pub` `async fn` inside the
   `#[uniffi::export] impl Subscription` block, and UniFFI exports it anyway. It is therefore
   already in the Swift and Kotlin bindings today. Move it out of the exported impl.
4. **`ubrn generate ... --library` conflicts with `--config`** and reads `uniffi.toml` from the
   crate directory via `cargo metadata` of the cwd. The repo will carry
   `modules/iroh-location/rust/uniffi.toml` with a `[bindings.typescript]` table; the Kotlin and
   Swift generators ignore it.

## Migration costs the spike makes concrete

- **`u64` is `bigint`.** `ts`, `seq`, `epoch`, `intervalMs`, `nowMs`, `expiresAtMs`, every
  timestamp and counter. The JS app uses `number` throughout. Two options: a thin adapter at the
  one place the generated module is imported, or newtypes in Rust (`MillisSinceEpoch(u64)`,
  `Seq(u64)`) with `[bindings.typescript.customTypes]` mapping them to `number`, which is lossless
  below 2^53 and matches what Swift (`Double`) and Kotlin (`Long`) already do by hand. The newtype
  route is the one that also documents the unit.
- **`Vec<u8>` is `Uint8Array`** (`strictByteArrays = true`; `ArrayBuffer` otherwise). Every id
  and key the app treats as hex. Finding 1's recommendation, hex `String` fields on the records
  that JS reads, removes most of these; the rest get a `hex()` helper once.
- **Flat enums are numeric TS enums** (`FixRejection.Stale === 1`), not the string unions the app
  has today. Comparisons and switch statements change; persisted values must not store the
  number. Data-carrying enums and errors are tagged unions with a `_Tags` companion.
- **`Option<T>` is `T | undefined`**, never `null`. The app's `string | null` fields change.
- **Every async method takes a trailing `{ signal: AbortSignal }`**, which is a bounded-await
  primitive the service currently hand-rolls seven times.

## Not verified here

- **Expo prebuild coexistence.** The turbo-module scaffold is ordinary autolinking (a podspec, a
  `build.gradle`, a `ReactPackage`), and nothing in it conflicts with `expo-modules-core`, but no
  document says so and this host cannot run `expo prebuild` against a native toolchain. The
  next step is a dev-client build with the generated package alongside the existing Expo module.
- **Hermes JSI timings.** The numbers above are libffi on Node; JSI should be faster, not slower.
- **Upstream health.** Pinned to UniFFI 0.31 (matches this crate); the 0.32 upgrade is open; the
  Android turbo-module compatibility test is disabled in upstream CI; three named React Native
  adopters plus Ferrostar and LiveKit.

## Recommended next step

A branch that adds `modules/iroh-location/rn/` generated by `ubrn build ios|android --and-generate
--native-bindings` from `scripts/eas-build-pre-install.sh`, with the generated TS committed and
checked like `check-bindings`, and `location-sharing.ts` pointed at it for `createNode` / `start`
/ `subscribe` / `readLatest` only. If the dev client links and those four calls work on a phone,
the rest of the node API follows mechanically and the audit's step 5 is done.
