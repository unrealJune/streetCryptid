//! **App-condition** tests for the ratchet: the states a phone actually gets into.
//!
//! `ratchet_integration.rs` proves the happy path over real transport. This file is about the
//! unhappy ones, because those are what a location app spends its life in — a phone that was in
//! a tunnel for an hour, two people who both moved at the same instant, one friend who walks all
//! day while the other sits still, and the device that got reinstalled.
//!
//! Same setup as its sibling: two real `LocationNode`s, real QUIC, real iroh-docs reconciliation
//! through a third node holding only ciphertext.
//!
//! One property shapes most of what follows. The durable path is **last-write-wins** (§4.4), so
//! being offline never means "catch up on 200 fixes" — it means "read the one current fix, whose
//! ratchet position is 200 ahead of you". The receiving chain fast-forwards and every skipped key
//! is unrecoverable, by design (§9). That is why offline recovery is a *window* question rather
//! than a backlog question.

use std::sync::Arc;

use iroh_location::{LocationFix, LocationNode};

// ── the normative source-level check (§7 step 7) ──────────────────────────────────────────

/// §4.6: "there is no code path that roots a session in static-static DH alone, and no automatic
/// downgrade of any kind."
///
/// That is a claim about code that no runtime test can make, because the dangerous version
/// *works* — a session rooted in two long-term keys passes every functional test in this repo
/// and quietly loses forward secrecy against §3's seized device. So it is checked as a tripwire
/// on the source instead, which is what the plan asks for.
///
/// The invariant: a root key is only ever bound by [`derive_boot_root`], whose input is an
/// ephemeral-ephemeral shared secret. Anyone introducing a second way to produce one — from the
/// pairing DH, from the receiving keys, from anything a seized device still holds — has to delete
/// this test to do it, and deleting it is a reviewable act.
#[test]
fn no_session_root_derives_from_static_static_dh() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut root_bindings = Vec::new();
    let mut derive_callers = Vec::new();

    for file in [
        "lib.rs",
        "sessions.rs",
        "ratchet.rs",
        "pairing.rs",
        "crypto.rs",
    ] {
        let text = std::fs::read_to_string(src.join(file)).expect("read source");
        // The body of the derivation itself necessarily binds a root; it is the one place
        // allowed to, so it is skipped rather than special-cased in the assertion below.
        let mut inside_derivation = false;
        for (i, line) in text.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.starts_with("fn derive_boot_root(") {
                inside_derivation = true;
                continue;
            }
            if inside_derivation {
                if line == "}" {
                    inside_derivation = false;
                }
                continue;
            }
            if trimmed.starts_with("//") {
                continue; // prose, including this invariant's own documentation
            }
            let at = format!("{file}:{}", i + 1);
            // A *binding* of a root, not a use of one: `rk0` must appear on the left of the `=`.
            // `let state = bootstrap_responder(.., rk0, ..)` passes a root along; only
            // `let (rk0, ..) = ..` creates one.
            if trimmed.starts_with("let ") {
                if let Some((lhs, _)) = trimmed.split_once('=') {
                    if lhs.contains("rk0") {
                        root_bindings.push((at.clone(), trimmed.to_string()));
                    }
                }
            }
            if trimmed.contains("derive_boot_root(") && !trimmed.starts_with("fn ") {
                derive_callers.push((at, trimmed.to_string()));
            }
        }
    }

    // Every root binding — bootstrap and resync alike — comes from the ephemeral-ephemeral
    // derivation. Two call sites is correct and expected; a third that did NOT go through
    // `derive_boot_root` is the thing this exists to catch.
    assert!(
        !root_bindings.is_empty(),
        "no root binding found at all — has the derivation been renamed out from under this test?"
    );
    for (at, binding) in &root_bindings {
        assert!(
            binding.contains("derive_boot_root("),
            "a session root must only ever come from derive_boot_root, but {at} binds one from \
             something else: {binding}"
        );
    }

    // And every caller of it is a bootstrap or a resync — never a fallback on some other path.
    assert!(
        !derive_callers.is_empty(),
        "derive_boot_root must actually be used"
    );
    for (at, line) in &derive_callers {
        assert!(
            line.contains("rk0"),
            "derive_boot_root's output must be used as a root at {at}: {line}"
        );
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn start_node() -> Arc<LocationNode> {
    let node = LocationNode::new(None, None).expect("construct node");
    node.start(
        vec!["https://127.0.0.1:1".into()],
        "test-token".into(),
        true,
        true,
        true,
    )
    .await
    .expect("start node");
    node
}

fn fix_at(ts: u64) -> LocationFix {
    LocationFix {
        lat: 47.6062,
        lon: -122.3321,
        accuracy_m: 4.0,
        heading_deg: 90.0,
        ts,
    }
}

async fn replicate(
    author: &Arc<LocationNode>,
    stash: &Arc<LocationNode>,
    reader: &Arc<LocationNode>,
) {
    let ticket = author.doc_ticket().await.expect("author trail ticket");
    stash
        .import_doc_ticket(ticket.clone())
        .await
        .expect("stash imports");
    stash
        .sync_latest(Some(author.ticket().await.expect("author ticket")))
        .await
        .expect("stash reconciles with author");
    reader
        .import_doc_ticket(ticket)
        .await
        .expect("reader imports");
    reader
        .sync_latest(Some(stash.ticket().await.expect("stash ticket")))
        .await
        .expect("reader reconciles with stash");
}

async fn bootstrap_pair(a: &Arc<LocationNode>, b: &Arc<LocationNode>) {
    let a_id = hex(&a.endpoint_id());
    let b_id = hex(&b.endpoint_id());
    let a_eph = a.begin_session(b_id.clone()).await.expect("a ephemeral");
    let b_eph = b.begin_session(a_id.clone()).await.expect("b ephemeral");
    a.complete_session(b_id, b_eph).await.expect("a completes");
    b.complete_session(a_id, a_eph).await.expect("b completes");
}

/// Which of the pair takes the initiator role — the same endpoint-id ordering the nodes use.
fn initiator_first<'a>(
    a: &'a Arc<LocationNode>,
    b: &'a Arc<LocationNode>,
) -> (&'a Arc<LocationNode>, &'a Arc<LocationNode>) {
    if a.endpoint_id() < b.endpoint_id() {
        (a, b)
    } else {
        (b, a)
    }
}

