//! State-machine and property tests for the Double Ratchet schedule (`src/ratchet.rs`).
//!
//! `docs/social/FORWARD-SECRECY.md` §7 step 6 asks for "the published DR test vectors against the
//! schedule". **There are none.** Signal specifies the Double Ratchet in prose; unlike XEdDSA or
//! RFC 7748 there is no official vector file to check a schedule against, and the reference
//! implementations bury their own in protocol-specific fixtures. That line in the plan is an
//! assumption, not a citable artifact.
//!
//! So the assurance is carried by three things instead, in descending order of value:
//!
//! 1. **The property tests below** — the sender-liveness invariant and the global no-key-twice
//!    assertion, both named explicitly by step 6. These say something true for *every* reachable
//!    state, which a vector file never can.
//! 2. **The state-machine cases** — loss, reordering, replay from the archive, crash between
//!    persist and publish, fast-forward with skip-deletion, lapse and un-lapse, rotating-kid
//!    lookup across the acceptance window. One per failure mode step 6 enumerates.
//! 3. **`tests/fixtures/ratchet_vectors.json`** — a frozen fixture in the `mesh_vectors.json`
//!    style, so the schedule cannot drift silently even though it has nothing external to be
//!    checked against. Regenerate deliberately, and say in the commit why the schedule changed.
//!
//! What none of this substitutes for is outside review, which step 6's gate also asks for.

use std::collections::HashSet;

use iroh_location::ratchet::{
    kdf_ck, kdf_kid, kdf_mk, kdf_rk, initiator_by_endpoint, MessageKey, RatchetError,
    RatchetHeader, RatchetKeySource, RatchetState, DEFAULT_ACCEPT_WINDOW, DEFAULT_T_LAPSE_MS,
    KEY_LEN, SESSION_ID_LEN, STATE_LEN, STATE_V,
};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

/// Deterministic, unbounded ratchet keys so a whole session is reproducible.
///
/// Counter-derived rather than a fixed list: how many DH steps a scenario performs is a property
/// of the schedule, not something a test should have to predict in advance.
struct FixedKeys {
    seed: u8,
    n: u32,
}

impl FixedKeys {
    fn new(seed: u8) -> Self {
        Self { seed, n: 0 }
    }
}

impl RatchetKeySource for FixedKeys {
    fn next_ratchet_secret(&mut self) -> XStaticSecret {
        let mut raw = [0u8; KEY_LEN];
        raw[0] = self.seed;
        raw[1..5].copy_from_slice(&self.n.to_le_bytes());
        self.n += 1;
        XStaticSecret::from(raw)
    }
}

fn secret(seed: u8) -> XStaticSecret {
    XStaticSecret::from([seed; KEY_LEN])
}

/// Lift a key out for comparison. Production code never does this — `use_once` exists precisely
/// so the bytes go straight into one AEAD call — but a test has to be able to assert agreement.
fn bytes(key: MessageKey) -> [u8; KEY_LEN] {
    key.use_once(|k| *k)
}

const RK0: [u8; KEY_LEN] = [7u8; KEY_LEN];
const SID: [u8; SESSION_ID_LEN] = [1u8; SESSION_ID_LEN];
const W: u32 = DEFAULT_ACCEPT_WINDOW;

/// A bootstrapped pair: `a` is the initiator (can send at once), `b` the responder.
fn pair() -> (RatchetState, FixedKeys, RatchetState, FixedKeys) {
    let b_boot = secret(0xB0);
    let b_pub = XPublicKey::from(&b_boot).to_bytes();
    let mut ka = FixedKeys::new(0xA0);
    let kb = FixedKeys::new(0xB1);
    let a = RatchetState::bootstrap_initiator(SID, RK0, b_pub, 0, &mut ka).unwrap();
    let b = RatchetState::bootstrap_responder(SID, RK0, b_boot, 0);
    (a, ka, b, kb)
}

// ── the basics ────────────────────────────────────────────────────────────────────────────────

#[test]
fn initiator_sends_and_responder_opens() {
    let (mut a, _ka, mut b, mut kb) = pair();
    let slot = a.next_send().unwrap();
    let sent = bytes(slot.key);
    let got = bytes(b.accept(&slot.header, 0, W, &mut kb).unwrap());
    assert_eq!(sent, got);
}

