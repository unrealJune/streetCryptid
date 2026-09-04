//! **End-to-end** Double Ratchet tests: two real `LocationNode`s, the real iroh transport, the
//! real durable docs path, and a third node standing in for the trail stash.
//!
//! `tests/ratchet.rs` proves the schedule in isolation and `crypto.rs`'s unit tests prove the v3
//! wrap in isolation. Neither can tell you that a fix sealed on one device is readable on
//! another after crossing iroh-docs replication, which is the claim that actually matters — and
//! which is where session lookup, persistence, and the wire format have to agree with each other
//! rather than merely with their own tests.
//!
//! What is real here: two endpoints, QUIC over loopback direct addresses, document reconciliation
//! through an intermediary that holds only ciphertext, and ratchet state going to disk and back
//! between every publish. What is injected: nothing — `RK₀` is derived by the nodes themselves
//! from an ephemeral exchange (FORWARD-SECRECY.md §4.6). What is *missing* until step 7 is that
//! the exchange is not yet carried and identity-signed over the pairing connection, so these
//! tests hand the two ephemerals across directly.

use std::sync::Arc;

use iroh_location::{LocationFix, LocationNode};

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

/// The §4.6 bootstrap, with the two halves handed across in-process.
///
/// Both sides mint an ephemeral, then each completes with the other's public half. Neither is
/// told which role to take: `initiator_by_endpoint` decides it from the endpoint ids, so this
/// exercises the same ordering rule two phones would.
async fn bootstrap_pair(a: &Arc<LocationNode>, b: &Arc<LocationNode>) {
    let a_id = hex(&a.endpoint_id());
    let b_id = hex(&b.endpoint_id());

    let a_eph = a.begin_session(b_id.clone()).await.expect("a ephemeral");
    let b_eph = b.begin_session(a_id.clone()).await.expect("b ephemeral");

    a.complete_session(b_id, b_eph).await.expect("a completes");
    b.complete_session(a_id, a_eph).await.expect("b completes");
}

fn fix_at(ts: u64) -> LocationFix {
    LocationFix {
        lat: 47.6062,
        lon: -122.3321,
        accuracy_m: 4.0,
        heading_deg: 90.0,
        ts,
        motion: None,
        motion_since_ms: None,
    }
}

/// Replicate `author`'s namespace to `reader` through `stash`, exactly as an offline phone
/// recovers a friend's fix: the stash pulls from the author, the reader pulls from the stash.
async fn replicate(
    author: &Arc<LocationNode>,
    stash: &Arc<LocationNode>,
    reader: &Arc<LocationNode>,
) {
    let ticket = author.doc_ticket().await.expect("author trail ticket");
    stash
        .import_doc_ticket(ticket.clone())
        .await
        .expect("stash imports author trail");
    stash
        .sync_latest(
            vec![author.ticket().await.expect("author endpoint ticket")],
            None,
        )
        .await
        .expect("stash reconciles with author");
    reader
        .import_doc_ticket(ticket)
        .await
        .expect("reader imports friend trail");
    reader
        .sync_latest(
            vec![stash.ticket().await.expect("stash endpoint ticket")],
            None,
        )
        .await
        .expect("reader reconciles with stash");
}

/// Bootstrap, then bring the pair to a state where **either** side can publish.
///
/// Standard Double Ratchet gives the responder no sending chain until the initiator's first
/// envelope arrives, and `initiator_by_endpoint` assigns that role by endpoint-id ordering — so
/// with two randomly generated identities, which node can publish first is a coin flip. In
/// production the window closes on its own within one cadence interval, because symmetric lanes
/// (§4.1) mean the initiator publishes whether or not it shares position. A test should not be
/// flaky on a key comparison, so this drives that first envelope explicitly.
///
/// `responder_window_blocks_the_responder_until_the_initiator_speaks` pins the underlying
/// behaviour, so priming here hides nothing.
async fn bootstrap_and_prime(
    a: &Arc<LocationNode>,
    b: &Arc<LocationNode>,
    stash: &Arc<LocationNode>,
) {
    bootstrap_pair(a, b).await;
    let (first, second) = if a.endpoint_id() < b.endpoint_id() {
        (a, b)
    } else {
        (b, a)
    };
    first
        .docs_write_ratcheted(
            "prime".into(),
            0,
            fix_at(1),
            vec![hex(&second.endpoint_id())],
        )
        .await
        .expect("initiator's priming publish");
    replicate(first, stash, second).await;
    second
        .read_latest_ratcheted()
        .await
        .expect("responder accepts the initiator's first envelope");
}

