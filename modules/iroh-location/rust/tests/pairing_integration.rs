//! In-process two-node pairing + profile-propagation integration test over the normal iroh
//! transport (loopback direct addresses carried in the endpoint ticket; **no BLE hardware
//! required**). This is the end-to-end companion to the pure unit tests in `pairing.rs` /
//! `profile.rs`.
//!
//! It exercises the bilateral-consent happy path: invite → dial → `Hello` exchange → both sides
//! `Accept` → `Ready` on both → a verified [`PairResult`] binding each peer's endpoint id + recv
//! key, then initial profile sync and profile-**update** propagation over the dedicated profile
//! docs namespace.

use std::sync::Arc;

use iroh_location::{LocationNode, PairEventKind, PairState};

const SIGIL: &str = "/\\_/\\\n(o.o)";

async fn start_node() -> Arc<LocationNode> {
    let node = LocationNode::new(None, None).expect("construct node");
    node.start(vec!["https://127.0.0.1:1".into()], "test-token".into())
        .await
        .expect("start node");
    node
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

    // Both sides consent. A accepts first (records local decision + notifies B); then B accepts,
    // which drives both sessions to completion.
    a.respond_pair(sid.clone(), true).await.expect("A accept");
    b.respond_pair(sid.clone(), true).await.expect("B accept");

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
