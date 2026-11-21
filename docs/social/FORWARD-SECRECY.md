# streetCryptid — Forward Secrecy (ratcheted envelopes over last-write-wins fixes)

> Status: **design of record; built and wired.** The schedule, store, session seam, and
> envelope v3 live in `modules/iroh-location/rust`, and every **fix** lane now uses them:
> the fix and null docs slots (and, until 2026-11 removed it, the app gossip lane). Sessions are bootstrapped by the SAS bump itself
> (`pairing.rs`), so there is no manual seam and no JS-callable way to root one from
> anything weaker; the native drain drives §4.6 recovery (`recover_sessions`). Still v2 by
> construction, deliberately: the (since retired) live-mode control lane, the restart control record (it is what
> re-establishes a ratchet, so it cannot depend on one), the BLE mesh path (§8.1), and the web/WASM build,
> which has no durable store to keep sequential state in. This document
> supersedes the forward-secrecy line in [`ARCHITECTURE.md`](./ARCHITECTURE.md) §11
> ("full ratcheting … is out of scope for this phase") and **changes two of that
> document's stated goals** — §1.3 offline trail recovery is deleted, and the durable
> path collapses to last-write-wins. Keep the two in sync; `ARCHITECTURE.md` §4–6 must be
> revised when §7 of this plan lands.
>
> **Revision 2 (2026-08-06), after security review.** The strict one-fix-per-ack gate of
> revision 1 is replaced by a symmetric-lane Double-Ratchet schedule (§4): the v1 gate
> deadlocks on a burned key and couples publish availability to ack round-trips (see §9).
> This revision also adds desync recovery (§4.6), a wire-format section (§4.7), an
> erasure-hygiene surface (§5.4), rescopes the backup fix (§6), and states two residual
> risks previously implicit (§1).
>
> **Revision 3 (2026-08-13), after the second security review.** The schedule was found
> correct; the holes were around it. This revision makes persist-before-publish mean
> _fsync_ (§4.2), splits the node's storage into a purgeable data root and a durable,
> backup-excluded state root (§6), adds storage corruption as a distinct desync entry
> point and monotonic acceptance plus re-minting for resync records (§4.6). The schedule
> itself is unchanged.
>
> It also closes the gap the review named as its second-highest finding: the ratchet was
> **built but unreachable**. The bump now carries a ratchet ephemeral, bound into the SAS
> transcript and committed at `Hello`, so the figure the humans compare authenticates the
> root (§4.2); the null and live lanes moved to v3, which is what stops a watch-only edge
> lapsing after 24 h (§4.1); and the app runs the resync driver, distinguishes lapsed from
> desynced from needs-re-pair, and forgets a session on unfriend (§4.5, §4.6).
>
> **Migration, stated plainly:** the pairing ALPN went to `streetcryptid/pair/3` and a
> session can only come from a v3 pair, so **every friendship formed before this must be
> re-paired.** Until then those friends are dropped from each publish with `no_session`
> and the app shows "re-pair with this friend". This is a deliberate choice over a v2
> fallback, which would have kept the archive non-forward-secret for exactly the
> friendships that have existed longest.
>
> Re-pairing does **not** require being in the same room: invite/link pairs and nearby BLE
> pairs run the identical handshake and both bootstrap a session (§4.2). What the SAS gate
> needs is an out-of-band channel for the two humans to compare their figure on — see the
> note in §4.2 on what "out-of-band" has to mean for a link pair.
>
> **Revision 4 (2026-10-04), after two field failures of recovery.** §4.6's two-sided resync
> is replaced by a leader-decided restart against published, signed prekeys, carried on every
> envelope until answered, with the replaced sessions kept for decryption — Signal's X3DH +
> `PreKeySignalMessage` + Sesame, adapted to a store-and-forward channel. Detection now counts
> only distinct envelopes and adds a "stuck" verdict for a follower with no sending chain. The
> `rsy` slot now holds the control record (prekeys + restart requests). The schedule is
> unchanged. See "Why revision 3's resync was replaced" in §4.6.
>
> **Revision 5 (2026-11-10), after a review against the tree at v3.0.0.** No mechanism changes
> in this revision; it corrects what the document claims and lists the work that would make
> the claims true (§10). The threat model gains a copied-and-returned device, which is what
> post-compromise security is for, so §1 no longer calls it worthless. §1 and §4.7 now state
> the forward-secrecy window as it is (reader absence, not a small constant), §4.2 records
> that a healthy iPhone lapses, §4.7 withdraws the claim that rotating kids stop linking,
> §3 and §9 stop rejecting a symmetric chain for a reason revision 3 removed, and §8.1 gets
> a proposed answer for the mesh. Every correction is marked **[rev 5]**.
>
> Claims below are marked **[verified]** where checked against the tree at the time of
> writing, and **[MUST VERIFY]** where they are assumptions that gate the plan.

## 1. Goal and threat model

The threat we are designing against is **targeted device seizure by an adversary who
already holds the trail-stash ciphertext archive.** Both halves matter: seizure alone
yields whatever is on the phone, and the archive alone yields ciphertext. Together, under
today's design, they yield the complete decrypted history of everyone who has ever shared
with that device.

**[rev 5] A second threat: the device that comes back.** A phone taken at a border, a
checkpoint or an arrest can be imaged in minutes and handed back. The adversary then holds
a copy of every key and all ratchet state, and the owner keeps using the phone. Revisions
1–4 considered only a device that never returns. This one matters as much for the people
this design is for, and it changes what the ratchet is worth (see the note on
post-compromise security below).

In scope:

1. **Past traffic is unrecoverable.** An adversary holding the archive _and_ every key
   present on a seized device can decrypt no fix older than a bounded, small window.
2. **No plaintext history at rest.** Received location history is not retained on device.
3. **No ciphertext archive.** The stash holds the last thing it received, and that is
   structurally true rather than true-by-query.

**[rev 5] The window in claim 1 is not small today.** A receiver's chain moves only when it
opens an envelope, and on iOS that happens only while the app is mounted. A seized reader
can therefore open everything sealed for it since its owner last opened the app, up to the
acceptance window of `2^17` positions (§4.7, about seven months at the 5-minute cadence),
for as long as those ciphertexts still exist anywhere. Claim 3 is what should bound that,
and it is not met in this tree: superseded doc versions stay in the replica and no blob
collection is configured (§5.1, §5.2). Repair items R2 and R3 in §10 close the gap.

"Unrecoverable" and "not retained" are claims about _erasure_, not just deletion — SQLite
and flash storage keep deleted data recoverable by default. §5.4 bounds the gap; the
honest form of claim 1 is "no fix older than the last erasure pass," which §5.4 keeps
small, not zero.

**Post-compromise security (PCS), restated [rev 5].** PCS heals when a legitimate device
keeps running and ratchets forward. Against a device that is seized and kept it is worth
nothing: that device never ratchets again, and the mechanism that stops post-seizure access
is **revocation**, which already exists (`pool.ts:48` drops the recipient's wrap;
`crypto.rs` re-keys `K` per fix, so no wrap means no access). Against a device that is
copied and returned it is the whole defence: the owner's next DH step locks the copy out,
with nobody having to notice anything.

Revisions 1–4 said PCS was out of scope and that no part of the design should be justified
by it. That was inconsistent with the design. Healing is the one thing the DH ratchet, the
null fixes (§4.1), the lapse rule (§4.5) and the restart protocol (§4.6) provide that a
symmetric chain from the pairing ephemerals does not (§3). PCS is therefore **in scope for
a passive adversary holding a copy of the state**, and it is what that machinery is for.
It does not cover an adversary who also uses the copied identity key actively: the restart
path trusts a prekey signed by that key (§1.1).

### 1.1 Accepted residual risks — stated so nobody mistakes this design for covering them

