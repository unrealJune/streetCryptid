//! In-process two-node pairing + profile-propagation integration test over the normal iroh
//! transport (loopback direct addresses carried in the endpoint ticket; **no BLE hardware
//! required**). This is the end-to-end companion to the pure unit tests in `pairing.rs` /
//! `profile.rs`.
//!
//! It exercises the bilateral-consent happy path: invite → dial → `Hello`/`Reveal` (SAS
//! commit-then-reveal) exchange → both sides clear the **mandatory visual SAS gate** (the
//! displayer confirms the match; the picker selects the target figure) → both sides `Accept` →
//! `Ready` on both → a verified [`PairResult`] binding each peer's endpoint id + recv key, then
//! initial profile sync and profile-**update** propagation over the dedicated profile docs
//! namespace. It also covers the negative paths that the SAS gate must enforce: no `PairResult`
//! before SAS confirmation (premature `respond_pair(true)` is rejected), and an SAS mismatch or
//! cancel never completes.

use std::sync::Arc;

use iroh_location::{LocationNode, PairEventKind, PairState, SasRoleKind};

const SIGIL: &str = "/\\_/\\\n(o.o)";

async fn start_node() -> Arc<LocationNode> {
    let node = LocationNode::new(None, None).expect("construct node");
    node.start(vec!["https://127.0.0.1:1".into()], "test-token".into())
        .await
        .expect("start node");
    node
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_stash_peer_reconciles_an_imported_friend_trail() {
    let author = start_node().await;
    let stash = start_node().await;
    let phone = start_node().await;

    let author_id = author.endpoint_id();
    let fix = iroh_location::LocationFix {
        lat: 47.6062,
        lon: -122.3321,
        accuracy_m: 4.0,
        heading_deg: 90.0,
        ts: 1234,
    };
    author
        .docs_write(
            "test".into(),
            1,
            0,
            fix,
            vec![phone.recv_public()],
        )
        .await
        .expect("author writes encrypted trail fix");
    let trail_ticket = author.doc_ticket().await.expect("author trail ticket");

    stash
        .import_doc_ticket(trail_ticket.clone())
        .await
        .expect("stash imports author trail");
    stash
        .sync_trail(0, Some(author.ticket().await.expect("author endpoint ticket")))
        .await
        .expect("stash explicitly reconciles with author");
    assert!(
        !stash
            .read_trail(author_id.clone(), 0)
            .await
            .expect("stash reads opaque trail")
            .iter()
            .any(|entry| entry.seq == 1),
        "stash must remain unable to decrypt the replicated fix"
    );
    author.shutdown().await.expect("author goes offline");

    phone
        .import_doc_ticket(trail_ticket)
        .await
        .expect("phone imports friend trail");
    phone
        .sync_trail(0, Some(stash.ticket().await.expect("stash endpoint ticket")))
        .await
        .expect("phone explicitly reconciles with stash");

    let recovered = phone
        .read_trail(author_id, 0)
        .await
        .expect("phone reads recovered friend trail");
    assert!(
        recovered.iter().any(|entry| entry.seq == 1),
        "phone must recover the friend's fix from the stash while the author is offline"
    );

    phone.shutdown().await.expect("phone shutdown");
    stash.shutdown().await.expect("stash shutdown");
}

/// Poll an `Option`-returning async expression until it is `Some`, or panic after `$secs`.
macro_rules! poll_until {
    ($secs:expr, $body:block) => {{
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs($secs);
        loop {
            if let Some(v) = $body {
                break v;
            }
            if std::time::Instant::now() >= deadline {
                panic!("condition not met within {}s", $secs);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }};
}

/// Wait until `node`'s session reaches the `Verifying` SAS phase (peer reveal verified), then
/// return its SAS challenge.
async fn await_challenge(node: &Arc<LocationNode>, sid: &[u8]) -> iroh_location::SasChallenge {
    poll_until!(20, {
        node.pair_sas_challenge(sid.to_vec())
            .await
            .expect("pair_sas_challenge")
    })
}

/// Clear the SAS visual gate for one side by performing the correct human action for its role:
/// the displayer confirms the match, the picker selects the target figure. Both actions latch the
/// local SAS and send `Accept`.
async fn clear_sas_gate(node: &Arc<LocationNode>, sid: &[u8]) {
    let ch = await_challenge(node, sid).await;
    match ch.role {
        SasRoleKind::Displayer => node
            .confirm_pair_display(sid.to_vec(), true)
            .await
            .expect("displayer confirm match"),
        SasRoleKind::Picker => node
            .submit_pair_choice(sid.to_vec(), ch.target_index)
            .await
            .expect("picker submit target"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_node_pair_and_profile_sync() {
    let a = start_node().await;
    let b = start_node().await;
    let a_id = a.endpoint_id();
    let b_id = b.endpoint_id();

    // Each side publishes an initial profile into its dedicated profile namespace.
    a.publish_profile(
        "alice".into(),
        "Alpha Sighting".into(),
        SIGIL.into(),
        "#11aa33".into(),
    )
    .await
    .expect("A publish profile");
    b.publish_profile(
        "bob".into(),
        "Beta Sighting".into(),
        SIGIL.into(),
        "#3311aa".into(),
    )
    .await
    .expect("B publish profile");

    // B pairs with A using A's out-of-band invite (B dials A; Hello is exchanged in-band).
    let invite = a.create_invite(300).await.expect("A create invite");
    let sid = b.initiate_pair(invite).await.expect("B initiate pair");

    // A observes a pending request for the same (invite-derived) session id.
    let a_pending = poll_until!(20, {
        a.poll_pair_events()
            .await
            .into_iter()
            .find(|e| matches!(e.kind, PairEventKind::PendingRequest) && e.session_id == sid)
    });
    assert_eq!(
        a_pending.peer_endpoint_id, b_id,
        "A's pending request is from B"
    );

    // Premature acceptance must be impossible: before either side clears the SAS gate, an accept
    // is rejected outright and no `PairResult` is produced.
    assert!(
        a.respond_pair(sid.clone(), true).await.is_err(),
        "A cannot accept before its SAS visual check is confirmed"
    );
    assert!(
        a.pair_result(sid.clone())
            .await
            .expect("A pair_result")
            .is_none(),
        "no PairResult before SAS"
    );

    // Both sides clear the mandatory visual SAS gate. Each performs the correct action for its
    // transcript-derived role (displayer confirms; picker selects the target), which latches the
    // local SAS and sends `Accept`, driving both sessions to completion.
    clear_sas_gate(&a, &sid).await;
    clear_sas_gate(&b, &sid).await;

    // Both sides reach Complete and emit a `Ready` event.
    for (label, node) in [("A", &a), ("B", &b)] {
        poll_until!(20, {
            match node.pair_state(sid.clone()).await.expect("pair_state") {
                Some(st) if matches!(st.state, PairState::Complete) => Some(()),
                _ => None,
            }
        });
        let ready = poll_until!(20, {
            node.poll_pair_events()
                .await
                .into_iter()
                .find(|e| matches!(e.kind, PairEventKind::Ready) && e.session_id == sid)
        });
        assert_eq!(
            ready.session_id, sid,
            "{label} emitted Ready for the session"
        );
    }

    // Each side exposes a verified PairResult binding the peer's endpoint id + recv key + tickets.
    let a_res = poll_until!(20, {
        a.pair_result(sid.clone()).await.expect("A pair_result")
    });
    let b_res = poll_until!(20, {
        b.pair_result(sid.clone()).await.expect("B pair_result")
    });
    assert_eq!(a_res.peer_endpoint_id, b_id);
    assert_eq!(a_res.peer_recv_pub, b.recv_public());
    assert_eq!(b_res.peer_endpoint_id, a_id);
    assert_eq!(b_res.peer_recv_pub, a.recv_public());
    assert!(
        !a_res.peer_profile_ticket.is_empty(),
        "A got B's profile ticket"
    );
    assert!(
        !a_res.peer_trail_ticket.is_empty(),
        "A got B's trail ticket"
    );
    assert!(
        !b_res.peer_profile_ticket.is_empty(),
        "B got A's profile ticket"
    );

    // Initial profile sync: each side eventually reads the other's verified profile over the
    // profile namespace imported during pair completion.
    let a_sees_b = poll_until!(30, {
        a.read_profile(b_id.clone()).await.expect("A read B")
    });
    assert_eq!(a_sees_b.handle, "bob");
    assert_eq!(a_sees_b.endpoint_id, b_id);

    let b_sees_a = poll_until!(30, {
        b.read_profile(a_id.clone()).await.expect("B read A")
    });
    assert_eq!(b_sees_a.handle, "alice");
    let first_epoch = b_sees_a.epoch;

    // Update propagation: A publishes a newer profile; B eventually observes the strictly-newer
    // epoch both via a live-sync event and via a fresh read.
    a.publish_profile(
        "alicexo".into(),
        "Alpha Sighting".into(),
        SIGIL.into(),
        "#11aa33".into(),
    )
    .await
    .expect("A update profile");

    let evt = poll_until!(30, {
        b.poll_profile_events()
            .await
            .into_iter()
            .find(|p| p.handle == "alicexo" && p.epoch > first_epoch)
    });
    assert_eq!(evt.endpoint_id, a_id, "update event is for A");

    let b_sees_update = poll_until!(30, {
        match b.read_profile(a_id.clone()).await.expect("B read A update") {
            Some(p) if p.handle == "alicexo" && p.epoch > first_epoch => Some(p),
            _ => None,
        }
    });
    assert!(
        b_sees_update.epoch > first_epoch,
        "epoch advanced on update"
    );
}

/// Bring two fresh nodes to an invite-based pair that has cleared the SAS commit-then-reveal
/// handshake (both sides in `Verifying` with a live challenge). Returns `(initiator, responder,
/// session_id)` where `b` initiated against `a`'s invite.
async fn pair_to_verifying() -> (Arc<LocationNode>, Arc<LocationNode>, Vec<u8>) {
    let a = start_node().await;
    let b = start_node().await;

    let invite = a.create_invite(300).await.expect("A create invite");
    let sid = b.initiate_pair(invite).await.expect("B initiate pair");

    // Drive A's inbound queue so it processes the Hello/Reveal handshake.
    let _ = poll_until!(20, {
        a.poll_pair_events()
            .await
            .into_iter()
            .find(|e| matches!(e.kind, PairEventKind::PendingRequest) && e.session_id == sid)
    });

    // Both sides must reach the SAS gate before any human action is possible.
    await_challenge(&a, &sid).await;
    await_challenge(&b, &sid).await;
    (a, b, sid)
}

/// An SAS mismatch (the picker selects a wrong figure) is terminal: the session fails and no
/// `PairResult` is ever produced on either side.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sas_mismatch_never_completes() {
    let (a, b, sid) = pair_to_verifying().await;

    // Find whichever side is the picker and feed it a wrong (but in-catalog) option.
    let mut acted = false;
    for node in [&a, &b] {
        let ch = node
            .pair_sas_challenge(sid.clone())
            .await
            .expect("challenge")
            .expect("live challenge");
        if matches!(ch.role, SasRoleKind::Picker) {
            let wrong = ch
                .option_indices
                .iter()
                .copied()
                .find(|&i| i != ch.target_index)
                .expect("a non-target option exists");
            node.submit_pair_choice(sid.clone(), wrong)
                .await
                .expect("submit wrong choice (call succeeds, gate fails)");
            acted = true;
            break;
        }
    }
    assert!(acted, "one side was the picker");

    // The picker's own session is terminally Failed and exposes no result.
    poll_until!(10, {
        match a.pair_state(sid.clone()).await.expect("A state") {
            Some(st) if matches!(st.state, PairState::Failed | PairState::Rejected) => Some(()),
            _ => match b.pair_state(sid.clone()).await.expect("B state") {
                Some(st) if matches!(st.state, PairState::Failed | PairState::Rejected) => Some(()),
                _ => None,
            },
        }
    });

    // Give the reject a moment to propagate, then assert neither side ever completes.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert!(
        a.pair_result(sid.clone())
            .await
            .expect("A result")
            .is_none(),
        "A must not have a PairResult after SAS mismatch"
    );
    assert!(
        b.pair_result(sid.clone())
            .await
            .expect("B result")
            .is_none(),
        "B must not have a PairResult after SAS mismatch"
    );
    for node in [&a, &b] {
        assert!(
            !matches!(
                node.pair_state(sid.clone()).await.expect("state"),
                Some(st) if matches!(st.state, PairState::Complete)
            ),
            "no side reaches Complete after SAS mismatch"
        );
    }
}

/// Cancelling under verification is terminal: no `PairResult` is produced on either side.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sas_cancel_never_completes() {
    let (a, b, sid) = pair_to_verifying().await;

    // A cancels while both sides are still at the SAS gate.
    a.cancel_pair(sid.clone()).await.expect("A cancel");

    poll_until!(10, {
        match a.pair_state(sid.clone()).await.expect("A state") {
            Some(st) if matches!(st.state, PairState::Failed | PairState::Rejected) => Some(()),
            _ => None,
        }
    });

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert!(
        a.pair_result(sid.clone())
            .await
            .expect("A result")
            .is_none(),
        "A must not have a PairResult after cancel"
    );
    assert!(
        b.pair_result(sid.clone())
            .await
            .expect("B result")
            .is_none(),
        "B must not have a PairResult after cancel"
    );
}
