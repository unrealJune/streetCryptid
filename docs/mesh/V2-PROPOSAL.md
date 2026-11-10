# streetCryptid — Mesh v2 proposal (pucks, HaLow carriers, offline messaging)

> Status: **proposal, rev 1 (2026-11-10). Nothing here is implemented or measured.** This is a
> brainstorm record, not a spec. [`DESIGN.md`](./DESIGN.md) stays the design of record until the
> spikes in §11 are run. Every capacity number below is arithmetic, and several prices are
> estimates. Read `DESIGN.md`, [`../social/FORWARD-SECRECY.md`](../social/FORWARD-SECRECY.md) and
> [`../social/POST-QUANTUM.md`](../social/POST-QUANTUM.md) first; §5 says where this proposal
> departs from them.

## 1. Summary

An offline mesh where anyone in a crowd can find their friends, with uniform privacy at any crowd size, looks feasible on hardware that can be bought today.

What changes from the design of record:

- **Personal pucks.** Every user can carry an ESP32-S3 puck, in addition to antennas placed around a venue. The phone keeps all keys; the puck only moves ciphertext.
- **HaLow for reach.** About 5 in 100 pucks are carriers with a sub-GHz HaLow radio that joins clusters across a venue. ESP-NOW handles everything local.
- **Every puck holds everything.** Capsules shrink from about 400 bytes per friend to about 45 bytes per fix, so the whole venue's state floods to every puck. Nobody queries for anything, so there is nothing to observe.
- **Messaging is in scope.** It is a non-goal in the design of record.
- **Room for post-quantum key exchange.** Big key-exchange material moves to a separate, chunked session plane.
- **Abuse resistance.** Anonymous hardware-backed tickets plus per-capsule broadcast authentication, both still research.

What stays unsolved: jamming can be tolerated but not prevented, and a transmitting puck can always be located by its signal. Internet egress is deferred, not dropped.

## 2. Architecture

Three links, three radios, and no routing anywhere: every puck is a full replica of the venue's ciphertext.

```
  CLUSTER A (one part of the crowd)            CLUSTER B (across the venue)
 ┌───────────────────────────────────┐        ┌───────────────────────────────────┐
 │  ┌─────────┐      ┌─────────────┐ │ HaLow  │ ┌─────────────┐      ┌──────────┐ │
 │  │  Phone  │      │ Carrier puck├─┼────────┼─┤ Carrier puck│      │ Friend's │ │
 │  │ (keys)  │      │  (+ HaLow)  │ │915 MHz │ │  (+ HaLow)  │      │  phone   │ │
 │  └────┬────┘      └──────┬──────┘ │        │ └──────┬──────┘      └────┬─────┘ │
 │       │ BLE              │ESP-NOW │        │        │ESP-NOW           │ BLE   │
 │  ┌────┴────┐ ESP-NOW ┌───┴──────┐ │        │ ┌──────┴─────┐ ESP-NOW ┌──┴─────┐ │
 │  │Your puck├─────────┤  Other   │ │        │ │   Other    ├─────────┤Friend's│ │
 │  │(cipher- │         │  pucks   │ │        │ │   pucks    │         │  puck  │ │
 │  │  text)  │         │(replicas)│ │        │ │ (replicas) │         │        │ │
 │  └─────────┘         └──────────┘ │        │ └────────────┘         └────────┘ │
 └───────────────────────────────────┘        └───────────────────────────────────┘
```

Each cluster floods over ESP-NOW. Only the carriers span the distance between clusters.

| Link                      | Radio                                          | What it does                                                      |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| Phone to its own puck     | BLE mailbox (`DESIGN.md` §4.1, unchanged)      | Phone seals and opens capsules; the puck stores and forwards them |
| Puck to puck              | ESP-NOW broadcast, 2.4 GHz                     | Replicates every capsule to every puck within a few hops          |
| Carrier to carrier        | Wi-Fi HaLow, 902 to 928 MHz                    | Joins clusters across the venue; about 5 carriers per 100 people  |
| Carrier to egress (later) | HaLow client to an access point with an uplink | Syncs to the hosted trail-stash for off-site friends              |