#[test]
fn responder_cannot_send_before_the_first_envelope() {
    // The bootstrap-window caveat on sender liveness, asserted so it stays a known state rather
    // than a surprise.
    let (_a, _ka, mut b, _kb) = pair();
    assert_eq!(b.next_send().unwrap_err(), RatchetError::NoSendingChain);
}

#[test]
fn the_role_split_is_total_and_symmetric() {
    assert!(initiator_by_endpoint(b"aaaa", b"bbbb"));
    assert!(!initiator_by_endpoint(b"bbbb", b"aaaa"));
    // Both devices compute complementary answers with no negotiation.
    let (ours, theirs) = (b"abc".as_slice(), b"abd".as_slice());
    assert_ne!(
        initiator_by_endpoint(ours, theirs),
        initiator_by_endpoint(theirs, ours)
    );
}

#[test]
fn conversation_survives_many_turns_in_both_directions() {
    let (mut a, mut ka, mut b, mut kb) = pair();
    for turn in 0..4u64 {
        for _ in 0..3 {
            let s = a.next_send().unwrap();
            let sent = bytes(s.key);
            assert_eq!(sent, bytes(b.accept(&s.header, turn, W, &mut kb).unwrap()));
        }
        for _ in 0..3 {
            let s = b.next_send().unwrap();
            let sent = bytes(s.key);
            assert_eq!(sent, bytes(a.accept(&s.header, turn, W, &mut ka).unwrap()));
        }
    }
}

// ── the delta from Signal: skipped keys are gone, not stored ──────────────────────────────────

#[test]
fn loss_is_tolerated_and_the_skipped_keys_are_unrecoverable() {
    let (mut a, _ka, mut b, mut kb) = pair();
    let lost = a.next_send().unwrap();
    let also_lost = a.next_send().unwrap();
    let delivered = a.next_send().unwrap();
    let expected = bytes(delivered.key);

    // B jumps straight to counter 2.
    assert_eq!(
        expected,
        bytes(b.accept(&delivered.header, 0, W, &mut kb).unwrap())
    );

    // The two it stepped over can never be opened afterwards. This is the whole point of
    // refusing a skipped-key table (§9): there is no stored index into the archive.
    assert_eq!(
        b.accept(&lost.header, 0, W, &mut kb).unwrap_err(),
        RatchetError::NotAhead
    );
    assert_eq!(
        b.accept(&also_lost.header, 0, W, &mut kb).unwrap_err(),
        RatchetError::NotAhead
    );
}

#[test]
fn out_of_order_delivery_drops_the_straggler() {
    let (mut a, _ka, mut b, mut kb) = pair();
    let first = a.next_send().unwrap();
    let second = a.next_send().unwrap();

    assert!(b.accept(&second.header, 0, W, &mut kb).is_ok());
    // Reordering is not repaired: the earlier position is behind us and its key is gone.
    assert_eq!(
        b.accept(&first.header, 0, W, &mut kb).unwrap_err(),
        RatchetError::NotAhead
    );
}

#[test]
fn a_position_beyond_the_window_is_refused_rather_than_walked() {
    // Bounds the work an unauthenticated counter can demand.
    let (mut a, _ka, mut b, mut kb) = pair();
    let mut slot = a.next_send().unwrap();
    slot.header.counter = 10_000;
    assert_eq!(
        b.accept(&slot.header, 0, 16, &mut kb).unwrap_err(),
        RatchetError::BeyondWindow
    );
}

// ── replay ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_byte_identical_replay_is_refused() {
    let (mut a, _ka, mut b, mut kb) = pair();
    let slot = a.next_send().unwrap();
    assert!(b.accept(&slot.header, 0, W, &mut kb).is_ok());
    assert_eq!(
        b.accept(&slot.header, 0, W, &mut kb).unwrap_err(),
        RatchetError::NotAhead
    );
}

#[test]
fn an_old_epoch_replayed_from_the_archive_is_refused() {
    let (mut a, mut ka, mut b, mut kb) = pair();
    let ancient = a.next_send().unwrap();
    drop(b.accept(&ancient.header, 0, W, &mut kb).unwrap());

    // Push both sides forward an epoch.
    let reply = b.next_send().unwrap();
    drop(a.accept(&reply.header, 0, W, &mut ka).unwrap());
    let fresh = a.next_send().unwrap();
    drop(b.accept(&fresh.header, 0, W, &mut kb).unwrap());

    // The stash still holds the very first envelope, and the operator can serve it forever.
    assert_eq!(
        b.accept(&ancient.header, 0, W, &mut kb).unwrap_err(),
        RatchetError::NotAhead
    );
}

