# streetCryptid — Forward Secrecy (ratcheted envelopes over last-write-wins fixes)

> Status: **design of record, pre-implementation.** Nothing here is built. This document
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
> Claims below are marked **[verified]** where checked against the tree at the time of
> writing, and **[MUST VERIFY]** where they are assumptions that gate the plan.

## 1. Goal and threat model

The threat we are designing against is **targeted device seizure by an adversary who
already holds the trail-stash ciphertext archive.** Both halves matter: seizure alone
yields whatever is on the phone, and the archive alone yields ciphertext. Together, under
today's design, they yield the complete decrypted history of everyone who has ever shared
with that device.

In scope:

1. **Past traffic is unrecoverable.** An adversary holding the archive _and_ every key
   present on a seized device can decrypt no fix older than a bounded, small window.
2. **No plaintext history at rest.** Received location history is not retained on device.
3. **No ciphertext archive.** The stash holds the last thing it received, and that is
   structurally true rather than true-by-query.

"Unrecoverable" and "not retained" are claims about _erasure_, not just deletion — SQLite
and flash storage keep deleted data recoverable by default. §5.4 bounds the gap; the
honest form of claim 1 is "no fix older than the last erasure pass," which §5.4 keeps
small, not zero.

Explicitly **out of scope — post-compromise security (PCS).** PCS heals when a legitimate
device keeps running and ratchets forward. A seized device never returns to its owner, so
it never ratchets again, so the session never heals. Against this threat PCS is close to
worthless, and no part of this design should be justified by it. The mechanism that stops
post-seizure access is **revocation**, which already exists (`pool.ts:48` drops the
recipient's wrap; `crypto.rs` re-keys `K` per fix, so no wrap means no access).

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
- **Persist-before-publish.** Hold the state lock across _load → derive → persist →
  seal → publish_, persisting the advanced state **before** the doc write. A crash then
  burns one counter value instead of reusing a key — and because the sending chain can
  step symmetrically, recovery is local: the next publish uses the next counter. No
  peer round-trip, no deadlock. (Revision 1's strict gate turned this same crash into a
  permanent deadlock for watcher edges; see §9.)
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

**The `RK₀` bootstrap.** The first session's root must not be recomputable from statics.
Bootstrap is the §4.6 resync primitive run over the pairing connection during the
in-person SAS bump: fresh ephemerals from both sides, identity-signed, mixed into `RK₀`.
The window of statically-recomputable messages is zero.

**Do not trigger the DH ratchet on `NeighborUp`.** The gossip topic is per _author_
(`lib.rs:202`), so its neighbours are the whole pool; a neighbour coming up may be C, not
B. The trigger is a signed envelope from B carrying a new ratchet pub. `NeighborUp` is
only a hint that publishing is worthwhile.

### 4.3 Regimes

The transport split already exists (`ARCHITECTURE.md:139`): gossip for live, docs for
durable.

|                  | Cold                                               | Hot                      |
| ---------------- | -------------------------------------------------- | ------------------------ |
| Transport        | docs / stash, LWW                                  | gossip, peer connected   |
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
revoked, distinct from merely stale. Live mode remains the escape hatch for "current,
now."

### 4.6 Desync detection and recovery

Any ratchet deployment's real risk is the recovery path becoming the bypass. So:

**Detection.** An envelope that is signature-valid but whose wrap cannot be located or
opened after fast-forwarding the receiving chain through its full acceptance window
(§4.7), persisting across R consecutive envelopes, marks the session desynced. Expected
causes: state loss on one side (reinstall without backup, storage corruption), or an
active adversary tampering with ratchet headers — which the envelope signature confines
to the peer's identity key or the archive replaying (already rejected by monotonicity).

**Recovery is a session restart via the resync primitive — never a static fallback.**
Each side publishes on its control key a resync record: `{new session_id, fresh ephemeral
X25519 pub, peer id, ts}`, signed with its ed25519 identity key, transcript-bound (both
identities and both ephemerals under the signature once known). On seeing the peer's
record, derive `RK₀' = KDF(DH(eph_ours, eph_peer), transcript)`, delete the ephemeral
private per the bootstrap rule, and resume at epoch 0 of the new session. This is the
same primitive as the SAS-bump bootstrap (§4.2), run over the async channel; it works
without liveness because each side's half rides the existing publish lanes.

**Normative:** there is no code path that roots a session in static-static DH alone, and
no automatic downgrade of any kind. An adversary who can force desync (the stash operator
can try, by withholding or replaying) gains a DoS that recovery heals — never a weaker
root. Resyncs are telemetered (`sc.resync` counter with reason); they should be rare, and
a resync loop surfaces a "re-pair with this friend" prompt rather than retrying forever.

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
  while fast-forwarding its receiving chain — bounded by the acceptance window, a few
  hundred hashes worst case. Outsiders can no longer link a recipient across envelopes
  or across authors, closing the §1.1 shared-friend-graph leak.
- **KDF domain separation.** All derivations use `blake3::derive_key` with distinct
  contexts (`sc-dr/v1/rk`, `/ck`, `/mk`, `/kid`, `/boot`), matching the existing
  `mesh.rs` convention.
- The overloaded envelope `epoch` field is left to the mesh path; the docs-path key epoch
  is the per-wrap `i` (this completes §7 step 4's split).

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

**[MUST VERIFY]** whether iroh-docs 0.101 exposes entry deletion that actually purges
rather than tombstones. Prior expectation: it does not — set-reconciliation replicas are
built to converge, not forget, and deletion is tombstone-shaped. If confirmed, fixes
bypass docs entirely (gossip plus a purpose-built LWW stash endpoint) and §7 step 2
changes shape.

### 5.2 Blob store [verified: no GC configured]

Doc entries reference content hashes; envelope ciphertext lives in `FsStore` on disk
(`lib.rs:999`). Dropping an entry does not reclaim the blob. No GC is configured anywhere
in the crate.

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

**The Rust-side store.** Ratchet state (§4.2) persists in the node's data directory on
the filesystem — which Android Auto Backup and iCloud backup capture, and which no
keychain flag protects. This is the store that actually holds the sequential state.

Today this is harmless: a static key restores to itself. **The moment key state becomes
sequential it is a critical hazard** — restoring from backup rewinds the chain and reissues
message keys, which is nonce-and-key reuse and breaks confidentiality outright. This is the
most common way ratchet deployments fail in practice.

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

**7. Resync + bootstrap.** The §4.6 primitive, used for both the SAS-bump bootstrap and
desync recovery; desync detection; `sc.resync` telemetry; the re-pair prompt on resync
loops.
_Test:_ forced state loss on one side converges to a working new session; a replayed old
resync record is rejected; grep-level assertion that no session root derives from
static-static DH alone.

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
| `libsignal` (Signal)                                                                                                | **AGPL-3.0-only** — disqualifying on its own. Also `pub(crate)` and welded to Signal's protobuf session storage.                                                                                                                                                                                                                                                                                                                                                                                                    |
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
| Symmetric chain from the pairing DH                                 | **No FS at all.** Static-static root is recomputable from surviving long-term keys (§3).                                                                                                                                                                                                                                                                                                      |
| Prepublished one-time prekeys                                       | Correct, but the symmetric lanes deliver the ephemeral contribution continuously with no batch, exhaustion, or fallback machinery. Survives as a candidate for the mesh path only (§8.1).                                                                                                                                                                                                     |
| **Strict one-fix-per-ack gate** (revision 1 of this document)       | Deadlocks: a crash after persisting a consumed ack leaves the sender needing an ack the watcher believes it already gave — the retry is a replay and must be rejected. Fixing that needs either a retained multi-key set on the acker or symmetric chain steps; the latter also decouples publish availability from ack round-trips, so the hard gate buys nothing the bounded chain doesn't. |
| **Standalone ack messages** (revision 1)                            | A second, unauthenticated-by-default message lane and state machine whose replay/ordering rules had to be specified from scratch. Superseded by riding the ratchet header inside the already-signed envelope (§4.1).                                                                                                                                                                          |
| Skipped-message key **storage** (full DR as deployed by messengers) | Unnecessary under LWW — there is no history to catch up on — and against an archive-holding adversary it is actively harmful, being a stored key index into the archive. The DR _schedule_ is adopted (§4.2); only the table is rejected: skipped keys are deleted, not stored.                                                                                                               |
| MLS-style group epochs                                              | Membership here is per-author and asymmetric, and offline members reintroduce retained epoch secrets. Large lift, little gain over the above.                                                                                                                                                                                                                                                 |
| **Adopting a third-party Double Ratchet crate**                     | Surveyed under §7.1 and rejected on evidence, not preference: every candidate hardcodes a private skipped-key store capacity, and the strongest (vodozemac) exposes a message key on the sending side only — so a receiver could never unwrap `K` itself. Forcing it means forking the exact code its audit covered. Kept as the standing answer to "why not just use a library?".            |