- **A seized recipient device is a silent live tracker until revoked.** The adversary
  holds B's identity key and ratchet state and can keep the session healthy
  indistinguishably from B, receiving A's ongoing location. No ratchet fixes this — the
  adversary simply continues it — and PCS would not either. The only cutoff is A revoking,
  which requires A to _learn_ of the seizure. The lapse window (§4.5) at least forces the
  adversary to actively emit signed envelopes on B's cadence, which is observable evidence
  and a legal/opsec cost, but it is not prevention. This is a disclosure item, not a
  design item.
- **Metadata is not protected from the stash.** The stash operator sees each author's
  publish cadence, envelope sizes, and recipient count. Revision 1 was worse: today's wrap
  `kid` is a _stable_ hash of the recipient's receiving key (`crypto.rs:87` [verified]),
  so the archive clusters recipient sets _across authors_ — a shared-friend-graph leak.
  §4.7's rotating kids close that. Padded null fixes (§4.1) make watchers and sharers
  indistinguishable. Full traffic-analysis resistance remains a non-goal.
  **[rev 5]** Rotating kids do not close the recipient-linking leak while the ratchet
  header beside each kid is plaintext; see the correction in §4.7 and R5 in §10.
- **[rev 5] A copied identity key is a durable takeover.** The ed25519 identity never
  rotates (it is the iroh endpoint id), and a restart is rooted in a prekey that identity
  signs (§4.6). An adversary holding a copy of the device can publish its own control
  record and prekey and be restarted into the session. The DH ratchet heals against a
  copy that only listens; nothing here heals against one that writes. Binding the prekey
  signature to a hardware-held key exchanged at pairing would narrow this and is not
  designed.
- **[rev 5] A decrypted fix is non-repudiable.** Every envelope is signed by the author's
  long-term identity, and iroh-docs signs each entry as well. Anyone who obtains one
  content key can show a third party that the author published that position. Messengers
  avoid this with deniable authentication; this design does not, and removing it would
  mean changing how entries are authenticated to the stash and to relaying friends.

Non-goals this phase: multi-device identity, mesh-path forward secrecy (see §8), and
protection of the user's _own_ trail beyond a retention cap (§5.3).

## 2. What exists today

| Property          | State                                                                   | Evidence                                               |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Payload crypto    | ChaCha20-Poly1305 under a fresh random `K` per fix                      | `crypto.rs:145`                                        |
| Key wrap          | HPKE base mode, `DhKemX25519HkdfSha256`, per recipient                  | `crypto.rs:172`                                        |
| Sender-side FS    | **Holds.** HPKE discards the ephemeral; `K` is random and dropped       | `crypto.rs:146`                                        |
| Receiver-side FS  | **None.** `recvSecret` is long-term and has no rotation path            | `secure-keys.ts:33`                                    |
| Wrap recipient id | Stable `blake3(recvPub)[..8]` — linkable across envelopes and authors   | `crypto.rs:87`                                         |
| Local history     | Every friend's fixes as plaintext JSON, never pruned                    | `persistence.ts:137`, `prune()` at `:199` is dead code |
| Archive           | Stash retains indefinitely; no TTL                                      | no retention config in tree                            |
| Envelope `epoch`  | Overloaded: `0` on the docs path, mesh 15-min epoch via `mesh_seal_fix` | `location-sharing.ts:1243`, `lib.rs:412`               |
| Key persistence   | Best-effort, silently swallows failures                                 | `secure-keys.ts:35`, `state-store.ts:27`               |

The gap is precise and one-directional: **the static `recvSecret` versus the archive of
envelopes wrapped to it.** Sender-side FS already holds and needs no work.

## 3. The requirement

Forward secrecy requires that **some ephemeral secret contributed to the key derivation
and was subsequently deleted**, such that no combination of surviving long-term keys
reconstructs it.

This rules out the obvious cheap designs. A symmetric hash chain rooted in the pairing DH —
`RK₀ = KDF(X25519(a_recv_priv, b_recv_pub))` — has **no forward secrecy at all**: both
inputs are long-term, so an adversary seizing either device recomputes `RK₀` and derives
every message key from position zero. The same flaw is present in the mesh capsule design
today (`mesh.rs:108`, `ss_AB` from two static keys), which is why §8 leaves the mesh path
open rather than assuming this design covers it.

There are exactly two ways to obtain the ephemeral contribution:

- **Live DH** — ratchet on an exchange, delete the ephemeral private. Requires
  bidirectionality.
- **Prepublished one-time prekeys** — receiver publishes a batch, sender consumes one,
  receiver deletes the private after opening. Requires no liveness.

This design takes the first path and _manufactures_ the bidirectionality (§4.1).

**[rev 5] A third way exists once the root is ephemeral.** The objection above is to a
chain whose _root_ is static-static. Since revision 3 the pairing bump derives `RK₀` from
fresh ephemerals on both sides (`derive_boot_root`, §4.2). A symmetric chain exported from
that root, stepped forward and with old states deleted, is forward secret with no further
exchange: the deleted ephemerals and the deleted chain states are the contribution this
section asks for. It can be indexed by the clock, so both sides advance it alone.

What such a chain lacks is healing: a copy of its state follows it forever. That is the
reason the docs path keeps the DH ratchet (§1), and it is the only reason. Where there is
no return path to ratchet on, the clock-indexed chain is the right tool, and §8.1 proposes
it for the mesh.

## 4. Design

### 4.1 Symmetric lanes: every edge is bidirectional

**Every sharing relationship runs the protocol in both directions.** A one-directional
watcher publishes **null fixes** — ordinary envelopes whose plaintext is an empty payload —
on the same cadence a sharer publishes real ones. There is no standalone ack message and
no separate ack state machine.