/// The bootstrap asymmetry, stated as a test rather than left as a surprise: fresh out of the
/// bump the responder cannot publish, and the initiator's first envelope is what unblocks it.
///
/// This is why the null-fix lane (§4.1) has to carry ratchet headers too — a watcher edge whose
/// initiator never publishes a *position* still needs to publish *something*, or the responder
/// half of that pair stays mute.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn responder_window_blocks_the_responder_until_the_initiator_speaks() {
    let a = start_node().await;
    let b = start_node().await;
    let stash = start_node().await;

    bootstrap_pair(&a, &b).await;
    let (initiator, responder) = if a.endpoint_id() < b.endpoint_id() {
        (&a, &b)
    } else {
        (&b, &a)
    };

    // The responder has a session but no sending chain.
    let dropped = responder
        .docs_write_ratcheted(
            "test".into(),
            1,
            fix_at(1000),
            vec![hex(&initiator.endpoint_id())],
        )
        .await
        .expect("publish returns rather than failing");
    assert_eq!(
        dropped,
        vec![format!(
            "{}:no_sending_chain",
            hex(&initiator.endpoint_id())
        )],
        "a responder before the initiator's first envelope must be dropped, not published to"
    );

    // The initiator speaks; the responder's DH ratchet gives it a sending chain.
    initiator
        .docs_write_ratcheted(
            "test".into(),
            1,
            fix_at(2000),
            vec![hex(&responder.endpoint_id())],
        )
        .await
        .expect("initiator publishes");
    replicate(initiator, &stash, responder).await;
    responder
        .read_latest_ratcheted()
        .await
        .expect("responder reads");

    let dropped = responder
        .docs_write_ratcheted(
            "test".into(),
            2,
            fix_at(3000),
            vec![hex(&initiator.endpoint_id())],
        )
        .await
        .expect("responder publishes");
    assert!(
        dropped.is_empty(),
        "the responder must be able to publish once the initiator has spoken: {dropped:?}"
    );

    for node in [a, b, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// The headline claim: a ratcheted fix survives the durable path to the friend it was sealed
/// for, and the stash that carried it cannot read a byte of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ratcheted_fix_crosses_the_durable_path_and_the_stash_stays_blind() {
    let author = start_node().await;
    let friend = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&author, &friend, &stash).await;
    let author_id = author.endpoint_id();
    let friend_id = hex(&friend.endpoint_id());

    let dropped = author
        .docs_write_ratcheted("test".into(), 1, fix_at(1234), vec![friend_id])
        .await
        .expect("author seals a ratcheted fix");
    assert!(
        dropped.is_empty(),
        "no recipient should have been dropped: {dropped:?}"
    );

    replicate(&author, &stash, &friend).await;

    // The stash replicated it and has no session with anyone.
    assert!(
        stash
            .read_latest_ratcheted()
            .await
            .expect("stash reads")
            .is_empty(),
        "the stash must not be able to open a ratcheted envelope"
    );
    // Nor can the pre-ratchet path help it: v2 `open` refuses a v3 envelope outright.
    assert!(
        stash
            .read_latest()
            .await
            .expect("stash reads v2")
            .is_empty(),
        "the stash must not open a v3 envelope through the v2 path either"
    );

    let recovered = friend
        .read_latest_ratcheted()
        .await
        .expect("friend reads the ratcheted trail");
    let entry = recovered
        .iter()
        .find(|e| e.author == author_id)
        .expect("friend must recover the author's ratcheted fix");
    assert_eq!(entry.seq, 1);
    assert_eq!(entry.fix.ts, 1234);
    assert!((entry.fix.lat - 47.6062).abs() < 1e-9);

    for node in [author, friend, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// Both directions across a DH ratchet, over the real transport. The reply carries a ratchet key
/// the first sender has never seen, which is the case wrap lookup needs its trial derivation for.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn both_directions_ratchet_over_the_wire() {
    let a = start_node().await;
    let b = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&a, &b, &stash).await;
    let a_id = a.endpoint_id();
    let b_id = b.endpoint_id();

    a.docs_write_ratcheted("test".into(), 1, fix_at(1000), vec![hex(&b_id)])
        .await
        .expect("a publishes");
    replicate(&a, &stash, &b).await;
    assert!(
        b.read_latest_ratcheted()
            .await
            .expect("b reads")
            .iter()
            .any(|e| e.author == a_id && e.fix.ts == 1000),
        "b must open a's fix"
    );

    // b only has a sending chain now that a's first envelope performed its DH ratchet.
    b.docs_write_ratcheted("test".into(), 1, fix_at(2000), vec![hex(&a_id)])
        .await
        .expect("b publishes");
    replicate(&b, &stash, &a).await;
    assert!(
        a.read_latest_ratcheted()
            .await
            .expect("a reads")
            .iter()
            .any(|e| e.author == b_id && e.fix.ts == 2000),
        "a must open b's reply across the DH ratchet"
    );

    for node in [a, b, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// Revocation, unchanged by the ratchet: a friend who is not in the wrap set gets nothing, even
/// though they replicate the same bytes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_recipient_outside_the_wrap_set_reads_nothing() {
    let author = start_node().await;
    let shared_with = start_node().await;
    let revoked = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&author, &shared_with, &stash).await;
    bootstrap_and_prime(&author, &revoked, &stash).await;

    author
        .docs_write_ratcheted(
            "test".into(),
            1,
            fix_at(1234),
            vec![hex(&shared_with.endpoint_id())],
        )
        .await
        .expect("author publishes to one friend only");

    replicate(&author, &stash, &shared_with).await;
    replicate(&author, &stash, &revoked).await;

    assert!(
        !shared_with
            .read_latest_ratcheted()
            .await
            .expect("friend reads")
            .is_empty(),
        "the wrapped friend must read the fix"
    );
    assert!(
        revoked
            .read_latest_ratcheted()
            .await
            .expect("revoked reads")
            .is_empty(),
        "a friend outside the wrap set must read nothing, session or no session"
    );

    for node in [author, shared_with, revoked, stash] {
        node.shutdown().await.expect("shutdown");
    }
}