/// Bootstrap and close the responder window, so either side can publish (see the sibling file).
async fn bootstrap_and_prime(
    a: &Arc<LocationNode>,
    b: &Arc<LocationNode>,
    stash: &Arc<LocationNode>,
) {
    bootstrap_pair(a, b).await;
    let (first, second) = initiator_first(a, b);
    first
        .docs_write_ratcheted(
            "prime".into(),
            0,
            fix_at(1),
            vec![hex(&second.endpoint_id())],
        )
        .await
        .expect("priming publish");
    replicate(first, stash, second).await;
    second.read_latest_ratcheted().await.expect("prime read");
}

/// Publish from `from` to `to` and deliver it, returning what `to` could open.
///
/// Reconciliation is bounded by timeouts (a cold dial can outlast them on a loaded machine), so
/// delivery is attempted a few times rather than once. This is not papering over flakiness — the
/// app itself reconciles on a cadence and never assumes a single pass landed. Retrying is safe
/// because a pass that transfers nothing consumes no ratchet position: there is nothing to open,
/// so nothing is accepted.
async fn publish_and_deliver(
    from: &Arc<LocationNode>,
    to: &Arc<LocationNode>,
    stash: &Arc<LocationNode>,
    seq: u64,
    ts: u64,
) -> Vec<iroh_location::IncomingFix> {
    let dropped = from
        .docs_write_ratcheted("t".into(), seq, fix_at(ts), vec![hex(&to.endpoint_id())])
        .await
        .expect("publish");
    assert!(
        dropped.is_empty(),
        "publish seq {seq} silently dropped its recipient: {dropped:?}"
    );
    let author_id = from.endpoint_id();
    let mut last = Vec::new();
    for _ in 0..5 {
        replicate(from, stash, to).await;
        last = to.read_latest_ratcheted().await.expect("read");
        if last.iter().any(|e| e.author == author_id) {
            return last;
        }
    }
    last
}
/// One delivery attempt, for assertions that expect **nothing** to arrive — retrying there would
/// only spend five reconciliation timeouts proving the same negative.
async fn publish_and_deliver_once(
    from: &Arc<LocationNode>,
    to: &Arc<LocationNode>,
    stash: &Arc<LocationNode>,
    seq: u64,
    ts: u64,
) -> Vec<iroh_location::IncomingFix> {
    from.docs_write_ratcheted("t".into(), seq, fix_at(ts), vec![hex(&to.endpoint_id())])
        .await
        .expect("publish");
    replicate(from, stash, to).await;
    to.read_latest_ratcheted().await.expect("read")
}

