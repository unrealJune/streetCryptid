# streetCryptid — Friend Location Sharing (decentralized, E2E-encrypted)

> Status: **design of record** for the first app service. The native app now owns
> the service at the root, broadcasts automatically, and renders friend presence. This
> document is the security/architecture contract — keep it in sync with the code in
> `modules/iroh-location/` and `src/features/social/`.

## 1. Goal

Let User **A** opt to share their location with friends **B, C, D…** such that:

1. **Decentralized** — no central server holds location data. Peers talk directly
   (with a relay only for NAT traversal, which cannot read the data).
2. **Per-recipient confidentiality** — every fix is encrypted individually per
   recipient. If A stops sharing with C, C can no longer read **new** fixes even though
   they travel over a shared, replicated channel.
3. **Offline recovery** — if B was offline, B recovers the **trail it missed** from any
   other device in the sharing pool when it comes back.
4. **Secure transport** — the wire is authenticated and encrypted end-to-end.

Non-goals (this phase): multi-device-per-user identity and production web parity.
See "Later phases".

## 2. Building blocks (iroh, July 2026)

| Layer      | Crate / tech                                                          | Role                                                                      |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Transport  | **iroh 1.0** (QUIC via `noq`)                                         | E2E-encrypted, relay-blind connections; identity = ed25519 `EndpointId`   |
| Location   | **iroh-docs** (+ **iroh-blobs**; iroh-gossip only inside docs)        | one LWW slot per author, live-synced + **range-based set reconciliation** |
| App crypto | `chacha20poly1305`, `hpke`, `x25519-dalek`, `ed25519-dalek`, `blake3` | the per-recipient envelope (below)                                        |

> **Constraint that shapes everything:** the official `iroh-ffi` 1.0 bindings expose
> **only iroh core** (endpoint/QUIC/tickets/relays). gossip/docs/blobs are **not**
> exposed. We therefore ship our **own** Rust crate (`modules/iroh-location/rust`)
> wrapping iroh + docs + the crypto, and generate our **own** UniFFI
> (Swift/Kotlin) bindings, surfaced to React Native via an Expo Module.

## 3. Identities & keys (device-based)

Each device holds two keypairs, both persisted in the OS secure store (iOS Keychain /
Android EncryptedSharedPreferences):

- **Identity key** — iroh `SecretKey` (**ed25519**) → stable `EndpointId`. Used for the
  QUIC transport _and_ to **sign** every location envelope (authenticity/integrity).
- **Receiving key** — a **separate X25519** keypair. Its public half is the
  **"receiving key"** a friend hands to A so A can wrap content keys only that friend can
  open. Kept separate from the ed25519 identity to avoid the ed25519→X25519 conversion
  footgun.

A device is identified to friends by a **contact card**:

```
ContactCard {
  handle:        string        // "@name"
  sigil:         string        // multiline ASCII cryptid (spaces/newlines preserved)
  cryptidName:   string?       // form label, e.g. "Mothman"
  color:         string?       // chosen #RRGGBB map/roster signal
  endpointTicket: bytes        // iroh dialing info (EndpointId + relay URL + addrs)
  recvPub:       [u8; 32]      // X25519 public "receiving key"
}
```

Exchanged out-of-band: **QR code** (in person), a `streetcryptid://contact?…` deep link,
or a short relay-rendezvous code. (`scheme` is already `streetcryptid` in `app.json`.)

## 4. The location envelope (per GPS fix)

Encrypt the payload **once**; wrap the symmetric key **per recipient**. This is what
makes it both efficient and revocable.

```
Envelope (wire format, versioned) {
  v:        u8                              // schema version
  author:   [u8; 32]                        // A's EndpointId (ed25519 pub)
  seq:      u64                             // A's monotonic counter
  ts:       u64                             // ms since epoch
  epoch:    u32                             // key epoch (reserved for forced rotation)
  nonce:    [u8; 12]                        // RFC 8439 ChaCha20-Poly1305 nonce
  ct:       bytes                           // AEAD(K, Payload)  — K = fresh random 32B
  wraps:    [ Wrap { kid: [u8;8], enc: bytes } ]   // one per ACTIVE recipient
  sig:      [u8; 64]                        // ed25519_sign(identity, header‖ct‖wraps)
}

Payload { lat: f64, lon: f64, accuracy_m: f32, heading_deg: f32, ts: u64 }
Wrap.enc = HPKE-Seal(recipient.recvPub, K)  // DhkemX25519HkdfSha256 + ChaCha20Poly1305
Wrap.kid = first 8 bytes of blake3(recipient.recvPub)  // which wrap is "mine"
```