/// A recipient with no session is reported, not silently omitted. §4.2 makes silence the enemy:
/// a short wrap list that nobody notices is a friend who quietly stops receiving.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unbootstrapped_recipient_is_reported_as_dropped() {
    let author = start_node().await;
    let stranger = start_node().await;

    let stranger_id = hex(&stranger.endpoint_id());
    let dropped = author
        .docs_write_ratcheted("test".into(), 1, fix_at(1234), vec![stranger_id.clone()])
        .await
        .expect("publish still succeeds for the others");

    assert_eq!(dropped, vec![format!("{stranger_id}:no_session")]);

    for node in [author, stranger] {
        node.shutdown().await.expect("shutdown");
    }
}

/// Ratchet state must survive the trip to disk: the session store is the only thing between two
/// publishes, so a state that did not round-trip would show up as a second publish the friend
/// cannot open.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sessions_persist_across_publishes() {
    let author = start_node().await;
    let friend = start_node().await;
    let stash = start_node().await;

    bootstrap_and_prime(&author, &friend, &stash).await;
    let author_id = author.endpoint_id();
    let friend_id = hex(&friend.endpoint_id());

    for seq in 1..=3u64 {
        let dropped = author
            .docs_write_ratcheted(
                "test".into(),
                seq,
                fix_at(1000 + seq),
                vec![friend_id.clone()],
            )
            .await
            .expect("author publishes");
        assert!(
            dropped.is_empty(),
            "publish {seq} dropped recipients: {dropped:?}"
        );
        replicate(&author, &stash, &friend).await;

        let recovered = friend.read_latest_ratcheted().await.expect("friend reads");
        assert!(
            recovered
                .iter()
                .any(|e| e.author == author_id && e.fix.ts == 1000 + seq),
            "friend must open publish {seq}; state did not survive the round trip"
        );
    }

    for node in [author, friend, stash] {
        node.shutdown().await.expect("shutdown");
    }
}
