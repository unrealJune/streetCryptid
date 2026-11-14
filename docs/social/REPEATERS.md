# streetCryptid — Repeaters (self-hosted, ciphertext-blind replicas)

> Status: **phases 0-2 built.** Written 2026-11-07; the repeater moved into this repository on
> 2026-11-11 ([`docs/MONOREPO.md`](../MONOREPO.md)).
>
> - Phases 0 and 1: the daemon on disk with siblings, the roster, claiming and the
>   `streetcryptid/repeater/1` protocol, in [`repeater/server`](../../repeater/server) (crate
>   `trail-stash`) and [`repeater/protocol`](../../repeater/protocol), which carry the history of the
>   former `unrealJune/trail-stash` repository.
> - Phase 2: the phone's half (§9), and the Windows repeater in [`repeater/windows`](../../repeater/windows).
>
> Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6 and §10 and
> [`FORWARD-SECRECY.md`](./FORWARD-SECRECY.md) §4.1 first.
>
> **Audited against the code on 2026-11-12.** This document is the design of record. Where the
> code does less, or something else, the section says "not built" or "today". §11 records what
> the audit found and how each gap was closed. Three questions people keep asking have one answer each: what leaving a
> repeater can and cannot undo (§2.2), how someone else's repeaters come to carry you (§4.5), and
> what carries the control traffic (§6.2).
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

- **It remembers who it carries, and nothing it carries.** A laptop restarts all the time, and
  the phones that granted it are not awake to grant it again, so its identity, its roster and every
  grant are on disk and reopen on start. The envelopes themselves are **in memory only**, like the
  stash's (decided 2026-11-10): no sealed location is ever written to the machine's disk, and a
  restart comes back carrying the same people and holding nothing until their phones sync again.
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

In MLS terms (`repeater/server/src/mls.rs`) it is another untrusted Delivery Service.

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

- Nobody enrolls with anyone's repeaters to pull from them (§5).
- Phones do not filter incoming docs or gossip connections by who the peer is.
- The stash opt-out keeps your trail off the hosted stash. It does not promise that your phone
  never ends up connected to it through someone else's swarm.

The one thing a person opts into is **carrying**: whether someone's repeaters replicate their own
namespace on their behalf and they push to them. Carrying spends someone else's memory and gives
those machines a copy of your ciphertext to hold, so it is a choice and not a side effect.

### 2.2 Leaving: what it stops, and what it cannot undo

Carrying can be ended. Read access cannot be taken back. These are different things and the app
must not blur them.

