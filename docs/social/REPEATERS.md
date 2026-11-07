# streetCryptid — Repeaters (self-hosted, ciphertext-blind replicas)

> Status: **design, with a phase-0 spike.** Written 2026-11-07; revised the same day so that
> reading is open and the only opt-in is having your own trail carried (§2.1). The spike is in
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
- **Carrying a trail is opt-in; reading from it is not.** Each person chooses whether a pool
  of repeaters replicates _their own_ trail on their behalf (§3, §4). Anyone may pull from a
  repeater, the same as from any other replica (§2.1).

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

### 2.1 Reading is open, by protocol and by decision

Nothing in iroh gates who reads a replica, and this design does not add a gate.

- **iroh-docs serves any peer that names the namespace.** A read ticket is essentially the
  namespace id plus addresses, so any node holding a namespace reconciles it with whoever asks:
  a friend, a repeater, the stash, or a stranger who learned the id.
- **Gossip connects replicas nobody chose.** Every docs namespace has a gossip swarm, and the docs
  engine syncs with each new gossip neighbour on its own. `docs.rs` already records pushes
  finishing with peers that `start_sync` was never told about. Gossip passes peer addresses along,
  so two of A's friends who are not friends with each other can become neighbours in A's swarm and
  serve A's envelopes to one another. That is the "recovery against C/D/A" of `ARCHITECTURE.md`
  §6, and it is intended.
- **Content stays safe.** Envelopes are sealed per recipient, so a relaying copy is useless to
  anyone it was not wrapped for, and a recipient can open a copy from any source.
- **Metadata is the cost, and we accept it.** Whoever serves you, or is served by you, learns your
  endpoint id, your IP address, and which namespaces you read.

So there is **no consent to read and no consent to be read through**:

- Nobody joins a pool to pull from its repeaters (§5).
- Phones do not filter incoming docs or gossip connections by who the peer is.
- The stash opt-out keeps your trail off the hosted stash. It does not promise that your phone
  never ends up connected to it through someone else's swarm.

The one thing a person opts into is **carrying**: whether a pool replicates their own namespace
on their behalf and they push to it. Carrying spends someone else's disk and gives that pool a
copy of your ciphertext to hold, so it is a choice and not a side effect.

## 3. Pools, the roster, and the ACL

A **pool** is a set of repeaters plus a **roster**: the list of people whose namespaces those
repeaters carry, who may add more, and how.

### 3.1 Why a roster at all

Reading is open, but a repeater still needs to know whose namespaces it should hold.

- Without that list, anyone who learns a repeater's ticket could make it store and serve
  arbitrary namespaces. That would be a storage-abuse problem, and a way to make it dial things.
- Opting out has to be possible, and something has to record it.
- With several repeaters, the roster is the thing they have to agree on.

The roster is the only list. Nobody keeps an allowlist by hand.

### 3.2 Roles and join policy

| role        | may                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| **owner**   | everything; the pool's root of trust. Adds and removes repeaters, grants roles, sets the join policy. |
| **inviter** | offer the pool to people (§4.4); turn on auto-offer for their own new friends.                        |
| **member**  | have their trail carried; leave.                                                                      |

Each pool has one **join policy**, set by the owner:

- **`invite`**: carrying needs an `Offer` from an inviter or the owner, plus the person's `Join`.
- **`open`**: anyone who learns of the pool from a member's `PoolCard` (§4.2) may `Join`
  directly. In practice that means the friends of its members. This is the "a friend sets up a
  repeater later and anyone may use it" case. Per-member quotas (phase 3) bound what an open pool
  can be made to hold, and the owner can `Remove` anyone.

The owner is the phone that claimed the first repeater (§4.1). Granting `inviter` is how an
`invite` pool grows without the owner approving every person. Auto-offer is a per-inviter
setting: it decides whether _my_ new friends are offered _my_ pools at pairing time.

### 3.3 The roster is a signed operation log

The roster is a hash-linked log of operations, each one signed by the endpoint key of the phone
that made it:

```
Genesis { pool_id, owner, policy }             signed by owner
SetPolicy { invite | open }                    by owner
AddRepeater { repeater, cert }                 by owner
Offer { member, by }                           by inviter/owner — `invite` pools only
Join { member, offer? }                        by the member — "carry my trail"
Grant { member, role } / Revoke { member, role } by owner
Remove { member } / Leave { member }           by owner / by the member
```

- `pool_id` is the hash of the genesis op.
- **A namespace is carried when its author has a valid `Join`** and has not left or been removed.
  In an `invite` pool, a `Join` is valid only if it names a live `Offer`. In an `open` pool, a
  `Join` needs no offer. Either way, only the person can sign their own `Join`, so nobody's trail
  is carried without their choosing it.