#[test]
fn one_ratchet_key_may_not_span_two_epochs() {
    let (mut a, _ka, mut b, mut kb) = pair();
    let slot = a.next_send().unwrap();
    drop(b.accept(&slot.header, 0, W, &mut kb).unwrap());

    let mut forged = a.next_send().unwrap();
    forged.header.epoch += 5; // same ratchet key, later epoch
    assert_eq!(
        b.accept(&forged.header, 0, W, &mut kb).unwrap_err(),
        RatchetError::EpochKeyConflict
    );
}

// ── crash between persist and publish ─────────────────────────────────────────────────────────

#[test]
fn a_crash_after_persisting_burns_one_counter_and_recovers_locally() {
    let (mut a, _ka, mut b, mut kb) = pair();

    // Persist-before-publish: state advanced, then the process died before the doc write.
    drop(a.next_send().unwrap());

    // Recovery consumes NO peer message — it simply steps past the burned value. This is the
    // property that killed the revision-1 deadlock, where the same crash was permanent.
    let next = a.next_send().unwrap();
    assert_eq!(next.header.counter, 1, "exactly one counter value skipped");

    let expected = bytes(next.key);
    assert_eq!(expected, bytes(b.accept(&next.header, 0, W, &mut kb).unwrap()));
}

// ── the two invariants step 6 names ───────────────────────────────────────────────────────────

#[test]
fn sender_liveness_holds_from_every_reachable_state() {
    // "From any persisted sender state short of lapse, the next publish derives without peer
    // input." Driven over a mix of sends, silent drops, catch-ups and burned publishes.
    let (mut a, mut ka, mut b, mut kb) = pair();
    let mut pending: Vec<RatchetHeader> = Vec::new();

    for step in 0..60u64 {
        // Whatever else has happened, A can always publish.
        let slot = a.next_send().expect("sender liveness violated");
        pending.push(slot.header);

        match step % 5 {
            0 | 1 => {} // nothing delivered; A keeps publishing into the void
            2 => {
                // B catches up on the newest only; the rest are lost for good.
                if let Some(h) = pending.pop() {
                    drop(b.accept(&h, step, W, &mut kb).unwrap());
                }
                pending.clear();
            }
            3 => {
                if let Some(h) = pending.pop() {
                    drop(b.accept(&h, step, W, &mut kb).unwrap());
                }
                pending.clear();
                let reply = b.next_send().unwrap();
                drop(a.accept(&reply.header, step, W, &mut ka).unwrap());
            }
            _ => {
                // A burned publish: derived, never delivered.
                drop(a.next_send().unwrap());
            }
        }
    }
}

#[test]
fn no_message_key_is_ever_derived_twice() {
    // The global assertion §7 step 6 asks for, across both chains and many DH epochs.
    let (mut a, mut ka, mut b, mut kb) = pair();
    let mut seen: HashSet<[u8; KEY_LEN]> = HashSet::new();

    for turn in 0..12u64 {
        for _ in 0..4 {
            let s = a.next_send().unwrap();
            let sent = bytes(s.key);
            assert!(seen.insert(sent), "a message key was derived twice");
            // Both sides derive the SAME key for one position — agreement, not reuse.
            assert_eq!(sent, bytes(b.accept(&s.header, turn, W, &mut kb).unwrap()));
        }
        for _ in 0..4 {
            let s = b.next_send().unwrap();
            let sent = bytes(s.key);
            assert!(seen.insert(sent), "a message key was derived twice");
            assert_eq!(sent, bytes(a.accept(&s.header, turn, W, &mut ka).unwrap()));
        }
    }
    assert_eq!(seen.len(), 12 * 8);
}