**What ending it does.** A `Withdraw` (yours) or a `Remove` (the owner's) that reaches a repeater
makes it release your namespaces (`StashNode::release`):

- the grant leaves the grant book, so a restart does not reopen it;
- the repeater leaves the namespace in iroh-docs. From then on it is out of that namespace's
  gossip swarm, and it answers a sync request for it with `NotFound` (iroh-docs 0.101,
  `engine/state.rs::accept_request`), so it neither receives new envelopes nor serves old ones;
- what it already held stays in its memory, unserved, until the process restarts at the latest.

Your phone stops pushing to that roster's repeaters as soon as you withdraw, whether or not they
heard, because push targets come from your own copy of the roster.

**What it cannot do.** A namespace id is a bearer read capability and it never expires (§2.1).
A repeater you granted has held your read ticket. Nothing in iroh lets you take that back:

- A repeater that never hears the op keeps carrying you. A repeater that was asleep when you
  withdrew hears it on your next grant pass that overlaps it (§4.4), and one its owner removed
  releases everything it carried as soon as it hears that (§6.2); until then, both carry on.
- A repeater that does not cooperate (modified software, or an operator who copied the grant
  book) can import the namespace again and sync it from any replica: your phone, the stash, a
  friend, another carrier. Phones do not filter who they sync with (§2.1), so your own phone
  will serve it.
- What such a machine keeps getting is what it always got: sealed envelopes, their timing and
  size, and your IP address if it syncs with your phone directly. It never gets a position.

So **leaving is cooperative.** It is honoured by an honest repeater that hears about it. The app
should say "these repeaters will stop carrying your trail", never "can no longer see it".

The only real revocation is **rotating the namespace**: a new trail namespace, with new read
tickets handed to every friend, and the old one abandoned. That is not built, and it is the same
work a removed friend would need, since a removed friend also keeps their read ticket. It is an
open question (§10), not a repeater feature.

**The other direction has no opt-out either.** If a friend is carried by a repeater, that
repeater is in the friend's swarm, and the friend's envelopes may reach you through it whether you
pull from it or not. This is safe: iroh-docs entries are signed by their author, so a repeater
cannot forge or alter one, and the envelope inside is sealed for you. The cost is metadata: the
repeater learns your endpoint id, your IP address, and that you read that friend. A phone can
decline to _dial_ friends' repeaters (the pull plan, §5); that would be a setting, and there is
none today. It cannot decline to be dialled.

### 2.3 Considered and not done: a key exchange in front of reads

Proposed 2026-11-12: make connecting to a repeater require a key exchange, with the fixes still
sealed. Not adopted, for these reasons.

- **The exchange already happens.** Every iroh connection is a mutually authenticated handshake,
  so a repeater knows the endpoint id of whoever dialled, and `Claim`, `Fetch` and `Grant` use it
  (§4.2.1). What the read path lacks is authorization, not authentication.
- **The namespace id is already the shared secret.** Only a person's friends, the stash and
  their carriers hold it; it is not in the roster or on a card. A second reader key would go to
  the same people and be exactly as hard to take back.
- **A repeater is one replica of many.** Whoever it refused would ask the author's phone, the
  stash or a friend's phone, which serve the same ciphertext.
- **An allowlist tells the repeater who your friends are.** Today it learns only the readers
  that actually connect.
- **It breaks what §2.1 and §6.1 rely on:** friends relaying for each other, and two people's
  repeaters converging on a trail neither roster links them through.
- **It would hide little.** Envelopes are sealed either way. The gate would keep timing and size
  from someone who already holds the namespace id.

What addresses the underlying worries instead:

- **A reader who should no longer read** (a removed repeater, a removed friend): namespace
  rotation (§10). It is the only mechanism that works against every replica at once.
- **A cheap partial measure:** a phone may refuse docs sync from a repeater it has withdrawn
  from, by handshake identity. It closes the direct path only, so the copy still cannot say "can
  no longer see" (§2.2). Not built.
- **Strangers pulling from a repeater on the open internet:** a repeater could refuse docs sync
  from anyone who is not a carried member, a listed co-carrier or a sibling. That also stops
  friends pulling from it, which is most of what a repeater is for, so it is not proposed.
- **The holes that were real were in the control protocol**, not the read path: §11's G1, G2
  and G6, fixed 2026-11-12. For G6: the signature is verified before any limit is counted,
  held-aside ops have their own bounded queue, ops are capped per signer, and the owner has a
  reserved share (§8).

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

**How it is built.** The owner invites from Settings → Repeaters → People (a friend list under
INVITE) and grants or revokes `inviter` on a carried member's row (LET INVITE / NO INVITES); an
inviter reaches the same INVITE list from the owner's roster (Invite friends). An invite is also how a member the
owner removed comes back, in either policy, so the owner can invite in an `open` roster too.
"Invite new friends" on the same page is auto-invite: it pre-checks "Also invite them" at
pairing (§4.4). The core is `repeater::invite`, `invite_targets` and
`pending_invites`; which invite stands is `Roster::standing_invite`, the same rule an `Enroll`
is judged by (an invite made before a `Remove` of that person does not).

### 3.3 The roster is a signed operation log

The roster is a hash-linked log of operations, each one signed by the endpoint key of the phone
that made it (`roster.rs` in `streetcryptid-repeater`, see §3.4):

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
  - an enrollment concurrent with a `Remove` or `Withdraw` ends.
- A revocation made _after_ an invite stops later invites, not that one.
- A `Remove` is sticky against re-enrollment until an invite made after it.
- A `SetPolicy` applies to ops that have seen it. It never drops an enrollment the owner had seen
  when closing. Two concurrent ones resolve to `invite`, the stricter.
- **Closing beats an uninvited enrollment it had not seen**, the same way a removal does. Without
  this, closing closed nothing: anyone holding the genesis, which friends' cards publish (§4.2),
  could sign an `Enroll` citing the open genesis alone, and its past would say "open". Concurrent
  and backdated look the same, so a genuine race now costs the enrollee an invite.

**Signed bytes are kept as signed.** An op is stored as the exact bytes its signer signed and is
decoded only after the signature checks out. `PairMsg` and `ProfileRecord` sign a re-encode of the
decoded struct, which is why appending a field to either is a breaking change; the roster does not
share that trap.

**Who replicates and reads it.**

- The log is replicated between the owner's repeaters over the repeater protocol (§6). A repeater
  cannot forge any of it, because every op is signed by a phone.
- The owner, carried members, inviters and the owner's repeaters can fetch it from a repeater.
  Members can therefore see who else is carried; the enroll screen says so.
- Every member's repeater card carries the whole log too (§4.2), so the friends of anyone in a
  roster can read who it carries. Members are endpoint ids, which mean something only to people
  who already hold them, but this is wider than "members only" and is a deliberate trade: the log
  is what lets a friend check a roster, label it and enroll, without fetching it from a repeater
  that would refuse them.

### 3.4 One crate, both sides

The roster, the cert, the grant proof and the `streetcryptid/repeater/1` wire are one crate,
`streetcryptid-repeater` (`repeater/protocol`). The daemon, the Windows host and the app's core
(`modules/iroh-location/rust/src/repeater.rs`) all link it by path from the same tree, so a phone
signs ops with exactly the code that judges them on the repeater. Phones in the field lag the
repeaters, so the crate's golden vectors (`repeater/protocol/tests/fixtures/`) pin every released
encoding: append-only, end-only, like the location wire.

The boundary is drawn so the crate holds only what both sides must agree on byte for byte:

| in `streetcryptid-repeater`  | repeater (`repeater/server`) only      | app core only                     |
| ---------------------------- | -------------------------------------- | --------------------------------- |
| roster ops, rules, state     | console claim window                   | the roster book (`repeaters.bin`) |
| `RepeaterCert`               | namespace book, release                | claim flow + cert check           |
| requests, responses, framing | protocol handler, sibling/carrier sync | grant plan, enroll/withdraw       |
| grant proof, claim link      | persistent node                        | `RepeaterCard`                    |

It has no iroh, tokio or I/O. Each side brings its own iroh (one workspace now, so both resolve
to the same 1.4), and identities cross the boundary as raw 32-byte ed25519 keys, which is what
endpoint ids and namespace ids both are.

One thing is not shared and should be: the client half of the wire. `call` and `read_frame`
exist twice, word for word, in `repeater/server/src/repeater.rs` and in the app core's
`repeater.rs`, because the crate holds no iroh (§6.2).

## 4. Attestation and enrollment, without SAS

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

1. An unclaimed repeater prints a **claim link** on its own console, as a QR code and as text:
   `https://streetcrypt.id/repeater#t=<endpoint ticket>&s=<secret>`. streetcrypt.id claims
   `/repeater` as a Universal Link / App Link, so the phone's own camera opens Settings →
   Repeaters with the link filled in; without the app, the page there hands off or offers the
   link to paste. Both halves ride in the fragment, which is never sent to the server. The older
   `streetcryptid-repeater:<endpoint ticket>#<secret>` shape still parses, on both sides. The
   endpoint ticket carries the repeater's full endpoint id, so scanning it is as strong as an SAS
   check.
2. The secret is single use. It is replaced every 30 minutes, and a refused claim spends it, so a
   leaked code cannot be retried.
3. The phone dials the repeater and sends `Claim { secret, ops }`. For a first repeater, `ops` is a
   fresh `Genesis`. For an additional repeater, it is the owner's roster so far.
4. The repeater accepts only if the caller is the genesis owner. The QUIC handshake authenticates
   the caller, so "the phone at my console" and "the owner the roster names" are the same key or
   the claim fails.
5. The repeater signs the cert with **the same key it answers dials with**, so the cert and every
   later handshake name one machine. Dialling it later proves you reached that machine or fails.
6. A claimed repeater cannot be claimed again by anyone else. Its owner may repeat the claim
   for the same roster: the repeater persists the roster before it answers, so a `Claimed` reply
   lost on the way would otherwise leave a machine that is claimed and a phone with no cert to
   list it with. The repeat is answered with a fresh cert and needs no secret (the first claim
   spent it); the QUIC handshake already proves the caller is the owner. Scanning the same code
   again is enough.

Losing `secret.key` means claiming a new repeater, which is why the daemon never regenerates it
over an unreadable one.

**Releasing a machine is done at the machine.** Two ordinary events need it: the owner's phone is
gone (§10), or someone wants to hand the machine to another owner. The daemon has
`trail-stash release` (run with the repeater stopped: it removes `roster.bin`, and the next start
releases everything it carried and prints a new claim link); the Windows app has RELEASE THIS
REPEATER on its running page, which sends the host's one other command (`release`) and shows the
new code at once. Either keeps the machine's identity. The roster's owner, if there still is one,
sees the machine stop answering and can remove it. A machine the owner removed releases itself the
moment the removal reaches it (§6.2), so it needs no trip to the machine either way.

**Naming a machine.** The person at the machine can name it ("Living room PC"): the Windows app's
Name field, or `TRAIL_STASH_NAME` for the daemon. The name is signed into the `RepeaterCert` the
machine issues (`CertBody::name`), so it rides the roster to the owner and to everyone who reads
it from a card, and nobody but the machine can set it. The cert's bytes are the four original
fields and then `Some(name)` only when there is one: an unnamed cert is byte-identical to before,
and older readers, which ignore trailing bytes, read a named one as the old fields. A name is at
most 40 characters with no control characters (`repeater_name`); a cert carrying anything else does
not verify. A rename reaches the roster when the owner's phone asks for a fresh cert: opening
Settings → Repeaters sends each listed machine a repeated `Claim` (owner-only, no secret, changes
nothing else) and lists any whose cert names it differently with a new `AddRepeater`, which wins
as the newest cert for that machine (`refreshRepeaterNames`). It dials, so it never runs on a
background wake.

### 4.2 Announcing repeaters, and confirming them through other friends

Each owner and member publishes a signed **`RepeaterCard`** in their **profile namespace**, under
its own key (`repeaters`, signing context `streetcryptid/repeater-card/1`). The card contains the
**whole signed op log** of every roster its publisher owns or is carried by, nothing they merely
saw. A log is self-verifying: it starts at the genesis that names the owner, every repeater in it
carries a cert, and every op is signed by whoever made it. So a reader needs nothing else to check
a roster, to label it ("June's repeaters"), or to sign an `Enroll` that cites it, and the card
needs no endpoint tickets: repeaters are dialled by endpoint id.

Built (`modules/iroh-location/rust/src/repeater.rs`: `build_card`, `open_card`, `ingest_cards`).
A phone republishes its card after every roster change it makes and after each grant pass's
refresh (span `repeater.card`), and reads its friends' whenever the repeater settings are read.

The card must not be added as a field of `ProfileRecord`. That record's signature covers a
re-encode of the decoded struct, so appending a field breaks verification for every older reader.
A separate key with its own signing context is ignored by old clients and costs nothing.

Because the card carries signed ops rather than claims about them, **two cards cannot disagree**
in a way that matters: a friend cannot add a repeater, change the policy or invent a member
without the owner's or the member's own key, and two logs for one roster simply merge. What a
card does say on its own authority is "I am in this", and that is checked against the log: a
card counts as a **vouch** only when its signer is the roster's owner or carried by it. A
friend republishing a roster they are not in teaches you the roster (it is real) but vouches for
nothing.

- The app shows every roster a friend vouches for under **Available through friends**, as
  _"June's repeaters · vouched for by June, Sam"_. An owner who is not your friend is shown by
  short id.
- Enrolling from there needs the roster to be `open`, or an `Invite` naming you in the log. The
  app cites the newest such invite; a roster you cannot enroll in shows why instead of a switch.
- **A card vouches only from the friend whose profile it was read from.** Cards are read per
  friend (`ProfileDocs::read_key_from_friends`), each paired with the friend the pairing ticket
  says owns that namespace, and `ingest_cards` counts a card as a vouch only when its signer is
  that friend. A card someone else signed, republished in a friend's namespace, still teaches the
  rosters on it (the logs verify themselves) and vouches for nothing.
- **Auto-enroll can require two vouches.** Defeating that means compromising two of your friends,
  not one. Not built: there is no auto-enroll, and vouches are only shown. The binding above is
  what makes counting them safe when it is.

The same cards also tell your phone which repeaters carry a friend, which is what pulls use (§5).

**A card is not always there.** It is an entry in a profile namespace, so a friend has it only
after their phone has synced that namespace since it was last written:

- The publisher writes it after a roster change and after each grant pass, to its local replica.
  It leaves the phone only when something syncs with it.
- A reader syncs a friend's profile when the ticket is imported (at pairing, in the app) and,
  on a native pull, for at most two seconds, **dialling only that friend's own phone**
  (`sync_known_friends`). The pull plan adds a friend's repeaters for their trail namespace and
  not for their profile, although those repeaters carry the profile too.
- So a card written while the two phones were never awake together has not arrived. A friend
  who claims a repeater today is invisible to you until your phones next overlap, and the same
  delay applies to learning that they left one.
- A card holds at most 16 rosters and 256 KiB. Past 16, rosters are dropped by id order.

Nothing breaks when a card is missing: the roster is absent from Available through friends, and
that friend's repeaters are not pulled from. Pulling a friend's profile from their carriers
would close most of the gap and is not built.

### 4.2.1 What is gated, and by what

| action                         | gate                                                                                 | checked by                |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------- |
| claim a machine                | the console's one-time secret, and the caller is the genesis owner                   | the repeater, at `Claim`  |
| change the roster              | the op's signature, and its signer's role in the op's own causal past (§3.3)         | every replica, at insert  |
| send ops to a repeater         | **nothing** (`Publish` is open; each op is judged)                                   | n/a                       |
| read the roster from a machine | caller is the owner, carried, an inviter, or a listed repeater                       | the repeater, at `Fetch`  |
| read the roster at all         | **nothing in practice**: it is on every member's card                                | n/a                       |
| have a namespace carried       | caller is carried, the namespace's own key signed the proof, at most four per member | the repeater, at `Grant`  |
| become carried                 | an `open` roster: nothing but an `Enroll`. An `invite` roster: an invite naming you  | the roster rules          |
| read a carried trail           | **nothing** (§2.1). Holding the namespace id is enough                               | n/a                       |
| write into a carried trail     | the namespace's write key, which only its author's phone holds                       | iroh-docs, on every entry |
| open an envelope               | being in the wrap set                                                                | the ratchet               |

Every "who is this" reads the QUIC handshake, never a field in a request. The whole of access
control is therefore the `Grant` check plus the roster rules, and what they protect is the
repeater's memory and the choice to be carried. They do not protect who reads.

`open` is wider than "the friends of its members" (§3.2) suggests. A member's card carries the
roster to their friends; each who enrolls publishes it on their own card. So an `open` roster is
open to everyone connected to it through any chain of friendships, and to anyone at all who is
handed the roster id and a repeater's endpoint id.

### 4.3 Granting a namespace, and proving it is yours

After its `Enroll` is accepted, a member's phone sends `Grant { ticket, proof, carriers }` for each
namespace it wants carried (its trail and its profile). The repeater checks two things:

- **The caller is carried.** That comes from the roster.
- **The namespace is the caller's own.** `proof` is a signature by the **namespace's own key**
  over `(repeater, caller, namespace)`. Only the namespace's writer holds that key. Friends hold
  read tickets for each other's trails, and without this check enrolling would let anyone
  volunteer a friend's trail to be carried. The proof is bound to the repeater and the caller, so
  it cannot be replayed elsewhere.

`carriers` names the member's _other_ repeaters carrying the same namespace (§6.1). It is a sync
hint, not a permission: it comes from the authenticated member, at most eight, and re-granting
replaces it.

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
- the person can enroll days later;
- whichever repeater wakes first takes the ops, and its siblings converge from it.

**How it is built.** A signed op is saved in the roster book at once and offered to the roster's
repeaters straight away. Each repeater that answers the `Publish` is recorded against our heads
at that moment (`repeaters-delivered.bin`, beside the book). The grant pass on every start then
calls `repeater::deliver` **before** it fetches: for each roster this phone has signed an op in
(owned, enrolled, or withdrawn from), every repeater the roster has ever listed whose recorded
heads are not our current ones is offered the roster again, in parallel. A removed machine is
included, because it must hear that it was removed (§6.2, G2). The record is advisory: losing
it means offering everything once more. `repeater.grant` carries `delivered`.

### 4.5 How someone else's repeaters come to carry you

This is the whole of "sharing a repeater". Nothing is handed over at pairing, no repeater ticket
is shared, and no repeater is ever told to go and fetch someone. **The person being carried does
every step themselves**, and the repeater only ever answers.

Say June owns a roster and Sam is her friend.

1. **June's phone publishes a `RepeaterCard`** in her profile namespace (§4.2). Sam's phone
   already replicates that namespace because they paired. The card holds the roster's whole
   signed log, so Sam's phone now knows the roster id, its policy, and each repeater's endpoint
   id.
2. **Sam's phone decides whether it may enroll.** It may if the roster is `open`, or if the log
   holds an `Invite` naming Sam that still stands.
3. **Sam signs an `Enroll`** and sends the log to June's repeaters with `Publish`, dialling each
   by endpoint id. Anyone may `Publish`; the op stands on Sam's signature and the roster's rules.
4. **Sam's phone sends `Grant`** to each of those repeaters, once for his trail and once for his
   profile, each with his read ticket and a proof signed by that namespace's own key (§4.3).
5. **The repeater imports the namespace** from the ticket and joins its swarm. From then on
   Sam's phone pushes to it, and anyone who reads Sam can pull from it.
6. **Sam's own card now lists June's roster**, so Sam's friends learn that June's repeaters
   carry Sam (and, if the roster is `open`, that they may enroll too).

What follows from that shape:

- **June can extend access to her own roster only.** An inviter can extend access to a roster
  they hold `inviter` in. A plain member cannot bring anyone in, although in an `open` roster
  their card is how their friends find it.
- **The read ticket goes from Sam to the repeater, never from June.** June holds Sam's read
  ticket too, as his friend, and that is exactly why `Grant` demands the namespace's own
  signature: otherwise June could volunteer Sam.
- **Nothing is pushed to Sam.** A person who never opens Settings → Repeaters is never carried.
  The Enroll prompt at pairing (below) would change how often people are asked, not who acts.
- **The owner's remedy is `Remove`,** which is cooperative in the same way `Withdraw` is (§2.2).

The same question, _"Replicate your trail on June's repeaters?"_ (Enroll / Not now), appears in two
places.

**At pairing.** The two questions are asked at two moments, because one is about the friend and
the other about your location.

- **Above ACKNOWLEDGE / REJECT**, the inviting side sees _"Also invite them to my repeaters"_:
  one switch per `invite` roster I may invite to and they are not in, each pre-checked when my
  auto-invite is on. Acknowledging signs those invites (`inviteToRepeater`, per roster), not
  awaited, like everything else at ACKNOWLEDGE (`connectNewFriend`); the grant pass offers them
  to the repeaters (§4.4).
- **After ACKNOWLEDGE**, if this phone knows rosters of the new friend's it may enroll in (an
  `open` one, or an `invite` one where they invited me), the screen stays to ask _"Replicate your
  location on their repeaters?"_, with what that gives, what it never does and who will see it
  (`enrollFacts`), then ENROLL / NOT NOW. The radio is stood down first exactly as leaving would
  (`stopPairing`), and ENROLL goes through `setRepeaterCarried`, not awaited.

