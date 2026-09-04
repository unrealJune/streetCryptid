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

/// Poll an `Option`-returning async expression until it is `Some`, or panic after `$secs`.
///
/// Declared here rather than beside its other users below: `macro_rules!` resolution is textual,
/// so a test above this point cannot see it.
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
        motion: None,
    };
    author
        .docs_write("test".into(), 1, fix, vec![phone.recv_public()])
        .await
        .expect("author writes encrypted trail fix");
    let trail_ticket = author.doc_ticket().await.expect("author trail ticket");

    stash
        .import_doc_ticket(trail_ticket.clone())
        .await
        .expect("stash imports author trail");
    stash
        .sync_latest(
            vec![author.ticket().await.expect("author endpoint ticket")],
            None,
        )
        .await
        .expect("stash explicitly reconciles with author");
    assert!(
        !stash
            .read_latest()
            .await
            .expect("stash reads opaque trail")
            .iter()
            .any(|entry| entry.author == author_id && entry.seq == 1),
        "stash must remain unable to decrypt the replicated fix"
    );
    author.shutdown().await.expect("author goes offline");

    phone
        .import_doc_ticket(trail_ticket)
        .await
        .expect("phone imports friend trail");
    phone
        .sync_latest(
            vec![stash.ticket().await.expect("stash endpoint ticket")],
            None,
        )
        .await
        .expect("phone explicitly reconciles with stash");

    let recovered = phone
        .read_latest()
        .await
        .expect("phone reads recovered friend trail");
    assert!(
        recovered
            .iter()
            .any(|entry| entry.author == author_id && entry.seq == 1),
        "phone must recover the friend's fix from the stash while the author is offline"
    );

    phone.shutdown().await.expect("phone shutdown");
    stash.shutdown().await.expect("stash shutdown");
}

/// A POOL MEMBER — not the author, and not the stash — serves an absent author's fix.
///
/// This is ARCHITECTURE.md §1.3/§6 stated as a test: "a rejoining B runs range-based
/// reconciliation against C/D/A". `relay` here is an ordinary peer holding nothing but a READ
/// ticket for the author's namespace, exactly like any friend in a sharing pool; the author is
/// shut down before the late device ever asks. Nothing in the recovery path touches the stash.
///
/// Two things this pins down, both of which were broken or unproven when it was written:
///
///  * `sync_latest` takes a LIST of peers. It used to take a single `Option<String>` that only
///    ever carried the trail stash, so a device could recover from the author or from the durable
///    server and from nobody else — which is strictly narrower than the design, and left a device
///    unable to obtain a fix that a friend beside it was demonstrably holding.
///  * A relay can only serve what is in its REPLICA. A fix that reaches it over live gossip lands
///    in app storage, not in the author's namespace (a friend holds a read ticket and cannot write
///    there), so the relay must have reconciled with the author at least once. That is why this
///    test syncs `relay` against the author before taking the author away, and it is the same
///    precondition scripts/e2e/relay-e2e.sh has to arrange on real devices.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pool_member_serves_an_absent_authors_fix() {
    let author = start_node().await;
    let relay = start_node().await;
    let late = start_node().await;

    let author_id = author.endpoint_id();
    let fix = iroh_location::LocationFix {
        lat: 47.6205,
        lon: -122.3493,
        accuracy_m: 5.0,
        heading_deg: 12.0,
        ts: 9_876,
        motion: None,
    };
    // Sealed for BOTH friends: the late device must be able to decrypt what the relay hands on,
    // which is the whole point of the wrap set (§4.1).
    author
        .docs_write(
            "relay-case".into(),
            7,
            fix,
            vec![relay.recv_public(), late.recv_public()],
        )
        .await
        .expect("author writes an encrypted fix for both friends");
    let trail_ticket = author.doc_ticket().await.expect("author trail ticket");

    // The relay reconciles with the author while the author is still up — this is what puts the
    // entry in its replica and therefore what makes it relayable at all.
    relay
        .import_doc_ticket(trail_ticket.clone())
        .await
        .expect("relay imports the author's trail");
    relay
        .sync_latest(
            vec![author.ticket().await.expect("author endpoint ticket")],
            None,
        )
        .await
        .expect("relay reconciles with the author");

    author.shutdown().await.expect("author goes offline");

    // The relay's REPLICA, not its app storage: reconciliation serves out of the former, and only
    // this distinguishes "the relay had nothing to give" from "the transfer failed" if the
    // assertion below goes red.
    let servable = relay
        .trail_replica_status()
        .await
        .expect("relay reports its replica");
    assert!(
        servable
            .iter()
            .any(|slot| slot.author == author_id && slot.seq == 7 && slot.has_content),
        "the relay must hold the author's fix in its replica, with content, or it has nothing to \
         relay: {servable:?}"
    );

    // The late device asks the RELAY only. No stash, and the author is gone.
    late.import_doc_ticket(trail_ticket)
        .await
        .expect("late device imports the author's trail");
    late.sync_latest(
        vec![relay.ticket().await.expect("relay endpoint ticket")],
        None,
    )
    .await
    .expect("late device reconciles with the relay");

    let recovered = late
        .read_latest()
        .await
        .expect("late device reads its replica");
    assert!(
        recovered
            .iter()
            .any(|entry| entry.author == author_id && entry.seq == 7),
        "a pool member must be able to serve the author's fix once the author is offline"
    );

    late.shutdown().await.expect("late shutdown");
    relay.shutdown().await.expect("relay shutdown");
}