Rules that hold across all of it:

- **The puck is keyless.** Keys and crypto stay on the phone, in the Rust core. A lost puck loses nothing.
- **Nothing is routed.** Pucks rebroadcast with suppression and reconcile set differences with neighbors. There is no path for a malicious puck to claim.
- **A puck is optional.** A phone without one syncs over BLE with any nearby puck, as it would with a placed antenna (§3).
- **Carriers ride high.** A 915 MHz antenna against a body loses a lot of signal (unmeasured), so a carrier belongs on a backpack or a totem, not in a pocket.

The carrier link is the least certain part. Morse Micro's microcontroller SDK has no mesh mode, and its access-point mode is beta and capped at 4 clients ([forum](https://community.morsemicro.com/t/does-the-mm6108-support-802-11s-or-mesh/421), [release notes](https://www.morsemicro.com/resources/software_releases/iot/MM-IoT-SDK-Software-Release-Notes.pdf)). The fallback is Linux-class carriers running 802.11s, which Morse's OpenWrt build limits to 20 mesh peers ([release notes](https://docs.morsemicro.com/software-releases/openwrt-software-release-notes)).

This replaces the TTL-4 flood of `DESIGN.md` §4.2. That flood was sized for sparse fixed antennas; with 100 pucks in mutual range every capsule would be rebroadcast 100 times.

## 3. Phones without a puck

A phone with no puck can still use the mesh as a leaf: it is a BLE client to anyone else's puck, the same way it would talk to a placed antenna.

| Situation                           | What works                                                                                                    | Limits                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Someone's puck is in BLE range      | Drop off own capsules and pick up friends' through that puck's mailbox, on iOS and Android, in the background | Range is BLE only, perhaps 10 to 30 m in a crowd (unmeasured); the phone never relays for others |
| No pucks, friend is in direct range | Paired friends exchange directly over Wi-Fi Aware; Android to Android works unpaired                          | iOS Wi-Fi Aware is pairing-only, so the pairing must be folded into the friend-add step          |
| No pucks, both apps open            | BLE phone to phone                                                                                            | Background-to-background discovery between iPhones is unreliable                                 |

What a puckless phone gives up:

- **Some privacy.** The whole venue's state is too large to pull over BLE inside an 8-second wake, so the phone asks for specific tags. A stranger's puck sees which tags were asked for together in that epoch. Asking by tag prefix and downloading the whole bucket would blur that.
- **Ticket source.** If abuse tickets are tied to puck hardware, puckless phones need another way to earn them, probably the platform's app attestation.

Wi-Fi Aware cannot carry the mesh itself. The constraints ledger in `DESIGN.md` §2.2 already settles this: iOS only allows it between paired devices, and the ESP32's version does not interoperate with iPhones.

## 4. Crypto and wire format

Split the traffic into two planes: a small symmetric data plane that floods constantly, and a session plane that carries the big, rare key-exchange material.

**Data plane (location fixes)**

- Each author holds a sender key shared with their friends. The epoch key and the over-the-air tag derive from it and the epoch number.
- One capsule per fix, not one per friend. No public-key operation per fix.
- Proposed capsule, about 45 bytes: version and class (1), epoch (2), tag (8), counter (2), ciphertext for a venue-grid position and timestamp (about 12), AEAD tag (12), broadcast-auth MAC (8).
- A fix is sent only when the user has moved.

**Session plane (pairwise)**

- The existing pairwise ratchet sessions distribute and rotate sender keys and carry messages.
- Asymmetric ratchet steps run over iroh whenever a phone is online. Over the mesh they travel as low-priority, erasure-coded chunks, the way Signal's SPQR does it ([paper](https://cs.nyu.edu/~dodis/ps/migrating.pdf)).
- A naive ML-KEM-768 step is 2,272 bytes ([NIST talk](https://csrc.nist.gov/csrc/media/presentations/2025/post-quantum-ratcheting-for-signal/post-quantum_ratcheting-schmidt_1.14.pdf)). Chunked, it is about 50 capsule-sized pieces, any sufficient subset of which rebuilds it.
- Offline, keys hash-ratchet forward each epoch. Forward secrecy holds at epoch granularity; post-compromise healing pauses until the next asymmetric step.

**Why this is also a post-quantum answer for the mesh**

Today's capsule key derives from a static X25519 secret (`DESIGN.md` §3.2), so a recording of the venue's radio can be decrypted if that ever breaks. Deriving sender keys from a session root that was established with a hybrid post-quantum exchange makes the recorded traffic safe at no per-capsule cost.

**Format room**

- Capsules pad to a few fixed sizes so a fix, a message and a session chunk look alike in length.
- A 2-bit class stays visible so relays can shed load (fix, message, session, ticket). That leaks the kind of capsule; it is a deliberate trade.
- This replaces the normative format in `DESIGN.md` §3.2, so it needs a new version byte and new test vectors.

**Costs of the sender key**

- Removing one friend means rotating the key and redistributing it to everyone else.
- All of an author's friends look for the same tag. That is harmless only while every puck holds everything and nobody queries.

## 5. Fit with the existing security docs

This proposal departs from two documents of record, and both departures need a decision before any code.

- **Sender key versus per-pair message keys.** `FORWARD-SECRECY.md` §4.2 gives every friend their own message key for every fix, one AEAD invocation per key. A sender key shared across friends gives that up on the mesh path: forward secrecy becomes per epoch, not per message, and removing a friend takes a key rotation instead of dropping one wrap. If that is unacceptable, per-recipient capsules of about 45 bytes still cut traffic roughly 9 times against today's 5 capsules of 400 bytes, before any ratchet header.
- **Ratchet header size.** `POST-QUANTUM.md` §3 notes the 32-byte ratchet public key rides in every wrap. A 45-byte capsule has no room for it, so the mesh path would carry ratchet steps only on the session plane.
- **Post-quantum on the mesh.** `POST-QUANTUM.md` §3 recommends a hybrid re-key at epoch boundaries, not per message, and defers the mesh question to P3. "Re-key online, coast offline" is the same idea with the re-key moved off the radio; chunked session capsules are the option for re-keying while offline. This proposal is input to that P3 decision, not a replacement for it.
- **No skipped-message keys.** `FORWARD-SECRECY.md` §4.2 deliberately stores none, because location is last-write-wins. Messages are not, so messaging (§6) needs either a separate message chain with bounded skipped-key storage or strictly ordered delivery. §9 of that document rejects the skipped-key table for location; the argument has to be re-examined for messages.

## 6. Messaging over the mesh

Messages reuse the envelope with a new payload type, but they break three assumptions the location design relies on.

| Location assumes                         | Messages need             |
| ---------------------------------------- | ------------------------- |
| Last write wins per tag                  | A queue per conversation  |
| Capsules expire after the next epoch     | Retention until delivered |
| A dropped fix is covered by the next one | Acks and retransmission   |

Proposed handling:

- **Pairwise.** One capsule per recipient under the pairwise session key, about 150 to 250 bytes. Groups are pairwise fan-out for now.
- **Short flood lifetime.** A message floods for about 10 minutes, then pucks drop it. The sender's puck retransmits with backoff until an ack capsule comes back.
- **Presence-triggered resend.** When the sender's puck sees the recipient's location tag appear in the flood, it knows they are in the mesh and resends anything pending. This avoids a slow-rotating mail tag, which would weaken unlinkability.
- **Budget.** A per-puck cap on messages per minute, enforced by the same tickets that limit location capsules.
- **Online.** Over iroh-docs, each message is its own entry, not a last-write-wins slot.

## 7. Threat model

Reading, forging and cross-epoch linking are covered by the existing design; flooding is the open research problem, and jamming and physical tracking are accepted limits.

| Adversary       | What they can do                                | Answer                                                      | State                    |
| --------------- | ----------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| Passive sniffer | Record all radio traffic                        | AEAD, rotating tags, post-quantum session root              | Designed                 |
| Malicious puck  | Drop or swallow what passes through it          | No routing; suppressed flooding plus reconciliation         | Designed                 |
| Flooder         | Inject junk capsules to fill airtime and memory | Anonymous tickets plus per-capsule broadcast authentication | Research                 |
| Sybil           | Pose as many pucks                              | Tickets issued only to genuine hardware                     | Research                 |
| Radio tracker   | Locate a transmitter by signal strength         | Rotate every radio address each epoch, HaLow included       | Accepted residual        |
| Jammer          | Deny a band                                     | Three bands, carry-out on foot, tell the user               | Tolerated, not prevented |

**Tickets plus TESLA**

- While online, each genuine puck collects blind-signed tickets for an event. The ESP32-S3's signature peripheral keeps its key out of software's reach ([Espressif](https://docs.espressif.com/projects/esp-idf/en/v4.4.8/esp32s3/api-reference/peripherals/ds.html)), so a puck can prove it is real without saying which one it is.
- A ticket commits to a hash chain. Each capsule carries a short MAC whose key is disclosed one interval later, the TESLA pattern from sensor networks ([Liu and Ning](https://people.cs.vt.edu/~wjlou/htmls/teaching/CS6204-F11/files/MutiTesla-liu.pdf)). Verification is symmetric-only and needs loosely synchronized clocks.
- Relays enforce a rate per ticket. An attacker's junk budget becomes the number of pucks they bought.
- Known weak spot: relays must buffer capsules until the key is disclosed, which is itself a flooding target ([Ren, Lou, Zhang](https://www.cnsr.ictas.vt.edu/publication/chapter/BookChapter_Ren09.pdf)).

**Jamming**

Jam-resistant broadcast without shared secrets exists in research: the sender picks a spreading code at random from a public set and receivers search for it ([Pöpper, Strasser, Čapkun](https://static.usenix.org/events/sec09/tech/full_papers/popper.pdf)). It needs a custom radio front end, not a Wi-Fi or HaLow chip. The practical position is tolerance:

- Spread across 2.4 GHz, sub-GHz and BLE so a jammer must cover all three.
- Every puck holds the whole venue, so walking out of the jammed area resyncs it.
- Detect jamming and say so in the app.

## 8. Capacity math

Shrinking the capsule cuts venue-wide traffic about 45 times, which is what lets every puck carry everything. These figures are calculated at one fix per person per minute, before any rebroadcast overhead.

| Crowd   | Design of record (5 capsules of 400 B) | v2 (1 capsule of 45 B) | v2 live set in memory |
| ------- | -------------------------------------- | ---------------------- | --------------------- |
| 100     | 27 kbps                                | 0.6 kbps               | 4.5 KB                |
| 1,000   | 267 kbps                               | 6 kbps                 | 45 KB                 |
| 10,000  | 2.7 Mbps                               | 60 kbps                | 450 KB                |
| 100,000 | 27 Mbps                                | 600 kbps               | 4.5 MB                |

How that sits against the hardware:

- **Memory.** The puck has 8 MB of PSRAM. A 100,000-person live set fits, but index overhead makes it tight.
- **Radio.** ESP-NOW defaults to a 1 Mbps PHY rate, at which Espressif measured about 214 kbps of real throughput in the open ([FAQ](https://docs.espressif.com/projects/espressif-esp-faq/en/latest/application-solution/esp-now.html)). With two to three times overhead for redundancy, 10,000 people fits at the default rate.
- **Headroom.** The rate is configurable per peer up to the fastest Wi-Fi rates, and v2.0 frames hold 1,470 bytes, so one frame batches about 30 capsules (same FAQ). 100,000 people needs the faster rates, which is plausible when neighbors are meters apart.

Not counted: messages, tickets and session chunks, which add load; movement gating, which removes it. The simulator in §11 exists to replace this table with measurements.

## 9. Open questions

Ranked by how badly a wrong answer hurts the plan.

1. **Can a microcontroller send HaLow frames without associating?** Carrier-to-carrier links on an ESP32-S3 depend on it. If not, carriers are Linux-class, or one carrier acts as an access point for up to 4 others.
2. **Does iOS wake and sync reliably?** Spike S0.2 in `DESIGN.md` §6 (beacon wake, 8-second BLE sync, pocketed and terminated) has no recorded results. The puck idea depends on it more than the placed-antenna design did.
3. **Is a sender key acceptable on the mesh path?** See §5.
4. **Does flood plus reconciliation hold at 10,000 pucks?** Only simulation or a field test can say.
5. **How long does a puck last?** One retailer lists the XIAO ESP32-S3 Plus at about 81 mA with Wi-Fi active ([Botland](https://botland.store/xiao/29648-seeed-xiao-esp32-s3-plus-wifi-bluetooth-16-mb-flash-arduino-micropython-seeedstudio-102010671.html)), which is roughly 12 hours on 1,000 mAh before BLE or HaLow. Needs measuring.
6. **How far does one ESP-NOW hop reach through a crowd,** at the default rate and at fast rates?
7. **Can tickets be small enough?** At 100,000 people, ticket storage may not fit in memory. The issuing and attestation flow is undesigned.
8. **How exposed is the ticket key?** ESP32 chips have a history of fault-injection attacks (unverified).
9. **How much signal does a body-worn 915 MHz antenna lose,** and what does a carrier look like as an object?
10. **Where is HaLow legal and useful?** The US band is wide. Europe's is heavily restricted ([heise](https://heise.de/-11152896)).

## 10. Hardware to buy

About $300 covers the local mesh and the first HaLow link, or about $430 with measurement tools. Listed prices were checked on 2026-11-10 and exclude tax and shipping; estimates are guesses and need a real quote.

| Phase         | Item                                                                                                                                                 | Qty | Unit price | Line total | Price basis |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------- | ---------- | ----------- |
| 1. Local mesh | [Seeed XIAO ESP32-S3 Plus](https://www.robotshop.com/products/seeed-studio-xiao-esp32s3-plus-unsoldered) (8 MB PSRAM, 16 MB flash, battery charging) | 6   | $8.54      | $51        | Listed      |
| 1. Local mesh | 3.7 V LiPo cell, about 1,000 mAh                                                                                                                     | 6   | $7         | $42        | Estimate    |
| 1. Local mesh | Headers, perfboard, USB-C cables                                                                                                                     | 1   | $15        | $15        | Estimate    |
| 2. HaLow      | [Seeed Wi-Fi HaLow module for XIAO](https://www.seeedstudio.com/Wio-WM6180-Wi-Fi-HaLow-Module-for-XIAO-p-6395.html) (MM6108, 902 to 928 MHz)         | 3   | $14.90     | $45        | Listed      |
| 2. HaLow      | 915 MHz antenna plus SMA to I-PEX pigtail                                                                                                            | 3   | $8         | $24        | Estimate    |
| 2. HaLow      | [GL.iNet HaLowLink 2](https://store-us.gl-inet.com/products/halowlink2) access point                                                                 | 1   | $129.90    | $130       | Listed      |
| Tools         | Nordic Power Profiler Kit II                                                                                                                         | 1   | $100       | $100       | Estimate    |
| Tools         | nRF52840 USB dongle as a BLE sniffer                                                                                                                 | 1   | $10        | $10        | Estimate    |
| Tools         | RTL-SDR receiver to see the 915 MHz band                                                                                                             | 1   | $35        | $35        | Estimate    |

Notes before ordering:

- **Six pucks, three carriers.** Six is the smallest group that shows multi-hop flooding; three HaLow modules give two carriers and a spare.
- **Cheaper access point.** The [Heltec HT-H7608 V2](https://openelab.com/collections/wireless-iot-wifi) lists at $100.56. HaLowLink 2 is the better-documented Morse reference.
- **Antennas.** Seeed's wiki names verified antenna models for the HaLow module; buy those, not a generic one ([wiki](https://wiki.seeedstudio.com/getting_started_with_wifi_halow_module_for_xiao/)).
- **Headers.** Retailers disagree on whether the Plus board ships with pin headers. Check the listing.
- **iPhone.** Spike S0.1 (USB ethernet into the phone) needs a USB-C iPhone, model 15 or later.
- **Not yet.** Raspberry Pi nodes for an 802.11s lattice are only worth buying if open question 1 comes back negative. OpenMANET lists Seeed's SPI HaLow board as Pi 4-only for now ([hardware page](https://openmanet.github.io/docs/hardware)).
- **No custom board.** Stay on certified modules until the radio choice is settled.

## 11. Next steps

The first three can start today and need no hardware on the desk.

- [ ] Ask Morse Micro's community forum whether the microcontroller SDK can transmit without association (open question 1).
- [ ] Order phases 1 and 2. The HaLow parts ship from China, so order them with the first batch.
- [ ] Build the `just mesh-sim` harness: suppressed flooding plus reconciliation with fake radios at 100, 1,000 and 10,000 pucks, reporting airtime per neighborhood.
- [ ] Run spike S0.2 on the first two boards: beacon wake and an 8-second BLE sync, phone pocketed, app suspended and terminated. Record results in `docs/mesh/spike-results.md`.
- [ ] Decide the sender-key question in §5, then draft capsule v2 in `modules/iroh-location/rust/src/mesh.rs` with new test vectors.
- [ ] Bring up HaLow: one XIAO plus module as a client of the HaLowLink 2, pushing test-vector capsules.
- [ ] Walk test through a real crowd: ESP-NOW at default and fast rates beside HaLow, logging range and loss.
- [ ] Measure puck current draw in each radio posture.
- [ ] Decide microcontroller or Linux carriers once the forum answer and the HaLow bring-up are in.
- [ ] Fold what survives into `DESIGN.md`.

## 12. Sources

These were read as search results on 2026-11-10, not opened in full.

- [Morse Micro community: does the MM6108 support 802.11s or mesh](https://community.morsemicro.com/t/does-the-mm6108-support-802-11s-or-mesh/421)
- [Morse Micro MM-IoT-SDK release notes](https://www.morsemicro.com/resources/software_releases/iot/MM-IoT-SDK-Software-Release-Notes.pdf)
- [Morse Micro OpenWrt release notes](https://docs.morsemicro.com/software-releases/openwrt-software-release-notes)
- [morsemicro/halow ESP-IDF component](https://components.espressif.com/components/morsemicro/halow)
- [Espressif ESP-NOW FAQ](https://docs.espressif.com/projects/espressif-esp-faq/en/latest/application-solution/esp-now.html)
- [Espressif ESP32-S3 Digital Signature peripheral](https://docs.espressif.com/projects/esp-idf/en/v4.4.8/esp32s3/api-reference/peripherals/ds.html)
- [Dodis et al., Triple Ratchet paper](https://cs.nyu.edu/~dodis/ps/migrating.pdf)
- [NIST talk: post-quantum ratcheting for Signal](https://csrc.nist.gov/csrc/media/presentations/2025/post-quantum-ratcheting-for-signal/post-quantum_ratcheting-schmidt_1.14.pdf)
- [Liu and Ning, Multilevel µTESLA](https://people.cs.vt.edu/~wjlou/htmls/teaching/CS6204-F11/files/MutiTesla-liu.pdf)
- [Ren, Lou, Zhang, Multi-user Broadcast Authentication](https://www.cnsr.ictas.vt.edu/publication/chapter/BookChapter_Ren09.pdf)
- [Pöpper, Strasser, Čapkun, Jamming-resistant Broadcast Communication without Shared Keys](https://static.usenix.org/events/sec09/tech/full_papers/popper.pdf)
- [OpenMANET hardware docs](https://openmanet.github.io/docs/hardware)
- [CNX Software on OpenMANET](https://cnx-software.com/2026/09/16/openmanet-a-higher-bandwidth-meshtastic-alternative-leveraging-802-11ah-wifi-halow)
- [heise on HaLowLink 2 and European limits](https://heise.de/-11152896)