- **Wire version:** envelope v2 uses only RFC-defined payload encryption. It intentionally rejects
  the pre-release v1 XChaCha20-Poly1305 format, so internal test installs must clear old app data and
  pair again after upgrading.
- **Confidentiality / per-recipient:** only a recipient whose `recvPub` was wrapped can
  recover `K` and decrypt `ct`. Relays, the swarm, and revoked peers see only ciphertext.
- **Authenticity:** `sig` proves A produced the envelope and it wasn't tampered with.
  _(The user's "sign packets meant for B" = this signature for authenticity; the
  "only B can read it" property is the per-recipient **wrap**, not the signature.)_
- **Efficiency:** payload encrypted once; each `Wrap` is tiny (HPKE enc + tag). N
  recipients ⇒ 1 payload + N small wraps.

## 5. One channel: the docs namespace

Each user owns **one location namespace** (they are the sole writer of their own trail), and
location travels over iroh-docs alone. Per fix, A's native drain:

1. builds the Envelope for its **current active recipient set**,
2. **writes** it to A's namespace under the single key `hex(A)/fix` (`docs.write`) — one
   last-write-wins slot per author; `seq` lives inside the signed envelope, not in the key — and
3. **pushes** the namespace to the stash and every friend it holds a ticket for (`trail.push`).

Every namespace a node holds — its own and each imported friend's — joins the iroh-docs **live
engine** at start (`start_sync`). A write is therefore broadcast to whoever is syncing that
namespace at that moment (iroh-docs uses gossip internally for this, keyed by namespace id), and a
device that was asleep **reconciles** the newest slot from any peer that holds it: the author, the
stash or another friend. Live delivery and offline catch-up are the same mechanism.

Until 2026-11 a separate app-level gossip topic (`blake3("streetcryptid.loc" ‖ id)`) carried each
fix a second time, sealed separately, for lower latency. It is gone: it had no history, it was a
second ratchet consumer, and everything it delivered the live engine already delivers.

**Retention:** asymmetric, and deliberately so.

- **Your own trail** is retained locally in full. It is yours, it never leaves the device except as
  ciphertext, and the map draws it behind you.
- **A friend's trail is not retained.** Only their newest fix is kept — in the local cache, and on
  the stash. A received fix supersedes the previous one instead of appending to it.

Because the key is one overwritten slot, a peer catching up reconciles one entry per author rather
than a back-catalogue. (Pre-LWW `hex(author)/{seq}` keys an older build left in a replica are
skipped by every reader.)

Each retained fix keeps a `via` label recording how it reached this device, and a `viaPeer`
recording **who** performed that hop (see `modules/iroh-location/README.md`). Since a friend's
history is gone, both surface once — as the profile sheet's SIGNAL PATH row for their current fix —
rather than per row of a timeline; the row opens to name the deliverer. The two are stored and
merged as one record, because a label from one delivery beside a peer from another would read as a
fact and be a fiction.

Only endpoints in this device's own pool are named. A fix can be served by anyone replicating the
author's namespace, and that set is the author's rather than ours, so a deliverer we have not
paired with is shown as a truncated endpoint id and nothing else.

This is a privacy decision first — nobody needs a searchable movement history of their friends —
but it also fixed a severe performance bug. iroh-docs reconciliation does not trickle: when it
caught up with a friend it delivered that friend's _entire_ retained trail in one burst (956
entries in ten seconds on the device this was diagnosed from), and processing them per-entry pinned
the JS thread, stalled tile loading, and drained the battery. See
`src/features/social/net/__tests__/backfill-storm.test.ts` for the regression that guards this.

## 6. Sharing, recovery, and revocation

**Granting to B** is two independent grants:

1. **Join the namespace** — A gives B the docs **read-ticket** + bootstrap (A's
   `endpointTicket`) so B can replicate A's namespace live.
2. **Decrypt access** — A registers B's `recvPub` so every future envelope includes
   B's `Wrap`.

**Offline recovery works** because the whole (encrypted) envelope is replicated to every
pool member; a rejoining B runs range-based reconciliation against C/D/A, pulls the
envelopes it missed, and decrypts its own wraps.

**That replication is A's job, on publish.** A pushes its namespace (`trail.push`) to the trail
stash **and to every pool member**, not to the stash alone — so C holds A's envelope as A publishes
it, and can serve it to B the moment A goes dark. When A pushed only to the stash, C could relay a
fix solely if C happened to reconcile with A while A was still up — recovery "against C/D/A" was
true of the reader and false of the writer, and with the stash off there was no durable copy
anywhere.