Built: `usePairingRepeaterOffer` and `pairingOffers` (`src/features/repeaters`).

The cards arrive with the pair: the v4 `Accept` carries the profile record, and the cards follow on
the profile namespace. If they arrive in time the question is on the pairing result screen.
Otherwise the roster turns up under Available through friends, and the Settings menu's repeater
line counts it ("1 offered by friends") with a badge.

**In the repeater menu** (Settings → Repeaters), at any time:

- **Stash**, then **My repeaters**: your roster in a card, opening _Your repeaters_, or
  _Add a repeater_.
- **Carrying my location.** Whose repeaters I am enrolled with, with their machines; switching it
  off is a Withdraw. Per-machine last contact is not shown: nothing records it per machine.
- **Available through friends.** Every roster on a friend's card: `open` ones and `invite` ones
  with an invite waiting for me get a switch, which asks first in a sheet with the same facts as
  at pairing; an invite-only one nobody invited me to says so. This is how repeaters a friend
  sets up later reach people who paired long before they existed.

Behind it (`src/app/settings/repeaters/`):

- **Add** (`claim`): the claim in the pairing screen's shape. ADD takes a pasted link (there is no
  in-app camera: the console's QR code is a Universal Link / App Link the phone's own camera
  opens, landing here on SCANNED); SCANNED names the machine read from the link's endpoint ticket
  (`claimLinkMachineId`) and asks the policy (first machine only) and whether it carries me;
  REACHING is the claim in flight, bounded at 20 s, so it has no cancel; CLAIMED or REFUSED.