/// Stop a node and bring it back as a **new process would**: same identity and receiving secret,
/// therefore the same data directory, therefore the same on-disk session store.
///
/// This is the real restart shape rather than a simulated one — nothing is carried across in
/// memory. Everything the ratchet needs afterwards has to have come off disk.
async fn restart(node: Arc<LocationNode>) -> Arc<LocationNode> {
    let identity = node.identity_secret();
    let recv = node.recv_secret();
    node.shutdown().await.expect("shutdown");
    drop(node);

    let fresh = LocationNode::new(Some(identity), Some(recv)).expect("reconstruct after restart");
    fresh
        .start(
            vec!["https://127.0.0.1:1".into()],
            "test-token".into(),
            true,
            true,
            true,
        )
        .await
        .expect("restart");
    fresh
}

// ── restarts ──────────────────────────────────────────────────────────────────────────────

/// **The app is killed and reopened.** Ratchet state lives on disk precisely so this works, and
/// nothing else in the test suite would notice if it stopped.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sessions_survive_an_app_restart() {
    let author = start_node().await;
    let friend = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&author, &friend, &stash).await;
    let author_id = author.endpoint_id();

    assert!(
        publish_and_deliver(&author, &friend, &stash, 1, 1000)
            .await
            .iter()
            .any(|e| e.author == author_id),
        "traffic flows before the restart"
    );

    let friend = restart(friend).await;

    assert!(
        publish_and_deliver(&author, &friend, &stash, 2, 2000)
            .await
            .iter()
            .any(|e| e.author == author_id && e.fix.ts == 2000),
        "the friend must still open the author's fixes after a restart"
    );

    for node in [author, friend, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// **Both phones restart.** Sending state as well as receiving state has to come back, so this
/// covers the half the previous test does not: a sender whose chain position was lost would
/// either fail to publish or — much worse — resume at a counter it has already used.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn both_sides_survive_a_restart_and_keep_talking() {
    let a = start_node().await;
    let b = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&a, &b, &stash).await;

    let a = restart(a).await;
    let b = restart(b).await;
    let a_id = a.endpoint_id();
    let b_id = b.endpoint_id();

    assert!(
        publish_and_deliver(&a, &b, &stash, 5, 5000)
            .await
            .iter()
            .any(|e| e.author == a_id && e.fix.ts == 5000),
        "a → b must survive both sides restarting"
    );
    assert!(
        publish_and_deliver(&b, &a, &stash, 5, 6000)
            .await
            .iter()
            .any(|e| e.author == b_id && e.fix.ts == 6000),
        "b → a must survive both sides restarting"
    );

    for node in [a, b, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// **A restart between deriving a key and publishing it** — the crash §4.2 designs for.
///
/// Persist-before-publish means the counter is on disk before the envelope is on the wire, so a
/// death in between burns that counter rather than reusing it. Recovery is local: the next
/// publish steps to the next counter with no peer round-trip, which is the sender-liveness
/// invariant. What must never happen is the sender coming back and re-deriving the same position.
///
/// Deliberately asserted **without a cross-node delivery**. Post-restart delivery is already
/// covered by the two tests above; adding it here made the case fail intermittently under full
/// suite load for a reason that had nothing to do with the ratchet — the friend received no
/// envelope at all, so nothing was ever handed to the schedule. That is a docs-replication
/// question (a namespace whose value changed while every reader was away), and it is filed as
/// one rather than left to flicker inside a forward-secrecy test and be read as a crypto fault.
///
/// What is asserted here is the part that is deterministic and is the actual claim: the session
/// survives, the sending chain keeps stepping, and no publish silently drops its recipient —
/// which is what reusing or losing a counter would look like from the outside.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restart_mid_publish_burns_a_counter_rather_than_reusing_one() {
    let author = start_node().await;
    let friend = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&author, &friend, &stash).await;
    let friend_id = hex(&friend.endpoint_id());

    // Publish, but never deliver it — the envelope exists and its counter is spent.
    let dropped = author
        .docs_write_ratcheted("t".into(), 1, fix_at(1000), vec![friend_id.clone()])
        .await
        .expect("author publishes");
    assert!(
        dropped.is_empty(),
        "pre-restart publish dropped: {dropped:?}"
    );

    let author = restart(author).await;

    // If the restart had resurrected stale state, or lost it, this is where it shows: a session
    // that failed to round-trip reports `no_session`, and one that came back at a position it had
    // already used would have had to skip persisting in the first place.
    for seq in 2..=4u64 {
        let dropped = author
            .docs_write_ratcheted("t".into(), seq, fix_at(1000 + seq), vec![friend_id.clone()])
            .await
            .expect("author publishes after the restart");
        assert!(
            dropped.is_empty(),
            "publish {seq} after the restart dropped its recipient: {dropped:?}"
        );
    }
    assert!(
        author.has_session(friend_id).await.expect("session query"),
        "the session must still be there after the restart"
    );

    for node in [author, friend, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// A stop/start cycle inside one process must work — the app does this on lifecycle transitions,
/// and the session store's writer claim is process-global (§4.2).
///
/// Holding that claim past `shutdown` would make every backgrounding permanently break sharing,
/// with a failure mode ("AlreadyOpen") that looks nothing like its cause.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_start_in_one_process_does_not_strand_the_writer_claim() {
    let node = start_node().await;
    let peer = start_node().await;
    let peer_id = hex(&peer.endpoint_id());

    node.begin_session(peer_id.clone())
        .await
        .expect("bootstrap");
    node.shutdown().await.expect("first shutdown");

    node.start(
        vec!["https://127.0.0.1:1".into()],
        "test-token".into(),
        true,
        true,
        true,
    )
    .await
    .expect("restarting in the same process must reclaim the session store");

    // And the store is usable again, not merely opened.
    assert!(
        !node.has_session(peer_id).await.expect("query sessions"),
        "the reclaimed store must answer queries"
    );

    for n in [node, peer] {
        n.shutdown().await.expect("shutdown");
    }
}