- Every op names its causal parents, so concurrent ops merge. Validity is decided by replaying
  from genesis: an op counts only if its signer held the needed role at the op's parents.
  `Remove` and `Revoke` beat anything the removed party did concurrently. A `SetPolicy`
  takes effect for ops after it; it never invalidates a `Join` that was valid when it was made.
- The log is replicated between the pool's repeaters as one more iroh-docs namespace, the same
  machinery the spike already reconciles between siblings. Any member can read it from any
  repeater and check it. A repeater cannot forge membership, because every op is signed by a
  phone.
- Members can see who else is in the pool. That is inherent to a shared roster, and the join
  screen says so.

## 4. Joining without SAS

Short authentication strings (SAS) exist because pairing has to authenticate a stranger's key
over an untrusted path. Joining a pool rides on a path that is already authenticated, whether that
is a QR code shown on a screen or a friend's SAS-verified key. What joining protects against is
**pushing your trail to the wrong machine**: a lookalike repeater that would collect your
ciphertext and your phone's metadata.

### 4.1 Claiming a repeater

`trail-stash` in repeater mode prints a QR code holding its **full endpoint id** plus a one-time
claim secret. Scanning it, the phone dials the repeater on a new `streetcryptid/repeater/1` ALPN
and sends `Claim { secret }` signed by the phone's key. The repeater then:

1. records that phone as the owner of a new pool, with the policy the owner chose;
2. returns a `RepeaterCert`, signed by the repeater, binding `(pool_id, repeater id)`.

The QR code carries the whole key, so this is stronger than an SAS comparison and needs no second
screen. Adding a second repeater to an existing pool is the same claim followed by
`AddRepeater`. The claim secret is single use and expires quickly. Losing `secret.key` means
claiming a new repeater, which is why the daemon never regenerates it over an unreadable one.

### 4.2 Announcing a pool, and confirming it through other friends

Each member publishes a signed **`PoolCard`** in their **profile namespace**, under its own key.
The card contains:

- the pool id and its join policy;
- each repeater's endpoint ticket and `RepeaterCert`;
- the roster head the member last saw.

The card must not be added as a field of `ProfileRecord`. That record's signature covers a
re-encode of the decoded struct, so appending a field breaks verification for every older reader,
the same trap as `PairMsg`. A separate key with its own signing context is ignored by old clients
and costs nothing.

A friend therefore learns of a pool from a card signed by someone they already verified by SAS.
To substitute a repeater, an attacker needs that friend's identity key. **Confirmation through
other members** builds on this:

- Your app collects every `PoolCard` your friends publish for a pool and shows it as _"June's
  repeaters · vouched by June, Sam"_.
- If two friends' cards **disagree**, the app shows a warning and offers no one-tap join. Two cards
  disagree when they name different repeaters for the same `pool_id`, or roster heads where
  neither is an ancestor of the other.
- **Auto-join can require two vouches.** Defeating that means compromising two of your friends,
  not one.
- On first contact the app fetches the roster from the repeater and checks that it starts at the
  genesis the cards name. A repeater that serves a different log is rejected.

The same cards are also how you **read** through a pool: they tell your phone which repeaters
carry a friend (§5).

### 4.3 Joining is asynchronous

`Offer` and `Join` are signed ops, and a phone **queues them durably** until any repeater in the
pool answers, the same way the outbox holds envelopes. Nobody has to be online at the same moment:

- An inviter can offer while every repeater is off.
- The member can join days later.
- Whichever repeater wakes first takes the ops, and its siblings converge from it.

After `Join`, the member's phone sends its trail **read ticket** directly to a repeater over the
repeater ALPN (`Grant { ticket }`). It is not written into the roster. Reading is open (§2.1), so
this is not a secrecy measure. It keeps the roster small, and keeps tickets with their fresh
addresses on the path that uses them.

### 4.4 Where the choice is offered

The same question, _"Replicate your trail on June's repeaters?"_ (Join / Not now), appears in two
places.

**At pairing.** When a pair completes, each side looks at the other's `PoolCard`s and offers every
pool it may join:

- an `open` pool;
- an `invite` pool where the other side has offered it to me.

On the inviting side, the ACKNOWLEDGE screen shows _"Also offer my repeaters"_ for each `invite`
pool where I hold `inviter`. It is pre-checked when my auto-offer is on. Acknowledging queues the
`Offer`, and like everything else at ACKNOWLEDGE it is not awaited (`connectNewFriend`).

The cards arrive with the pair: the v4 `Accept` carries the profile record, and the cards follow
on the profile namespace. If they arrive in time the question is on the pairing result screen.
Otherwise it appears as a badge on the repeater menu.

**In the repeater menu** (Settings → Repeaters), at any time:

- **Carrying my trail.** The pools I have joined. Each one shows its repeaters and when each was
  last in contact, with a Leave action.
- **Available through friends.** Every pool on a friend's `PoolCard` that I may join: `open`
  pools, and `invite` pools with an offer waiting for me. This is how a pool a friend sets up later
  reaches people who paired long before it existed.