- **Your repeaters** (`mine`): the roster this phone owns on one page, in the order a person
  decides about it: carrying me, its machines (each REMOVE confirmed once; _Add a repeater_), who
  can join (the policy), and its people with invites and auto-invite. People are the roster's, so
  they live here rather than on a page of their own. Rosters that carry me or are offered stay as
  cards on the list itself: switching one off is a Withdraw (never "remove": §2.2), and switching
  an offered one on asks first in a sheet. There is no "deny": nothing refuses an offer.
- **People** (`people?roster=`): members, inviters, invites, and auto-invite, for another person's
  roster this phone may invite to.

No pairing-wire change is needed, and none should be made: `PairMsg` is signed over a re-encode,
so appending to it means bumping `PAIR_ALPN` (see `AGENTS.md`).

## 5. Delivery

A repeater is one more peer in the existing paths. It never becomes something the paths depend
on.

- **Push: only to repeaters carrying me.** Pushes of my own trail go to the repeaters of the
  rosters I am enrolled in; anyone else's would refuse my namespace anyway. Pushes go to everyone
  in parallel under the existing budget, and **a repeater is never waited for.** Built: carriers
  are handed to the live engine as `unwaited` peers (`TrailDocs::push`), dialled by endpoint id.
  A push with no stash or friend in it ends as `FlushOutcome::Scheduled`, not `Pushed`, unless a
  repeater answers with a receipt (next).
