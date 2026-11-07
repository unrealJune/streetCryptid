# streetCryptid — Repeaters (self-hosted, ciphertext-blind replicas)

> Status: **design; phases 0 and 1 built in `unrealJune/trail-stash`.** Written 2026-11-07.
>
> - Phase 0 (PR #7): the stash daemon on disk, reconciling with sibling repeaters.
> - Phase 1 (`phase1/roster`): the roster, claiming, and the `streetcryptid/repeater/1` protocol,
>   with integration tests against real iroh endpoints.
>
> Nothing in the app changes yet. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6 and §10 and
> [`FORWARD-SECRECY.md`](./FORWARD-SECRECY.md) §4.1 first.
>
> **Vocabulary.** There are no "pools" of repeaters. A person **owns repeaters**, and their
> **roster** records which machines those are and whose trails they **carry**. The app says
> _"June's repeaters"_. A friend's sharing pool (`PoolState`) is a different thing and is not
> involved.

## 1. What a repeater is

The hosted trail stash is open source and anyone can run one, but the app can only practically
point at one. Opting out of it leaves a friendship with no always-on copy. That matters most
between two people, where the only other copy is a phone that is usually asleep. A **repeater**
fills that gap with a machine someone already has: a laptop, a desktop, a Raspberry Pi.

A repeater is **the stash run as a daemon**, with three differences:

- **It is persistent.** A laptop restarts all the time, and the phones that granted it are not
  awake to grant it again. It records every grant to disk and reopens all of them on start.
- **It is not guaranteed to be up.** It is only _more likely_ to answer than a phone. Nothing on
  the delivery path may assume it is reachable (§5).
- **Carrying a trail is opt-in; reading from it is not.** Each person chooses whether someone's
  repeaters replicate _their own_ trail on their behalf (§3, §4). Anyone may pull from a repeater,
  the same as from any other replica (§2.1).

It is **ciphertext-blind**, exactly like the stash:

- It holds read capabilities and sealed envelopes.
- It is never in a wrap set, and it holds no ratchet state.
- Seizing one yields what the stash operator already sees (§8), and every friend's per-pair
  location keys stay exactly where they are.

In MLS terms (`trail-stash/src/mls.rs`) it is another untrusted Delivery Service.

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

- Nobody enrols with anyone's repeaters to pull from them (§5).
- Phones do not filter incoming docs or gossip connections by who the peer is.
- The stash opt-out keeps your trail off the hosted stash. It does not promise that your phone
  never ends up connected to it through someone else's swarm.

The one thing a person opts into is **carrying**: whether someone's repeaters replicate their own
namespace on their behalf and they push to them. Carrying spends someone else's disk and gives
those machines a copy of your ciphertext to hold, so it is a choice and not a side effect.

## 3. The roster

Each repeater belongs to exactly one **owner**: the phone that claimed it. The owner's **roster**
lists:

- the owner's repeaters;
- whose trails they carry;
- who besides the owner may invite people;
- how people get in (the policy).

A person with three repeaters has one roster that all three replicate.

### 3.1 Why a roster at all

Reading is open, but a repeater still needs to know whose namespaces it should hold.

- Without that list, anyone who learns a repeater's ticket could make it store and serve arbitrary
  namespaces. That would be a storage-abuse problem, and a way to make it dial things.
- Opting out has to be possible, and something has to record it.
- With several repeaters, the roster is the thing they have to agree on.

The roster is the only list. Nobody keeps an allowlist by hand.

### 3.2 Roles and policy

| role        | may                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------- |
| **owner**   | everything; the root of trust. Adds and removes repeaters, grants roles, sets the policy. |
| **inviter** | invite people; turn on auto-invite for their own new friends (§4.4).                      |
| **member**  | have their trail carried; withdraw.                                                       |

Each roster has one **policy**, set by the owner:

- **`invite`**: carrying needs an `Invite` from an inviter or the owner, then the person's own
  `Enroll`.
- **`open`**: anyone who learns of the repeaters from a member's `RepeaterCard` (§4.2) may
  `Enroll` directly. In practice that means the friends of its members. This covers the case of a
  friend who sets up a repeater later and lets anyone use it. The owner can `Remove` anyone.
  Per-member limits bound the rest: at most four namespaces each today, with quotas in phase 3.

Granting `inviter` is how an `invite` roster grows without the owner approving every person.
Auto-invite is a per-inviter setting: it decides whether _my_ new friends are invited, at pairing
time, to the repeaters I can invite people to.

### 3.3 The roster is a signed operation log

The roster is a hash-linked log of operations, each one signed by the endpoint key of the phone
that made it (`trail-stash/src/roster.rs`):

```
Genesis { owner, policy, nonce }                 signed by owner; its op id is the roster id
SetPolicy { invite | open }                      by owner
AddRepeater { cert } / RemoveRepeater { id }     by owner (cert: §4.1)
Invite { member }                                by owner or an inviter
Enroll { invite? }                               by the member: "carry my trail"
Grant / Revoke { member, inviter }               by owner
Remove { member }                                by owner
Withdraw                                         by the member
```

**Who is carried.**

- A trail is carried when its author has an `Enroll` that still stands. Only the person can sign
  their own `Enroll`, so nobody's trail is carried without their choosing it. An `Invite` alone
  carries nobody.
- In an `invite` roster, an `Enroll` needs an invite naming that member.

**How concurrent ops resolve.** Every op names its causal parents, so the log is a DAG. Every rule
is phrased in terms of what the signer had _seen_, never arrival order, so replicas that hold the
same ops agree. The test `order_does_not_matter` feeds one log in 200 orders.

- An op counts only if its signer held the needed role **in the op's own causal past**. One that
  did not is refused when inserted, because its past can never change.
- **A removal beats anything concurrent with it:**
  - an invite concurrent with its inviter's revocation does not stand;
  - an enrolment concurrent with a `Remove` or `Withdraw` ends.
- A revocation made _after_ an invite stops later invites, not that one.
- A `Remove` is sticky against re-enrolment until an invite made after it.
- A `SetPolicy` applies to ops that have seen it. It never drops an enrolment made while the
  roster was open. Two concurrent ones resolve to `invite`, the stricter.

**Signed bytes are kept as signed.** An op is stored as the exact bytes its signer signed and is
decoded only after the signature checks out. `PairMsg` and `ProfileRecord` sign a re-encode of the
decoded struct, which is why appending a field to either is a breaking change; the roster does not
share that trap.

**Who replicates and reads it.**

- The log is replicated between the owner's repeaters over the repeater protocol (§6). A repeater
  cannot forge any of it, because every op is signed by a phone.
- The owner, carried members, inviters and the owner's repeaters can fetch it. Members can
  therefore see who else is carried; the enrol screen says so.

## 4. Attestation and enrolment, without SAS

Short authentication strings (SAS) exist because pairing has to authenticate a stranger's key
over an untrusted path. Everything here rides on a path that is already authenticated: a code shown
on the repeater's own screen, a friend's SAS-verified key, or the QUIC handshake. What it protects
against is **pushing your trail to the wrong machine**: a lookalike repeater that would collect
your ciphertext and your phone's metadata.

### 4.1 Linking a repeater to its owner

Linking takes four signatures and one handshake. No single key can put a machine in someone's
roster, or a roster on someone's machine.

| step                                       | signed by                        | proves                                                                  |
| ------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------- |
| `Genesis`                                  | the owner's phone                | who the owner is; its op id is the roster id                            |
| `Claim` over `streetcryptid/repeater/1`    | (the QUIC handshake)             | the caller is the owner named in the genesis                            |
| `RepeaterCert { roster, owner, repeater }` | **the repeater**                 | this machine agreed to be this owner's, in this roster                  |
| `AddRepeater { cert }`                     | the owner                        | the owner lists this machine; a repeater cannot add itself or a sibling |
| `RepeaterCard` (§4.2)                      | a friend already verified by SAS | how a phone learns of a roster without trusting whoever told it         |

The claim works like this:

1. An unclaimed repeater prints a **claim link** on its own console:
   `streetcryptid-repeater:<endpoint ticket>#<secret>`. The endpoint ticket carries the
   repeater's full endpoint id, so scanning it is as strong as an SAS check.
2. The secret is single use. It is replaced every 30 minutes, and a refused claim spends it, so a
   leaked code cannot be retried.
3. The phone dials the repeater and sends `Claim { secret, ops }`. For a first repeater, `ops` is a
   fresh `Genesis`. For an additional repeater, it is the owner's roster so far.
4. The repeater accepts only if the caller is the genesis owner. The QUIC handshake authenticates
   the caller, so "the phone at my console" and "the owner the roster names" are the same key or
   the claim fails.
5. The repeater signs the cert with **the same key it answers dials with**, so the cert and every
   later handshake name one machine. Dialling it later proves you reached that machine or fails.
6. A claimed repeater cannot be claimed again, by anyone.

Losing `secret.key` means claiming a new repeater, which is why the daemon never regenerates it
over an unreadable one.

### 4.2 Announcing repeaters, and confirming them through other friends

Each owner and member publishes a signed **`RepeaterCard`** in their **profile namespace**, under
its own key. The card contains:

- the roster id and its policy;
- each repeater's endpoint ticket and cert;
- the roster head the person last saw.

The card must not be added as a field of `ProfileRecord`. That record's signature covers a
re-encode of the decoded struct, so appending a field breaks verification for every older reader.
A separate key with its own signing context is ignored by old clients and costs nothing.

A friend therefore learns of someone's repeaters from a card signed by someone they already
verified by SAS. To substitute a repeater, an attacker needs that friend's identity key.
**Confirmation through other friends** builds on this:

- Your app collects every card your friends publish for a roster and shows it as _"June's
  repeaters · vouched by June, Sam"_.
- If two friends' cards **disagree**, the app shows a warning and offers no one-tap enrol. Two
  cards disagree when they name different repeaters for the same roster, or heads where neither is
  an ancestor of the other.
- **Auto-enrol can require two vouches.** Defeating that means compromising two of your friends,
  not one.
- On first contact the app fetches the roster and checks four things:
  - it starts at the genesis the card names;
  - every repeater in it carries a cert that verifies;
  - the owner signed each `AddRepeater`;
  - the endpoint that answered is one of those repeaters.

The same cards also tell your phone which repeaters carry a friend, which is what pulls use (§5).

### 4.3 Granting a namespace, and proving it is yours

After its `Enroll` is accepted, a member's phone sends `Grant { ticket, proof }` for each namespace
it wants carried (its trail and its profile). The repeater checks two things:

- **The caller is carried.** That comes from the roster.
- **The namespace is the caller's own.** `proof` is a signature by the **namespace's own key**
  over `(repeater, caller, namespace)`. Only the namespace's writer holds that key. Friends hold
  read tickets for each other's trails, and without this check enrolling would let anyone
  volunteer a friend's trail to be carried. The proof is bound to the repeater and the caller, so
  it cannot be replayed elsewhere.

Each grant is recorded against its member in the grant book. When the member stops being carried,
every namespace granted on their behalf is released:

- the grant is forgotten;
- the repeater leaves the namespace, so the live engine stops syncing it;
- its content leaves the ledger.

Releasing happens as soon as the roster change arrives, from a phone or a sibling. A repeater that
was down applies it at its next start.

### 4.4 Enrolling is asynchronous, and offered in two places

`Invite` and `Enroll` are signed ops, and a phone **queues them durably** until any of the owner's
repeaters answers, the same way the outbox holds envelopes. Nobody has to be online at the same
moment:

- an inviter can invite while every repeater is off;
- the person can enrol days later;
- whichever repeater wakes first takes the ops, and its siblings converge from it.

The same question, _"Replicate your trail on June's repeaters?"_ (Enrol / Not now), appears in two
places.

**At pairing.** When a pair completes, each side looks at the other's `RepeaterCard`s and offers
every roster it may enrol in:

- an `open` one;
- an `invite` one where the other side has invited me.

On the inviting side, the ACKNOWLEDGE screen shows _"Also invite them to my repeaters"_ for each
`invite` roster where I hold `inviter`. It is pre-checked when my auto-invite is on. Acknowledging
queues the `Invite`, and like everything else at ACKNOWLEDGE it is not awaited
(`connectNewFriend`).

The cards arrive with the pair: the v4 `Accept` carries the profile record, and the cards follow on
the profile namespace. If they arrive in time the question is on the pairing result screen.
Otherwise it appears as a badge on the repeater menu.

**In the repeater menu** (Settings → Repeaters), at any time:

- **Carrying my trail.** Whose repeaters I am enrolled with. Each shows its machines and when each
  was last in contact, with a Withdraw action.
- **Available through friends.** Every roster on a friend's card that I may enrol in: `open` ones,
  and `invite` ones with an invite waiting for me. This is how repeaters a friend sets up later
  reach people who paired long before they existed.
- **My repeaters.** Claim a machine, set the policy, grant `inviter`, remove members, and toggle
  auto-invite.

No pairing-wire change is needed, and none should be made: `PairMsg` is signed over a re-encode,
so appending to it means bumping `PAIR_ALPN` (see `AGENTS.md`).

## 5. Delivery

A repeater is one more peer in the existing paths. It never becomes something the paths depend
on.

- **Push: only to repeaters carrying me.** Pushes of my own trail go to the repeaters of the
  rosters I am enrolled in; anyone else's would refuse my namespace anyway. Pushes go to everyone
  in parallel under the existing budget, and **a repeater is never waited for.** Today a push stops
  waiting once the stash has finished taking the entries (`docs.rs`, "break on the stash"). A
  repeater may end that wait in the same way, but only by having **already answered with a
  receipt**: `Have { hashes } → present`, asked while still connected. A repeater that is down was
  never in the race and costs nothing.
- **Pull: from whoever carries the friend, enrolled or not.** For each friend, `friend_pull` also
  dials the repeaters on that friend's cards, because those repeaters carry that friend. Reading is
  open (§2.1), so this needs no enrolment. Pull targets are capped at 3 repeaters per friend and 6
  per pass, because every extra dial costs iOS wake time. A repeater that answers is a source like
  any other.
- **Isolation (`isolation.rs`).** An answer from a repeater counts as contact. Its silence does
  **not** count toward isolation, because a closed laptop is not a broken network. Only the
  stash's silence does.
- **Telemetry.**
  - App: add `contact.role = repeater` on `peer.contact`, and `repeaters.enrolled` /
    `repeaters.last_contact_age_ms` on `device.health`.
  - Daemon: `repeater.request` (with `request` and `outcome`), `repeater.restore`,
    `repeater.peer_sync` and `repeater.release`.
- **Relays.** A repeater's ticket goes through `relay::scrub_addr` like any other, so the daemon
  should default to the app's relay list (at most 5, see the relay notes in `AGENTS.md`). If its
  home relay is missing from the phone's map, the phone falls back to address lookup.
- **Retention.** Last-write-wins, as in `FORWARD-SECRECY.md` §4.4. The stash's retention code runs
  unchanged and keeps the latest fix per author.

## 6. Several repeaters, one owner

An owner's repeaters reconcile with each other on a timer (`TRAIL_STASH_PEER_SYNC_INTERVAL_MIN`,
default 5):

