//! The one rule about the node lock, enforced against the source that has to keep it.
//!
//! `LocationNode::inner` is the single process-wide lock behind every JS-visible native call. A
//! guard held across an `await` does not slow one call down — it stops the phone, because the
//! pairing poll that opens the SAS gate, the BLE reads, the publish path and the inbound
//! `PairProtocol` handler all queue behind whatever the holder is waiting for. When that await is
//! a docs import or a gossip subscribe aimed at an unreachable peer, nothing releases it and only
//! a force-quit clears it.
//!
//! This has been fixed three times: `import_profile_ticket` and `read_profile` on 2026-09-10 after
//! `pairing.poll` spans of 47-131 s, and the whole remaining sweep on 2026-09-17 after ACKNOWLEDGE
//! wedged two Pixels through `import_doc_ticket` + `subscribe`. Each fix was correct and local, and
//! each left the next call site free to reintroduce it — so the rule is checked rather than
//! remembered.
//!
//! A source scan and not a runtime assertion because there is nothing to assert at runtime: the
//! failure is a future that never completes, which is exactly what a test cannot wait for. The
//! shape is deliberately the same as `scripts/test-build-profile-isolation.sh`: prove the property
//! offline, cheaply, on every run.
//!
//! **Adding a call that needs the node's handles?** Use `LocationNode::live()` (or `live_opt()`),
//! which clones them and releases the lock. Do not reach for the guard.

use std::path::Path;

/// Bind the guard, and you may not `.await` until you have dropped it.
const GUARD_BINDING: &str = "self.inner.lock().await";

#[test]
fn the_node_lock_is_never_held_across_an_await() {
    let src = std::fs::read_to_string(Path::new("src/lib.rs")).expect("read src/lib.rs");
    let lines: Vec<&str> = src.lines().collect();

    let mut offences: Vec<String> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        // Only the form that BINDS the guard to a name can hold it; `*self.inner.lock().await = x`
        // and `self.inner.lock().await.take()` drop it at the end of their own statement.
        if !(line.contains(GUARD_BINDING) && line.contains("let guard")) {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        // Walk to the end of the guard's scope, which is the first line that closes a block at or
        // outside the guard's own indent.
        for (offset, following) in lines[index + 1..].iter().enumerate() {
            let trimmed = following.trim_start();
            if trimmed.starts_with("drop(guard)") {
                break;
            }
            let closes_scope = trimmed.starts_with('}')
                && (following.len() - trimmed.len()) < indent
                && !trimmed.starts_with("};");
            if closes_scope {
                break;
            }
            if following.contains(".await") {
                offences.push(format!(
                    "src/lib.rs:{}: `let guard = {GUARD_BINDING}` is still alive at line {}: {}",
                    index + 1,
                    index + offset + 2,
                    trimmed
                ));
                break;
            }
        }
    }

    assert!(
        offences.is_empty(),
        "the node lock is held across an await — every one of these stalls every other native \
         call on the device until the await completes, and if it never does, until the app is \
         force-quit. Take the handles with `self.live().await?` and let the guard go.\n  {}",
        offences.join("\n  ")
    );
}

/// The pairing wire has no unbounded awaits left on it.
///
/// A dial with no deadline is an unbounded promise in JS, which is a pairing screen stuck on
/// "REACHING THEM" with no end state and no error — the 2026-09-17 00:50 UTC failure, five
/// `pair.stand_down`s and three force-quits. The budgets themselves are judgement calls and may
/// well be retuned; that each of these awaits HAS one is not.
#[test]
fn every_await_on_the_pairing_wire_is_bounded() {
    let src = std::fs::read_to_string(Path::new("src/pairing.rs")).expect("read src/pairing.rs");
    for (what, needle) in [
        (
            "the outbound connect",
            "PAIR_CONNECT_TIMEOUT, endpoint.connect",
        ),
        ("the outbound round trip", "PAIR_EXCHANGE_TIMEOUT, exchange"),
        ("the inbound handler", "PAIR_INBOUND_TIMEOUT, async"),
        (
            "the inbound close linger",
            "PAIR_CLOSE_LINGER, conn.closed()",
        ),
        ("the handshake's docs reads", "PAIR_DOCS_TIMEOUT, work"),
        (
            "finalize's profile ticket import",
            "PAIR_DOCS_TIMEOUT, profile.import_ticket(pt)",
        ),
        (
            "finalize's trail ticket import",
            "PAIR_DOCS_TIMEOUT, trail.import_ticket(tt)",
        ),
        // Bounded by a `budget` that is `ENDPOINT_ONLINE_TIMEOUT` the first time and zero once
        // the endpoint has been seen online — see `our_endpoint_ticket`.
        (
            "the invite address snapshot",
            "tokio::time::timeout(budget, ep.online())",
        ),
    ] {
        assert!(
            src.contains(needle),
            "{what} lost its timeout (looked for `{needle}`). An unbounded await here is a \
             pairing screen that never comes back."
        );
    }
}