The ratchet header (the sender's current ratchet public key, §4.7) rides _inside_ every
signed envelope. This buys three things at once:

1. **Authentication and replay protection for free.** The ratchet material inherits the
   envelope's ed25519 signature, AAD binding, and `seq` monotonicity — the exact
   discipline `crypto.rs:225` already enforces, with no second code path to get wrong.
   Revision 1's standalone acks had none of this specified.
2. **One state machine.** Watchers and sharers are the same protocol participant; a null
   fix is a fix.
3. **Traffic-shape privacy.** Payloads are padded to a fixed size class before encryption
   (§4.7), so the stash cannot distinguish a watcher's null fix from a sharer's real one.

Cost: watcher devices publish small envelopes on the cold cadence. They already needed
background execution to ack under revision 1; this changes the payload, not the wake
requirement.

**Each envelope gets its own `seq`.** A tick that has both sharing and watching edges
publishes two envelopes, and they take consecutive `seq` values rather than sharing one —
no two envelopes from an author are ever the same `(author, seq)`, which keeps `seq` a
usable identity for replay rejection and for the `sc.*` telemetry join keys. Recipient
sets are disjoint, so each peer still sees a strictly increasing `seq` from us; it just
has gaps where the other lane's envelopes were. Monotonic acceptance (§4.2) is a
strictly-ahead test, not a no-gaps test, so gaps are already legal.

The null lane is **best effort within the tick**: it runs after the real fix is on the
wire and its `seq` returned, so a failure there must not fail the tick — that would make
the outbox retain and re-publish a fix that already went out. A missed watcher envelope
costs at most one cadence interval of freshness, bounded by T_lapse (§4.2).

### 4.2 The ratchet

The key schedule is the **Double Ratchet**
([Signal spec](https://signal.org/docs/specifications/doubleratchet/), normative for the
schedule), with one deliberate delta: **there is no skipped-message key storage.** Under
LWW there is no history to catch up on — a receiver that is behind fast-forwards its
receiving chain to the message's position, uses that one key, and _deletes_ every
intermediate chain key it stepped past. Skipped messages are gone, by design. This keeps
§9's objection to the skipped-key table (a stored key index into the archive) fully
intact while inheriting the DR schedule's published security analysis.

Per friend, per session, each side holds (~200 B): `session_id`, root key `RK`, its own
current ratchet keypair, the peer's latest ratchet public key, sending and receiving
chain keys `CKs`/`CKr`, and counters. The steps are the standard ones:

```
DH ratchet (on the first envelope from the peer carrying a new ratchet pub):
  RK, CKr ← KDF_rk(RK, DH(our_ratchet_priv, peer_pub_new))
  our_ratchet ← fresh X25519 keypair          // old private deleted
  RK, CKs ← KDF_rk(RK, DH(our_ratchet_priv, peer_pub_new))

symmetric step (every message sent or accepted):
  MK ← KDF_mk(CK);  CK ← KDF_ck(CK)           // MK deleted after its single use
```

**Normative rules:**

- **One `MK`, one AEAD invocation, ever.** A fix that cannot be sealed under a fresh key
  is dropped — never re-sealed under a used one. The temptation will arrive the first
  time iOS background flakiness makes a friend chronically stale; resist it here, in the
  spec, so it cannot be resisted case-by-case in code.
- **Monotonic acceptance.** A receiver accepts only positions strictly ahead of its
  state (epoch, then counter); everything else — including a byte-identical replay from
  the archive — is dropped before any state mutation. Signature verification precedes
  state mutation, preserving the `crypto.rs:225` ordering.
- **Persist-before-publish, _durably_.** Hold the state lock across _load → derive →
  persist → seal → publish_, persisting the advanced state **before** the doc write. A
  crash then burns one counter value instead of reusing a key — and because the sending
  chain can step symmetrically, recovery is local: the next publish uses the next
  counter. No peer round-trip, no deadlock. (Revision 1's strict gate turned this same
  crash into a permanent deadlock for watcher edges; see §9.)

  "Persist" here means **fsync**, not `write`. Write-then-rename is atomic against a torn
  file and gives nothing against power loss: the rename can land while the data behind it
  has not. Since the caller treats a successful save as "the counter is on disk, it is
  safe to seal", a save that returns `Ok` and then evaporates is precisely the reuse this
  rule exists to forbid — the same key at the same position sealing a different content
  key under the same zero nonce. `SessionStore::save` therefore fsyncs the temp file, then
  renames, then fsyncs the directory. One fsync per recipient per publish is affordable at
  the cold cadence; if the hot cadence ever moves onto this path the answer is counter
  _reservation_ (persist `ns + N`, hand out `N` from RAM, burn the remainder on restart),
  never a weaker save. Burned counters are free under the sender-liveness invariant.

- **Persistence is fail-stop.** If ratchet state cannot be persisted, publishing stops.
  The current best-effort/silent-catch pattern (`secure-keys.ts:35`, `state-store.ts:27`
  [verified]) is fine for a static key and fatal for sequential state — a silent persist
  no-op _is_ key reuse.
- **The single-writer lock must be structural, not behavioral.** `self.inner.lock()` is
  in-process only. The headless-vs-foreground node races that were fixed by discipline
  would, with sequential state, cause key reuse rather than a clobber. Before §7 step 6
  ships, either the node singleton is structurally impossible to instantiate twice or a
  cross-process guard (file lock on the state store) backs it.

**Bounded chains.** The sending chain may step at most until the peer's contribution goes
stale: if no fresh ratchet pub has arrived from the peer within **T_lapse** (default 24 h;
tuning in §8), the peer drops from the wrap set until one does. This bounds how long a
sender publishes into a one-sided session, restores revision 1's "lapsed ≈ revoked"
property on a longer fuse, and forces the §1.1 seized-device adversary to actively emit
signed envelopes at least every T_lapse to keep tracking.

**[rev 5] What "fresh ratchet pub" means in practice.** `peer_advanced_ms` moves only when
we perform a DH step on a new key from the peer (`ratchet.rs`), and the peer mints a new
key only when it _reads_ one of ours. On iOS the read happens only while the app is
mounted. A friend whose phone is healthy and publishing, but who has not opened the app
for a day, therefore lapses, and comes back through a §4.6 restart rooted in a semi-static
prekey. The recovery path is a routine path for such users, and its weaker forward
secrecy (the §4.6 residual) is what they get. R2 in §10 lets a background wake advance
the receiving chain, after which a lapse means what this section intended: the device has
stopped. Until then, read `sc.restart` counts with reason `lapsed` as a measure of how
often this happens, not as a fault rate.

**The `RK₀` bootstrap.** The first session's root must not be recomputable from statics.
Bootstrap is the §4.6 resync primitive run over the pairing connection during the SAS
gate: fresh ephemerals from both sides, identity-signed, mixed into `RK₀`. The window of
statically-recomputable messages is zero.

Both pairing routes bootstrap identically — an invite/link pair and a nearby BLE pair run
the same `Hello`/`Reveal` handshake, the same SAS gate, and the same `finalize`, and
`pairing.rs` does not branch on `nearby` for any of it. Each side mints a fresh X25519
ephemeral per pairing session, commits to it in `Hello` alongside its SAS nonce, and
carries it in the SAS transcript, so a MITM who swaps an ephemeral changes the figure the
two humans are comparing.

**What that last clause rests on.** The ephemeral binding is only as strong as the channel
the humans compare the figure over, and that channel is not the pairing connection — the
whole point is that it is out-of-band. In person, or a voice/video call where each
recognises the other, is sound. **Comparing the figure in the same chat thread that
carried the invite link is not**: an attacker who controls that thread substitutes the
link, sits in the middle, and reports whichever figure keeps both sides agreeing. That is
a UX obligation, not a protocol one — the link-pair flow must tell the user to check the
figure somewhere other than where the link came from, or the SAS gate is decorative for
exactly the users most likely to use it.

**Do not trigger the DH ratchet on a sync event.** The docs live-sync swarm is per _author
namespace_, so its members are the whole pool; a neighbour coming up or an `InsertRemote`
from some peer may be C, not B. The trigger is a signed envelope from B carrying a new
ratchet pub. A sync event is only a hint that reading is worthwhile.

### 4.3 Regimes

The schedule was designed for two regimes. Only the cold one exists now: the app gossip
lane and the on-demand live mode that drove the hot one were both retired in 2026-11, so
every envelope travels the docs slot (`ARCHITECTURE.md` §5). The hot column is kept because
the schedule still covers it — a future real-time mode would ride the docs live engine
under the same ratchet (`ARCHITECTURE.md` §9c).

|                  | Cold                                               | Hot                      |
| ---------------- | -------------------------------------------------- | ------------------------ |
| Transport        | docs / stash, LWW                                  | (retired) peer connected |
| Cadence          | 5 min (`sampling-policy.ts:41`)                    | 4 s floor                |
| Ratchet material | header on every envelope (null fixes for watchers) | header on every envelope |
| DH epoch advance | ~each publish interval (peer's next envelope)      | continuous               |
| Publish gate     | none — never blocked on a round-trip               | none                     |

Mutual sharers pay nothing extra. Watchers pay one padded null envelope per cold interval.
Because the sending chain steps symmetrically between DH epochs, staleness of the _peer's_
device never blocks the _sender's_ publish — the failure mode of revision 1's hard gate —
and B's view of A degrades only after T_lapse, surfaced through the existing
`PresenceFreshness` vocabulary (`presence.ts:6`, `live | recent | stale | unknown`).

### 4.4 Last-write-wins fixes, and trail removal

The durable path collapses from `(author, seq)` to a single overwritten key per author —
structurally identical to the existing control-message path (`encode_ctl_key`,
`Query::single_latest_per_key`). `seq` stays in the envelope for replay rejection; the
ratchet position lives in the per-wrap header (§4.7); both leave the doc key.

**Two lanes, two slots.** A tick produces two envelopes — the real fix for the wrap set,
the null fix for the watcher edges (§4.1) — wrapped for _disjoint_ recipient sets. They
therefore need distinct LWW keys, or each tick's second write silently supersedes its
first and a device that both shares and watches can keep only one lane durable. Null
fixes go to `nul/hex(author)` (`encode_nul_key`), alongside `hex(author)/fix` and
`ctl/hex(author)`; like `ctl`, the `nul` lead is not valid hex, so every existing fix
reader skips the lane without change. Each lane keeps exactly one overwritten slot per
author — a null fix carries no history worth keying either, only the sender's current
ratchet contribution.

The two lanes are distinguishable by doc key to the stash, which is a real (small)
metadata leak: the stash can see that an author writes a null lane at all. It is
strictly less than what today's _stable_ wrap `kid` already tells it — the exact
recipient set of every envelope, per §1.1 — and it is what §4.7's rotating kids close.
Revisit lane-shape uniformity (always writing both slots, so role is not inferable from
which lanes an author uses) when rotating kids land, not before: until then it would buy
nothing and cost every device a write per tick.

Received trails are deleted entirely. **Self trails stay** — locally generated, never
decrypted from the network, bounded by §5.3.

### 4.5 Wrap set

The wrap set is _recipients who are neither revoked nor lapsed_ (no fresh ratchet pub
within T_lapse, §4.2). A lapsed recipient is structurally identical to a revoked one until
they check back in, so this reuses revocation's mechanism rather than adding one. One
envelope, N wraps, unchanged in shape.

Product consequence, stated plainly: a friend whose device has not run the app in T_lapse
stops receiving until it does, and should be visibly "hasn't checked in" — distinct from
revoked, distinct from merely stale.

### 4.6 Desync detection and recovery

Any ratchet deployment's real risk is the recovery path becoming the bypass. The second-order
risk, learned in the field, is a recovery path that does not converge: revision 3's two-sided
resync split a working pair on 2026-10-02 and left one needing an in-person re-pair on
2026-10-03 (see "Why revision 3's resync was replaced" below). Revision 4 replaces it with the
shape Signal uses for the same problem — X3DH's prekeys, `PreKeySignalMessage`'s
carry-until-answered, and Sesame's archived sessions — adapted to a channel with no server and
no simultaneous presence.

**Detection.** A session counts as broken when any of these holds; each is reported by
`SessionManager::assess` as a distinct reason (`sc.restart` reasons in telemetry):

- **Misses.** `R` (= 3) _distinct_ signature-valid envelopes from the peer that no session we
  hold can open. Distinct by the author's monotonic `seq`: the durable path is one overwritten
  slot per author and every read opens the whole replica, so the same envelope is re-read
  constantly, and a re-read is evidence of nothing. An envelope on a chain we hold at a position
  we passed is likewise a replay (judged from the state on disk, so it survives a restart).
- **Damaged.** The record will not decrypt or parse. Miss counting cannot reach this — every
  `open` fails at the load — so it is a verdict on its own. "Damaged" stays distinguishable from
  "absent": nothing on disk is an unpaired peer waiting for a bump, not a session to restart.
- **Lapsed** (§4.5): the peer has not moved the ratchet within `T_lapse`. A mutual lapse produces
  no envelopes to miss and sustains itself, so it needs its own entry.
- **Stuck** (follower only): no sending chain for an hour since the session was installed. The
  responder side of a pairing waits for the initiator's first envelope; if that never arrives or
  never opens, nothing else ever called it broken.

**Roles.** Each pair has a fixed **leader** — the lower endpoint id, the same side that is the
ratchet initiator at pairing — and a **follower**. Only the leader restarts a session. The
follower can only ask. This asymmetry is the convergence argument: two sides that may each
restart unilaterally can restart past each other forever, and with sparse, crossing,
last-write-wins delivery they systematically do; one side that decides and one that follows
cannot.

**Prekeys.** Every device keeps a short list of X25519 **restart prekeys**, rotated every 24 h,
and publishes the newest two in its **control record**: an HPKE (v2) envelope in the device's
own `rsy/<author>` slot, sealed to every friend's receiving key and ed25519-signed by the
author. A prekey's private half is persisted before the record that names it is written, and is
deleted 7 days after it is superseded (the newest is always kept).

**Restart.** The leader restarts on its own:

```text
base      ← fresh X25519 keypair                       (private half dropped at once)
ts        ← max(now, origin of the session it replaces + 1)
RK₀, sid  ← restart_root(DH(base, prekey_F), leader ‖ follower ‖ base_pub ‖ prekey_pub ‖ id ‖ ts)
state     ← bootstrap_initiator(sid, RK₀, prekey_F)     (sends at once)
```

`restart_root` is ephemeral × semi-static: no long-term key a seized device holds forever can
recompute it, and its authentication is the envelope signature over the header on one side and
the control-record signature over the prekey on the other — the same signed-lane argument as
§4.1. **Normative:** a session root comes only from `derive_boot_root` (pairing, ephemeral ×
ephemeral) or `restart_root` (restart); no code path roots a session in static-static DH, and
there is no automatic downgrade of any kind. `no_session_root_derives_from_static_static_dh`
checks this against the source.

**Carried until answered.** The new session is in use from the leader's next publish, and every
wrap for that follower carries a restart header `{base_pub, prekey_id, ts}` (envelope v4, §4.7)
until the leader opens anything from the follower under it. The follower derives the session
from **any one** of those envelopes, whenever it next reads — hours later is fine, and nothing
about it waits in memory on either side. A process with no reader (the native background
runtime) **primes** instead: it performs the DH ratchet a read would, gaining a sending chain,
but does not consume the position, so the fix inside is still there for the reader that runs
later.

**When the leader restarts.** On a follower request newer than the last it answered (the
answered timestamp is persisted in the same write as the restart, so a request is never answered
twice); or on its own evidence — damaged, or misses — but not on top of its own unanswered
restart until 30 minutes have passed. **A lapse alone never makes the leader restart.** §4.5
drops a peer who has stopped contributing ratchet keys so that a device in someone else's hands
cannot keep tracking by doing nothing; a lapsed follower that is alive will ask.

**Prekey freshness is the §4.5 bound restated.** The leader restarts only against a prekey at
most 72 h old. A follower that is running rotates daily; a prekey older than that belongs to a
device that has stopped, possibly one in an evidence locker whose disk still holds the private
half.

**Requests.** A broken follower adds `{to, ts}` to its control record, where `to` is a tag
derived from both endpoint ids rather than the leader's id, so friends who read the record learn
nothing about who else it is talking to. It repeats an unanswered request after 30 minutes and
withdraws it once the session is healthy. `ts` is the follower's clock and the leader compares it
only with the follower's previous requests, so no agreement between clocks is needed.

**Replay is bounded by one durable rule.** A follower adopts a restart only if its `ts` is newer
than the origin of the session it is on, and the leader makes each restart strictly newer than
the last. Every replayed header — out of the stash, or re-read from the replica — is therefore
inert, across process restarts, with no nonce set to forget. A paired session's origin is the
pairing time minus a 10-minute skew allowance, so a restart from before a re-pair is old.

**Archived sessions.** A record keeps the two sessions most recently replaced, for decryption
only. Whatever the peer sealed before it learned of a restart — on last-write-wins, its current
position — still opens. Chain keys only move forward, so an archived session exposes nothing
already received; nothing is ever sealed under one.

**Failed decryption changes nothing.** State is persisted only after the payload opens, so an
envelope that matches a session but fails to decrypt leaves the store untouched.

**The driver.** `recover_sessions` runs on every native drain: prime any waiting restart, decide
per peer (`restart::plan_leader` / `plan_follower`), and republish the control record when its
content or recipients change (that write holds the drain's push open, because a request nobody
can read is not a request). The policy is pure and is the same function the test harness runs.
Restarts are telemetered on `session.recover` and counted per peer; a count that keeps climbing
is the "re-pair with this friend" signal.

**Residual risk, stated.** A restart is as forward-secret as Signal's without a one-time prekey:
an adversary who seizes the follower before it deletes a prekey, and also holds the stash
archive, can derive a restarted session until its first DH step — which happens on the
follower's first reply. Daily rotation and 7-day deletion bound the window; one-time prekeys
would close it but do not fit a one-slot-per-author store.

**Why revision 3's resync was replaced.** Each side published a fresh ephemeral and, on seeing
the other's, derived a root from _whatever ephemeral it held at that instant_. Records expired
after an hour and were re-minted every thirty minutes; ephemerals lived in memory. Convergence
needed both sides to hold the same pair of ephemerals at the same time, and nothing guaranteed
it: on 2026-10-02 one side applied while the other had already stopped looking (a false miss
count started the exchange), and on 2026-10-03 the follower's process died holding the ephemeral
the leader then applied against, after which neither side could ever reach the other's session.
Revision 4 removes every one of those dependencies: one side decides, the follower's half is
published in advance and persisted, the restart rides traffic that already flows, and nothing
expires on a timescale shorter than a phone can be asleep.

### 4.7 Wire format — envelope v3

Changes from v2 (`crypto.rs`):

- **Payload padding.** Plaintext is padded to a fixed size class before AEAD so null and
  real fixes are indistinguishable by ciphertext length. **[MUST VERIFY]** the real fix
  payload distribution fits one bucket; pick the bucket from telemetry.
- **Wrap under the ratchet.** Per-recipient wrap becomes
  `AEAD(MK, nonce = 0, plaintext = K, aad = envelope_aad ‖ wrap_header ‖ session_id)`.
  The zero nonce is safe if and only if the one-MK-one-invocation rule holds — which is
  why that rule is normative, not advisory. HPKE remains for pairing and any
  pre-session traffic only.
- **Per-wrap ratchet header** `{sender_ratchet_pub, epoch i, counter n}` — per wrap
  because ratchet keypairs are per pair. The header is inside the wrap's AAD and the
  envelope signature.
- **Rotating kids.** `kid = KDF_kid(CK at position (i, n))[..8]` instead of the stable
  `blake3(recvPub)[..8]`. The receiver knows which author an envelope is from (signed),
  holds exactly one session per author, and finds its wrap by computing candidate kids
  while fast-forwarding its receiving chain — bounded by the acceptance window, one hash
  per position. The kid itself no longer links a recipient across envelopes or across
  authors.
  **[rev 5] The wrap as a whole still does.** `WrapV3`/`WrapV4` carry the header
  `{sender_ratchet_pub, epoch, counter}` in plaintext beside the kid (`crypto.rs`). The
  ratchet pub is constant for a pair until the next DH step, and `(epoch, counter)` is a
  per-pair sequence, so the stash, and any friend relaying the namespace, can follow each
  recipient's wrap from envelope to envelope, count an author's recipients, and see how
  often each one reads. Linking _across authors_ is closed, since ratchet keys are per
  pair; linking within an author's envelopes is not. The code comment calls encrypting
  the header circular. The Double Ratchet specification's header-encryption variant
  exists for this case: header keys come from the root chain, and the receiver tries the
  current and next header key. That is R5 in §10 and needs a new envelope version.
- **The acceptance window is sized by reader absence, not cadence** (`2^17` positions).
  A sender's chain resets only when the reader answers, the reader answers only by
  _opening_ something (on iOS, only while the app is mounted), and every tick spends two
  positions while a gossip lane and the docs lane each sealed (one position since 2026-11). The original 512 assumed a reply every
  interval; it ran out after ~21 h of a friend not opening the app, and on 2026-10-09 left
  an iPhone unable to open anything from its friend until a §4.6 restart. The window bounds
  work only — no skipped key is stored, and anyone holding a chain key can walk it as far
  as they like regardless — so it is set wide: ~7 months at the 5-minute cadence.
  **[rev 5]** The window bounds work, but the receiver's stale chain key bounds secrecy:
  everything between the reader's position and the sender's is openable by whoever holds
  the reader's state and the ciphertexts (§1). Widening the window was right for
  availability and made that exposure seven months deep on paper. R2 and R3 in §10
  address it.
- **KDF domain separation.** All derivations use `blake3::derive_key` with distinct
  contexts (`sc-dr/v1/rk`, `/ck`, `/mk`, `/kid`, `/boot`), matching the existing
  `mesh.rs` convention.
- The overloaded envelope `epoch` field is left to the mesh path; the docs-path key epoch
  is the per-wrap `i` (this completes §7 step 4's split).
- **Envelope v4** is v3 with one optional field per wrap: the §4.6 restart header
  `{base_pub, prekey_id, ts}`, bound into that wrap's AAD as well as signed. It is written only
  while a leader has a restart its follower has not answered, so ordinary traffic stays v3 and a
  peer on an older build keeps reading it. A version and not an appended field because the
  signature covers a re-encode of the decoded struct: a reader that drops an unknown field
  re-encodes different bytes and fails the signature.

## 5. Retention surfaces

Crypto is the smaller half of this work. Four surfaces retain data independently, and
**all four must be closed or the ratchet is decorative.**

### 5.1 Superseded doc versions [verified]

`docs.rs:409` states it outright: _"the control key is overwritten in place, so superseded
versions still exist in the replica."_ That is why `single_latest_per_key` is load-bearing
for control messages. **LWW keying alone therefore does not empty the archive** — it
produces a stash that reads as "last thing received" while still holding every prior
version under a different query. Superseded entries need explicit removal, on device and on
the stash. (This applies to resync records on the control key too — harmless content, all
public and signed, but it is why nothing secret may ever ride a control key.)

**[rev 5] Still open at v3.0.0.** `docs.rs` says in its module docs that superseded versions
still exist in the replica and that reclaiming them is this section's work. The item below
has not been resolved, so goal 3 of §1 does not hold on device. The stash is in another
repository and was not checked in this review.

**[MUST VERIFY]** whether iroh-docs 0.101 exposes entry deletion that actually purges
rather than tombstones. Prior expectation: it does not — set-reconciliation replicas are
built to converge, not forget, and deletion is tombstone-shaped. If confirmed, fixes
bypass docs entirely (gossip plus a purpose-built LWW stash endpoint) and §7 step 2
changes shape.

### 5.2 Blob store [verified: no GC configured]

Doc entries reference content hashes; envelope ciphertext lives in `FsStore` on disk
(`lib.rs:999`). Dropping an entry does not reclaim the blob. No GC is configured anywhere
in the crate.

**[rev 5] Still open at v3.0.0:** no collection is configured where the `FsStore` is loaded.

**[MUST VERIFY]** iroh-blobs 0.103 default retention and the semantics of the second
argument to `BlobsProtocol::new` (`lib.rs:1009`). Prior expectation: GC exists but is
config-gated and tag-protected; assume defaults do not help.

### 5.3 Local plaintext [verified]

The `trail` table holds every author's fixes as plaintext JSON (`persistence.ts:137`) and
`prune()` (`:199`) is called only from tests. **This is the dominant term for the seizure
threat** — an adversary reads it without touching a key. Deleting received trails (§4.4)
removes most of it; the surviving self-trail needs a retention TTL.

### 5.4 Deletion is not erasure

Everything above says "delete"; storage does not cooperate. SQLite leaves deleted rows in
freelist pages and the WAL; flash wear-leveling retains stale copies below the
filesystem. An adversary matching §1 (device in hand, filesystem access) recovers
"deleted" rows forensically. Mitigations, all cheap:

- `PRAGMA secure_delete = ON` on every app database that ever holds fixes or ratchet
  state; periodic `wal_checkpoint(TRUNCATE)`; `auto_vacuum = INCREMENTAL` plus a periodic
  `incremental_vacuum` tick alongside the §5.3 prune.
- Ratchet state is encrypted at rest under a key held in the OS keychain and supplied to
  the node at init, the same lane the signing seed already travels. State files are never
  plaintext on disk.
- Below-filesystem remanence is accepted: the final backstop is OS file-based encryption
  on a locked device, and the §1 claim is worded accordingly ("last erasure pass," not
  "instantly").

## 6. Backup rollback [verified — blocks everything downstream]

Two stores are exposed, not one:

**Keychain items.** `secure-keys.ts:33–34` and `state-store.ts:26` — **three**
`setItemAsync` calls, not two — take expo-secure-store's default accessibility rather
than a `THIS_DEVICE_ONLY` class. `app.json` declares no `allowBackup` or
`dataExtractionRules`, so Android Auto Backup applies.

**The Rust-side store.** Ratchet state (§4.2) persists on the filesystem, and this is the
store that actually holds the sequential state.

Today this is harmless: a static key restores to itself. **The moment key state becomes
sequential it is a critical hazard** — restoring from backup rewinds the chain and reissues
message keys, which is nonce-and-key reuse and breaks confidentiality outright. This is the
most common way ratchet deployments fail in practice.

_Resolved (rev 3)._ The node keeps **two** storage roots, because the two hazards pull in
opposite directions and only one of them is a cryptographic break:

|                               | cache / temp | app data dir         |
| ----------------------------- | ------------ | -------------------- |
| backup rollback → key reuse   | impossible   | **must** be excluded |
| OS purge → every session lost | **likely**   | no                   |

The docs/blobs replica stays in cache: it is large, re-fetchable from the stash and from
friends, and a purge costs nothing but a resync. Ratchet session state goes in the app's
private data dir — Android `filesDir`, iOS Application Support — because losing it desyncs
every friend at once, **and** is excluded from backup there, because a restored copy
rewinds counters. Both halves are required and ship together: iOS stamps
`NSURLIsExcludedFromBackupKey` on the state root before the node can write into it
(`IrohLocationModule.swift`), Android excludes `files/streetcryptid` from cloud backup and
device transfer (`plugins/withBackupExclusion.js`). Moving the store without the exclusion
would create exactly the hazard the move was meant to prevent.

The accessibility class is `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, **not**
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`: the background location task publishes while the phone
is locked in a pocket, and a `WHEN_UNLOCKED` item is unreadable exactly then — the
stricter class would silently break background sharing on iOS.

Fix before any sequential state ships. This is independently valuable and blocks nothing,
so it goes first.

## 7. Implementation plan (agent-ready)

Each step states its own test. Steps 0–5 deliver most of the security and are a
legitimate landing spot; steps 6–7 are the ratchet proper, gated separately.

**0. Backup + keychain semantics.** Set
`keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` on all three `setItemAsync`
calls (`secure-keys.ts:33`, `:34`, `state-store.ts:26`). Add Android
`dataExtractionRules` (cloud backup _and_ device transfer) excluding the secure-store
prefs, the app databases, and the iroh data directory; exclude the iroh data directory
from iOS backup (`NSURLIsExcludedFromBackupKey`, via config plugin). Make sequential-state
persistence fail-stop (§4.2) — the silent catches stay only for the static identity keys.
_Test:_ unit assertion on the options object; a persistence-failure test asserting publish
aborts; manual restore-from-backup check that neither keys nor node state survive to a new
device.

**1. Trail removal + LWW keying.**
Rust: delete `read_range`, `read_trail`, `sync_trail`, the reconciliation block
(`docs.rs` ~440–660), `TrailFix`/`TrailSink`; `encode_key(author, seq)` → single LWW key.
TS: delete `history.ts` + tests, `FriendHistoryIsland`, `backfill-task.ts`,
`MAX_BACKFILL_MS`, friend breadcrumbs (`map-screen-body.tsx:122`). Keep the `SELF_AUTHOR`
path (`:174`). Refactor `presence.ts:65` from "join trail authors" to "latest fix per
friend".
_Test:_ existing social suites minus deleted ones; new assertion that a second publish
leaves exactly one readable entry per author.

**2. Retention surfaces + erasure hygiene.** Resolve both **[MUST VERIFY]** items in
§5.1/§5.2, then reclaim superseded entries and blobs on device and stash. Enable
`secure_delete`, WAL truncation, and incremental vacuum per §5.4.
_Test:_ publish N fixes, assert on-disk blob count and doc-entry count stay O(1); assert a
prior-version query returns nothing; assert the pragmas are set on every connection.

**3. Self-trail TTL.** Wire `prune()` to a user-visible retention setting, on the same
tick as the vacuum.
_Test:_ `prune()` call-site coverage; assert rows older than the TTL are gone after a tick.

**4. Epoch split.** Separate the envelope key epoch from the mesh 15-min epoch before
`mesh_vectors.json` is treated as frozen. With v3 the docs-path key epoch is the per-wrap
`i` (§4.7); the envelope-level field is mesh-only.
_Test:_ mesh vectors still reproduce; docs-path envelopes carry the per-wrap epoch.

**5. Symmetric lanes.** Null-fix publishing for watcher edges, payload padding to the
chosen size class, on the existing v2 crypto. This is independent of the ratchet and
de-risks it.
_Test:_ a watcher edge publishes on cadence; ciphertext length is constant across null
and real fixes; presence updates flow to the watched side.

**6. The ratchet (envelope v3).** DR schedule per §4.2, wire format per §4.7, state
per friend per session (~200 B) in the encrypted Rust-side store. Single-writer
discipline per §4.2, including the structural/cross-process guard. Signature
verification before any state mutation, preserving the `crypto.rs:225` ordering.

The implementation must satisfy the **sender-liveness invariant**: _from any persisted
sender state short of lapse, the next publish derives without peer input._ This is the
property that kills the revision-1 deadlock — recovery from a burned key is a local
symmetric step on the sending chain, never a round-trip — and it is what makes
persist-before-publish safe to mandate. Any future change that reintroduces a "waiting
on the peer to publish" state (a hard gate, a per-fix ack requirement, a consumed-key
retry) violates it and must be rejected in review.
_Test:_ the published DR test vectors against the schedule; a property test of the
sender-liveness invariant (for every reachable persisted state below the lapse bound,
`next_publish()` succeeds with no peer message consumed); an explicit state-machine
suite covering message loss, reordering, replay-from-archive, crash-between-persist-and-
publish (asserting local recovery via a burned counter — one counter value skipped, no
round-trip, no deadlock), fast-forward with skip-deletion (asserting skipped keys are
unrecoverable afterwards), lapse and un-lapse, rotating-kid lookup across the acceptance
window; a global assertion that no `MK` is ever derived twice.

**7. Bootstrap + restart.** The bootstrap primitive for the SAS bump; the §4.6 restart
(prekeys, leader-decided restart, carried-until-answered header, archived sessions); desync
detection; restart telemetry; the re-pair prompt on restart loops.
_Test:_ `tests/restart_protocol.rs` — libsignal's session suite adapted (repeated and replayed
restart messages, failed decryption leaves stores untouched, a header lifted into another
author's envelope is inert, simultaneous detection, archive bounds, damaged state on either
side) plus a seeded randomized model of sends, drops, reordering, re-reads, process restarts,
corruption and clock jumps that must always converge (libsignal's `proptest_session_resets`);
`tests/ratchet_conditions.rs` replays both field failures on real nodes; a grep-level assertion
that no session root derives from static-static DH alone.

Gate on steps 6–7: the schedule is now the standard Double Ratchet, so first evaluate
whether a vetted implementation binds cleanly with skipped-key storage capped at zero
and an external wrap payload; only write our own against the published vectors if none
does. If the budget for vectors, the state-machine suite, and outside review is not
there, **stopping after step 5 is a legitimate landing spot** — weaker than this design,
with far fewer ways to be silently wrong.

### 7.1 The step-6 gate, discharged [surveyed 2026-08-13]

**Finding: no vetted Rust implementation binds cleanly. We keep `ratchet.rs`.**

Every candidate treats the skipped-message-key store as a load-bearing correctness
feature with a **hardcoded, private** capacity, because every candidate assumes a
store-and-forward transport with message history. Last-write-wins inverts that
assumption, and none exposes a knob for it. The zero-skipped-keys requirement (§4.2,
§9) is not a near-miss anywhere — it is structurally the opposite of what these
libraries do.

| Candidate                                                                                                           | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vodozemac` 0.10.0 (Matrix, Apache-2.0)                                                                             | The only serious base. `MAX_MESSAGE_KEYS = 40` and `MAX_MESSAGE_GAP = 2000` are `pub(crate) const`; `SessionConfig` carries only a version. `MessageKey::key()` exists under `low-level-api` but **sending side only** — `RemoteMessageKey` is `pub(super)` and the receive path always does the AEAD itself, so we could never unwrap `K`. Chain keys are `pub(super)`: no `kid` derivation. Worst-case pickle ~6.4 KB against our 200 B budget. No injectable RNG, so our frozen vectors would be unreproducible. |
| `libsignal` (Signal)                                                                                                | AGPL-3.0-only, which was disqualifying when surveyed and is not since this repository became AGPL-3.0 **[rev 5]**. Still `pub(crate)` and welded to Signal's protobuf session storage.                                                                                                                                                                                                                                                                                                                              |
| `double-ratchet-2` 0.3.6                                                                                            | Abandoned 2023. Uses **P-256, not Curve25519** (self-declared in its own crate docs), constant nonce, `ratchet_decrypt` panics on malformed input, and its `Drop` impl is a no-op bug. `MAX_SKIP = 100` private.                                                                                                                                                                                                                                                                                                    |
| `double-ratchet` 0.1.0 (sebastianv89)                                                                               | Best architecture — a `CryptoProvider` trait would genuinely satisfy the external-wrap and chain-key-derivation constraints. But **no serialization at all** (fails §4.2's persist-before-publish outright), capacity is a precondition rather than a cap (zero would make every fast-forward `Err(StorageFull)`), and it has been dead since 2021 on `rand_core 0.4` / `hashbrown 0.1`.                                                                                                                            |
| `nostr-double-ratchet`, `enigma-double-ratchet`, `light-double-ratchet`, `olm-rs`, `libsignal-protocol` (crates.io) | Unvetted, dormant, transport-coupled, or C bindings requiring clang (which our wasm target already cannot satisfy).                                                                                                                                                                                                                                                                                                                                                                                                 |

Forcing vodozemac would take roughly 100 lines across three files — but they are ~100
lines **inside precisely the code the Least Authority audit covered** (the receiver
chain, the key store, key-lifetime logic), which forks away the one property that made
adoption attractive, and takes on permanent rebase cost against a `main` that already
diverges from 0.10.0 across four dependency majors.

Worth recording about vodozemac regardless, since it is the reference point: its audit
(Least Authority, 2022-05-16, co-funded by gematik) covered the **Rust crate itself**,
which is rarer and better than it sounds — but it audited ~0.1/0.2, eight minor releases
and an edition migration ago. Two post-audit CVEs landed (CVE-2024-34063, degraded
zeroization; CVE-2024-40640, non-constant-time Base64 over secret key material), and a
2026 cryptanalysis dispute is unresolved, though 0.10.0 credits it for making
`diffie_hellman()` return an `Option`. **An audit is a snapshot, not a standing
property** — which is the argument for §7 step 6's own outside-review line item, not
against it.

The consequence for our own implementation: `ratchet.rs` keeps the published DR
**schedule** (already vector-tested against a frozen fixture) and stays deliberately
free of a skipped-key table. The audit budget named in the gate above does not go away
by having surveyed — it moves onto our code.

## 8. Open questions

1. **Mesh forward secrecy.** BLE capsules are opportunistic with no reliable return path,
   so there is no envelope exchange to ratchet on, and `mesh.rs` derives from two static
   keys. The festival mesh either accepts weaker FS or keeps a prekey mechanism for that
   path alone. One mitigating observation: if mailbox capsule TTL is actually enforced,
   the mesh's archive surface is structurally far smaller than the stash's was, which may
   make "weaker FS, short TTL" a defensible _deliberate_ answer. Decide deliberately; do
   not let it be settled by omission.

   **[rev 5] Proposed answer: a clock-indexed chain exported from the paired session.**
   No return path is needed (§3). At pairing, and again at each restart, both sides
   export a mesh secret from the session root with its own KDF context. Each mesh epoch
   the secret is hashed forward and the previous value deleted; the capsule key and the
   over-the-air tag for an epoch derive from that epoch's value. Both phones compute this
   independently from the clock. It replaces `ss_AB` from two static keys in `mesh.rs`,
   gives forward secrecy at epoch granularity, inherits whatever the session root has
   (including a post-quantum root, `POST-QUANTUM.md` P1), and adds no bytes to a capsule.
   What it does not give is healing, which the mesh never had. A phone that has been
   offline hashes forward to the current epoch on wake and keeps nothing older, so a
   capsule older than the receiver's current epoch minus the skew allowance is lost;
   that matches the capsule TTL in `docs/mesh/DESIGN.md` §3.2. The inner envelope on the
   mesh path is still `crypto::seal` v2 to the static receiving key and must move with
   it, or the static key remains the weakest link. This is R7 in §10.

2. **iroh-docs purge semantics** (§5.1) — gates the shape of step 2.
3. **iroh-blobs default retention** (§5.2).
4. **Tuning:** T_lapse default (24 h?), the padding size class, R (desync threshold), and
   the UX copy distinguishing _stale_ / _hasn't checked in_ / _revoked_.
5. **trail-stash server** needs the matching LWW + retention change; it is not in this
   tree. It is ciphertext-blind and stays so; rotating kids additionally stop it from
   clustering recipients.

## 9. Rejected alternatives

| Option                                                              | Why not                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recv-key rotation ring                                              | Floors at a ~1-week window: a friend offline a week still wraps to the week-old `recvPub`, so the secret must be retained. `K × period ≥ max offline gap` is a product requirement, not a crypto one.                                                                                                                                                                                         |
| Symmetric chain from the pairing DH                                 | **No FS at all** as first proposed: a static-static root is recomputable from surviving long-term keys (§3). **[rev 5]** That objection is to the root, and revision 3 made the root ephemeral. A chain from the ephemeral root is forward secret; it is not used on the docs path because it cannot heal after a copied device (§1), and it is the proposed answer for the mesh (§8.1).      |
| Prepublished one-time prekeys                                       | Correct, but the symmetric lanes deliver the ephemeral contribution continuously with no batch, exhaustion, or fallback machinery. Survives as a candidate for the mesh path only (§8.1).                                                                                                                                                                                                     |
| **Strict one-fix-per-ack gate** (revision 1 of this document)       | Deadlocks: a crash after persisting a consumed ack leaves the sender needing an ack the watcher believes it already gave — the retry is a replay and must be rejected. Fixing that needs either a retained multi-key set on the acker or symmetric chain steps; the latter also decouples publish availability from ack round-trips, so the hard gate buys nothing the bounded chain doesn't. |
| **Standalone ack messages** (revision 1)                            | A second, unauthenticated-by-default message lane and state machine whose replay/ordering rules had to be specified from scratch. Superseded by riding the ratchet header inside the already-signed envelope (§4.1).                                                                                                                                                                          |
| Skipped-message key **storage** (full DR as deployed by messengers) | Unnecessary under LWW — there is no history to catch up on — and against an archive-holding adversary it is actively harmful, being a stored key index into the archive. The DR _schedule_ is adopted (§4.2); only the table is rejected: skipped keys are deleted, not stored.                                                                                                               |
| MLS-style group epochs                                              | Membership here is per-author and asymmetric, and offline members reintroduce retained epoch secrets. Large lift, little gain over the above.                                                                                                                                                                                                                                                 |
| **Adopting a third-party Double Ratchet crate**                     | Surveyed under §7.1 and rejected on evidence, not preference: every candidate hardcodes a private skipped-key store capacity, and the strongest (vodozemac) exposes a message key on the sending side only — so a receiver could never unwrap `K` itself. Forcing it means forking the exact code its audit covered. Kept as the standing answer to "why not just use a library?".            |

## 10. Repair items [rev 5, 2026-11-10]

What it takes to bring the tree in line with this document and with
[`POST-QUANTUM.md`](./POST-QUANTUM.md). Each item names where the work lands and what its test
is. None of it is started. The order is the suggested order: R1 is a one-line fix with a legal
dependency, R2 and R3 restore claims this document already makes, and the rest are wire changes
that should share one version bump where they can.

| Id  | Item                                       | Lands in                                                     | Closes                                   |
| --- | ------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------- |
| R1  | Correct the export declaration             | `app.json`                                                   | `POST-QUANTUM.md` §0                     |
| R2  | Advance the receiving chain on receipt     | `sessions.rs`, `ratchet.rs`, both native background runtimes | §1 claim 1, §4.2 lapse, routine restarts |
| R3  | Reclaim superseded entries and blobs       | `docs.rs`, blob store setup, trail-stash                     | §1 claim 3, §5.1, §5.2, §7 step 2        |
| R4  | Measure lapses before and after R2         | `infra/otel`, `sc.restart`                                   | Evidence for §4.2                        |
| R5  | Encrypt the ratchet header                 | `crypto.rs`, `ratchet.rs`, new envelope version              | §1.1 metadata, §4.7 linking              |
| R6  | Hybrid restart prekeys                     | `restart.rs`, control record, `BootHeader`                   | `POST-QUANTUM.md` P1b                    |
| R7  | Session-derived mesh keys                  | `mesh.rs`, `lib.rs` mesh seal, `mesh_vectors.json`           | §8.1, `POST-QUANTUM.md` row 6            |
| R8  | Decide on hardware-bound prekey signatures | Design only                                                  | §1.1 copied identity key                 |

**R1. Correct the export declaration.** `app.json:21` still reads
`"usesNonExemptEncryption": false` at v3.0.0. `POST-QUANTUM.md` §0 explains why that is wrong
and what the correct filing path is. The flag is one line; the classification behind it needs
the **[LEGAL]** items in that section, and nobody working on this document is qualified to file
it. _Test:_ none in code; the next submission asks the follow-up question.

**R2. Advance the receiving chain on receipt.** Today only a mounted app's read moves a
receiving chain, because a read consumes the position and a background process has nobody to
hand the fix to. `prime` already solves the same problem for restarts: it performs the DH step
without consuming the fix. Generalise it. When any process holding the node sees a signed
envelope from a friend at a position ahead of the stored one, it fast-forwards the chain to that
position, deletes every chain key it passed, performs the DH step if the header carries a new
ratchet key, and stores the **one** message key for that envelope so the reader can open it
later. A newer envelope replaces the stored key.

This keeps at most one message key per friend at rest, for the envelope currently in that
friend's last-write-wins slot. It is not the skipped-key table §9 rejects: that objection is to
a stored index into an archive, and this is the key to the single entry the replica is supposed
to hold anyway. It shrinks the §1 window from "since the app was last opened" to "since the
phone last woke", and it makes the peer's ratchet key fresh on every wake, so a healthy phone
stops lapsing (§4.2). _Test:_ a property test that after any sequence of background receipts
the store holds no chain key older than the newest envelope's position and at most one message
key per author; the §7 step-6 suite's fast-forward and replay cases run against the background
path; a replay of the 2026-10-09 trace (a reader absent 25 h) ending with no restart.

**R3. Reclaim superseded entries and blobs.** This is §7 step 2, still open. Resolve the two
**[MUST VERIFY]** items in §5.1 and §5.2 against the iroh-docs and iroh-blobs versions in
`Cargo.lock`, then delete superseded versions and unreferenced blobs on device, and make the
matching change in the trail-stash repository. If iroh-docs can only tombstone, §5.1 already
says what follows: fixes leave docs for a purpose-built last-write-wins slot. _Test:_ as §7
step 2 states it.

**R4. Measure lapses before and after R2.** Count `sc.restart` by reason and by platform for a
week on the current build, then again after R2. The first number says how much traffic rides
prekey-rooted sessions today. _Test:_ a dashboard row; no code path changes.

**R5. Encrypt the ratchet header.** Adopt the header-encryption variant of the Double Ratchet
specification: derive a header key and a next-header key alongside each chain, encrypt
`{sender_ratchet_pub, epoch, counter}` under the header key, and have the receiver try the
current and the next header key against each wrap. The rotating kid then becomes redundant and
can go, since trial decryption of the header finds the wrap. Cost is one AEAD attempt per wrap
per candidate key on read, and a new envelope version, because the signature covers a re-encode
of the decoded struct (§4.7). Ship it in the same version as R6's `BootHeader` change.
_Test:_ two envelopes from one author to the same recipients share no byte string outside the
signed envelope header; the §7 state-machine suite passes unchanged above the wire layer.

**R6. Hybrid restart prekeys.** `restart_root` takes one X25519 DH. Once pairing is hybrid
(`POST-QUANTUM.md` P1), the first restart would replace a post-quantum root with a classical
one. Publish an ML-KEM-768 encapsulation key beside each X25519 prekey in the control record,
have the leader encapsulate to it, carry the ciphertext in the restart header, and feed both
secrets into `restart_root`. The control record is not size-constrained. The restart header
grows by about 1.1 KB per wrap while a restart is unanswered, on the docs path only. The same
mechanism upgrades a friendship paired before P1 without a re-pair. Detail and the wire
consequences are in `POST-QUANTUM.md` P1b. _Test:_ `tests/restart_protocol.rs` runs with hybrid
prekeys; a restart from a hybrid session never yields a root derived from X25519 alone,
asserted the way `no_session_root_derives_from_static_static_dh` is.

**R7. Session-derived mesh keys.** Implement §8.1's proposal: export a mesh secret from the
session root, hash it forward per mesh epoch, derive the capsule key and tag from it, and stop
sealing the inner mesh envelope to the static receiving key. This changes the normative format
in `docs/mesh/DESIGN.md` §3.2 and its vectors. _Test:_ new vectors in `mesh_vectors.json`; an
assertion that no mesh key derives from a static-static DH; a capsule sealed in epoch `e` does
not open with state taken after epoch `e + 1` has passed.

**R8. Decide on hardware-bound prekey signatures.** §1.1 records that a copied identity key can
publish its own prekey and be restarted into a session. A non-exportable key in the Secure
Enclave or StrongBox, exchanged at pairing and bound into the SAS transcript, could co-sign the
control record so that a filesystem copy cannot mint prekeys. Those keys are P-256, not
ed25519, so this is an extra signature and a pairing wire change. This item is a decision, not
a build: write down whether the copied-and-returned adversary is assumed to write as well as
read, and accept or design accordingly.