// ── lapse ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_peer_who_stops_contributing_lapses_and_un_lapses() {
    let (mut a, mut ka, mut b, mut kb) = pair();
    let s = a.next_send().unwrap();
    drop(b.accept(&s.header, 0, W, &mut kb).unwrap());
    let reply = b.next_send().unwrap();
    drop(a.accept(&reply.header, 1_000, W, &mut ka).unwrap());

    assert!(!a.is_lapsed(1_000, DEFAULT_T_LAPSE_MS));
    assert!(a.is_lapsed(1_000 + DEFAULT_T_LAPSE_MS, DEFAULT_T_LAPSE_MS));

    // Un-lapsing takes a full ROUND TRIP, not merely inbound traffic. B mints a fresh ratchet
    // key only when it ratchets, and it ratchets only on a new key from A — the standard DR
    // ping-pong. So B sending again on its existing key does not reset A's fuse:
    let t = 1_000 + DEFAULT_T_LAPSE_MS + 1;
    let same_key_again = b.next_send().unwrap();
    drop(a.accept(&same_key_again.header, t, W, &mut ka).unwrap());
    assert!(
        a.is_lapsed(t, DEFAULT_T_LAPSE_MS),
        "receiving on the peer's existing ratchet key must not reset the lapse fuse"
    );

    // A round trip does. This is why symmetric lanes (§4.1) are a PREREQUISITE for the lapse
    // rule rather than merely a de-risker: without a watcher publishing on cadence, a
    // one-directional edge never completes the round trip and lapses despite being healthy.
    let onward = a.next_send().unwrap();
    drop(b.accept(&onward.header, t, W, &mut kb).unwrap());
    let fresh_key = b.next_send().unwrap();
    drop(a.accept(&fresh_key.header, t, W, &mut ka).unwrap());
    assert!(!a.is_lapsed(t, DEFAULT_T_LAPSE_MS));
}

#[test]
fn lapsing_never_blocks_our_own_publishing() {
    // §4.3: staleness of the PEER's device must not gate our publish. Dropping them from the wrap
    // set is the caller's decision; the schedule keeps producing keys.
    let (mut a, _ka, _b, _kb) = pair();
    let far_future = DEFAULT_T_LAPSE_MS * 10;
    assert!(a.is_lapsed(far_future, DEFAULT_T_LAPSE_MS));
    assert!(a.next_send().is_ok());
}

// ── rotating kids ─────────────────────────────────────────────────────────────────────────────

#[test]
fn a_receiver_finds_its_wrap_by_scanning_kids_forward() {
    let (mut a, _ka, mut b, mut kb) = pair();
    // Prime B's receiving chain.
    let first = a.next_send().unwrap();
    drop(b.accept(&first.header, 0, W, &mut kb).unwrap());

    // A runs ahead; B must locate the live one by kid alone (§4.7).
    let _skipped = a.next_send().unwrap();
    let _also = a.next_send().unwrap();
    let live = a.next_send().unwrap();

    let candidates = b.peek_recv_kids(8);
    let hit = candidates
        .iter()
        .find(|(kid, _)| *kid == live.kid)
        .expect("kid must be findable inside the window");
    assert_eq!(hit.1, live.header.counter);

    // Peeking is non-mutating: the state is still where it was, and the wrap still opens.
    let expected = bytes(live.key);
    assert_eq!(expected, bytes(b.accept(&live.header, 0, W, &mut kb).unwrap()));
}

#[test]
fn kids_do_not_repeat_across_positions() {
    // A stable kid is what let an outsider link a recipient across envelopes; rotation closes it.
    let (mut a, _ka, _b, _kb) = pair();
    let mut seen = HashSet::new();
    for _ in 0..64 {
        assert!(seen.insert(a.next_send().unwrap().kid), "a wrap id repeated");
    }
}

// ── key hygiene ───────────────────────────────────────────────────────────────────────────────

#[test]
fn a_low_order_peer_key_is_refused() {
    let mut ka = FixedKeys::new(0xA0);
    let err =
        RatchetState::bootstrap_initiator(SID, RK0, [0u8; KEY_LEN], 0, &mut ka).unwrap_err();
    assert_eq!(err, RatchetError::DegenerateKey);
}

#[test]
fn the_domain_contexts_are_distinct() {
    // All four derivations run over the same chain key, so a shared context would collapse them.
    let ck = [9u8; KEY_LEN];
    let next = kdf_ck(&ck);
    let mk = kdf_mk(&ck);
    assert_ne!(next, mk, "chain and message keys must not collide");
    assert_ne!(&kdf_kid(&ck)[..], &mk[..8]);
    assert_ne!(&kdf_kid(&ck)[..], &next[..8]);
}

#[test]
fn the_root_step_separates_its_two_outputs() {
    let (rk, ck) = kdf_rk(&[3u8; KEY_LEN], &[4u8; KEY_LEN]);
    assert_ne!(rk, ck);
}