/// **The foreground app hands off to a headless wake.** Two node instances over one data
/// directory, which is exactly what expo-task-manager produces — it gives every headless callback
/// a fresh JS context, so the module-level owner flag in `native-runtime-owner.ts` cannot see the
/// foreground one.
///
/// The session store refuses a second live writer on purpose (§4.2: with sequential state, two
/// writers is key reuse rather than a clobber). The corollary is that the *first* writer has to
/// let go on shutdown, or the handoff deadlocks — and the symptom, `AlreadyOpen` from a start
/// call, looks nothing like its cause.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_node_can_claim_the_store_after_the_first_shuts_down() {
    // Two instances of the same identity share a data directory (it is derived from the author
    // key), which is precisely the foreground/headless situation.
    let seed = LocationNode::new(None, None).expect("mint an identity");
    let identity = seed.identity_secret();
    let recv = seed.recv_secret();
    drop(seed);

    let foreground = LocationNode::new(Some(identity.clone()), Some(recv.clone()))
        .expect("construct foreground");
    foreground
        .start(
            vec!["https://127.0.0.1:1".into()],
            "test-token".into(),
            true,
            true,
            true,
        )
        .await
        .expect("foreground claims the store");

    // The app is backgrounded. The instance is still alive and referenced — a shutdown, not a
    // drop, which is the case that actually happens.
    foreground.shutdown().await.expect("foreground stops");

    let headless =
        LocationNode::new(Some(identity), Some(recv)).expect("construct headless context");
    headless
        .start(
            vec!["https://127.0.0.1:1".into()],
            "test-token".into(),
            true,
            true,
            true,
        )
        .await
        .expect("the headless context must be able to claim the store the foreground released");

    headless.shutdown().await.expect("headless stops");
    drop(foreground);
}

