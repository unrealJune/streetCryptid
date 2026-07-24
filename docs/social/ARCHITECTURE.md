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

| Layer        | Crate / tech                                                          | Role                                                                           |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Transport    | **iroh 1.0** (QUIC via `noq`)                                         | E2E-encrypted, relay-blind connections; identity = ed25519 `EndpointId`        |
| Live path    | **iroh-gossip 0.101**                                                 | best-effort epidemic broadcast of the newest fix (low latency, **no history**) |
| Durable path | **iroh-docs 0.101** (+ **iroh-blobs 0.103**)                          | replicated log with **range-based set reconciliation** → offline catch-up      |
| App crypto   | `chacha20poly1305`, `hpke`, `x25519-dalek`, `ed25519-dalek`, `blake3` | the per-recipient envelope (below)                                             |

> **Constraint that shapes everything:** the official `iroh-ffi` 1.0 bindings expose
> **only iroh core** (endpoint/QUIC/tickets/relays). gossip/docs/blobs are **not**
> exposed. We therefore ship our **own** Rust crate (`modules/iroh-location/rust`)
> wrapping iroh + gossip + docs + the crypto, and generate our **own** UniFFI
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

## 5. Channels: live + durable

Each user owns **one location namespace** (they are the sole writer of their own trail):

- `namespaceId` = the iroh-docs `NamespaceId` (public key of the doc's keypair).
- `topicId` = `blake3("streetcryptid.loc" ‖ namespaceId)` → the gossip `TopicId`.

Per fix, A:

1. builds the Envelope for its **current active recipient set**,
2. **broadcasts** it on `topicId` (gossip) → live update for online friends, and
3. **writes** it to the docs namespace under key `author/seq` → durable, replicated.

**Retention:** location entries are retained indefinitely. They are removed only through an
explicit deletion action, such as removing a friend or deliberately pruning history. Low background
ping ⇒ per-fix entries are cheap; if ping frequency ever rises, batch fixes into periodic
**snapshot** entries to limit iroh-blobs per-entry overhead.

## 6. Sharing, recovery, and revocation

**Granting to B** is two independent grants:

1. **Join the swarm** — A gives B the docs **read-ticket** + bootstrap (A's
   `endpointTicket`) so B can replicate the trail and subscribe to the topic.
2. **Decrypt access** — A registers B's `recvPub` so every future envelope includes
   B's `Wrap`.

**Offline recovery works** because the whole (encrypted) envelope is replicated to every
pool member; a rejoining B runs range-based reconciliation against C/D/A, pulls the
envelopes it missed, and decrypts its own wraps.

**Revocation works** because access is the `Wrap`, not swarm membership: to unshare with
C, A simply **stops emitting C's `Wrap`**. Since every fix uses a **fresh random `K`**,
"no wrap ⇒ no key ⇒ ciphertext is useless to C," even if C keeps replicating the doc.
(You cannot force-eject a peer from a gossip/doc swarm, and you don't need to.)
`epoch` is reserved if we ever want an explicit forced rotation for UX/audit.

```
                 ┌──────────── A (writer) ────────────┐
   GPS fix ─▶ build Envelope(active recipients) ─▶ sign ─┬─▶ gossip.broadcast(topic)   (live)
                                                         └─▶ docs.set(author/seq, bytes) (durable)
                                                                     │  replicate (range reconciliation)
                      B online: gossip Received ─▶ verify sig ─▶ unwrap(myWrap) ─▶ decrypt ─▶ dot
                      B rejoins: docs sync missed ─▶ (same) ─▶ backfill trail
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
        ──▶ Rust crate `iroh-location`  (iroh + gossip + docs + crypto)
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

The **phone background service** samples GPS foreground + background and pushes each fix into
both the live (gossip) and durable (docs) paths. Design of the JS layer lives under
`src/features/social/net/background/`; the durable path is native iroh-docs (`modules/iroh-location/rust/src/docs.rs`).

```
GPS (OS, fore+background) ─▶ LocationEngine ─▶ FixOutbox ─▶ LocationSharingService.publishFix
   expo-location            │ SamplingPolicy   │ durable queue,   ├─▶ gossip.broadcast   (live)
   + TaskManager            │ (motion+battery) │ survives resume  └─▶ docs.write(a/seq)  (durable)
   + Android FG service     │        ▲                ▼                        │ range reconciliation
   ▲                        │   BatterySource    TrailStore (local, history) ◀─ backfill onFix (sync)
   └── CadenceController ◀──┘   (expo-battery)
       re-arms OS on decision change
```

> ⚠️ **iOS reality check — read before tuning cadence.** expo-location's `timeInterval` is
> **Android-only**: the iOS `LocationOptions` record carries only `accuracy` and `distanceInterval`,
> so every interval the policy computes is discarded before it reaches Core Location. On iOS the
> only levers that actually land are `desiredAccuracy`, `distanceFilter` (a _delivery_ filter — it
> does **not** duty-cycle the receiver) and whether a location session is running at all. Note also
> that `deferredUpdatesInterval` is not Core Location's deferred updates (Apple deprecated
> `allowDeferredLocationUpdates` in iOS 13); expo implements it in userland by buffering callbacks,
> so it saves JS/CPU wakeups, not radio. Consequence: **`sessionMode` is the only meaningful
> battery lever on iOS**, and a stationary phone with anchoring off is sampling exactly as hard as
> a walking one apart from its accuracy tier.

- **Sampling** (`sampling-policy.ts`): battery/motion-aware cadence tuned as an _ambient_ sharer
  (Life360 / Find-My class), not a navigator — ~45s walking at balanced (~100m) accuracy, ~18s +
  high accuracy driving, stationary backed off to `low` (~1km) accuracy, ×3 backoff under Low-Power
  Mode / battery-saver (cancelled by charging, and applied as a _coarsening clamp_ so it never
  re-tightens the stationary tier), suspend on critically low battery. A bounded,
  on-demand **live mode** (`SamplingInputs.live` → `LocationEngine.setLiveMode` →
  `LocationSharingService.setLiveTracking`, default 2-min auto-revert) swaps in a real-time ~4s/high
  cadence for the "a friend is actively watching" case, so the app never pays real-time GPS cost
  around the clock. The network trigger for it is a future phase (§9c).
- **Motion signal** (`motion-source.ts`): a native-free seam over expo-location's motion-activity
  API (iOS `CMMotionActivityManager` / Android Activity Recognition), running on the motion
  coprocessor at near-zero power. It exists to break a circularity: `deriveMotion()` infers movement
  by comparing two GPS fixes, so the policy had to keep the receiver running to discover it didn't
  need the receiver. The engine prefers the coprocessor and falls back to `deriveMotion` whenever it
  has no opinion (denied Motion & Fitness permission, low confidence, or a **stale** reading).
  Staleness matters: the stream is **foreground-only** — "updates pause when the app is
  backgrounded" — so a backgrounded reading freezes at whatever it was (usually `walking`, right
  before the phone goes in a pocket) and is expired after `MOTION_STALE_AFTER_MS`. Never build a
  background state transition on this source; that is what the anchor geofence is for.
- **Stationary anchoring** (`sessionMode` + `cadence-controller.ts`): the pattern every
  battery-efficient tracker converges on — Foursquare's Movement SDK (<0.5%/day) "sets a single iOS
  geofence while the user is stationary to shut down background location usage"; transistorsoft's
  background-geolocation runs the same stationary/moving state machine; RAPS (MobiSys 2010) measured
  3.8× battery lifetime over always-on GPS. On a confirmed `stationary` classification the
  controller **arms an exit-only geofence at the last fix, then stops location updates entirely**;
  the exit wakes us (headless if need be) and restores continuous sampling. Ordering is deliberate
  in both directions: arm before stopping, and reprogram before disarming, so no partial failure
  ever leaves us both un-sampled and un-woken. Anchoring and cadence share ONE serialized
  latest-wins queue — two controllers racing `start/stopLocationUpdatesAsync` on the same OS task is
  the hazard that serialization exists to prevent. **Ships off** (`anchorWhenStationary: false`)
  until validated on a device, and is additionally gated on the coprocessor being available, since
  without a non-GPS movement signal the geofence is the only way back and iOS needs ~200 m of travel
  to report an exit.
- **Battery signal** (`battery-source.ts`): a native-free seam over `expo-battery` feeding the
  policy real charge level, charging state, and OS **Low-Power Mode / battery-saver**; `subscribe()`
  fires on power changes so cadence reacts immediately (web / Expo Go get a full-battery null source).
- **Cadence control** (`cadence-controller.ts`): the OS location task is armed once at start and
  would otherwise stay pinned at that cadence forever. The controller watches the engine's decisions
  and **re-programs `startLocationUpdatesAsync` only on a material change** (accuracy, interval,
  distance, deferred window, iOS activity/auto-pause), and asks the engine to re-evaluate on power
  events. OS integration: iOS `activityType` tracks motion (fitness/automotive/other); we keep
  `pausesUpdatesAutomatically` **off** so Core Location never auto-pauses background updates (it does
  not reliably resume, which stops background sharing until the app is reopened); Android carries a
  branded foreground-service notification color. Re-arms are serialized latest-wins so two
  `startLocationUpdatesAsync` calls never race the same task.
- **Outbox** (`fix-outbox.ts`): durable, serialized queue so captures survive the node being unbound
  (offline / process death). A mounted runtime publishes TaskManager batches immediately; a fresh
  headless context restores the persisted profile, keys, sharing pool, and minimal iroh publisher
  before draining the queue.
- **Reconnect-on-resume** (`lifecycle.ts`): on foreground → drain outbox + `syncTrail`;
  monotonic `seq` persisted (`state-store.ts`) so `author/seq` keys never collide across restarts.
- **Periodic backfill** (`backfill-task.ts` + `headless-runtime.ts`): the SEND task only fires on
  movement and only publishes, so a backgrounded phone never pulls peers' fixes. An
  `expo-background-task` (iOS `BGTaskScheduler` / Android `WorkManager`, ~15 min, OS-scheduled)
  periodically wakes a short-lived headless node to `syncTrail` from the stash + drain any queued
  outbox. Scheduled while background sharing is on; there is deliberately NO server push-wake.
- **Config**: iOS `UIBackgroundModes: [location, processing]` + `NSLocationAlwaysAndWhenInUse…`; Android
  `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` + `POST_NOTIFICATIONS`
  (`app.json` / expo-location config plugin).
- **web**: relay-only iroh WASM implements the same interface, including an **in-memory**
  iroh-docs replica (ephemeral across reloads, interoperable with native's persistent replica).
- The complete friend **trail** serves both offline recovery and the history view. The map normally
  shows only the latest point; selecting a friend connects a sampled set of retained fixes in that
  friend's chosen profile color. Amber
  stays "YOU" only, and contact-green remains the legacy/default friend signal.

> Android background execution still follows platform limits: force-stopping the app prevents
> delivery until the user launches it again. Normal backgrounding uses Expo Location's foreground
> service and a globally defined TaskManager task.

## 9a. Bilateral pairing and mutable profiles

Friendship is established over a dedicated authenticated iroh protocol:

```
ALPN: streetcryptid/pair/2 (wire v2)

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
- Pairing is bilateral and idempotent. A friend enters the local pool only after both human-gated
  `Accept` decisions, and only then does the app create reciprocal location grants. Either person
  can later pause their outbound grant from the friend's profile.
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

The Friends tab is the pairing surface; there is no separate pairing mode.

### Nearby: Bump over iroh BLE

- `iroh-ble-transport` is attached to the same endpoint as normal IP/relay transports. It acts as
  central and peripheral and routes authenticated iroh QUIC over GATT/L2CAP when a peer is nearby.
- The transport is experimental and AGPL-3.0-or-later; source and modification notices live under
  `modules/iroh-location/rust/third_party/iroh-ble-transport/`.
- BLE uses one shared central/peripheral pair for transport and Bump discovery. The transport's
  primary GATT service exposes a static, read-only full EndpointId characteristic; the advertised
  key UUID still carries its 12-byte prefix. This identity service survives GATT-server rebuilds.
- Nearby pairing is explicit. Both people tap **ARM BUMP**, then tap the phones together. One clear
  accelerometer impact commits the attempt; the same visible button remains a fallback if the
  sensor misses. The acceptance gate is active only during the short armed window.
- On commit, the shared scanner is restarted in low-latency mode. Fresh streetCryptid
  advertisements are ranked by RSSI, equally close candidates fail as ambiguous, and the strongest
  peer is connected long enough to read its full EndpointId. The read must match the advertised
  prefix; Android GATT cache recovery and bounded retries run before the attempt fails.
- Both phones may initiate the deterministic nearby session at once. The pairing core deduplicates
  that into one session with complementary SAS roles. Invite/code requests never inherit Bump
  consent.
- Transport discovery never grants friendship. After key exchange, the inline visual check
  requires the picker and displayer actions described in §9a before either side accepts.
- Haptics accelerate from soft search ticks through contact and key exchange, then settle while
  both people compare the figure. Verified completion produces a heavy success "pop" followed by a
  full-screen `CRYPTID DISCOVERED` ASCII-art dance. The reveal stays open until the user explicitly
  acknowledges the new friend or rejects them; rejection revokes sharing and removes the friend.
  An acknowledged friend appears on the map as soon as their first encrypted fix arrives.
- BLE permission is checked before node creation without prompting. If Android permission is first
  granted from Bump, the node is rebuilt so the BLE transport actually attaches; queued location
  fixes remain durable during the short rebind.
- If BLE permission/radio initialization fails, the node logs that failure and continues over
  normal IP/relay transports.

### Remote: link or blind short code

- A shareable `streetcryptid:///social?token=scpair1:…` link opens the existing Friends route and
  carries the opaque native invite directly. Android native intents normalize both this canonical
  form and legacy `streetcryptid://social` / `/pair` links.
- Friends also provides a visible input for a full sharing link, raw token, or short code.
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

## 9c. Later phases

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