- **Mine.** Pools I own or can invite to: claim a repeater, set the join policy, grant `inviter`,
  remove members, and toggle auto-offer.

No pairing-wire change is needed, and none should be made: `PairMsg` is signed over a re-encode,
so appending to it means bumping `PAIR_ALPN` (see `AGENTS.md`).

## 5. Delivery

A repeater is one more peer in the existing paths. It never becomes something the paths depend
on.

- **Push: only to pools carrying me.** Pushes of my own trail go to the repeaters of pools I have
  joined. A repeater outside those pools would refuse my namespace anyway. Pushes go to everyone in
  parallel under the existing budget, and **a repeater is never waited for.** Today a push stops
  waiting once the stash has finished taking the entries (`docs.rs`, "break on the stash"). A
  repeater may end that wait in the same way, but only by having **already answered with a
  receipt** for the entries and their content. A repeater that is down was never in the race and
  costs nothing.
- **Receipt.** A repeater on a laptop has no HTTP content API. The phone can instead ask over the
  repeater ALPN, `Have { hashes } → bitmap`, while it is still connected. Until that exists, a
  repeater cannot end a wait early.
- **Pull: from whoever carries the friend, joined or not.** For each friend, `friend_pull` also
  dials the repeaters on that friend's `PoolCard`s, because those repeaters carry that friend.
  Reading is open (§2.1), so this needs no membership. Pull targets are capped at 3 repeaters per
  friend and 6 per pass, because every extra dial costs iOS wake time. A repeater that answers is
  a source like any other.
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
- **Sharing with it is per sharer**, because the wrap set is per sharer. Owning the account does
  not let you share anyone else's location with it. This is a decrypt grant, so it stays explicit
  even though reading ciphertext is open (§2.1).
- **It is a pool member with a `kind`, not a separate system.** The friend model should grow a
  `kind` (`person | service`) rather than repeaters being squeezed into `friends`. That is why §2
  keeps repeaters out of `friends` entirely.
- **It never shares an identity with a repeater** (§2).
- **It costs one wrap per envelope.** Check the pad budget before promising many.

## 8. Threat model additions (`ARCHITECTURE.md` §10)

- **Repeater operator or thief.** Sees what the stash operator sees: sealed envelopes, which
  namespaces exist, arrival times and sizes. It also learns the pool roster (members' endpoint
  ids), and the IP address of every phone that pushes to it or pulls from it, members or not. It
  cannot decrypt, cannot forge fixes, and cannot forge roster ops. The disk holds ciphertext, the
  grant book and `secret.key`. The only extra harm from that key is impersonating the repeater,
  which members detect through `RepeaterCert` and the roster genesis.
- **Any reader** can pull a carried namespace's ciphertext from a repeater, as from any other
  replica (§2.1). It cannot open anything not wrapped for it.
- **A malicious member** can learn who else is in the pool, and can fill the repeater's disk with
  its own namespace. In an `open` pool that is anyone who saw a `PoolCard`. Per-member quotas and
  the owner's `Remove` bound it.
- **A compromised inviter** can offer the pool to anyone, but cannot make anyone join. The owner
  revokes the role.
- **The roster is not secret from members.** The join screen says so.

## 9. Phases

0. **Spike: the stash on disk, with siblings.** Built; trail-stash PR #7, CI green. It adds
   `Storage::Persistent`, a grant book that is written before a grant is acknowledged and fails
   the start when unreadable, adoption of on-disk entries into the content ledger, `sync_peers`,
   and a self-generated identity. It is proven by integration tests: a restart with the writer
   gone still serves the trail; siblings converge and a reader pulls from the repeater that never
   saw the writer; an unreadable book refuses to start. Grants still use the PSK'd HTTP API, which
   is enough to point a phone at one by hand.
1. **Roster and claim.** The `streetcryptid/repeater/1` ALPN (Claim, Grant, roster sync, Have),
   the roster log with both join policies and its validation (pure, with the replay rules as
   tests), `RepeaterCert`, carrying enforced by the daemon (reading stays open), and a QR printer
   in the daemon.
2. **App.**
   - A `repeaters` collection outside `friends`, with the invariant test.
   - `PoolCard` on the profile namespace, with cross-friend vouching.
   - The Join prompt at pairing and in the repeater menu.
   - Delivery: pushes to joined pools, pulls from friends' pools, the receipt-gated early break,
     isolation, and telemetry.
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
- **How common is relaying between non-friends?** `peer.contact{contact.role=other}` counts
  exchanges between phones that are not friends. A week of it would show how often the open-read
  path in §2.1 actually delivers. That is worth knowing before anyone proposes closing it.
- **Roster visibility.** Could members see only the part of the chain that admits them, with full
  visibility kept to repeaters and the owner? It costs validation complexity. Decide in phase 1.
