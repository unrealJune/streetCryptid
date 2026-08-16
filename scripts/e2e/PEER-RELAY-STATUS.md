# Peer relay: what is proven, and what the device test now means

**Status:** the property holds by construction, not by luck. The author publishes to the whole
pool, so a friend with the app open holds its entries as they are written and can hand them on the
moment the author goes dark. `scripts/e2e/relay-e2e.sh` asserts that against the relay's replica
and drives both devices through a deep-link command channel rather than app restarts.

This is a record of what was found and what changed, so the next person does not have to
rediscover any of it.

## The property

ARCHITECTURE.md §1.3 and §6 say a device recovers what it missed from _any_ pool member:

> if B was offline, B recovers the **trail it missed** from any other device in the sharing pool
> when it comes back.

> Offline recovery works because the whole (encrypted) envelope is replicated to every pool
> member; a rejoining B runs range-based reconciliation against **C/D/A**.

## What was broken, in two halves

**The receive half.** `sync_latest` took a single `Option<String>` that only ever carried the
trail stash, so recovery could reach the author or the durable server and nobody else. Fixed by
"recover a friend's fix from any pool member" (`a62b52f`), which also made `subscribeToFriend`
bootstrap a friend's topic from the whole pool, and moved the trail-namespace import _before_ the
subscribe (importing is local bookkeeping; `subscribe` dials, and an offline friend used to make
it throw before `importDocTicket` was ever reached).

**The send half, which that commit did not touch.** `push_trail` still took one peer — the stash.
`TrailDocs::push` is `doc.start_sync(peers)`, and the live engine broadcasts a `LocalInsert` only
for namespaces `start_sync` has marked as syncing, so an author's published fix went over docs to
the stash and to nobody else.

That matters because of the precondition the Rust tests pin down:

**A relay can only serve what is in its replica, and live gossip does not put anything there.**

A fix that arrives over the live lane lands in the receiver's app storage — the `friend_latest`
row, labelled `via=lan` — and _not_ in its replica of the author's iroh-docs namespace. A friend
holds a READ ticket for that namespace and cannot write to it; only replication puts entries
there. So a relay that has only ever heard the author over gossip has the fix on screen and
nothing to hand on.

With the send half stash-only, the only way an entry reached a pool member's replica was that
member happening to dial the author during a `syncTrail` while the author was still up. On device
that is a timing lottery, which is why the e2e had to choreograph a reconciliation window and
still only passed intermittently; in the field it meant peer relay silently depended on a device
having synced recently, and with the stash off there was no durable copy anywhere at all.

## The invariant now

**An author's namespace is live-synced to the trail stash _and_ to every pool member, on every
publish** (`push_trail(Vec<String>, Option<String>)` → `pushTrail` → `durablePeerTickets()`).
`start_sync` is a no-op once a namespace is syncing, so steady state is one connection per member
for the process's lifetime; a headless wake pays a cold dial per member, the same cost shape the
stash-only push already had.

Two Rust tests hold the line, both deterministic and a few seconds each
(`tests/pairing_integration.rs`):

- `a_pool_member_serves_an_absent_authors_fix` — an ordinary peer holding only a READ ticket
  serves the author's fix after the author shuts down, with the stash untouched. It now asserts
  the relay's **replica** (`trail_replica_status`) before the author leaves, so an empty relay and
  a failed transfer are distinguishable.
- `a_published_fix_reaches_the_pool_without_a_reconciliation_window` — the same property with the
  choreography removed. The relay opens the author's namespace while it is still empty, the author
  publishes with the relay in its push list and never reconciles again, and a third node recovers
  the fix from the relay. This is the one that says peer relay is the normal flow.

## What the device test now proves, and how it is driven

Two affordances replaced the guesswork:

1. **`trail_replica_status`** — a diagnostics read of the replica, alongside
   `transport_diagnostics`: one record per author present locally (`author`, `seq`, `fixTs`,
   `hasContent`), no decryption, no location data. `hasContent` is true only when a readable
   _signed_ envelope is actually here, so "we hold a docs record pointing at a blob that never
   landed" is not reported as servable. This is what the e2e asserts as its precondition, in place
   of a `friend_latest` row — that row is written by the gossip lane too, and its `via` column has
   a sticky-merge rule, so it can say the relay _saw_ the fix but never that it can _serve_ it.
2. **A dev command channel** — `streetcryptid://dev?cmd=<name>&id=<nonce>`, handled by
   `src/app/+native-intent.tsx` and `src/features/dev/commands/`. Commands are `sync-trail` and
   `replica-status`; both call ordinary service methods, and each writes its result to the event
   log with the caller's nonce echoed back, which is the channel the harness already reads.

The channel exists because Maestro's `launchApp` force-terminates and relaunches on iOS
(`.maestro/README.md`). The old harness called it six times as "foreground the device", so every
one of those steps tore the iroh node down and left a fixed `sleep` to cover a cold dial. Opening
a URL foregrounds a running app without restarting it, launches it when it is not running, and its
acknowledgement is a better readiness signal than `assertVisible: map-view`: it proves the sharing
service answered, not that a view painted. The Maestro `foreground-app.yaml` flow and its
`device_foreground` / `bring_to_foreground` wrappers were added for this one test and are gone.

Consequently `relay-e2e.sh` no longer has reconciliation `sleep`s, re-drives the late device on
every pass of its wait loop (its own `syncTrail` runs only on a resume or during a live-watch
session, so a single cold launch used to be the whole test's one attempt), breaks out of the
publish loop as soon as `publish.fix ok` lands, and clears stale friend records on the late device
before intersecting endpoint lists.

## How to run it

```sh
just bindgen-ios                   # macOS only; the Swift bindings must have trailReplicaStatus
just e2e-build-ios                 # Release build — a dev build cannot be driven reliably
just e2e-relay ios:<A> ios:<B> ios:<C>

# The control. Identical scenario with the durable server left ON. If this passes and the above
# fails, the scenario is sound and what is missing is specifically peer relay.
STASH_OPT_IN=1 bash scripts/e2e/relay-e2e.sh ios:<A> ios:<B> ios:<C>
```

The Rust tests are the gate for the property; `relay-e2e.sh` is the gate for it working on real
devices. A failure there is now readable: if the precondition fails, the relay's `replica-status`
is printed and the relay genuinely had nothing to give; if the wait loop fails, the relay
demonstrably could serve it and the transfer is what broke.

## Still open

If a device hears an author over gossip but never reconciles their namespace, it cannot relay for
them. That is now the exception rather than the rule — the author pushes to it directly — but it
is still true of a device that was asleep for the whole window in which the author published. The
stash covers that case; a pool with the stash off does not. Worth deciding deliberately whether a
device should reconcile more eagerly after receiving a live fix, rather than leaving it implicit.