- **A repeater's receipt.** A repeater counts as a delivery only by **answering with a receipt**:
  `Have { hashes } → present`. After a push that reached carriers alone, the phone asks every
  carrier, in parallel and again every 1.5 s for at most `RECEIPT_BUDGET` (8 s), whether it holds
  the content of every newest entry in our trail namespace (`repeater::receipt`, span
  `repeater.receipt`). The first carrier that holds all of it turns the flush into `Pushed`;
  none means `Scheduled`, as before, and the carriers still reconcile when they next wake. A push
  that includes the stash or a friend does not ask: those are waited for already, and a repeater
  never extends a push that had someone else to wait for.
- **Pull: from whoever carries the friend, enrolled or not.** For each friend, `friend_pull` also
  dials the repeaters on that friend's cards, because those repeaters carry that friend. Reading is
  open (§2.1), so this needs no enrollment. Pull targets are capped at 3 repeaters per friend and 6
  per pass, because every extra dial costs iOS wake time. A repeater that answers is a source like
  any other.
- **Isolation (`isolation.rs`).** An answer from a repeater counts as contact. Its silence does
  **not** count toward isolation, because a closed laptop is not a broken network. Only the
  stash's silence does.
- **Telemetry.**
  - App: `contact.role = repeater` on `peer.contact`, `fix.source = repeater` on
    `fix.provenance`, `repeater.grant` (with `delivered`) and `repeater.receipt`, and
    `repeaters.enrolled` / `repeaters.carriers` / `repeaters.last_contact_age_ms` on
    `device.health`. The last is per process: any answered repeater call or `peer.contact` with
    one stamps it, and it is absent after a relaunch until a repeater answers.
  - Daemon: `repeater.request` (with `request` and `outcome`), `repeater.restore`,
    `repeater.peer_sync` and `repeater.release`.
- **Addresses.** Only the claim link carries a repeater's ticket, and it goes through
  `relay::scrub_addr` like any other. Every later dial, from a phone or a sibling, is by **bare
  endpoint id**: the roster and the card hold ids and no addresses. So reaching a repeater
  depends on the N0 address lookup finding it, every time. A repeater that cannot publish itself
  there (blocked DNS, an air-gapped LAN) can be claimed and then never reached again. The daemon
  should default to the app's relay list (at most 5, see the relay notes in `AGENTS.md`).
- **Retention.** Last-write-wins, as in `FORWARD-SECRECY.md` §4.4. The stash's retention code runs
  unchanged and keeps the latest fix per author.

### 5.1 The hosted stash: beside the repeaters, not one of them

The hosted stash and a repeater do the same job (an always-on, ciphertext-blind replica that
holds a trail while its phone sleeps), so the app shows them together and opts in and out of both
with the same kind of switch. They stay different things on purpose:

|              | hosted stash                                              | repeater                                                                    |
| ------------ | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| owner        | **nobody**                                                | the roster's owner, who can remove people                                   |
| keeps        | each author's latest fix, in memory, at most 48 hours     | each carried author's latest fix, in memory, until released or restarted    |
| opt-in       | the delivery mode (`stash`), one switch                   | `Enroll` in a roster                                                        |
| grant        | HTTP control API + a PSK baked into the build             | `Grant` over `streetcryptid/repeater/1`, with the namespace's own signature |
| whose trails | mine **and every friend's** (`grantStash` registers both) | only people who enrolled, each proving the namespace is theirs              |
| identified   | by the build's stash config (its ticket's endpoint id)    | by its cert in a roster                                                     |

