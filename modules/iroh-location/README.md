# iroh-location (local Expo module)

streetCryptid's decentralized, end-to-end-encrypted friend location core. Wraps
**iroh 1.x** (QUIC transport) + **iroh-docs 0.101** / **iroh-blobs 0.103** (one replicated
namespace per author, synced live and by range reconciliation) and per-recipient crypto (Rust
`rust/`), exposed to React Native via **UniFFI → Expo Modules API**. iroh-gossip is linked only
because iroh-docs' live engine runs on it; the app opens no gossip topic of its own.

> Design of record: [`docs/social/ARCHITECTURE.md`](../../docs/social/ARCHITECTURE.md).

## Why this module exists

`iroh-ffi` 1.0 (the official Swift/Kotlin bindings) exposes **only iroh core** —
`iroh-gossip`/`iroh-docs`/`iroh-blobs` are out of scope. So we ship our own Rust crate
and UniFFI bindings.

## Layout

```
rust/                 cargo crate `iroh-location` (crypto is unit-tested; iroh glue in lib.rs)
  src/crypto.rs       envelope: ChaCha20-Poly1305 content + per-recipient wraps + ed25519 sign
  src/docs.rs         the replica: own + friend namespaces, live sync, push, pull, prune
  src/lib.rs          UniFFI domain API (LocationNode, ReplicaListener, pairing, profiles)
  src/bin/uniffi-bindgen.rs
ios/                  IrohLocationModule.swift + IrohLocation.podspec (+ generated/ + xcframework)
android/              build.gradle + IrohLocationModule.kt (+ src/main/jniLibs/ + generated Kotlin)
src/                  TS API (types + native/web accessors)
rust-wasm/            browser WASM crate (relay-only replica node; neither reads nor publishes)
web/                  wasm-pack output imported by `IrohLocationModule.web.ts`
index.ts             public JS entry (imported as `iroh-location`)
```

The app talks to this module through `getIrohLocation()` / `tryGetIrohLocation()`;
native resolves `requireNativeModule('IrohLocation')`, while web resolves
`IrohLocationModule.web.ts`. The TS type contract lives in `src/IrohLocation.types.ts`
and is mirrored by the app's service.

## What runs where

- `cargo test` (in `rust/`) verifies the crypto envelope plus the pairing protocol: nonce
  commit/reveal, transcript-derived visual SAS, session-peer binding, mutual confirmation,
  mismatch/timeout handling, and simultaneous nearby initiation. **This is fully portable and the
  security core is validated here.**
- Everything below (cross-compile, dev client, on-device A→B) requires **macOS/Xcode**
  (iOS), **Android NDK**, and **physical devices**.

## Build pipeline

The generated Android `.so` files and iOS XCFramework are git-ignored. EAS runs
`scripts/eas-build-pre-install.sh` to rebuild the correct platform artifact from the committed Rust
source before each cloud build.

### 0. Toolchain

```bash
# Rust + mobile targets
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \
  aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cargo install cargo-ndk cargo-make
# Android NDK installed; ANDROID_NDK_HOME set. Kotlin 2.2+.
```

### 1. Verify the crate

```bash
cd modules/iroh-location/rust
cargo test           # crypto envelope tests (should pass everywhere)
cargo build          # compiles the iroh + docs glue against the pinned versions
```

### 2. iOS — XCFramework + Swift bindings