**Revocation works** because access is the `Wrap`, not swarm membership: to unshare with
C, A simply **stops emitting C's `Wrap`**. Since every fix uses a **fresh random `K`**,
"no wrap ⇒ no key ⇒ ciphertext is useless to C," even if C keeps replicating the doc.
(You cannot force-eject a peer from a doc's replica set, and you don't need to.)
`epoch` is reserved if we ever want an explicit forced rotation for UX/audit.

```
                 ┌──────────── A (writer, native drain) ────────────┐
   GPS fix ─▶ build Envelope(active recipients) ─▶ sign ─▶ docs.write(hex(A)/fix)   (one LWW slot)
                                                               │  live engine: broadcast to peers
                                                               │  syncing A's namespace right now
                                                               │  trail.push: stash + every friend
                                                               ▼
                      B online: InsertRemote ─▶ ReplicaListener ─▶ app reads replica ─▶ unwrap ─▶ dot
                      B rejoins: reconcile with A / stash / C ─▶ (same)
                      C revoked: replicates bytes but has no wrap ─▶ cannot decrypt
```

## 7. Transport security

Provided by iroh: QUIC connections are authenticated by `EndpointId` (ed25519) and
**E2E-encrypted**; even relays that forward traffic cannot read it. Our envelope adds an
**application-layer** E2E boundary on top, so even authorized pool members (and any
relay) cannot read A's location unless A wrapped a key for them. Discovery uses
iroh DNS/Pkarr plus authenticated relay URLs supplied through public build-time
configuration. Deployment credentials and infrastructure stay outside this repository.

## 8. Native integration (Expo SDK 57 / RN 0.86, New Architecture)

```
React Native JS  ──JSI TurboModule (auto via Expo Modules API)──▶
  iOS Swift ExpoModule / Android Kotlin ExpoModule
     ──▶ UniFFI-generated Swift/Kotlin bindings
        ──▶ Rust crate `iroh-location`  (iroh + docs/blobs + crypto)
```

- Local Expo module: `modules/iroh-location/` (`rust/`, `ios/`, `android/`, `src/` TS,
  `plugin/` config plugin).
- Cross-compile: iOS `cargo make swift-xcframework` (aarch64-ios + sim); Android
  `cargo ndk` (arm64-v8a, armeabi-v7a, x86_64). UniFFI `0.31` + `tokio` feature.
- Gotchas: iOS `-framework Network` + network client/server entitlements; Android JNA
  **`@aar`** variant, **Kotlin 2.2+**, and mandatory
  `IrohAndroid.installAndroidContext(context)` before endpoint init.
- iOS declares the Apple-managed `com.apple.developer.networking.multicast` entitlement, approved
  for `com.unrealjune.streetcryptid`, so custom iroh mDNS can use the direct same-Wi-Fi fast path.
  Regenerate EAS provisioning profiles after entitlement changes; pre-approval profiles cannot
  sign the app.
- **Requires a custom dev client** (EAS Build / local prebuild) — **not Expo Go**.

## 9. Background execution & durable trails (implemented)

The **phone background service** samples GPS foreground + background and publishes each fix
into the docs namespace (§5). Capture, the slot gate, the outbox and the drain all run in Rust
(`gate.rs`, `outbox.rs`, `publish.rs`) so a JS-free OS wake can publish; a mounted app still runs
the sampling policy and hands its captures to the same `ingestFix` on the same node. The JS layer
lives under `src/features/social/net/background/`, the docs path in
`modules/iroh-location/rust/src/docs.rs`; AGENTS.md records the background rules learned from the
field.

```
GPS (iOS BackgroundLocationRuntime / Android service, or the mounted app's LocationEngine)
   │ ingestFix / heartbeatFix
   ▼
Rust DrainEngine: slot gate ─▶ durable outbox ─▶ seal ─▶ docs.write(hex(A)/fix) ─▶ trail.push
                                                                                (stash + friends)
friends' slots ─▶ live engine / reconcile ─▶ InsertRemote ─▶ ReplicaListener ─▶ app reads replica
```

- **The slot grid bounds publication; the OS wake cadence is movement-driven.** Envelopes are
  E2E-encrypted, but their arrival timing is visible. A perfectly fixed wire cadence hid motion at
  the cost of effectively continuous Core Location on iOS, because iOS ignores `timeInterval`.
  Ambient sharing now accepts that movement timing is observable, as it is in Life360-class
  products, and prioritizes sustainable battery use.
