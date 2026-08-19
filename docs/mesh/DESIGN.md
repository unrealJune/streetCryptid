# streetCryptid — Festival Mesh (offline location sharing over local radio)

> Status: **design of record. W1 (Rust core) is implemented; everything else is
> pre-implementation.** This is the architecture contract for the offline/no-coverage
> location mesh ("festival mesh"). Keep it in sync with the code: capsule crypto + mailbox
> store in `modules/iroh-location/rust/src/mesh.rs` (**built**), firmware in
> `firmware/antenna/`, phone radio in `modules/mesh-radio/`, TS feature in
> `src/features/mesh/`. Read [`../social/ARCHITECTURE.md`](../social/ARCHITECTURE.md)
> first — the mesh reuses its envelope, keys, and trust model wholesale.
>
> **The wire format in §3.2 is normative and now has executable vectors:**
> `modules/iroh-location/rust/tests/fixtures/mesh_vectors.json` (hex fields, so C and TS
> read the same file) driven by `tests/mesh_vectors.rs`. Every other implementation —
> antenna firmware included — must reproduce it.

## 1. Goal

At a venue with **no cell coverage** (festival, concert, deep wilderness), users can
still see their friends on the map:

1. **No phone-to-phone dependency.** Phones are leaves; a lattice of cheap dedicated
   hardware ("cryptid antennas") carries all multi-hop traffic. Phone↔phone direct
   links are opportunistic accelerators only.
2. **Same security model as the trail-stash.** Every relay — antenna, smart node,
   stranger's phone — is **ciphertext-blind**. Nothing new to trust.
3. **No new linkable radio identity.** Over-the-air addressing uses per-epoch rotating
   tags. A passive observer at the venue cannot track a person across epochs.
4. **Graceful degradation.** Zero infrastructure → nearby-friends still works
   opportunistically. One node → a mailbox plaza. A dozen nodes → live site-wide map.
5. **Egress.** Any node with an uplink syncs the venue's traffic to the hosted
   trail-stash, so off-site friends and post-event trails work through the existing
   pipeline unchanged.

Non-goals (this phase): messaging/chat over the mesh, stranger-relay phone gossip
("mule mode" — designed for, not built), Wi-Fi Aware anywhere on the critical path.

## 2. Topology

```
                        ┌─────────────┐   any uplink (Starlink at FOH,
   INTERNET ◄───────────┤ EGRESS NODE │   tethered phone at the gate)
   (hosted trail-stash) └──────┬──────┘
                               │
        ═══════════ TIER 1: SMART NODE BACKBONE ═══════════
        (refurb Android / Pi + antenna, running iroh trail-stash)
                               │
     ┌──────────┐  iroh sync over IP  ┌──────────┐
     │  NODE A  ├─────────────────────┤  NODE B  │
     └───┬──┬───┘ (WiFi / ethernet /  └───┬──────┘
         │  │      antenna backhaul)      │
         │  └── ESP-NOW/LR ──[ant]──[ant]──┐   TIER 2: bare antennas =
         │          hops                   │   repeaters + remote mailboxes
         │                            ┌────┴─────┐
         │                            │  NODE C  │
         │                            └────┬─────┘
        ═══ TIER 0: PHONES (leaves; BLE mailbox sync) ═══
         │                                 │
   ┌─────┴─────┐                     ┌─────┴─────┐
   │  iPhone   │                     │  Android  │
   └───────────┘                     └───────────┘
    Opportunistic direct (gravy, NOT backbone):
    iPhone↔iPhone friends: paired Wi-Fi Aware · Android↔Android: unpaired Aware
```

**Organizing principle: nothing is routed.** The backbone is a _replicated mailbox_ —
iroh-docs set reconciliation between smart nodes, LRU capsule caches on bare antennas.
Any phone syncing with any one smart node sees everything addressed to it. A node that
rejoins after a failure just reconciles. There is no routing table anywhere.

### 2.1 One hardware SKU: the cryptid antenna