**Decided (2026-11-08): the stash stays ownerless, with its rolling deletion.** An owner would be
someone who can say whose trails it carries, and a server everyone shares should not have one.
Forgetting on a clock is the stronger privacy promise. A repeater forgets on a restart too (§1),
but it answers to an owner and keeps what it carries until they release it. So the stash gets no roster, no genesis and no operator key, and the
app carries a deliberate **carve-out** for it:

- **Identification** is by configuration, as now: the stash is the endpoint in
  `EXPO_PUBLIC_TRAIL_STASH_TICKET`, first in the delivery list when opted into
  (`DeliveryConfig`). It is never looked for in a roster and never appears on a card.
- **Settings → Repeaters** shows it first, as "streetCryptid stash · hosted, owned by nobody ·
  keeps only your latest sealed fix, for at most 48 hours, in memory", with a carry switch that
  _is_ the delivery mode, so this page and Settings → Delivery are one setting (built,
  `stash-card.tsx`). The 48 hours is `STASH_RETENTION_MS`, which must match the deployed
  `retentionHours`; it said 30 minutes until this change.
- **Telemetry** keeps `contact.role = stash` and `fix.source = stash`, checked before repeaters.
- **Isolation** still counts only the stash's silence (§5).

**What could still be shared, later.** The stash could speak the repeater protocol's `Grant`, with
the namespace proof, under an "ownerless" rule (anyone may grant their own namespace, retention
applies), and drop the PSK and the HTTP grant. That would also end registering friends'
namespaces, which today stashes a friend who never opted in. Neither is needed for the switch
above, and the second is a behaviour change worth deciding on its own.

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

**A repeater knows its siblings only from its own copy of the roster.** There is no
introduction step. The loop runs in the daemon and in the Windows host, and each tick dials every
other repeater its roster lists, by bare endpoint id (§5, Addresses).

- A newly claimed repeater knows the older ones at once: the `Claim` carries the roster so far.
- An older repeater learns of the new one when the `AddRepeater` op reaches it: from the owner's
  phone, which offers it until it answers (§4.4), or from the new repeater's own `Publish` on its
  next tick.
  Until then it refuses the newcomer's `Fetch`, because it does not list it. The `Publish` half
  still goes through, since anyone may publish, so the pair converges within a tick or two.
- The one case that does not converge is a new repeater that never received its own
  `AddRepeater`: it holds a roster that does not list it, and it has nothing to tell anyone.
- Siblings matter only when two repeaters were awake at different times. Phones already push to
  every carrier, and a repeater holds nothing across a restart, so with one machine, or with
  machines that are always up together, the loop moves nothing.

The tests cover the two halves with explicit addresses (`sibling_repeaters_share_the_roster`,
`sibling_repeaters_converge_without_the_writer`). Nothing tests the loop finding a sibling from
the roster and reaching it by id alone, which is the only way it runs in the field.

### 6.1 Repeaters in different people's rosters

Rosters are per owner, and a person can be carried by several: their own, and any friend's they
enrolled in. If A and B both run repeaters and each enrolls in the other's roster, A's trail is
carried by A's repeater and by B's. That needs no new mechanism:

- A's phone enrolls in B's roster like any member (policy `open`, or an invite from an inviter), and
  B's phone in A's. Each is its own opt-in; nothing is reciprocal by default.
- A's phone grants its namespaces to every repeater carrying it, and names each to the others as
  **co-carriers**. A repeater reconciles each namespace with its co-carriers on the same timer as
  its siblings, so A's repeater and B's converge on A's trail while A's phone sleeps, although
  neither roster lists the other's repeater.
- Readers need nothing: any friend of A can pull A's trail from either, as from any replica (§2.1).

Everything between repeaters is iroh: roster ops over `streetcryptid/repeater/1` on the node's own
endpoint, and trails over plain iroh-docs sync. There is no HTTP between repeaters, or between a
phone and a repeater. `repeaters_in_different_rosters_converge_on_a_trail_they_both_carry`
(`repeater/server/src/repeater_tests.rs`) tests it end to end.

### 6.2 The control plane

There are four channels. Only the first is "the repeater protocol".

| channel                         | carries                                           | transport                                                             |
| ------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| phone → repeater, and siblings  | `Claim`, `Publish`, `Fetch`, `Grant`, `Have`      | ALPN `streetcryptid/repeater/1` on the node's own iroh endpoint       |
| owner or member → their friends | the roster's signed log (`RepeaterCard`)          | iroh-docs: the `repeaters` key of the publisher's profile namespace   |
| phone → hosted stash            | namespace grants, push subscriptions              | HTTP + a PSK baked into the build. Not served in repeater mode        |
| Windows app ↔ service ↔ host    | status snapshots out; `settings` and `release` in | JSON lines on the host's stdin/stdout, relayed over a named pipe (v2) |

**The repeater protocol, exactly** (`repeater/protocol/src/wire.rs`):

- One request per connection: dial, open one bi-stream, send one frame, read one frame, close.
- A frame is a `u32` big-endian length and a postcard body, at most 2 MiB.
- Each side bounds an exchange at 20 seconds, dial included.
- The caller is whoever the QUIC handshake authenticated. No request carries an identity.
- There is no negotiation inside the ALPN. Appending an enum variant is the only compatible
  change; anything else bumps the suffix.
- Roster ops travel as the exact bytes their signer signed, inside the frame.

The roster reaches a repeater by `Claim` and `Publish`, moves between siblings by `Fetch` then
`Publish` on a five-minute timer, and reaches people who are not in it through the card. The
trail itself never uses this protocol: it is plain iroh-docs sync (§5).

**The Windows machine has no local control plane for the roster, on purpose.** The host emits
snapshots (endpoint id, claim link, owner, policy, members, counters) and accepts two commands:
its two settings, and `release` (§4.1), which forgets the roster and nothing finer. The service
forwards nothing else (`HostProtocol.IsHostCommand`). Everything about who is carried is
decided by phones, over iroh; the person at the machine can only hand it back.

