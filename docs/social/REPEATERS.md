# streetCryptid — Repeaters (self-hosted, ciphertext-blind replicas)

> Status: **design, with a phase-0 spike.** Written 2026-11-07. The spike is in
> `unrealJune/trail-stash` (PR #7, `spike/repeater`): the stash daemon on disk, reconciling with
> sibling repeaters, with integration tests against real iroh endpoints. Nothing in the app
> changes yet. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6 and §10 and
> [`FORWARD-SECRECY.md`](./FORWARD-SECRECY.md) §4.1 first.

## 1. What a repeater is

The hosted trail stash is open source and anyone can run one, but the app can only practically
point at one, and opting out of it leaves a pool with no always-on copy. That matters most in a
two-person pool, where the only other copy is a phone that is usually asleep. A **repeater** fills
that gap with a machine its owner already has: a laptop, a desktop, a Raspberry Pi.

A repeater is **the stash run as a daemon**, with three differences:

- **It is persistent.** A laptop restarts all the time, and the phones that granted it are not
  awake to grant it again. It records every grant to disk and reopens all of them on start.
- **It is not guaranteed to be up.** It is only _more likely_ to answer than a phone. Nothing on
  the delivery path may assume it is reachable (§5).
- **It is admitted, not configured.** People consent to it individually, and a pool of repeaters
  has an access-control list (ACL) for who may invite others (§3, §4).

It is **ciphertext-blind**, exactly like the stash. It holds read capabilities and sealed
envelopes, it is never in a wrap set, and it holds no ratchet state. Seizing one yields what the
stash operator already sees (§8). Every friend's per-pair location keys stay exactly where they
are. In MLS terms (`trail-stash/src/mls.rs`) it is another untrusted Delivery Service.

## 2. Two grants, kept apart

`ARCHITECTURE.md` §6 already splits access in two. **Joining the swarm** means holding a read
ticket and replicating ciphertext. **Decrypt access** means being in the wrap set. Every kind of
participant is one combination of those two grants, so it helps to name each one now, before
service accounts arrive (§7):

| participant              | swarm (replicates) | decrypt (wrapped for)    | publishes  | in friends list |
| ------------------------ | ------------------ | ------------------------ | ---------- | --------------- |
| friend                   | yes                | yes (or a watcher, §4.1) | yes        | yes             |
| hosted stash             | yes                | **no**                   | no         | no              |
| **repeater**             | yes                | **no**                   | no         | no              |
| service account (future) | optional           | yes, per sharer          | null fixes | no              |

The rules that follow from this table, and that the implementation must keep:

- **A repeater is never in `PoolState.friends`.** Everything in `friends` becomes a recipient or
  a watcher (`pool.ts`), and a watcher gets null fixes sealed for it every tick. A repeater in
  there would get a ratchet session, spend window positions, and take part in leader restarts. It
  needs its own collection, and a test that `recipients ∪ watchers` never contains one.
- **A repeater identity never holds recipient keys.** A future service account may run on the
  same box (a Home Assistant add-on), but it has its **own** identity. Compromising the repeater
  must never expose plaintext.

## 3. Pools, the roster, and the ACL

A **pool** is a set of repeaters plus a **roster**: the list of people whose namespaces those
repeaters carry and what each of them may do.

### 3.1 Is the allowlist needed?

A separate allowlist that the owner keeps by hand is not needed: **the roster is the
allowlist.** A repeater carries a namespace only if the namespace's author is a current member. It
does need _some_ list, for three reasons:

- Without one, anyone who learns a repeater's endpoint ticket can make it store and serve
  arbitrary namespaces, which is both a storage-abuse problem and a way to make it dial things.
- Consent is only real if it can be withdrawn, and something has to record the withdrawal.
- With several repeaters, the list is the thing they have to agree on.

### 3.2 Roles

| role        | may                                                                             |
| ----------- | ------------------------------------------------------------------------------- |
| **owner**   | everything; the pool's root of trust. Adds and removes repeaters, grants roles. |
| **inviter** | invite new members; turn on auto-offer for their own new friends (§4.4).        |
| **member**  | have their namespace carried; leave.                                            |

The owner is the phone that claimed the first repeater (§4.1). Granting `inviter` is how a pool
grows without the owner approving every person. "Expand it automatically to new friends" is a
per-inviter setting, not a pool-wide one: it decides whether _my_ new friends are offered _my_
pools.

### 3.3 The roster is a signed operation log

The roster is a hash-linked log of operations, each one signed by the endpoint key of the phone
that made it:

```
Genesis { pool_id, owner }                     signed by owner
AddRepeater { repeater, cert }                 by owner
Offer { member, by }                           by inviter/owner — an invitation
Join { member, offer }                         by the member — their consent
Grant { member, role } / Revoke { member, role } by owner
Remove { member } / Leave { member }           by owner / by the member
```

- `pool_id` is the hash of the genesis op.
- A namespace is carried only when both an `Offer` and a matching `Join` exist and neither has
  been removed. **Admission needs the inviter's offer and the member's consent**, and neither
  side can fake the other.
- Every op names its causal parents, so concurrent ops merge. Validity is decided by replaying
  from genesis: an op counts only if its signer held the needed role at the op's parents.
  `Remove` and `Revoke` beat anything the removed party did concurrently.
- The log is replicated between the pool's repeaters as one more iroh-docs namespace, the same
  machinery the spike already reconciles between siblings. Any member can read it from any
  repeater and check it. A repeater cannot forge membership, because every op is signed by a
  phone.
- Members can see who else is in the pool. That is inherent to a shared roster, and it is
  disclosed at `Join` time.

## 4. Admission without SAS

Short authentication strings (SAS) exist because pairing has to authenticate a stranger's key
over an untrusted path. Every admission here rides on a path that is already authenticated,
whether that is a QR code shown on a screen or a friend's SAS-verified key.

### 4.1 Claiming a repeater

`trail-stash` in repeater mode prints a QR code holding its **full endpoint id** plus a one-time
claim secret. Scanning it, the phone dials the repeater on a new `streetcryptid/repeater/1` ALPN
and sends `Claim { secret }` signed by the phone's key. The repeater then:

1. records that phone as the owner of a new pool;
2. returns a `RepeaterCert`, signed by the repeater, binding `(pool_id, repeater id)`.

The QR code carries the whole key, so this is stronger than an SAS comparison and needs no second
screen. Adding a second repeater to an existing pool is the same claim followed by
`AddRepeater`. The claim secret is single use and expires quickly. Losing `secret.key` means
claiming a new repeater, which is why the daemon never regenerates it over an unreadable one.

### 4.2 Announcing a pool, and confirming it through other friends

Each member publishes a signed **`PoolCard`** in their **profile namespace**, under its own key.
The card contains:

- the pool id;
- each repeater's endpoint ticket and `RepeaterCert`;
- the roster head the member last saw.

The card must not be added as a field of `ProfileRecord`. That record's signature covers a
re-encode of the decoded struct, so appending a field breaks verification for every older reader,
the same trap as `PairMsg`. A separate key with its own signing context is ignored by old clients
and costs nothing.

A friend therefore learns of a pool from a card signed by someone they already verified by SAS.
To substitute a repeater, an attacker needs that friend's identity key. **Confirmation through
other members** builds on this:

- Your app collects every `PoolCard` your friends publish for a pool and shows the consent screen
  as _"Carried by June's repeaters · vouched by June, Sam"_.
- If two friends' cards **disagree**, the app shows a warning and offers no one-tap join. Two cards
  disagree when they name different repeaters for the same `pool_id`, or roster heads where
  neither is an ancestor of the other.
- **Auto-join can require two vouches.** Defeating that means compromising two of your friends,
  not one.
- On first contact the app fetches the roster from the repeater and checks that it starts at the
  genesis the cards name. A repeater that serves a different log is rejected.

### 4.3 Consent is asynchronous

An `Offer` and a `Join` are signed ops, and a phone **queues them durably** until any repeater in
the pool answers, the same way the outbox holds envelopes. Nobody has to be online at the same
moment:

- An inviter can offer while every repeater is off.
- The member can accept days later.
- Whichever repeater wakes first takes both ops, and its siblings converge from it.

After `Join`, the member's phone sends its trail **read ticket** directly to a repeater over the
repeater ALPN (`Grant { ticket }`). It is **not** written into the roster, so pool members who are
not that person's friends never hold it.

### 4.4 Offering a pool at pairing time

No pairing-wire change is needed, and none should be made: `PairMsg` is signed over a re-encode,
so appending to it means bumping `PAIR_ALPN` (see `AGENTS.md`). The offer travels on paths that
already exist.

- **Inviter side.** At ACKNOWLEDGE, if I hold `inviter` in any pool, the screen shows _"Also offer
  my repeaters"_. It is pre-checked when that pool's auto-offer is on, and acknowledging writes an
  `Offer` to my queue. Like everything else at ACKNOWLEDGE, it is not awaited (`connectNewFriend`).
- **Receiving side.** The pool is visible as soon as the inviter's `PoolCard` arrives. The v4
  pairing `Accept` carries the profile record, and the card follows on the profile namespace.
  Once a repeater reports an `Offer` for me, the app shows _"Sam offers their repeaters"_ with
  Join and Not now. That happens on the pairing result screen if it arrives in time, and otherwise
  as a badge in Settings → Repeaters.

## 5. Delivery

A repeater is one more peer in the existing paths. It never becomes something the paths depend
on.

- **Addressing.** The repeaters of every pool I have joined are added to
  `DeliveryConfig.peer_tickets` and to the pull targets, capped at 3 per pool and 6 in total.
  Every extra dial costs iOS wake time.
- **Push.** Pushes go to everyone in parallel under the existing budget, and **a repeater is never
  waited for.** Today a push stops waiting once the stash has finished taking the entries
  (`docs.rs`, "break on the stash"). A repeater may end that wait in the same way, but only by
  having **already answered with a receipt** for the entries and their content. A repeater that is
  down was never in the race and costs nothing.
- **Receipt.** A repeater on a laptop has no HTTP content API. The phone can instead ask over the
  repeater ALPN, `Have { hashes } → bitmap`, while it is still connected. Until that exists, a
  repeater cannot end a wait early.
- **Pull.** `friend_pull` dials repeaters alongside the stash and friends. A repeater that answers
  is a source like any other.
- **Isolation (`isolation.rs`).** An answer from a repeater counts as contact. Its silence does
  **not** count toward isolation, because a closed laptop is not a broken network. Only the
  stash's silence does.
- **Telemetry.** Add `contact.role = repeater` on `peer.contact`, and `repeaters.joined` /
  `repeaters.last_contact_age_ms` on `device.health`. The daemon emits `repeater.*` spans
  (`repeater.restore`, `repeater.peer_sync` exist in the spike).
- **Relays.** A repeater's ticket goes through `relay::scrub_addr` like any other, so the daemon
  should default to the app's relay list (at most 5, see the relay notes in `AGENTS.md`). If its
  home relay is missing from the phone's map, the phone falls back to address lookup.
- **Retention.** Last-write-wins, as in `FORWARD-SECRECY.md` §4.4. The stash's retention code runs
  unchanged and keeps the latest fix per author.

## 6. Several repeaters in one pool

A pool can hold several repeaters, and they reconcile with each other:

- **Every carried namespace.** Each repeater runs `sync_peers` against its siblings on a timer
  (`TRAIL_STASH_PEER_SYNC_INTERVAL_MIN`, default 5). Two repeaters that were awake at different
  times converge the next time they overlap, with no phone in between. Content follows the records
  automatically: the sibling is recorded as the delivering peer, and the settle loop fetches the
  bytes from it.
- **The roster.** It is replicated in the same way (§3.3), so a `Join` taken by one repeater
  reaches the others.
- **Siblings in the spike.** They are configured by hand (`TRAIL_STASH_PEERS`). In the full design
  they come from the roster's `AddRepeater` ops.

## 7. Service accounts (out of scope, but decided now)

A Home Assistant presence sensor is the opposite of a repeater: **decrypt without swarm.** It
needs plaintext, so it must be in the wrap set. What the protocol already implies about it:

- **It is a full participant in the ratchet.** FORWARD-SECRECY.md §4.1 makes every edge
  symmetric, and a watcher must publish null fixes so that both sides contribute key material.
  A service account therefore needs its own identity, its own namespace for null fixes and for its
  prekey/control record (§4.6), and a session with each sharer. In protocol terms it is a headless
  friend that never shares a real position, not a reader bolted on.
- **Consent is per sharer**, because the wrap set is per sharer. Owning the account does not let
  you share anyone else's location with it.
- **It is a pool member with a `kind`, not a separate system.** The friend model should grow a
  `kind` (`person | service`) rather than repeaters being squeezed into `friends`. That is why §2
  keeps repeaters out of `friends` entirely.
- **It never shares an identity with a repeater** (§2).
- **It costs one wrap per envelope.** Check the pad budget before promising many.

## 8. Threat model additions (`ARCHITECTURE.md` §10)

- **Repeater operator or thief.** Sees what the stash operator sees: sealed envelopes, which
  namespaces exist, arrival times and sizes. It also learns the pool roster (members' endpoint
  ids) and the IP addresses of members' phones when they dial it. It cannot decrypt, cannot forge
  fixes, and cannot forge roster ops. The disk holds ciphertext, the grant book and
  `secret.key`. The only extra harm from that key is impersonating the repeater, which members
  detect through `RepeaterCert` and the roster genesis.
- **A malicious member** can learn who else is in the pool, and can fill the repeater's disk with
  its own namespace. It cannot read anyone's location. Quotas per member belong in phase 3.
- **A compromised inviter** can offer the pool to anyone, but cannot make anyone join. The owner
  revokes the role.
- **The roster is not secret from members.** That is stated at `Join`.

## 9. Phases

0. **Spike: the stash on disk, with siblings.** Built; trail-stash PR #7. It adds `Storage::Persistent`,
   a grant book that is written before a grant is acknowledged and fails the start when
   unreadable, adoption of on-disk entries into the content ledger, `sync_peers`, and a
   self-generated identity. It is proven by integration tests: a restart with the writer gone
   still serves the trail; siblings converge and a reader pulls from the repeater that never saw
   the writer; an unreadable book refuses to start. Grants still use the PSK'd HTTP API, which is
   enough to point a phone at one by hand.
1. **Roster and claim.** The `streetcryptid/repeater/1` ALPN (Claim, Grant, roster sync, Have),
   the roster log and its validation (pure, with the replay rules as tests), `RepeaterCert`,
   enforcement in the daemon, and a QR printer in the daemon.
2. **App.**
   - A `repeaters` collection outside `friends`, with the invariant test.
   - `PoolCard` on the profile namespace, cross-friend vouching, and the consent UI.
   - The offer at ACKNOWLEDGE.
   - Delivery: `peer_tickets`, pull targets, the receipt-gated early break, isolation, and
     telemetry.
3. **Operations.**
   - Disk blob GC, with the content ledger rebuilt before the store opens, since the spike leaves
     released content on disk.
   - Per-member quotas.
   - Packaging: systemd unit, launchd plist, Windows service, and a Home Assistant add-on.
   - Health on the daemon (`/healthz` is already there).

## 10. Open questions

- **Owner continuity.** The owner is a phone identity, so a lost phone orphans the pool until
  multi-device identity exists (`ARCHITECTURE.md` §9d). Should the owner be able to designate a
  co-owner?
- **Repeater as a pull accelerator.** A repeater that is up could pull friends' namespaces
  proactively from the stash, so that a LAN-local phone pulls from it quickly. That is a latency
  win to measure, not a design need.
- **Roster visibility.** Could members see only the part of the chain that admits them, with full
  visibility kept to repeaters and the owner? It costs validation complexity. Decide in phase 1.