**ESP32-S3** (the only chip with BLE 5 + full USB-OTG device mode + ESP-NOW/LR; the C6
has debug-serial USB only), module with PSRAM (≥2 MB, prefer 8 MB), one firmware,
three postures:

| Posture          | Plugged into               | Behaves as                                                                                          |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| **Standalone**   | battery pack               | Tier-2: BLE mailbox (LRU cache) + ESP-NOW/LR relay + iBeacon                                        |
| **Phone dongle** | any attendee phone (USB-C) | USB-NCM ethernet gadget bridging phone ⇄ mesh; phone's own iroh node becomes a backbone participant |
| **Node radio**   | refurb Android / Pi        | gives the smart node its long-haul ESP-NOW/LR radio (same NCM interface)                            |

The tier distinction is not a hardware distinction: **smart node = anything running the
iroh stack + an antenna**. Every dongle an attendee plugs in densifies the backbone.

### 2.2 Platform constraints ledger (verified July 2026 — do not re-litigate)

- **iOS Wi-Fi Aware is pairing-only** (DeviceDiscoveryUI / AccessorySetupKit per device
  pair). No unpaired publish. iOS 27 changed nothing. Stranger-relay over WFA on iOS is
  impossible; friend-pair WFA is viable (fold pairing into the in-person friend-add
  ceremony). Known bugs: dual publish+subscribe never connects (Apple forums #811828);
  Android→Apple pairings not persisted (#797170).
- **ESP32 NAN** (all of ESP32/C3/S3/C6) is pre-4.0: discovery+datapath only, **no NAN
  Pairing**, and iOS 26 interop fails at discovery (`Invalid time bitmap in
Availability`, esp-idf #16743, closed-source blob). Do not put Aware-on-ESP32 on any
  critical path. Revisit if Espressif ships Aware 4.0.
- **iOS cannot put payload bytes in BLE advertisements** (no manufacturer data, ever) and
  backgrounded advertising is overflow-area only. Phones are therefore **BLE centrals**;
  antennas/nodes are peripherals. Never design a phone-as-beacon data path.
- **iOS background BLE for _connected/known_ peripherals is strong**: characteristic
  notifications wake the app (~10 s, ~30 s with assertion); pending `connect()` never
  expires and completes on sight; state restoration revives terminated apps. Limits:
  user force-quit kills everything until manual relaunch; first contact with an unknown
  node needs the iBeacon wake (§6.1).
- **iPhone (USB-C, 15+) accepts standard-class USB ethernet (CDC-NCM/ECM) without MFi.**
  MFi/ExternalAccessory is only required for raw serial accessories. Lightning iPhones:
  BLE-only, unsupported for the dongle posture.
- **Android**: unpaired Wi-Fi Aware works Android↔Android; Aware 4.0 pairing exists API
  35+ behind `isAwarePairingSupported()`. USB-NCM is a native network interface, no
  prompts. All mesh radio work runs under the existing foreground service.
- **Android 17 local-network permission** (`ACCESS_LOCAL_NETWORK`) gates node-WiFi/iroh
  local sync — carry the fix from the A17 netlink finding.

## 3. Security model

### 3.1 Reuse, don't invent

The **inner envelope is `crypto::seal` from `modules/iroh-location/rust`, unchanged**
(same as live-mode control messages: "same envelope, different payload" — payload here
is the normal `LocationFix`). All revocation, per-recipient wrap, and signature
semantics carry over.

**But the envelope must never touch open radio bare.** Its `author` field and ed25519
`sig` are plaintext, stable, linkable identifiers — fine inside iroh's E2E transport,
a stalking beacon over BLE/ESP-NOW. Hence one new layer:

### 3.2 The radio capsule (outer wrapper, per recipient)

For author **A**, recipient **B**, epoch **e**:

```
ss_AB   = X25519(A.recv_priv, B.recvPub)            // both sides can compute
tag     = HKDF-BLAKE3(ss_AB, "sc-mesh-tag/v1" || A.endpoint_id || u32_le(e))[..16]
K_e     = HKDF-BLAKE3(ss_AB, "sc-mesh-key/v1" || A.endpoint_id || u32_le(e))[..32]

Capsule (wire, little-endian) {
  v:      u8            // 0x01
  epoch:  u32           // floor(unix_seconds / 900)  — 15 min, matches BLE MAC rotation
  tag:    [u8; 16]      // mailbox address; meaningless to non-friends
  nonce:  [u8; 12]
  ct:     bytes         // ChaCha20-Poly1305(K_e, nonce, envelope_bytes, aad = v||epoch||tag)
}
```

```rust
// modules/iroh-location/rust — sketch; expose via UniFFI as
// mesh_capsule_seal / mesh_capsule_open / mesh_expected_tags
pub fn mesh_tag(ss: &[u8; 32], author: &EndpointId, epoch: u32) -> [u8; 16] {
    let mut h = blake3::Hasher::new_derive_key("sc-mesh-tag/v1");
    h.update(author.as_bytes());
    h.update(&epoch.to_le_bytes());
    h.update(ss);
    h.finalize().as_bytes()[..16].try_into().unwrap()
}
// mesh_expected_tags(friends, now) -> Vec<[u8;16]> for epochs {e-1, e, e+1}
```

Rules:

- **Per-recipient capsules.** The inner envelope is built with **only that recipient's
  wrap** (smaller, and group membership stays hidden). N friends ⇒ N capsules per fix.
- **Epoch = 900 s.** Mailboxes accept and phones query epochs **e−1, e, e+1** (clock
  skew). Capsules expire from live sets after their epoch +1 passes (history is the
  trail-stash's job, via egress).
- **No outer signature, ever.** Authenticity is the AEAD (only A and B hold `K_e`) plus
  the inner envelope's existing `sig`, verified after decryption.
- **Dedup key** = `blake3(capsule_bytes)[..16]`, used by every relay tier. Stamp it as
  `sc.entry_hash` alongside `sc.author`/`sc.seq`/`sc.drop_reason` at each drop-decision
  point per `infra/otel/README.md` (phone-side; antennas don't emit OTLP in v1).

### 3.3 Threat model summary

| Adversary                  | Sees                                                                     | Cannot                                                                              |
| -------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Passive radio sniffer      | opaque capsules, rotating tags, node beacons                             | link a person across epochs; read anything                                          |
| Malicious/compromised node | which tags were queried together this epoch; capsule sizes/timing        | decrypt; link across epochs; forge (AEAD+inner sig)                                 |
| Flooder                    | can congest radio / fill LRU caches                                      | corrupt or read; mitigations: per-origin token bucket, TTL, small fixed frame sizes |
| Colluding nodes            | co-queried tag sets within one epoch (social-graph shadow, epoch-scoped) | resolve tags to identities                                                          |

Accepted residual: nodes learn _"some radio asked for these 12 ephemeral tags."_ This is
strictly less than the hosted stash already learns, and nodes are our hardware.

## 4. Wire protocols

### 4.1 BLE mailbox (phone ⇄ antenna/node) — the one mandatory phone protocol

Antenna advertises (extended adv where possible, legacy fallback):

- **Service UUID** `5C1DC0DE-0001-4A75-9E00-4D41494C4258` ("MAILBX")
- iBeacon frame interleaved: one org-wide **proximity UUID**
  `5C1DC0DE-BEAC-4A75-9E00-000000000001`, `major` = deployment id, `minor` = node id.
  Static IDs are fine: the _infrastructure_ broadcasts, never the person.

GATT (v1; L2CAP CoC via PSM characteristic is the planned v1.1 throughput upgrade):

| Char      | UUID suffix | Props          | Purpose                                                                                                                                               |
| --------- | ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node Info | `…0002`     | read           | `{fw_ver, node_id, epoch_now, backbone_ok, cache_stats}` (CBOR)                                                                                       |
| Query     | `…0003`     | write          | phone → node: chunked CBOR `{tags: [[u8;16]], have: [[u8;16]]}` (≤ 64 tags = 3 epochs × ~21 friends; `have` = dedup keys already held for those tags) |
| Deliver   | `…0004`     | indicate       | node → phone: chunked capsules matching `tags` minus `have`                                                                                           |
| Submit    | `…0005`     | write w/o resp | phone → node: chunked own capsules                                                                                                                    |

Chunking: negotiate MTU, frame = `{u16 msg_id, u16 idx, u16 total, bytes}`; a full
mailbox sync is ≤ a few KB and must complete inside an iOS background wake window
(**hard budget: 8 s** from connect to disconnect — acceptance criterion for the spike).

Node behavior: index capsules by `tag`; **LWW per tag** for the live set (a tag already
encodes author+recipient+epoch, so "latest capsule per tag by inner arrival order" is
the live position; keep a small per-tag ring (4) for jitter). Answer Query from local
cache only — never block on backbone.

### 4.2 ESP-NOW backbone (antenna ⇄ antenna)

- Frame ≤ 250 B ⇒ capsules (~300–450 B) fragment:
  `{u8 ver, u8 flags, u16 net_id, u32 frag_group, u8 idx, u8 total, u8 ttl, bytes}`.
- **Flood with dedup**, TTL ≤ 4, per-origin token bucket (default 2 capsules/s/origin),
  LRU dedup cache of frag_group + capsule dedup keys.
- LR mode on point-to-point long hops (elevated antennas); normal ESP-NOW in clusters.
- Bare antennas keep an **LRU capsule cache** (PSRAM-bounded, current epochs only) —
  they are mailboxes for phones out of smart-node range, not full replicas.

### 4.3 Smart-node replication & egress

Smart nodes run the existing trail-stash (iroh-docs). Venue live set: 10 k users ×
~5 recipients × ~400 B, LWW ⇒ **~20 MB total, non-growing** — trivial for phone/Pi
class hardware and WiFi backhaul. Egress node = a smart node that additionally syncs
with the hosted stash exactly as any device does today; capsules unwrap nowhere —
recipients' phones do the only decryption, on-site or at home.

### 4.4 USB-NCM (dongle posture)

Antenna enumerates as CDC-NCM (esp-idf `tusb_ncm` example is the starting point),
serves RA/DHCP for one link-local /64 (or 169.254/16), forwards IP ⇄ mesh frames for
the mailbox port only (it is a modem, not a general NAT). Phone side: it's just a
network interface — the app's iroh node uses it directly. iOS: fat pipe while app
foreground; the dongle's BLE side stays the background channel (persistent connection +
notify-on-arrival). Android: full function under the foreground service.

## 5. Phone integration

Code placement (follow existing module conventions; bun + `bunx expo install`, routes
untouched — this is a background feature + one settings/dev surface):

- `modules/iroh-location/rust`: capsule seal/open/tags (UniFFI), capsule store, LWW
  merge. **All crypto stays in Rust.**
- `modules/mesh-radio/` (new Expo module): BLE central (scan/connect/GATT chunking),
  iBeacon region monitoring (iOS), foreground-service wiring (Android). No crypto —
  bytes in, bytes out to the Rust core.
- `src/features/mesh/`: orchestration (when to sync, which tags, telemetry), settings
  UI, dev screen (node RSSI, last sync, cache stats). Any env config read statically
  per the `EXPO_PUBLIC` convention.

### 5.1 iOS ladder (cheapest → richest; each layer additive)

1. **iBeacon region wake** — first contact + roaming. App already holds Always
   location. Region entry launches even a terminated app (§2.2; not force-quit).

```swift
// modules/mesh-radio/ios — wake on any deployment node
let region = CLBeaconRegion(
  uuid: UUID(uuidString: "5C1DC0DE-BEAC-4A75-9E00-000000000001")!,
  identifier: "sc.mesh.node")
region.notifyOnEntry = true
locationManager.startMonitoring(for: region)
// didEnterRegion → beginBackgroundTask → meshSyncOnce() (≤ 8 s) → end task
```

2. **Background GATT sync** in the wake window; after first contact, keep a
   **pending `connect()`** to every seen node (auto-reconnect on sight) and rely on
   CoreBluetooth **state restoration** (`CBCentralManagerOptionRestoreIdentifierKey`).
3. **Personal dongle**: persistent BLE connection; dongle notifies on traffic-for-you →
   wake → sync. USB-NCM fat pipe when foreground/plugged.
4. **Later**: node WiFi via `NEHotspotConfiguration` (persistent config, auto-join;
   test captive-portal behavior — open question Q3), MFi `external-accessory`
   background session if the antenna productizes, friend-pair Wi-Fi Aware folded into
   the friend-add ceremony.

Failure honesty: after user force-quit, nothing revives the app. Surface "mesh paused —
open the app" via the dongle posture where detectable; otherwise accept it.

### 5.2 Android

Everything under the existing background/foreground-service architecture (do **not**
add battery-optimization prompts — AGENTS.md). BLE central sync identical to iOS minus
the wake gymnastics. Optional: unpaired Wi-Fi Aware subscribe for Android↔Android
direct exchange (same capsules; treat as another mailbox transport).

## 6. Implementation plan (agent-ready)

Workstreams are independent unless noted. Every PR: `just check`, jest-expo for TS,
`cargo test` for Rust; wire formats above are **normative** — add test vectors in
`modules/iroh-location/rust/tests/mesh_vectors.rs` first (W1) and make every other
implementation (firmware included) pass them.

**Spike 0 (do first, hardware on desk):**

- **S0.1 — iPhone accepts TinyUSB NCM.** Flash esp-idf `tusb_ncm` on an S3 devkit, plug
  into iPhone 15+: Settings shows Ethernet? App can hit a link-local TCP socket?
  Fallback order: NCM → ECM → declare iPhone-dongle BLE-only. _Deliverable: yes/no +
  descriptor set that worked, committed to `firmware/antenna/README.md`._
- **S0.2 — pocketed-iPhone wake→sync.** Devkit advertising iBeacon + MAILBX GATT with
  a stub mailbox; test app with region monitoring + state restoration. Measure: wake
  rate walking in/out of range ×20 (app suspended AND terminated), time from entry →
  sync-complete (budget 8 s), pending-reconnect behavior. Same harness on the Pixel.
  _Deliverable: numbers table in `docs/mesh/spike-results.md`. This gates everything._

**W1 — Rust core** — ✅ **DONE** (`modules/iroh-location/rust/src/mesh.rs`): capsule
seal/open, tag derivation, epoch logic (±1), LWW capsule store with dedup keys, UniFFI
surface, **test vectors**. No radio. As built:

- `mesh_constants` / `mesh_epoch` / `mesh_expected_tags` / `mesh_capsule_header` /
  `mesh_capsule_seal` / `mesh_capsule_open`, plus `mesh_seal_fix` (fix → **one capsule per
  recipient**, so the per-recipient rule is structural rather than a convention) and
  `mesh_open_fix` (capsule → envelope → verified `LocationFix`, feeding the existing
  friend-presence path). Mailbox = the `MeshCapsuleStore` object (`insert` / `have` /
  `deliver` / `latest` / `prune` / `stats`) — exactly the §4.1 Query/Deliver exchange with
  the radio removed, so W3 can drive it against a simulator.
- `insert` returns the `sc.drop_reason` string directly. Telemetry stamps **two** hashes,
  not one: `sc.entry_hash` stays the envelope hash (the existing cross-device join key with
  the stash), and `sc.capsule_hash` is the radio-tier dedup key antennas key on. A capsule
  the phone drops before decryption only has the latter.
- One deviation worth knowing: `shared_secret` rejects low-order peer keys, so a forged
  contact card cannot pin a friend onto a predictable tag stream.
- Bindings: Kotlin **and** Swift sources regenerated (the generator runs on any host — only
  the Android `.so` cross-compile and the iOS XCFramework need NDK/macOS, and neither is
  tracked). CI regenerates both binding sets on every PR, so the native `mesh*` symbols reach iOS without a
  Mac in the loop; only the XCFramework compile still needs one (EAS does it for cloud builds).

**W2 — Antenna firmware v1** (`firmware/antenna/`, esp-idf/C): BLE peripheral (adv +
iBeacon + MAILBX GATT + chunking), capsule LRU keyed by tag (opaque bytes — firmware
never parses capsule interiors beyond `{v, epoch, tag}`), ESP-NOW flood/dedup/TTL/
fragmentation, NCM posture from S0.1. Must pass W1's vectors for `{v,epoch,tag}`
parsing. Simulator-first: a `just mesh-sim` host build of the mailbox/flood logic with
fake radios so logic is testable without hardware.

**W3 — mesh-radio module + TS orchestration** (`modules/mesh-radio/`,
`src/features/mesh/`): BLE central + chunking, beacon wake (iOS), sync loop (compute
tags via W1 → Query/Deliver/Submit → feed capsules to Rust store → surface fixes
through the **existing** friend-presence path so the map needs zero changes), sc.*
telemetry at every drop/skip decision, dev screen. Depends on W1; testable against W2's
simulator over TCP before hardware exists.

**W4 — smart node + egress**: trail-stash deployment profile for venue nodes (it's the
existing server + a mailbox sidecar speaking §4.1 over BLE via a USB antenna),
antenna-as-backhaul bridging, egress = stock stash sync. Depends on W2.

**W5 — field test**: 3 antennas + 2 smart nodes + 4 phones in a park with airplane-mode
SIMs. Scripted walk pattern; success = every phone's map shows every friend ≤ 90 s
after each fix, verified via sc.* traces pulled post-hoc.

**Deferred (design slots exist, do not build now):** mule mode (stranger phones as
capsule carriers), friend-pair Wi-Fi Aware, L2CAP CoC, `NEHotspotConfiguration` node
WiFi, MFi, Aware-4.0-on-ESP32 watch (esp-idf #16743).

## 7. Open questions

| #   | Question                                                                            | Resolves in                         |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| Q1  | Does iPhone accept TinyUSB NCM descriptors?                                         | S0.1                                |
| Q2  | Beacon-wake reliability & 8 s sync budget, pocketed/terminated?                     | S0.2                                |
| Q3  | Offline node WiFi vs captive-portal detection / `NEHotspotConfiguration` `joinOnce` | W4 (deferred if BLE suffices)       |
| Q4  | ESP-NOW/LR duty-cycle & EIRP compliance per target region; battery Wh per node-day  | desk-check before W2 hardware spend |
| Q5  | Per-tag ring depth vs live-map jitter under real GPS cadence                        | W5                                  |
| Q6  | Antenna cache sizing: PSRAM budget vs venue population for bare antennas            | W2 sim + W5                         |

## 8. Capacity math (why nothing here is scary)

- Fix payload ≈ 200–400 B per capsule; 1 fix/min/user; N ≈ 5 recipients avg.
- Venue live set (LWW): 10 000 × 5 × 400 B ≈ **20 MB, non-growing** → full replica on
  smart nodes, LRU slice on antennas (8 MB PSRAM ≈ 20 k capsules ≈ 4 k users' worth).
- Phone sync: ≤ 64 tags queried, delta typically < 10 capsules ≈ **< 4 KB per wake** —
  comfortably inside the 8 s budget even at GATT-chunk rates.
- Backbone: site-wide fresh traffic ≈ 10 k × 5 × 400 B/min ≈ 333 KB/s worst-case flood
  — fine on WiFi backhaul; ESP-NOW segments only carry their locality's slice + TTL-4
  flood, and token buckets shed the rest (drops are re-covered by the next fix a
  minute later; stamp `sc.drop_reason`).