- **The roster first.** Each repeater fetches each sibling's roster and publishes its own, so an
  `Enroll` taken by one reaches the others. Siblings are the other repeaters the roster lists, plus
  any configured by hand (`TRAIL_STASH_PEERS`). The owner's `AddRepeater` signature is what lets a
  sibling fetch the roster at all.
- **Then every carried namespace.** Two repeaters that were awake at different times converge the
  next time they overlap, with no phone in between. Content follows the records automatically: the
  sibling is recorded as the delivering peer, and the settle loop fetches the bytes from it.

A sibling that is down costs one failed dial per tick. Nothing waits on it.

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
- **It is a friend with a `kind`, not a separate system.** The friend model should grow a `kind`
  (`person | service`) rather than repeaters being squeezed into `friends`. That is why §2 keeps
  repeaters out of `friends` entirely.
- **It never shares an identity with a repeater** (§2).
- **It costs one wrap per envelope.** Check the pad budget before promising many.

## 8. Threat model additions (`ARCHITECTURE.md` §10)

- **Repeater operator or thief.** Sees what the stash operator sees: sealed envelopes, which
  namespaces exist, arrival times and sizes. It also learns the roster (members' endpoint ids),
  and the IP address of every phone that pushes to it or pulls from it, members or not. It cannot
  decrypt, cannot forge fixes, and cannot forge roster ops.
  - The disk holds ciphertext, the grant book, the roster and `secret.key`.
  - The only extra harm from that key is impersonating that one repeater.
  - It cannot move the repeater into another roster: a new cert would need a new `AddRepeater`
    from that roster's owner.
- **Any reader** can pull a carried namespace's ciphertext from a repeater, as from any other
  replica (§2.1). It cannot open anything not wrapped for it.
- **A malicious member** can learn who else is carried, and can fill the repeater's disk with
  their own namespaces, up to four each today. In an `open` roster that is anyone who saw a card.
  Quotas and the owner's `Remove` bound it. A member cannot have someone else's trail carried
  (§4.3).
- **A compromised inviter** can invite anyone, but cannot make anyone enrol. The owner revokes the
  role.
- **A leaked claim code** is worth one attempt within 30 minutes, and only to a phone that is
  also the owner the claim names. That means it is worth nothing to anyone but the person at the
  console.

## 9. Phases

0. **Spike: the stash on disk, with siblings.** Built; trail-stash PR #7, CI green.
   - `Storage::Persistent`.
   - A grant book that is written before a grant is acknowledged and fails the start when
     unreadable.
   - Adoption of on-disk entries into the content ledger.
   - `sync_peers`, and a self-generated identity.
1. **Roster and claim.** Built on `phase1/roster`; the daemon proves it without an app.
   - The roster as a pure module: ops, signatures, replay rules, and order-independence as tests.
   - The `streetcryptid/repeater/1` protocol: `Claim`, `Publish`, `Fetch`, `Grant` with the
     namespace proof, and `Have`.
   - The cert, and carrying enforced and released by the daemon (reading stays open).
   - Roster sync between siblings.
   - The claim link printed on the console. The HTTP control API is not served in repeater mode.
   - Not yet: a scannable QR rendering of the link.
2. **App.**
   - The roster code shared with the app's core, so the phone signs ops with the code that
     verifies them.
   - A `repeaters` collection outside `friends`, with the invariant test.
   - `RepeaterCard` on the profile namespace, with cross-friend vouching.
   - The claim flow, and the Enrol prompt at pairing and in the repeater menu.
   - Delivery: pushes to rosters I am enrolled in, pulls from friends' repeaters, the
     receipt-gated early break, isolation, and telemetry.
3. **Operations.**
   - Disk blob GC, with the content ledger rebuilt before the store opens, since released content
     still sits on disk.
   - Quotas.
   - Packaging: systemd unit, launchd plist, Windows service, and a Home Assistant add-on.
   - Health on the daemon.

## 10. Open questions

- **Owner continuity.** The owner is a phone identity, so a lost phone orphans the roster until
  multi-device identity exists (`ARCHITECTURE.md` §9d). Should the owner be able to designate a
  co-owner?
- **Sharing the roster code with the app.** The roster module is pure and uses ed25519-dalek 2 like
  the app's core. Should the app depend on `trail-stash` (git dependency, AGPL), or should the
  module be split into a small shared crate?
- **Repeater as a pull accelerator.** A repeater that is up could pull friends' namespaces
  proactively from the stash, so that a LAN-local phone pulls from it quickly. That is a latency
  win to measure, not a design need.
- **How common is relaying between non-friends?** `peer.contact{contact.role=other}` counts
  exchanges between phones that are not friends. A week of it would show how often the open-read
  path in §2.1 actually delivers. That is worth knowing before anyone proposes closing it.