/// The same relay property, with the choreography removed — because the AUTHOR pushes to the pool.
///
/// The sibling above has to arrange a reconciliation window: the relay dials the author *after* the
/// fix exists, because otherwise nothing would ever put that fix in the relay's replica. That was a
/// real gap and not merely a test contrivance — `push_trail` addressed only the trail stash, so an
/// author's published fix was broadcast over docs to the durable server and to nobody else, and a
/// pool member could relay it only if it happened to reconcile with the author at the right moment.
/// On real devices that is a timing lottery, which is exactly what `scripts/e2e/relay-e2e.sh` kept
/// losing.
///
/// Here the relay opens the author's namespace **before** there is anything in it, the author
/// publishes with the relay in its push list, and the author never reconciles again. The fix lands
/// in the relay's replica as a consequence of being published, which is the invariant that makes
/// peer relay the normal flow rather than luck.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_published_fix_reaches_the_pool_without_a_reconciliation_window() {
    let author = start_node().await;
    let relay = start_node().await;
    let late = start_node().await;

    let author_id = author.endpoint_id();
    let trail_ticket = author.doc_ticket().await.expect("author trail ticket");
    let relay_ticket = relay.ticket().await.expect("relay endpoint ticket");

    // The relay opens the author's namespace while it is still EMPTY. This is the steady state of
    // any friend in a sharing pool: the doc ticket arrives at pairing, long before any given fix.
    relay
        .import_doc_ticket(trail_ticket.clone())
        .await
        .expect("relay imports the author's trail");
    relay
        .sync_latest(
            vec![author.ticket().await.expect("author endpoint ticket")],
            None,
        )
        .await
        .expect("relay opens the author's namespace");

    let fix = iroh_location::LocationFix {
        lat: 47.6097,
        lon: -122.3331,
        accuracy_m: 6.0,
        heading_deg: 271.0,
        ts: 24_680,
        motion: None,
    };
    author
        .docs_write(
            "push-to-pool".into(),
            11,
            fix,
            vec![relay.recv_public(), late.recv_public()],
        )
        .await
        .expect("author writes an encrypted fix for both friends");
    // The publish-side half: `docs_write` only touches the local replica, and this is the call that
    // gets it off the device — to the POOL, with no stash anywhere in this test.
    author
        .push_trail(vec![relay_ticket.clone()], None)
        .await
        .expect("author pushes its trail to the pool");

    // Settle before taking the author away. `push` returns on `SyncFinished`, which is the entry
    // exchange; the receiving side pulls the content blob afterwards, so an author that vanished
    // the instant it was told "sent" would leave the relay holding metadata it cannot serve. This
    // is a LOCAL read on the relay — it dials nobody — so it observes the push's effect rather
    // than arranging one, and it asks about the REPLICA, which is what reconciliation serves from.
    let servable = poll_until!(30, {
        relay
            .trail_replica_status()
            .await
            .expect("relay reports its replica")
            .into_iter()
            .find(|slot| slot.author == author_id && slot.has_content)
    });
    assert_eq!(
        servable.seq, 11,
        "the relay must hold the fix the author published, not a stale slot"
    );

    author.shutdown().await.expect("author goes offline");

    // The late device asks the RELAY only, and the relay was never told to go and fetch anything.
    late.import_doc_ticket(trail_ticket)
        .await
        .expect("late device imports the author's trail");
    let recovered = poll_until!(30, {
        late.sync_latest(vec![relay_ticket.clone()], None)
            .await
            .expect("late device reconciles with the relay");
        late.read_latest()
            .await
            .expect("late device reads its replica")
            .into_iter()
            .find(|entry| entry.author == author_id && entry.seq == 11)
    });
    assert_eq!(
        recovered.fix.ts, 24_680,
        "the relayed entry must be the author's published fix, decryptable by the late device"
    );

    late.shutdown().await.expect("late shutdown");
    relay.shutdown().await.expect("relay shutdown");
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