- **Sampling** (`sampling-policy.ts`): one fix per `intervalMs` — user-selectable 1/5/15 min,
  default 5 — at balanced (~100m) accuracy, tuned as an _ambient_ sharer (Life360 / Find-My class),
  not a navigator. Battery moves **accuracy only** (→ `low` under ≤20% or Low-Power Mode, cancelled
  by charging) and, below 5% unplugged, suspends outright — a hard stop that reads as "the phone
  died" rather than a slow-down that would encode the charge level in the cadence. There is
  uses a 100 m distance filter, background deferral up to the chosen interval, and iOS automatic
  pausing so a stationary phone does not keep GPS and JS hot. (The on-demand live mode that once
  swapped in a ~4 s cadence is retired; see §9c.)
- **Confidence gate** (`fix-quality.ts`): Android's fused provider periodically reports fixes that
  are simply wrong — kilometre-radius tower/Wi-Fi trilateration when GPS has no sky, a cached fix
  replayed long after it was taken, or a lone sample that teleports and comes back. A fix is refused
  if it is coarser than `maxAccuracyM` (150 m), older than `maxAgeMs` (10 min), or implies a ground
  speed over `maxSpeedMps` (100 m/s) since the last accepted one — the last discounted by the two
  fixes' combined error radii, so a stationary phone's jitter is not mistaken for a teleport. After
  `acceptAnythingAfterMs` (15 min) with nothing accepted it takes what it can get, because a coarse
  position beats a frozen trail. **A rejected fix must never silence a slot**: the gate sits before
  `lastKnownFix`, never before the publish, so an awake runtime can reuse the last good coordinate
  rather than emit a known-bad one. The requested accuracy tier must never be coarser than
  `maxAccuracyM`, or we would spend battery on fixes we then discard — which is why
  `lowBatteryAccuracy` is `balanced` and not `low`.
- **Slot quantisation** (`location-engine.ts`): the engine publishes on wall-clock boundaries of
  `intervalMs`, not on fix arrival. Extra fixes within a slot are absorbed into `lastKnownFix`; a
  slot that produces no fix can re-publish `lastKnownFix` **verbatim, original `ts` intact**, while
  the runtime remains awake. Missed slots are backfilled on the next wake up to `MAX_BACKFILL_MS`
  (30 min). `LocationEngine.heartbeat` drives this from a timer and every OS background wake. Note
  the outbox's
  near-duplicate **coalescing is disabled** (`background-outbox.ts`): left on, it would collapse a
  backfill replay into a single envelope.
- **iOS is event-driven, not timer-driven.** `timeInterval` is Android-only. On iOS the ambient
  task uses `distanceInterval: 100`, deferred updates, and `pausesUpdatesAutomatically: true`.
  The 200 m revive fence can relaunch a normally terminated app after movement, while periodic
  refresh is a best-effort stationary backstop. A user force-quit remains an iOS hard stop.
- **The visible indicators** are where the platforms genuinely diverge. iOS: we set
  `showsBackgroundLocationIndicator: false`; per Apple QA1965 the blue pill is mandatory only for
  _when-in-use_ apps, so an "Always"-authorized app can leave it off (we were opting in). Android:
  the foreground-service notification and the ongoing-location indicator are both platform-mandated
  for continuous background location and are _not_ interval-dependent — dropping the FGS would cap
  us at "a few times each hour". Life360 ships the same notification; Find My and Maps sharing are
  privileged system apps. On Android 13+ the notification is user-dismissible and the service
  survives the swipe.
- **Battery signal** (`battery-source.ts`): a native-free seam over `expo-battery` feeding the
  policy real charge level, charging state, and OS **Low-Power Mode / battery-saver**; `subscribe()`
  fires on power changes so **accuracy** reacts immediately (web / Expo Go get a full-battery null
  source). It no longer influences timing — see the fixed-cadence note above.
- **Cadence control** (`cadence-controller.ts`): the OS location task is armed once at start and
  would otherwise stay pinned at that config forever. The controller watches the engine's decisions
  and **re-programs `startLocationUpdatesAsync` only on a material change** (accuracy, interval,
  distance, deferred window, iOS auto-pause), and asks the engine to re-evaluate on power events.
  Now that the interval is fixed this fires for battery-driven accuracy changes and for a
  user-chosen interval change, rather than continuously. OS integration: `activityType` is pinned to
  `other` (it used to track the motion class, which we no longer derive); we keep
  `pausesUpdatesAutomatically` **off** so Core Location never auto-pauses background updates (it does
  not reliably resume, which stops background sharing until the app is reopened — and which would
  also silence a stationary iPhone); Android carries a branded foreground-service notification color.
  Re-arms are serialized latest-wins so two `startLocationUpdatesAsync` calls never race the task.