**Recommended (2026-11-12), not yet decided: keep the hand-rolled wire. Not gRPC; `irpc` is the
real alternative, and if it is wanted the time is before phase 2 ships to phones, because its
framing differs from ours and the switch is a new ALPN.**

- gRPC over iroh exists as `tonic-iroh-transport`, which is at 0.0.x. It would bring protobuf
  and tonic into a crate whose point is to have no iroh, tokio or I/O (§3.4), and into the
  phone's binary. It buys streaming, deadlines and code generation for five unary calls that
  need none of them. The payloads that matter are signed byte strings, which protobuf would
  carry as opaque `bytes` anyway.
- `irpc` is the closer fit: it is n0's own RPC crate, it is already in every binary because
  iroh-docs and iroh-blobs depend on it (0.17 in `Cargo.lock`), and its framing is
  length-prefixed postcard, which is what we wrote by hand. It would give three things: one
  client instead of two (§3.4), a response type per request (today any `Response` can answer
  any `Request`, and the client maps a mismatch to `Unexpected`), and several requests on one
  connection. It costs two: the shared crate stops being free of tokio, and a wire we pin with
  golden vectors follows a pre-1.0 crate's framing while phones in the field lag the repeaters.
  The first two gains are about thirty lines each without it. Revisit if the protocol grows a
  streaming call (a large roster, a subscription).
- **What is wrong with the control plane is not its transport.** It is that most calls are
  their own connection made one after another (a grant pass is a `Fetch` per roster, then two
  `Grant`s per carrier, each able to cost 20 seconds against a sleeping laptop; only `Publish`
  fans out in parallel), and that `Have` has no caller (§5). Delivery used to be attempted once;
  it is now retried until acknowledged (§4.4). None of those is fixed by a framework. The first
  cheap fix is the missing piece of §3.4: put the client `call` in one place, behind a feature
  of the shared crate or in a small crate beside it.

**A removed repeater releases itself.** `Roster::is_removed_repeater` says whether a machine was
listed by an `AddRepeater` and is no longer; one that was claimed but whose cert has not arrived
yet is not removed. When a removal reaches the machine (`Repeater::merge`), or the machine starts
holding one, it releases itself exactly as a release at its console does (§4.1): it lets go of
every namespace, forgets the roster, and shows a new claim code under the same identity. The owner
has said they are done with it, so it goes back to belonging to nobody, with no trip to the
machine. Getting it back takes a new claim with that code; a re-added `AddRepeater` is refused as
`NotClaimed`, which the owner's phone counts as delivered for a machine its roster removed, so it
stops offering it ops.

**A removed member reads its removal.** `Fetch` is open to anyone who has signed an op in the
roster (`Roster::has_signed`), not only to who is carried now. A member the owner removed would
otherwise be refused (`NotCarried`) and its phone, holding a copy that still says carried, would
keep pushing there and listing the roster as carrying it until a card said otherwise.

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
  - The disk holds the grant book (read capabilities), the roster and `secret.key`. Ciphertext
    is in memory only, so a powered-off or stolen machine holds no envelopes at all.
  - The only extra harm from that key is impersonating that one repeater.
  - It cannot move the repeater into another roster: a new cert would need a new `AddRepeater`
    from that roster's owner.
- **Any reader** can pull a carried namespace's ciphertext from a repeater, as from any other
  replica (§2.1). It cannot open anything not wrapped for it.
- **A malicious member** can learn who else is carried, and can fill the repeater's memory with
  their own namespaces, up to four each today. In an `open` roster that is anyone who saw a card.
  Quotas and the owner's `Remove` bound it. A member cannot have someone else's trail carried
  (§4.3).
- **Anyone who knows a roster id can try to fill the roster.** `Publish` is open to all, and the
  roster id is on every member's card. The limits (`roster.rs`) are what bound it:
  - the signature is checked before anything counts, so junk costs nothing;
  - ops held aside for a missing parent sit in their own queue (`MAX_PENDING` = 256 for the
    owner's ops, 256 for everyone else's) and never take a slot in the log; a full queue refuses
    the op, and its sender offers it again;
  - each signer other than the owner may have at most `MAX_OPS_PER_SIGNER` = 128 accepted ops;
  - of the `MAX_OPS` = 4096 lifetime ops, the last `OWNER_RESERVE` = 512 are the owner's alone.

  So the owner can always close the roster and remove people. What remains: in an `open` roster,
  throwaway keys can each `Enroll` until the non-owner share is spent, which stops new
  enrollments for good, since the log is never compacted (§10). A close that had not seen those
  enrollments ends them, but does not free their slots. Replicas that see ops in different
  orders can disagree at the cap, as they could before.

- **A repeater that left, or was removed, was still a reader** (§2.2). It keeps the read
  capability for every namespace it ever carried.
- **A compromised inviter** can invite anyone, but cannot make anyone enroll. The owner revokes the
  role.
- **A leaked claim code** is worth one attempt within 30 minutes, and only to a phone that is
  also the owner the claim names. That means it is worth nothing to anyone but the person at the
  console.

## 9. Phases

The repeater work landed as trail-stash#8 and #9 before that repository moved into this one
(`repeater/server`, with its history); the app's is #187.

0. **Spike: the stash on disk, with siblings.** Built and green.
   - `Storage::Persistent` (no longer what a repeater runs: see `Storage::MemoryRepeater`, §1).
   - A grant book that is written before a grant is acknowledged and fails the start when
     unreadable.
   - Adoption of on-disk entries into the content ledger.
   - `sync_peers`, and a self-generated identity.
1. **Roster and claim.** Built and green; the daemon proves it without an app.
   - The roster as a pure module: ops, signatures, replay rules, and order-independence as tests.
   - The `streetcryptid/repeater/1` protocol: `Claim`, `Publish`, `Fetch`, `Grant` with the
     namespace proof, and `Have`.
   - The cert, and carrying enforced and released by the daemon (reading stays open).
   - Roster sync between siblings.
   - The claim link printed on the console. The HTTP control API is not served in repeater mode.
   - The shared crate (§3.4), and co-carriers across rosters (§6.1).
   - The link as an https URL and a console QR code, opened by the phone's camera (trail-stash#9).
