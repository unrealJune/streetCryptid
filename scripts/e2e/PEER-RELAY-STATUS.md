# Peer relay: verified in Rust, flaky on device

**Status:** the property is implemented and proven deterministically; the end-to-end test that
exercises it on real devices passes intermittently. This is a write-up of what is solid, what is
not, and what to do about it — so the next person does not have to rediscover any of it.

## The property

ARCHITECTURE.md §1.3 and §6 say a device recovers what it missed from *any* pool member:

> if B was offline, B recovers the **trail it missed** from any other device in the sharing pool
> when it comes back.

> Offline recovery works because the whole (encrypted) envelope is replicated to every pool
> member; a rejoining B runs range-based reconciliation against **C/D/A**.

Before this work it did not hold. `sync_latest` took a single `Option<String>` that only ever
carried the trail stash, so recovery could reach the author or the durable server and nobody else.
`scripts/e2e/relay-e2e.sh` demonstrated it: with the author force-quit and the stash switched off,
a device could not obtain a fix that a friend beside it was demonstrably holding, while the
identical run with the stash on passed. That control passing is what made the failure meaningful —
topology, pairing, publishing and timing were all sound, and the only variable was whether the
durable server was allowed to answer.

## What is fixed

Three changes, all committed:

1. **`sync_latest` takes a list of peers.** The stash is no longer a special case — it is one
   endpoint among the pool members. This also collapsed `sync_latest` / `sync_latest_traced` /
   `sync_latest_inner` into one function.
2. **`subscribeToFriend` bootstraps a friend's topic from the whole pool.** The swarm for A's
   topic contains everyone A shares with, so any of them is a valid entry point — and when A is
   down they are the only one. `ensureMySubscription` already did this for our own topic.
3. **The trail namespace is imported *before* subscribing.** Importing is local bookkeeping;
   `subscribe` dials. In the old order an offline friend made `subscribe` throw, `restorePool`
   swallowed it per-friend, and `importDocTicket` was never reached — so the device held no
   replica for that author and `syncTrail` reported success having recovered nothing.

Verified by `a_pool_member_serves_an_absent_authors_fix` (`tests/pairing_integration.rs`): an
ordinary peer holding only a READ ticket serves the author's fix after the author shuts down, with
the stash untouched. It is deterministic and runs in about five seconds.

## Why the e2e is delicate

The Rust test also pins down the precondition that makes the device test hard, and it is a
property of the design rather than a bug:

**A relay can only serve what is in its replica, and live gossip does not put anything there.**

A fix that arrives over the live lane lands in the receiver's own app storage — the
`friend_latest` row, labelled `via=lan` — and *not* in its replica of the author's iroh-docs
namespace. A friend holds a READ ticket for that namespace and cannot write to it; only
reconciliation puts entries there. So a relay that has only ever heard the author over gossip has
the fix on screen and nothing to hand on.

For the e2e to mean anything, then, the relay must have reconciled with the author over docs
**while the author was still reachable**, and that has to happen after the author actually
published. Arranging that on two simulators is where the flakiness lives:

- The app runs `syncTrail` on resume, so the harness drives it by foregrounding the device.
- Both ends must be awake for the exchange. A backgrounded iOS app is suspended on the OS's
  schedule and may not answer an inbound dial, so leaving the author in the background made the
  step depend on whether the OS happened to keep it alive.
- The author publishes on its own cadence, so a single reconciliation can legitimately land
  between two of its fixes.

Observed directly: the test passed cleanly once (`seq=1332 via=sync`, author force-quit, stash
off) and failed on repeat runs. Foregrounding the relay, and then foregrounding both ends twice
with settling time, did not make it reliable.

## What to try next

In rough order of expected value:

1. **Assert the relay's replica directly instead of inferring it from `friend_latest`.** This is
   the real gap in the test: `friend_latest` proves the relay *saw* the fix, not that it can serve
   it, and those are different things (see above). Without this the test cannot tell "the relay had
   nothing to give" from "the transfer failed", which is exactly the ambiguity that made the
   failures hard to read. A small native query — "does namespace N contain an entry for author A"
   — would turn the precondition into an assertion and make every subsequent failure diagnosable.
2. **Drive the reconciliation deterministically rather than through the UI.** Foregrounding is a
   proxy for "run `syncTrail` now". A debug affordance that triggers a reconciliation directly
   would remove the lifecycle timing from the test entirely.
3. **Consider whether the app should reconcile more eagerly after receiving a live fix.** If a
   device hears an author over gossip but never reconciles their namespace, it silently cannot
   relay for them. That is defensible (reconciliation costs battery and the stash usually covers
   it), but it means peer relay in the field depends on a device having synced recently, which is
   worth deciding deliberately rather than by accident.
4. Only then re-run `relay-e2e.sh` repeatedly and treat a green run as meaningful.

## How to run it today

```sh
just e2e-build-ios                 # Release build — a dev build cannot be driven reliably
just e2e-relay ios:<A> ios:<B> ios:<C>

# The control. If this passes and the above fails, the scenario is sound and what is
# missing is specifically peer relay rather than anything about the harness.
STASH_OPT_IN=1 bash scripts/e2e/relay-e2e.sh ios:<A> ios:<B> ios:<C>
```

Treat `a_pool_member_serves_an_absent_authors_fix` as the gate for the property, and
`relay-e2e.sh` as a manual end-to-end check until item 1 above lands.