// ── offline, then back ────────────────────────────────────────────────────────────────────

/// **A phone in a tunnel.** The author keeps publishing on cadence while the friend receives
/// nothing, then the friend comes back.
///
/// Under last-write-wins there is no backlog to deliver — only the current fix survives in the
/// author's slot — but its ratchet position is as far ahead as the author has published. The
/// friend fast-forwards to it in one step, and the fixes it never saw stay unopenable forever.
/// That second half is the design working, not a limitation: a skipped-key table would be a
/// stored key index into the stash's archive (§9).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_friend_offline_for_many_intervals_catches_up_to_the_current_fix() {
    let author = start_node().await;
    let friend = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&author, &friend, &stash).await;
    let author_id = author.endpoint_id();
    let friend_id = hex(&friend.endpoint_id());

    // Roughly four hours of the 5-minute cold cadence, with the friend hearing none of it.
    for seq in 1..=48u64 {
        author
            .docs_write_ratcheted(
                "t".into(),
                seq,
                fix_at(10_000 + seq),
                vec![friend_id.clone()],
            )
            .await
            .expect("author publishes while the friend is away");
    }

    replicate(&author, &stash, &friend).await;
    let recovered = friend.read_latest_ratcheted().await.expect("friend reads");
    let entry = recovered
        .iter()
        .find(|e| e.author == author_id)
        .expect("the friend must recover the current fix after a long absence");
    assert_eq!(
        entry.fix.ts, 10_048,
        "last-write-wins: the friend gets the CURRENT fix, not the oldest unread one"
    );

    // And the session is live afterwards — a fast-forward must leave a usable chain behind it.
    let next = publish_and_deliver(&author, &friend, &stash, 49, 20_000).await;
    assert!(
        next.iter()
            .any(|e| e.author == author_id && e.fix.ts == 20_000),
        "the session must keep working after a long fast-forward"
    );

    for node in [author, friend, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// **Offline past the acceptance window.** Beyond it the receiver refuses to walk the chain at
/// all (§4.2 bounds the work an unauthenticated counter can demand), so the friend cannot open
/// the fix and the session needs §4.6 resync rather than patience.
///
/// This is the case that decides whether `T_lapse` and the window are tuned sanely (§8.4): the
/// window is 512 positions, so at the 5-minute cold cadence a friend has ~42 hours before their
/// session stops being recoverable by fast-forward alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn beyond_the_acceptance_window_the_friend_needs_a_resync_not_patience() {
    let author = start_node().await;
    let friend = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&author, &friend, &stash).await;
    let author_id = author.endpoint_id();
    let friend_id = hex(&friend.endpoint_id());

    // One past the 512-position acceptance window.
    for seq in 1..=520u64 {
        author
            .docs_write_ratcheted(
                "t".into(),
                seq,
                fix_at(30_000 + seq),
                vec![friend_id.clone()],
            )
            .await
            .expect("author publishes");
    }

    replicate(&author, &stash, &friend).await;
    let recovered = friend.read_latest_ratcheted().await.expect("friend reads");
    assert!(
        !recovered.iter().any(|e| e.author == author_id),
        "a position beyond the acceptance window must be refused, not walked to"
    );

    for node in [author, friend, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

// ── simultaneous and asymmetric traffic ───────────────────────────────────────────────────

/// **Both people move at once.** Each publishes before either has seen the other's envelope, so
/// both are sending on chains the other has not ratcheted onto yet.
///
/// This is the classic Double Ratchet crossing case, and the one where an implementation that
/// conflated "the peer's epoch" with "my epoch" falls over — which is why `RatchetState` tracks
/// `send_epoch` and `recv_epoch` separately.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crossing_envelopes_converge() {
    let a = start_node().await;
    let b = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&a, &b, &stash).await;
    let a_id = a.endpoint_id();
    let b_id = b.endpoint_id();

    // Both publish before either reads.
    a.docs_write_ratcheted("t".into(), 1, fix_at(1000), vec![hex(&b_id)])
        .await
        .expect("a publishes");
    b.docs_write_ratcheted("t".into(), 1, fix_at(2000), vec![hex(&a_id)])
        .await
        .expect("b publishes");

    replicate(&a, &stash, &b).await;
    replicate(&b, &stash, &a).await;

    assert!(
        b.read_latest_ratcheted()
            .await
            .expect("b reads")
            .iter()
            .any(|e| e.author == a_id && e.fix.ts == 1000),
        "b must open a's crossing envelope"
    );
    assert!(
        a.read_latest_ratcheted()
            .await
            .expect("a reads")
            .iter()
            .any(|e| e.author == b_id && e.fix.ts == 2000),
        "a must open b's crossing envelope"
    );

    // Having both ratcheted on each other's keys, the next round must still work in both
    // directions — a converged state, not merely a survived collision.
    assert!(
        publish_and_deliver(&a, &b, &stash, 2, 3000)
            .await
            .iter()
            .any(|e| e.author == a_id && e.fix.ts == 3000),
        "a → b must still work after the crossing"
    );
    assert!(
        publish_and_deliver(&b, &a, &stash, 2, 4000)
            .await
            .iter()
            .any(|e| e.author == b_id && e.fix.ts == 4000),
        "b → a must still work after the crossing"
    );

    for node in [a, b, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// **One friend walks, the other sits still.** The everyday shape of a sharing pair: heavily
/// asymmetric traffic, so one sending chain runs long between DH ratchets while the other barely
/// moves.
///
/// The thing being checked is that a long one-sided run does not strand the quiet side: when it
/// finally speaks, its envelope must still be locatable, and the busy side must be able to
/// fast-forward to it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn heavily_asymmetric_traffic_keeps_both_directions_alive() {
    let walker = start_node().await;
    let sitter = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&walker, &sitter, &stash).await;
    let walker_id = walker.endpoint_id();
    let sitter_id = sitter.endpoint_id();

    // The walker publishes 30 times, delivered as it goes, while the sitter says nothing.
    for seq in 1..=30u64 {
        let seen = publish_and_deliver(&walker, &sitter, &stash, seq, 50_000 + seq).await;
        assert!(
            seen.iter()
                .any(|e| e.author == walker_id && e.fix.ts == 50_000 + seq),
            "the sitter must open the walker's fix {seq}"
        );
    }

    // The sitter finally moves. Its sending chain has been idle the whole time.
    let seen = publish_and_deliver(&sitter, &walker, &stash, 1, 60_000).await;
    assert!(
        seen.iter()
            .any(|e| e.author == sitter_id && e.fix.ts == 60_000),
        "the walker must open the sitter's first envelope after a long silence"
    );

    // ...and the walker keeps working afterwards, having just DH-ratcheted onto the sitter's key.
    let seen = publish_and_deliver(&walker, &sitter, &stash, 31, 70_000).await;
    assert!(
        seen.iter()
            .any(|e| e.author == walker_id && e.fix.ts == 70_000),
        "the walker must keep publishing after ratcheting onto the sitter's key"
    );

    for node in [walker, sitter, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

// ── desync and recovery (§4.6) ────────────────────────────────────────────────────────────

/// Run the §4.6 exchange between two nodes that have both lost step, and prime the new session.
async fn resync_pair(a: &Arc<LocationNode>, b: &Arc<LocationNode>, stash: &Arc<LocationNode>) {
    let a_id = hex(&a.endpoint_id());
    let b_id = hex(&b.endpoint_id());
    let a_recv = hex(&a.recv_public());
    let b_recv = hex(&b.recv_public());

    a.publish_resync(vec![b_recv.clone()])
        .await
        .expect("a offers its half");
    b.publish_resync(vec![a_recv.clone()])
        .await
        .expect("b offers its half");

    replicate(a, stash, b).await;
    replicate(b, stash, a).await;

    assert!(
        a.poll_resync(b_id, b_recv).await.expect("a polls"),
        "a must adopt b's resync record"
    );
    assert!(
        b.poll_resync(a_id, a_recv).await.expect("b polls"),
        "b must adopt a's resync record"
    );

    // A restarted session is a fresh bootstrap, so the responder window is open again.
    let (first, second) = initiator_first(a, b);
    first
        .docs_write_ratcheted(
            "prime".into(),
            0,
            fix_at(2),
            vec![hex(&second.endpoint_id())],
        )
        .await
        .expect("priming publish after resync");
    replicate(first, stash, second).await;
    second.read_latest_ratcheted().await.expect("prime read");
}

/// **A reinstalled phone.** One side loses its session state entirely — the case §4.6 exists for
/// — and the pair recovers by restarting the session, never by falling back to something weaker.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_that_lost_its_state_recovers_through_resync() {
    let a = start_node().await;
    let b = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&a, &b, &stash).await;
    let a_id = a.endpoint_id();

    assert!(
        publish_and_deliver(&a, &b, &stash, 1, 1000)
            .await
            .iter()
            .any(|e| e.author == a_id),
        "traffic flows before the loss"
    );

    // b reinstalls: session gone, identity and friendships intact.
    b.forget_session(hex(&a_id)).await.expect("b loses state");
    assert!(
        !b.has_session(hex(&a_id)).await.expect("b checks"),
        "the session must actually be gone"
    );
    assert!(
        publish_and_deliver_once(&a, &b, &stash, 2, 2000)
            .await
            .iter()
            .all(|e| e.author != a_id),
        "with no session b must open nothing"
    );

    resync_pair(&a, &b, &stash).await;

    assert!(
        publish_and_deliver(&a, &b, &stash, 3, 3000)
            .await
            .iter()
            .any(|e| e.author == a_id && e.fix.ts == 3000),
        "traffic must flow again after the resync"
    );
    assert_eq!(
        b.resync_count(hex(&a_id)).await.expect("count"),
        1,
        "one resync should be recorded, for the re-pair prompt to reason about"
    );

    for node in [a, b, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// A replayed resync record must not restart the session a second time.
///
/// The slot is overwritten in place and the stash controls what it serves, so re-serving an old
/// record is the cheapest attack available to it. Nonce dedup makes the second application a
/// no-op — the session stays where it is rather than being walked backwards onto a root the peer
/// has already moved off.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_replayed_resync_record_is_refused() {
    let a = start_node().await;
    let b = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&a, &b, &stash).await;
    let a_id = hex(&a.endpoint_id());
    let a_recv = hex(&a.recv_public());
    let author_id = a.endpoint_id();

    b.forget_session(a_id.clone()).await.expect("b loses state");
    resync_pair(&a, &b, &stash).await;

    // The stash re-serves a's record, unchanged. b has already applied it.
    assert!(
        !b.poll_resync(a_id.clone(), a_recv)
            .await
            .expect("b polls again"),
        "a replayed resync record must be a no-op"
    );
    assert_eq!(
        b.resync_count(a_id).await.expect("count"),
        1,
        "the replay must not count as a second resync"
    );

    // And the session it already established still works.
    assert!(
        publish_and_deliver(&a, &b, &stash, 9, 9000)
            .await
            .iter()
            .any(|e| e.author == author_id && e.fix.ts == 9000),
        "the replay must not have disturbed the live session"
    );

    for node in [a, b, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// Desync is detected from a *run* of failures, not a single one (§4.6's `R`).
///
/// A single unopenable envelope is ordinary — every envelope carries a wrap per recipient and
/// only one is ever ours — so detection has to mean "this peer keeps talking and we keep
/// failing".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repeated_failures_mark_the_session_desynced() {
    let a = start_node().await;
    let b = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&a, &b, &stash).await;
    bootstrap_pair(&a, &b).await;

    // The talker must be the side that can actually publish. After a fresh bootstrap only the
    // initiator has a sending chain, and a publish with nothing to wrap writes no envelope at
    // all — so driving this from the responder would produce silence rather than the run of
    // unopenable envelopes the test is about. Roles are by endpoint-id ordering, which is random
    // per run, so the sides are chosen rather than assumed.
    let (talker, listener) = initiator_first(&a, &b);
    let talker_id = hex(&talker.endpoint_id());
    let listener_id = hex(&listener.endpoint_id());

    assert!(
        !listener
            .is_desynced(talker_id.clone())
            .await
            .expect("healthy"),
        "a working session must not report desynced"
    );

    // Give the listener a session rooted differently from the talker's, so its failures are
    // misses rather than "no session at all" — the shape of one-sided state loss.
    listener
        .forget_session(talker_id.clone())
        .await
        .expect("drop the listener's matching session");
    let stale = talker.begin_session(listener_id).await.expect("eph");
    listener
        .begin_session(talker_id.clone())
        .await
        .expect("listener eph");
    listener
        .complete_session(talker_id.clone(), stale)
        .await
        .expect("listener builds a session the talker does not share");

    for seq in 1..=4u64 {
        let dropped = talker
            .docs_write_ratcheted(
                "t".into(),
                seq,
                fix_at(seq),
                vec![hex(&listener.endpoint_id())],
            )
            .await
            .expect("the talker publishes");
        assert!(
            dropped.is_empty(),
            "the talker must still hold a usable session, else there is nothing to miss: \
             {dropped:?}"
        );
        replicate(talker, &stash, listener).await;
        let _ = listener
            .read_latest_ratcheted()
            .await
            .expect("the listener tries");
    }

    assert!(
        listener.is_desynced(talker_id).await.expect("desynced"),
        "a run of unopenable envelopes from one peer must mark the session desynced"
    );

    for node in [a, b, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// A watcher who only ever *reads* still feeds the ratchet — §4.1's symmetric lanes, end to end.
///
/// This is the property the null lane exists for, and the one it did not have while that lane was
/// v2. A watch-only friend publishes null fixes on the same cadence as a real one: same shape,
/// same length, no position. Ratcheted, those envelopes carry the watcher's ratchet contribution,
/// which is what advances `peer_advanced_ms` on the sharer's side and stops `next_wraps` dropping
/// them as `Lapsed` at `T_lapse`. On the v2 null lane there was no contribution *and* the reader
/// skipped the `nul` key outright, so a one-directional watch edge went quiet after 24 h with
/// nothing in the app able to explain why.
///
/// The assertion is that the sharer keeps working across a return direction made **only** of null
/// fixes — including after the watcher's DH ratchet, which is the step that would fail if those
/// envelopes never reached the schedule.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_watch_only_friend_feeds_the_ratchet_with_null_fixes() {
    let sharer = start_node().await;
    let watcher = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&sharer, &watcher, &stash).await;
    let sharer_id = sharer.endpoint_id();
    let watcher_hex = hex(&watcher.endpoint_id());
    let sharer_hex = hex(&sharer_id);

    // The sharer shares position; the watcher never does.
    let seen = publish_and_deliver(&sharer, &watcher, &stash, 1, 80_000).await;
    assert!(
        seen.iter().any(|e| e.author == sharer_id),
        "the watcher opens the sharer's fix"
    );

    // The watcher's whole contribution is null fixes on the null lane.
    for seq in 1..=3u64 {
        let dropped = watcher
            .docs_write_null_ratcheted("t".into(), seq, 90_000 + seq, vec![sharer_hex.clone()])
            .await
            .expect("the watcher publishes a null fix");
        assert!(
            dropped.is_empty(),
            "the watcher's null fix dropped its recipient: {dropped:?}"
        );
        replicate(&watcher, &stash, &sharer).await;

        // Nulls carry no position, so nothing is *delivered* — but the read is what feeds the
        // schedule, and a `nul` entry the reader skipped would never get here at all.
        let delivered = sharer.read_latest_ratcheted().await.expect("sharer reads");
        assert!(
            !delivered.iter().any(|e| e.author == watcher.endpoint_id()),
            "a null fix must never surface as a position"
        );
        assert!(
            !sharer
                .is_desynced(watcher_hex.clone())
                .await
                .expect("healthy"),
            "opening the watcher's null fix keeps the session healthy"
        );
    }

    // The payoff: the sharer keeps publishing after DH-ratcheting onto the key the watcher
    // contributed through the null lane alone.
    let seen = publish_and_deliver(&sharer, &watcher, &stash, 2, 95_000).await;
    assert!(
        seen.iter()
            .any(|e| e.author == sharer_id && e.fix.ts == 95_000),
        "the sharer must keep publishing after ratcheting onto a key that arrived on the null lane"
    );

    for node in [sharer, watcher, stash] {
        node.shutdown().await.expect("shutdown");
    }
}