2. **App.**
   - Built (core): the shared crate as a dependency; the roster book; `claimRepeater` with the
     cert check, `repeaterRosters`, `setRepeaterCarried`, and the grant pass on every start
     (`repeater.grant` span) with co-carriers. Unit-tested; untested against a live daemon from a
     phone.
   - A `repeaters` collection outside `friends`, with the invariant test.
   - `RepeaterCard` on the profile namespace, with cross-friend vouching.
   - Built (UI): Settings → Repeaters (`src/features/repeaters`, §4.5): the list, a full-screen
     claim (by the camera's QR code or a pasted link), Your repeaters (carrying, machines with
     each removal confirmed once, the policy, and people: removing members, inviters, invites),
     and a People page for other rosters this phone may invite to; the Settings menu summarises
     them and badges offers. A build without the calls hides the entry.
   - Built: `RepeaterCard` (whole signed logs, vouching checked against the log), Available
     through friends in Settings → Repeaters, enrolling with a cited invite, and
     `fix.provenance` / `contact.role = repeater` telemetry (`infra/otel/README.md`).
   - Built: the Enroll and invite question on the pairing result screen, inviting, granting
     `inviter`, and auto-invite (§3.2, §4.4). Not yet: auto-enroll.
   - Built: vouches only from the friend whose profile namespace a card was read from (§4.2).
   - Delivery, built: unwaited pushes to rosters I am enrolled in, capped and rotated pulls from
     friends' repeaters, `contact.role` / `fix.provenance`. Isolation needed no change (any
     `peer.contact` is an answer; only the stash's silence counts).
   - Delivery, built: a carrier's `Have` receipt after a push to carriers alone (§5), and
     `repeaters.*` on `device.health`.
   - Built: re-offering roster ops a repeater missed until it answers (§4.4), and dialling only
     rosters this phone has signed an op in.
3. **Operations.**
   - Built: `Storage::MemoryRepeater` — identity, roster and grant book on disk, replica and
     ciphertext in RAM with the stash's GC — which also retires disk blob GC for repeaters.
   - Quotas.
   - Packaging: systemd unit, launchd plist, Windows service (built, `repeater/windows`), and a
     Home Assistant add-on.
   - Health on the daemon.
   - Built: a repeater that stops carrying when its owner removes it (§6.2).
   - Built: releasing a repeater at the machine (`trail-stash release`, the Windows app's
     RELEASE), and the owner repeating a claim whose reply was lost (§4.1).

## 10. Open questions

- **Owner continuity.** The owner is a phone identity, so a lost phone orphans the roster until
  multi-device identity exists (`ARCHITECTURE.md` §9d). Should the owner be able to designate a
  co-owner?
- **Repeater as a pull accelerator.** A repeater that is up could pull friends' namespaces
  proactively from the stash, so that a LAN-local phone pulls from it quickly. That is a latency
  win to measure, not a design need.
- **How common is relaying between non-friends?** `peer.contact{contact.role=other}` counts
  exchanges between phones that are not friends. A week of it would show how often the open-read
  path in §2.1 actually delivers. That is worth knowing before anyone proposes closing it.
- **Namespace rotation.** It is the only real revocation of a reader (§2.2), for a repeater and
  for a removed friend alike. Is it worth building, and how do friends learn the new ticket: the
  profile namespace, or a control record beside the prekey?
- **Should a phone be able to refuse friends' repeaters?** A "do not dial repeaters" setting
  would take them out of the pull plan. It would not stop them reaching the phone through a
  swarm (§2.2), so the copy would have to be careful.
- **Roster compaction.** Per-signer limits and the owner's reserve (§8) keep a flooded roster
  governable, but throwaway keys can still spend the non-owner share of the 4096-op lifetime cap
  in an `open` roster. An owner-signed checkpoint that drops ended enrollments would free it.
  Needed before `open` rosters are safe to recommend.

## 11. Where the code differs (audit of 2026-11-12)

The audit of 2026-11-12 found twelve places where the sections above described more, or
something other, than what ran. All twelve are closed; each section now says what is built and
what is not. What was found, and what changed:

| id  | gap                                                            | now                                                                                      |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| G1  | roster ops were offered to a repeater once                     | offered on every grant pass until the repeater answers (`repeater::deliver`, §4.4)       |
| G2  | a removed machine kept carrying                                | it releases everything and refuses `Grant` (`Roster::is_removed_repeater`, §6.2)         |
| G3  | `StashNode::release` described disk GC                         | rewritten for in-memory ciphertext                                                       |
| G4  | no call signed `Invite`, `Grant` or `Revoke`                   | invite, grant and revoke `inviter`, auto-invite (§3.2)                                   |
| G5  | no phone asked a repeater `Have`                               | a push to carriers alone waits up to 8 s for a receipt (`repeater::receipt`, §5)         |
| G6  | anyone holding a roster id could fill it                       | signatures first, a separate pending queue, per-signer cap, owner reserve (§8)           |
| G7  | every roster in the book was fetched on every start            | only rosters this phone owns or is carried by; a phone that signed nothing dials nothing |
| G8  | no release; a lost `Claimed` reply stranded the machine        | the owner may repeat a claim; `trail-stash release` and the Windows app's RELEASE (§4.1) |
| G9  | a card's signer was not tied to the namespace it was read from | a card vouches only from the friend whose profile it was read from (§4.2)                |
| G10 | no Enroll question at pairing                                  | enroll and invite on the pairing result screen (§4.4)                                    |
| G11 | no `repeaters.*` on `device.health`                            | `repeaters.enrolled`, `.carriers`, `.last_contact_age_ms` (§5)                           |
| G12 | the `wire.rs` table omitted inviters from `Fetch`              | fixed; `Fetch` is now open to anyone who signed in the roster (§6.2)                     |

Found while fixing them, and fixed with them: a member the owner removed could not `Fetch` the
roster (`NotCarried`), so its phone kept believing it was carried and pushing there. Anyone who
has signed an op in a roster may now fetch it (§6.2).

What remains is design, not drift: auto-enroll (§4.2), quotas and daemon health (§9), and the
open questions in §10. None of the fixes above has run against a live daemon from a phone yet.