/// The bump bootstraps a ratchet session on **both** sides, with no manual seam.
///
/// This is the property that separates "the ratchet exists" from "the ratchet is reachable".
/// Before it, `begin_session`/`complete_session` were manual calls nobody made, so a completed
/// pair left two friends with no session and every ratcheted publish dropped as `no_session`.
///
/// The assertion is deliberately behavioural rather than a `has_session` peek: publish a real
/// ratcheted fix and require the peer to open it. That exercises the whole chain the bump is
/// supposed to have set up — matching roots, agreeing session ids, complementary initiator /
/// responder roles — and would fail if any of them were merely plausible.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_completed_bump_leaves_both_sides_with_a_ratchet_session() {
    let (a, b, sid) = pair_to_verifying().await;
    clear_sas_gate(&a, &sid).await;
    clear_sas_gate(&b, &sid).await;

    // Wait for completion on both sides — `finalize` is what installs the session.
    for node in [&a, &b] {
        poll_until!(20, {
            node.pair_result(sid.clone()).await.expect("pair_result")
        });
    }

    let a_id = a.endpoint_id();
    let b_id = b.endpoint_id();
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();

    // The role is fixed by endpoint-id ordering, not by who dialled: only the initiator has a
    // sending chain before the first envelope crosses. Publish from that side.
    let (sender, receiver, receiver_hex) = if a_id < b_id {
        (&a, &b, hex(&b_id))
    } else {
        (&b, &a, hex(&a_id))
    };

    let fix = iroh_location::LocationFix {
        lat: 47.6062,
        lon: -122.3321,
        accuracy_m: 4.0,
        heading_deg: 90.0,
        ts: 4321,
        motion: None,
    };
    let dropped = sender
        .docs_write_ratcheted("test".into(), 1, fix, vec![receiver_hex.clone()])
        .await
        .expect("ratcheted publish");
    assert!(
        dropped.is_empty(),
        "the bump must leave a usable session — recipient was dropped: {dropped:?}"
    );

    // ...and the peer opens it against the session its own side of the bump installed.
    let opened = poll_until!(20, {
        receiver
            .read_latest_ratcheted()
            .await
            .expect("read ratcheted")
            .into_iter()
            .find(|f| f.author == sender.endpoint_id())
    });
    assert_eq!(
        opened.fix.ts, 4321,
        "the opened fix is the one that was sent"
    );

    a.shutdown().await.expect("A shutdown");
    b.shutdown().await.expect("B shutdown");
}