- **Outbox** (`rust/src/outbox.rs`): durable, so captures survive the node being unbound (offline /
  process death) and are drained by whichever holder of the node wakes next.
- **Push is explicit, and it addresses the whole pool** (native `trail.push`): `docs.write`
  reaches only peers syncing the namespace live at that moment, so the drain pushes after it
  writes, to the stash **and every pool member** under one `docs::PUSH_TIMEOUT_SECS` deadline. An
  earlier revision pushed only to the stash, so a friend held the author's entries solely if it
  happened to dial the author during a reconciliation window, and with the stash off nothing
  durable existed anywhere (§6). Ordering is load-bearing: pushing _before_ the drain leaves that
  wake's fixes for the next OS wake, which is what produced hour-long gaps in friends' trails while
  both phones looked healthy.
- **A node re-opens every namespace from disk** (`rust/src/ns_book.rs`): its own and each imported
  friend's, and all of them join the live engine at start. A node started by the native runtime
  with no JS alive therefore reconciles friends exactly as a mounted app does.
- **Reconnect-on-resume** (`lifecycle.ts`): on foreground → `syncTrail`. The envelope `seq` is
  counted natively and seeded at start from the keychain reservation (`seedSeq`, retried before a
  publish if the seed failed), so a reinstall never reuses a sequence number.
- **Periodic refresh** (`refresh-task.ts` + `headless-runtime.ts`; natively `NativeRefreshTask` on
  iOS): the SEND task only fires on
  movement and only publishes, so a backgrounded phone never pulls peers' fixes. An
  `expo-background-task` (iOS `BGTaskScheduler` / Android `WorkManager`, ~15 min, OS-scheduled)
  periodically wakes to heartbeat, drain any queued outbox and pull what friends left at the stash
  and on each other. Scheduled while background sharing is on.
- **There is no push-wake anywhere, by design.** The stash's control API still accepts a device
  push token and the server can still send a silent `trail-sync` push, but the app **never uploads
  one** (`stash-client.ts` sends a read-ticket and nothing else). See §10: an APNs/FCM token is the
  only identifier in this system a third party can resolve to a real person, and registering it
  against namespaces let the stash operator work out which namespace was ours. The cost is
  accepted and real: unless both phones are syncing live at once, a friend's fixes land on our next
  pull or periodic refresh rather than seconds after they publish.
- **The revive tripwire** (`background/revive-task.ts`) is a single 200 m exit-only geofence that
  re-centers on the user as they move. Core Location's standard location service keeps a _suspended_
  app awake but never relaunches a _terminated_ one; region monitoring is the only mechanism
  expo-location exposes that does, and silent push was given up with the push token (§10). On
  Android it cannot resurrect anything, but a geofence transition is a documented exemption to the
  Android 12+ ban on starting a foreground service from the background, which is the only way
  `ensureSharingArmedHeadless` can legally re-arm.
  > **iOS trap — do not "simplify" this away.** Arming is self-triggering. `startGeofencingAsync`
  > re-registers the whole region set, and expo-location's `EXGeofencingTaskConsumer` resets the
  > region's cached state to `CLRegionStateUnknown` and calls `requestStateForRegion`; the resulting
  > `didDetermineState:` fires the task whenever the determined state differs from the cached one —
  > always, after that reset — and picks the event type from the state alone, consulting **neither**
  > `notifyOnEnter` nor `notifyOnExit`. Those flags only filter genuine transitions. So a handler
  > that re-centers the fence recurses: measured at 60–125 wakes/second, persisted across cold
  > launches by expo-task-manager and clearable only by uninstalling. Two guards keep it closed —
  > the handler acts **only** on `GeofencingEventType.Exit`, and `armReviveFence` enforces a
  > `REVIVE_FENCE_MIN_REARM_MS` floor (bypassed only by `startBackground`, which may have no fence
  > standing yet). Android is unaffected: its consumer builds `transitionTypes` from the flags.