// ── persistence ───────────────────────────────────────────────────────────────────────────────

#[test]
fn a_restored_session_continues_the_same_schedule() {
    // Field equality is not the property that matters; producing the SAME NEXT KEY is. A restore
    // that silently diverged would reuse counter values against a peer that had moved on.
    let (mut a, _ka, mut b, mut kb) = pair();
    drop(b.accept(&a.next_send().unwrap().header, 0, W, &mut kb).unwrap());

    let saved = a.to_bytes();
    let expected = a.next_send().unwrap();

    let mut restored = RatchetState::from_bytes(&saved).unwrap();
    let got = restored.next_send().unwrap();

    assert_eq!(expected.header, got.header);
    assert_eq!(expected.kid, got.kid);
    assert_eq!(bytes(expected.key), bytes(got.key));
}

#[test]
fn a_restored_session_still_opens_what_the_peer_sends() {
    let (mut a, mut ka, mut b, mut kb) = pair();
    drop(b.accept(&a.next_send().unwrap().header, 0, W, &mut kb).unwrap());

    let mut a = RatchetState::from_bytes(&a.to_bytes()).unwrap();
    let reply = b.next_send().unwrap();
    let expected = bytes(reply.key);
    assert_eq!(expected, bytes(a.accept(&reply.header, 0, W, &mut ka).unwrap()));
}

#[test]
fn the_serialized_state_is_a_fixed_small_size() {
    // §4.2 budgets ~200 B per friend per session.
    let (a, _ka, _b, _kb) = pair();
    assert_eq!(a.to_bytes().len(), STATE_LEN);
    assert!(STATE_LEN <= 256, "session state grew past its budget: {STATE_LEN}");
}

#[test]
fn a_responder_with_no_chains_round_trips() {
    // The bootstrap state has three absent keys; the presence flags must survive it.
    let (_a, _ka, b, _kb) = pair();
    let mut restored = RatchetState::from_bytes(&b.to_bytes()).unwrap();
    assert_eq!(restored.next_send().unwrap_err(), RatchetError::NoSendingChain);
}

#[test]
fn corrupt_or_foreign_state_is_refused_rather_than_reset() {
    // Starting fresh on a parse failure would reuse counters the peer has already seen. The
    // caller must treat this as a desync and resync (§4.6), so it has to be an error.
    let (a, _ka, _b, _kb) = pair();
    let good = a.to_bytes();

    assert_eq!(
        RatchetState::from_bytes(&good[..good.len() - 1]).unwrap_err(),
        RatchetError::MalformedState,
        "truncated"
    );
    assert_eq!(
        RatchetState::from_bytes(&[]).unwrap_err(),
        RatchetError::MalformedState,
        "empty"
    );

    let mut newer = good.clone();
    newer[0] = STATE_V + 1;
    assert_eq!(
        RatchetState::from_bytes(&newer).unwrap_err(),
        RatchetError::MalformedState,
        "a newer build's format"
    );

    let mut bad_flag = good.clone();
    bad_flag[1 + SESSION_ID_LEN + KEY_LEN + KEY_LEN] = 2; // dh_peer presence flag
    assert_eq!(
        RatchetState::from_bytes(&bad_flag).unwrap_err(),
        RatchetError::MalformedState,
        "invalid presence flag"
    );
}

#[test]
fn a_replayed_snapshot_cannot_re_derive_a_used_key_at_the_receiver() {
    // The persistence failure mode that matters: an attacker, or a careless restore-from-backup,
    // rolls the state file back. The schedule cannot stop the SENDER re-deriving — that is why §6
    // excludes the store from backups and §4.2 mandates persist-before-publish — but the RECEIVER
    // must refuse the rewound positions, so the damage stops at the sender.
    let (mut a, _ka, mut b, mut kb) = pair();
    let snapshot = a.to_bytes();

    let first = a.next_send().unwrap();
    let first_key = bytes(first.key);
    drop(b.accept(&first.header, 0, W, &mut kb).unwrap());

    let mut rolled_back = RatchetState::from_bytes(&snapshot).unwrap();
    let reused = rolled_back.next_send().unwrap();
    assert_eq!(
        bytes(reused.key),
        first_key,
        "a rolled-back sender does re-derive — this is the risk §6 addresses"
    );
    assert_eq!(
        b.accept(&reused.header, 0, W, &mut kb).unwrap_err(),
        RatchetError::NotAhead
    );
}