> **Prerequisite: full Xcode** (not just Command Line Tools) — the iOS SDKs
> (`iphoneos`/`iphonesimulator`) are required. Verify with
> `xcrun --sdk iphoneos --show-sdk-path`; if it errors, run
> `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and
> `sudo xcodebuild -license accept`.

Run `just bindgen-ios` to regenerate the tracked Swift/C bindings and assemble the
git-ignored XCFramework. The recipe fixes the deployment target at iOS 16.4, builds the
device arm64 archive, combines arm64 and x86_64 simulator archives into one universal
simulator slice, and packages both slices:

```bash
just bindgen-ios
```

For EAS iOS builds, `eas-build-pre-install` runs
`scripts/eas-build-pre-install.sh` before prebuild and CocoaPods. The hook installs the
Rust toolchain when needed, regenerates the Swift/FFI bindings from the current Rust API,
builds the App Store device slice with the iOS 16.4 deployment target used by Expo SDK 57,
and creates the git-ignored XCFramework. Regenerating is required because UniFFI aborts on
first use when a generated API checksum does not match the linked archive. The podspec
propagates the Rust archive's `Network`, `CoreBluetooth`, and `SystemConfiguration`
dependencies to the app linker. Local device and simulator builds still use
`just bindgen-ios`.

CI closes the last gap: the `native` job in `.github/workflows/ci.yml` runs
`scripts/generate-uniffi-bindings.sh all` on Linux, and if the tracked Kotlin/Swift
sources have drifted from the Rust API it commits the refreshed ones back to the pull
request. So a Rust API change does **not** need a macOS session to land — only a local
iOS build does. (Fork PRs and pushes to `main` get no write access, and there CI still
fails with the manual `just bindgen-*` instruction.)

The Apple-managed `com.apple.developer.networking.multicast` capability is approved for
`com.unrealjune.streetcryptid` and declared under `expo.ios.entitlements`. After changing
this entitlement, regenerate every affected EAS provisioning profile; profiles created
before approval cannot sign the app. The signed app and its embedded profile should both
contain the entitlement.

### 3. Android — jniLibs + Kotlin bindings

```bash
just bindgen-android
```

`build.gradle` pins the JNA **`@aar`** variant (bundles `libjnidispatch.so`) — the plain
jar crashes on device. Requires Kotlin 2.2+.

`IrohAndroidBootstrap.install(...)` runs during module `OnCreate`: it loads the
shared library, installs a process-lifetime application context for iroh's DNS
resolver, initializes the BLE managers, and then runs UniFFI's generated integrity
checks before any endpoint is constructed.

The EAS pre-install hook uses the same generator before cross-compiling the Android
libraries, so bindings are refreshed before Gradle packages the ABI-specific `.so` files.

`just check-bindings` regenerates Kotlin and Swift/C bindings into a temporary directory
and compares them with the tracked files, so CI can detect Rust API drift without
modifying the worktree. `just check-all` includes this check.

The BLE transport also needs the vendored `blew` Android runtime under
`android/src/main/java/org/jakebot/blew/`. The Expo module loads
`libiroh_location.so` during `OnCreate`, which runs the Rust `JNI_OnLoad`
bootstrap, then initializes `BleCentralManager` and `BlePeripheralManager` with
the application context. Its manifest contributes the modern
scan/connect/advertise permissions and pre-Android-12 fallbacks.

On iOS, the pod links both `Network.framework` (iroh QUIC) and
`CoreBluetooth.framework` (the BLE custom transport). `app.json` provides the
Bluetooth usage description.

### 4. Dev client + run

```bash
# from the repo root
bunx expo prebuild --clean          # autolinks this local module
just run-android                    # or: bunx expo run:ios (on macOS)
```

Expo Go is **not** supported because it cannot load this local native module.

### 5. Web (WASM, relay-only)

The web path builds a sibling Rust crate so the native UniFFI crate stays untouched:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
just build-wasm
```

`src/IrohLocationModule.web.ts` registers a web Expo module with the same
`IrohLocationApi` and event surface as native. It imports `web/iroh_location_wasm.js`
and requires `web/iroh_location_wasm_bg.wasm` as a Metro asset; `metro.config.js` adds
`wasm` to `assetExts` so `bunx expo export -p web` copies the binary.

Configure the authenticated relay endpoints and limited-scope client credential in the
ignored root `.env.local`:

```dotenv
EXPO_PUBLIC_IROH_RELAY_URLS=https://relay.example.com
EXPO_PUBLIC_IROH_RELAY_TOKEN=<limited-scope client token>
```

Browsers cannot use UDP hole punching, so iroh runs relay-only there; native clients
retain direct IP and BLE paths alongside the same relay map. The token stays out of Git, but it is
necessarily embedded in client builds because each client presents it to the relay.

**The web node is a replica, not a peer.** It reuses `rust/src/docs.rs` verbatim by `#[path]`
(`iroh-docs` `0.101` / `iroh-blobs` `0.103` compile to `wasm32-unknown-unknown` with
`default-features = false`), so it can hold namespaces, import doc tickets, reconcile them
(`syncLatest`), report `trailReplicaStatus`, `pruneTrail` and hand out its `docTicket`. It
**neither opens nor seals a fix**: every envelope is v3, wrapped under a per-friend Double Ratchet
(`FORWARD-SECRECY.md`), and a ratchet needs sequential state that survives a reload. A browser has
no filesystem — both the blob store (`MemStore`) and the replica (`Docs::memory()`) are in-memory
and vanish with the tab — so ratchet state kept there would rewind into key reuse; and sessions
are installed by pairing, which the web build cannot do. So `readLatest` resolves `[]`, and
`ingestFix` / `heartbeatFix` / `publishIntroduction` resolve a non-publishing outcome
(`rejection: 'web-no-publish'`) rather than throwing, because the mounted heartbeat timer calls
them on every platform. Making web a real peer means a persistent store (IndexedDB) with the
rollback problem solved.