- **Who owns the native node.** There is exactly one iroh node per process: `self.node` in
  `IrohLocationModule.swift`, which **both** `createNode` and `shutdown` nil via `clearRuntime()`.
  Every other native export guards on it and throws `NoNode: call createNode first` once it is gone.
  So a second `LocationSharingService` — the short-lived one a TaskManager callback spins up — is
  never merely wasteful; it is destructive to whatever node the mounted runtime holds.
  `native-runtime-owner.ts` is the arbiter: the mounted service claims the runtime **before** its
  `createNode` and releases it in `performShutdown`, headless sessions refuse while a claim stands
  (and serialize against each other), and a mounted `init` awaits any in-flight session rather than
  clobbering it.
  > **iOS trap — `AppState` is not an ownership signal.** The guard here used to be
  > `AppState.currentState === 'active'`. iOS reports **`'inactive'`**, not `'active'`, during a cold
  > launch into the foreground and for as long as a system permission alert is up ("Allow Once /
  > While Using / Always") — precisely the two windows in which the mounted runtime is building its
  > node and in which expo-task-manager is replaying the persisted location/geofence tasks it
  > restored at module scope, before React mounts. A session admitted there calls `createNode`
  > (clearing the node being built) and then `shutdown` in its `finally` (clearing it again). Nothing
  > throws where anyone can see it: the mounted service keeps `status: 'ready'` and a non-null
  > `mod`, while `readTrail` `.catch`es to `[]`, `syncTrail` logs a warning and returns, and
  > `safeDocTicket` returns null. The app renders, the map still pans on the UI thread, and every
  > control is dead — through relaunches, because the same race re-runs each launch, until the user
  > reinstalls and clears the persisted tasks. Refusals are recorded on a `bg.session` span with
  > `sc.drop_reason` (`runtime-claimed` / `app-foreground`) and the observed `app_state`.
- **Config**: iOS `UIBackgroundModes: [location, processing]` + `NSLocationAlwaysAndWhenInUse…`; Android
  `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` + `POST_NOTIFICATIONS`
  (`app.json` / expo-location config plugin).
- **web**: relay-only iroh WASM implements the same interface as a **reader**: an **in-memory**
  iroh-docs replica (ephemeral across reloads, interoperable with native's persistent replica)
  that pulls and reads friends' slots. It does not publish (`web-no-publish`).
- Friends render as a **single dot** at their last known position, in their chosen profile color —
  there is no friend trail to draw, and selecting one shows only that point. Only **your own**
  retained fixes are connected into a sampled polyline. Amber stays "YOU" only, and contact-green
  remains the legacy/default friend signal.

> Android background execution still follows platform limits: force-stopping the app prevents
> delivery until the user launches it again. Normal backgrounding uses Expo Location's foreground
> service and a globally defined TaskManager task.

## 9a. Bilateral pairing and mutable profiles

Friendship is established over a dedicated authenticated iroh protocol:

```
ALPN: streetcryptid/pair/4 (wire v4)

invite / BLE discovery
        │
        ▼
signed Hello (EndpointId + recvPub + nonce commitment)
        │
        ▼
signed Reveal (fresh nonce)
        │
        ▼
verify commitment + derive transcript-bound visual SAS
        │
        ├── one phone displays the target ASCII figure
        └── the other chooses it from four shuffled figures
                 │
                 ▼
picker chooses correctly + displayer confirms the person matched
                 │
                 ▼
each human action latches that side's signed Accept
                 │
                 ▼
          both accepted only
                 │
                 ▼
 profile read-ticket + trail read-ticket + verified profile
```

- Every message is postcard-encoded, length-prefixed, versioned, bounded, and signed by the
  ed25519 key behind the sender's `EndpointId`.
- The asserted endpoint is also pinned to the authenticated iroh connection, permanently binding
  the separately generated X25519 receiving key to that endpoint.
- After a session is established, every reveal and decision is additionally pinned to that
  session's peer endpoint; knowing a session id cannot be used to inject a reject or substitute
  capability tickets from another authenticated endpoint.
- Pairing protocol v2 adds a mandatory visual Short Authentication String (SAS). Each side commits
  to a fresh 32-byte nonce before either nonce is revealed, preventing a responder from choosing
  its nonce after seeing the peer's value. The symmetric BLAKE3 transcript includes the protocol
  version, session id, and both canonically ordered endpoint ids, receiving keys, and nonces.
- The transcript deterministically assigns complementary roles and selects one of 256 stable ASCII
  figures. The picker receives four distinct, shuffled options; the displayer sees the target.
  The correct choice never crosses the wire.
- The automatic commit/reveal exchange must reach the visual gate within 60 seconds. Once it does,
  both people have 60 seconds to act: the picker chooses the matching figure and the displayer
  confirms that the other person chose it. A wrong choice, negative confirmation, cancellation,
  timeout, or invalid reveal is terminal; retrying requires a fresh session.
- Pairing is bilateral and idempotent. Both human-gated `Accept` decisions produce a pending
  discovery, not a friend or location grant. Only the local **Acknowledge** action persists the
  friend and enables outbound sharing. Pending discoveries remain outside the pool and survive
  duplicate completion notices without being silently accepted.
- **Reject** withdraws the completed handshake with a signed `Reject`. Native code erases only
  that round's ratchet, and the app removes the corresponding pending or acknowledged friendship.
  A newer re-pair must survive an older withdrawal; ordinary route teardown must never withdraw
  an acknowledged result. Notification of the peer is best-effort, not a recall of location
  updates already delivered. The UI therefore says sharing is off, not that nothing was shared.
  Either person can also pause their outbound grant from the friend's profile.
- Protocol v1 peers are intentionally incompatible and fail closed instead of bypassing the SAS
  gate. The 256-entry UI catalog in `pairing-figures.ts` is part of protocol v2 and must remain
  index-stable.
- New pair links contain only a random invite id/secret, endpoint id, endpoint ticket, version, and
  expiry. Mutable profile data and docs capabilities travel over the authenticated iroh channel.
- Legacy `streetcryptid://contact?…` cards remain importable as one-way contacts.

Profiles use a dedicated, single-writer iroh-docs namespace separate from the rolling trail:

```
ProfileRecord {
  v, endpointId, epoch,
  handle, cryptidName, sigil, color,
  recvPub, ts, signature
}
```

The record is signed by the endpoint identity and readers reject invalid signatures, wrong endpoint
bindings, oversized/invalid ASCII art, and non-increasing epochs. Live docs events update a roster
while both devices are online; range reconciliation restores the newest profile after an offline
period.

## 9b. Nearby and remote exchange

The island's **FRIENDS tab** and **Settings → Pair** open the dedicated pairing screen.
Opening that screen arms nearby listening; a shake starts the search. Leaving the screen
or backgrounding the app disarms nearby discovery. The friends tab itself does not arm
Bluetooth or request permission.

### Nearby: Bump over iroh BLE

- `iroh-ble-transport` is attached to the same endpoint as normal IP/relay transports. It acts as
  central and peripheral and routes authenticated iroh QUIC over GATT/L2CAP when a peer is nearby.
- The transport is experimental and AGPL-3.0-or-later; source and modification notices live under
  `modules/iroh-location/rust/third_party/iroh-ble-transport/`.
- BLE uses one shared central/peripheral pair for transport and Bump discovery. The transport's
  primary GATT service exposes a static, read-only full EndpointId characteristic; the advertised
  key UUID still carries its 12-byte prefix. This identity service survives GATT-server rebuilds.
- Nearby pairing is explicit. Both people open Pair, then shake their phones to start searching
  at the same time. An accelerometer impact commits the attempt; a visible fallback is available
  when motion sensing is unavailable. One radar rotation represents the 12-second search window,
  with elapsed dots distinguished from the remaining window. A found peer ends the search early.
- On commit, the shared scanner is restarted in low-latency mode. Fresh streetCryptid
  advertisements are ranked by RSSI, equally close candidates fail as ambiguous, and the strongest
  peer is connected long enough to read its full EndpointId. The read must match the advertised
  prefix; Android GATT cache recovery and bounded retries run before the attempt fails.
- Both phones may initiate the deterministic nearby session at once. The pairing core deduplicates
  that into one session with complementary SAS roles. Invite/code requests never inherit Bump
  consent.
- Transport discovery never grants friendship. After key exchange, the inline visual check
  requires the picker and displayer actions described in §9a before either side accepts.
- Haptics accompany searching, connecting, and the visual check. Verified completion opens the
  `CRYPTID DISCOVERED` reveal; a profile that arrives later updates that pending discovery.
  Acknowledge adds the friend and sharing grant. Reject (or closing an unconfirmed reveal)
  withdraws the pairing instead. An acknowledged friend appears on the map as soon as their first
  encrypted fix arrives.
- BLE permission is checked before node creation without prompting. If Android permission is first
  granted from Bump, the node is rebuilt so the BLE transport actually attaches; queued location
  fixes remain durable during the short rebind.
- If BLE permission/radio initialization fails, the node logs that failure and continues over
  normal IP/relay transports.

### Remote: link or blind short code

- A shareable `streetcryptid:///social?token=scpair2:…` link opens the map with the friends
  island showing and carries the opaque native invite directly. Android native intents
  normalize both this canonical form and legacy `streetcryptid://social` / `/pair` links
  into `/?pair=<token>`.
- **`scpair2:` does not interoperate with the `scpair1:` tokens shipped in v1.0.0–v2.4.0.** The
  break is deliberate and bidirectional, and it covers the short code too — the code's capsule
  seals the same token, so a cross-version code decrypts and is only then rejected on the token
  prefix. Both people must be on the same side of that boundary to pair by link or code; nearby
  BLE pairing works across it, since it carries no invite token. See `INVITE_V` in `pairing.rs`.
- Settings also provides a visible input for a full sharing link, raw token, or short code.
- Remote pairing still requires both people to compare the ASCII challenge over a trusted voice or
  video call. Possession of a link/code starts the authenticated transport exchange; it does not
  replace the human identity check.
- A typed code is an 80-bit Crockford Base32 secret displayed as
  `XXXX-XXXX-XXXX-XXXX`. On-device code derivation produces:
  - a 32-hex-character mailbox lookup id; and
  - an AES-256-GCM key for the invite capsule.
- The blind mailbox stores only `{lookup id, ciphertext}` for 60–900 seconds. A successful
  GET atomically burns the entry. The service never receives the code, decryption key,
  endpoint ticket, profile, or plaintext pairing token.
- Configure the app with `EXPO_PUBLIC_PAIR_MAILBOX_URL`. The service is replaceable through the
  `PairingMailbox` interface.

## 9c. Live mode (retired)

An on-demand live mode once let a watcher ask a subject to publish every ~4 s: the request was a
sealed `ctl/hex(author)` entry in the watcher's own namespace, polled by the subject, and the fast
fixes rode the app-level gossip topic. Both are gone. Readers still skip `ctl/` keys an older build
left in a replica (`docs::decode_key`). Real-time sharing, if it returns, should ride the live
engine (§5) — two phones syncing the same namespace already exchange each write as it lands.

## 9d. Later phases

- Operate authenticated relay and mailbox deployments outside the public app repository.
- IndexedDB-backed docs/outbox persistence for production web parity.
- Exchange explored-sector summaries so the roster can calculate the designed "shared ground"
  overlap metric without sharing raw movement trails.
- Persist/resume incomplete pairing sessions across process death.
- Surface BLE RSSI/last-seen from the vendored transport for stronger automatic candidate
  selection, and add explicit identity migration for a lost/reset endpoint key.

## 10. Threat model (summary)

- **Relay operator / network:** sees ciphertext + metadata (who dials whom, timing);
  cannot read locations (iroh E2E + envelope). Self-hosting reduces metadata exposure.
- **Revoked recipient (C):** may keep replicating the doc but cannot decrypt new fixes
  (no wrap; fresh key per fix). Cannot forge fixes (no A signing key).
- **Malicious pool member:** cannot impersonate A (envelopes are ed25519-signed) and
  cannot read fixes not wrapped for them.
- **Mailbox operator:** sees random lookup ids, ciphertext sizes and request timing, but cannot
  decrypt an invite. Codes are one-time, rate-limited, and short-lived.
- **Stash operator:** holds sealed envelopes it cannot decrypt, plus metadata — which namespaces
  exist, when entries arrive, and their sizes. It sees a live session as a cadence change from the
  ambient interval to ~4s, which §9 already treats as visible on the wire.
  **Device push tokens are the sharp edge here, and we no longer upload them.** An APNs/FCM token is
  the only identifier in this system a third party (Apple/Google) can resolve to a real person, and
  it is subpoenable — so pairing one with a namespace is a join from real-world identity to a
  location trail, worth more than the ciphertext. Worse, the old scheme leaked _which namespace was
  yours_ even though we never registered a token against it: under bilateral pairing your token
  appeared against every friend's namespace and never your own, so the operator recovered
  `token → your namespace` by set complement. `stash-client.ts` now sends a read-ticket and nothing
  else. Rows uploaded by older app versions remain
  server-side until purged; the server's push API is dead code the app never calls.
- **Nearby attacker:** BLE proximity and motion are not trusted. Pairing messages remain bound to
  authenticated iroh endpoint identities, and friendship remains blocked on the mandatory mutual
  visual SAS check.
- **Active relay / wrong person:** the commit/reveal transcript prevents adaptive SAS grinding, and
  both roles require a human action. Security depends on the people comparing the actual screens
  in person or over a trusted voice/video channel; blindly approving a relayed figure defeats that
  human check.
- **Compromised device:** exposes that device's keys + already-decrypted trail; out of
  scope to mitigate beyond OS secure-store storage. Multi-device revocation is future
  work.
- **Forward secrecy:** per-fix random content key limits blast radius; full ratcheting
  (e.g. MLS-style) is out of scope for this phase.