**Who delivered a fix.** Native `readLatest` rows carry `viaPeer` when a reconciliation brought
that author's newest slot in: the hex EndpointId of the peer that served it (captured from
iroh-docs' `InsertRemote`), never inferred from a replica read. It is frequently NOT the author —
any of the author's recipients, or the stash, can serve their namespace — and that is the point.
See `describeDelivery` in `src/features/social/core/fix-transport.ts`.

`endpointIdFromTicket(ticket)` decodes an endpoint ticket to its EndpointId without a node, which
is how the app recognises a configured stash as the deliverer instead of an unpaired device.

## Trail-stash desktop debug client

The host-side `trail-stash-client` uses the same `LocationNode`, envelope crypto, and mandatory
visual SAS pairing as the app. It is intended for an ADB-connected Android phone and reads location
fixes through trail-stash only:

```bash
just trail-stash-client status
just trail-stash-client pair --adb
just trail-stash-client pair --simulator <simulator-udid>
just trail-stash-client watch
just trail-stash-client watch --once --json
```

It loads relay, stash, PSK, and optional OTEL values from the existing `.env.local`. Pairing and
watching use separate on-disk replicas. The watcher does not import the phone namespace into the
live docs engine at all: it runs the lower-level range-reconciliation protocol directly against the
configured stash endpoint, downloads blobs only from that same endpoint, and never joins the
namespace's live-sync swarm. The pairing command also registers the phone's read-ticket through
`POST /v1/namespaces`, so the test does not depend on the phone's stash opt-in setting.

Keys and pair metadata are stored outside the repository under the platform data directory
(`%LOCALAPPDATA%\streetcryptid\trail-stash-client` on Windows), or an explicit `--state-dir`.
Coordinates are printed or emitted as JSON but are not persisted in the CLI state.

## Proving the A→B gate

1. Build the dev client on the iPhone (A) and the Android (B).
2. Open the **Friends** tab on both; each shows its `streetcryptid://contact?…` link.
3. Open A's one-time pairing link on B. Compare the visual check over a trusted call: one phone
   shows an ASCII figure, the other chooses it from four, then the displaying phone confirms.
4. Verify neither friend nor sharing grant appears until both people complete that check.
5. On A, tap **Share** next to B, nudge the point, tap **Broadcast** → B's Friends screen
   lists the decrypted fix under "Incoming fixes".
6. Revoke: on A tap **Sharing** to turn it off → B stops receiving new (decryptable)
   fixes, proving per-recipient revocation end-to-end.

## Status / next

- Location delivery is iroh-docs alone: `ingestFix` / `heartbeatFix` / `publishIntroduction`
  seal into the own namespace and push it; friends' namespaces are live-synced, pulled
  (`syncLatest`) and read (`readLatest`), with `onReplicaChanged` (`watchReplica`) announcing
  remote inserts. Native keeps a persistent replica; web an in-memory one (§5).
- Profile sync (§3), bilateral pairing (§4), and honest BLE status (§2) — **bridged** to JS.
  The Kotlin (`just bindgen-android`) and Swift (`--language swift`, host lib) UniFFI bindings are
  regenerated and the Expo wrappers expose `publishProfile`/`profileTicket`/`importProfileTicket`/
  `readProfile`/`pollProfileEvents`, `setPairingReady`/`pairingReady`/`createPairInvite`/
  `initiatePair`/`initiatePairByToken`/`initiatePairNearby`/`respondPair`/`pollPairEvents`/
  `pairState`/`listPairSessions`/`pairSasChallenge`/`submitPairChoice`/
  `confirmPairDisplay`/`cancelPair`/`pairResult`/`encodePairInvite`/`decodePairInvite`, and
  `bleAvailable`/`bleCapabilities`/`nearbyBlePeers`/`bleHasScanHint`. Byte fields cross the bridge
  as lowercase hex; enums as camelCase strings; U64 epochs/timestamps as JS numbers. The web
  (WASM) build reports these unavailable (empty/false/null) and throws only on explicit pairing
  actions.
- Background execution — **done** in the app layer (`src/features/social/net/background/`) over
  `expo-location` + `expo-task-manager`; see ARCHITECTURE.md §9.
- **iOS XCFramework** is generated automatically for EAS device builds by the pre-install
  hook. For local device + simulator builds, regenerate the Swift bindings and both
  XCFramework slices with `just bindgen-ios` on macOS + Xcode (README §2).
- Relay deployment configuration stays outside this public repository.
- Pin `iroh-docs`/`iroh-blobs` (and the `iroh-gossip` they run on) carefully; they are pre-1.0
  and move fast.
