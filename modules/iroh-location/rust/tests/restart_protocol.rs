//! The §4.6 session restart protocol, end to end, without a network.
//!
//! Modelled on libsignal's `tests/session.rs`: two (sometimes three) participants with real
//! session stores, real envelopes (`crypto::seal_v3` / `verify_v3`), and the exact recovery pass
//! the native drain runs (`restart::run_pass`) — everything except the transport, which these
//! tests replace with an explicit model of the two channels the app actually has:
//!
//! * the **durable** channel: one last-write-wins slot per author and lane, re-read on every sync
//!   (so the same envelope is opened again and again), plus the author's control record;
//! * the **live** channel: every envelope, in order, unless dropped or reordered.
//!
//! The deterministic tests each pin one property. `randomized_sessions_always_converge` at the
//! bottom is the analogue of libsignal's `proptest_session_resets`: random interleavings of
//! sends, deliveries, drops, reordering, re-reads, process restarts, lost and corrupted state and
//! clock jumps, followed by a quiet period after which the two sides must be on one session and
//! talking in both directions.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use ed25519_dalek::SigningKey;
use iroh_location::crypto::{self, VerifiedEnvelope};
use iroh_location::ratchet::{KEY_LEN, SESSION_ID_LEN};
use iroh_location::restart::{self, ControlRecord, PassReport};
use iroh_location::session_store::SessionStore;
use iroh_location::sessions::{
    self, Broken, Health, Role, SessionError, SessionManager, MAX_PREVIOUS_SESSIONS,
    PREKEY_MAX_USE_AGE_MS, PREKEY_ROTATE_MS, RESTART_SETTLE_MS, STUCK_NO_SEND_MS,
};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

const HOUR: u64 = 60 * 60 * 1000;
const DAY: u64 = 24 * HOUR;
/// A plausible wall clock, so `saturating_sub` against it never hides a bug at zero.
const T0: u64 = 1_790_000_000_000;

static UNIQUE: AtomicU64 = AtomicU64::new(0);

// ── participants ───────────────────────────────────────────────────────────────────────────

struct Party {
    name: &'static str,
    seed: [u8; 32],
    id: [u8; 32],
    dir: PathBuf,
    manager: Option<SessionManager>,
    next_seq: u64,
}

impl Party {
    fn new(name: &'static str, seed_byte: u8) -> Self {
        let seed = [seed_byte; 32];
        let id = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let dir = std::env::temp_dir().join(format!(
            "sc-restart-{name}-{}-{}",
            std::process::id(),
            UNIQUE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut party = Self {
            name,
            seed,
            id,
            dir,
            manager: None,
            next_seq: 1,
        };
        party.boot();
        party
    }

    fn boot(&mut self) {
        self.manager = None;
        let store = SessionStore::open(&self.dir, &self.seed).expect("open store");
        self.manager = Some(SessionManager::new(store, self.id));
    }

    /// The process dies and comes back: everything in memory is gone, the disk is not.
    fn restart_process(&mut self) {
        self.boot();
    }

    fn m(&self) -> &SessionManager {
        self.manager.as_ref().unwrap()
    }

    fn record_path(&self, peer: &[u8; 32]) -> PathBuf {
        self.dir.join("sessions").join(format!("{}.bin", hex(peer)))
    }

    fn control_path(&self) -> PathBuf {
        self.dir.join("sessions").join("control.bin")
    }

    /// Seal one envelope for `to`. `None` when every recipient was dropped (nothing is written).
    fn send(&mut self, to: &[[u8; 32]], lane: u8, now: u64) -> Option<Envelope> {
        let peers: Vec<Vec<u8>> = to.iter().map(|p| p.to_vec()).collect();
        let set = self.m().next_wraps(&peers, now).expect("next_wraps");
        if set.wraps.is_empty() {
            return None;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        let payload = payload_for(&self.id, seq, lane);
        let bytes =
            crypto::seal_v3(&self.seed, &self.id, seq, now, 0, &payload, set.wraps).expect("seal");
        Some(Envelope {
            author: self.id,
            seq,
            lane,
            bytes,
        })
    }

    /// Open `env`, checking that whatever comes out is exactly what was sealed.
    fn open(&self, env: &Envelope, now: u64) -> Result<(), SessionError> {
        let verified = crypto::verify_v3(&env.bytes).expect("signature");
        let payload = self.m().open(&env.author, &verified, now)?;
        assert_eq!(
            payload.as_slice(),
            payload_for(&env.author, env.seq, env.lane).as_slice(),
            "{} opened {}#{} to the wrong plaintext",
            self.name,
            hex(&env.author)[..6].to_string(),
            env.seq
        );
        Ok(())
    }

    fn control(&self, now: u64) -> ControlRecord {
        restart::our_control_record(self.m(), now).expect("control record")
    }

    /// One recovery pass, exactly as the native drain runs it.
    fn pass(
        &self,
        friends: &[[u8; 32]],
        replica: &[&Envelope],
        controls: &HashMap<[u8; 32], ControlRecord>,
        now: u64,
    ) -> PassReport {
        let verified: Vec<VerifiedEnvelope> = replica
            .iter()
            .map(|env| crypto::verify_v3(&env.bytes).unwrap())
            .collect();
        restart::run_pass(self.m(), friends, &verified, controls, now)
    }

    fn session_with(&self, peer: &[u8; 32]) -> Option<[u8; SESSION_ID_LEN]> {
        self.m().current_session_id(peer)
    }

    fn health(&self, peer: &[u8; 32], now: u64) -> Health {
        self.m().assess(peer, now).health
    }
}

impl Drop for Party {
    fn drop(&mut self) {
        self.manager = None;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[derive(Clone, Debug)]
struct Envelope {
    author: [u8; 32],
    seq: u64,
    lane: u8,
    bytes: Vec<u8>,
}

impl Envelope {
    fn version(&self) -> u8 {
        crypto::envelope_version(&self.bytes).unwrap()
    }
}

fn payload_for(author: &[u8; 32], seq: u64, lane: u8) -> Vec<u8> {
    let mut out = author.to_vec();
    out.extend_from_slice(&seq.to_le_bytes());
    out.push(lane);
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Two fresh participants, ordered `(leader, follower)`.
fn two() -> (Party, Party) {
    let a = Party::new("a", 0x11);
    let b = Party::new("b", 0x22);
    if a.id < b.id {
        (a, b)
    } else {
        (b, a)
    }
}

/// An in-person pairing, as `PairCore::bootstrap_ratchet` installs it: the leader (initiator)
/// holds the follower's bump ephemeral; the follower keeps it as its first ratchet key.
fn pair(leader: &Party, follower: &Party, now: u64) {
    assert_eq!(leader.m().role(&follower.id), Role::Leader);
    // Distinct per pair: two pairs sharing a root would share every key.
    let mut rng =
        StdRng::seed_from_u64(now ^ u64::from(leader.seed[0]) ^ (u64::from(follower.seed[0]) << 8));
    let rk0: [u8; KEY_LEN] = rng.gen();
    let sid: [u8; SESSION_ID_LEN] = rng.gen();
    let eph = XStaticSecret::from(rng.gen::<[u8; 32]>());
    let eph_pub = XPublicKey::from(&eph).to_bytes();
    leader
        .m()
        .bootstrap(&follower.id, sid, rk0, eph_pub, now)
        .unwrap();
    follower
        .m()
        .bootstrap_responder(&leader.id, sid, rk0, eph, now)
        .unwrap();
}

/// Pair, then let the leader's first envelope reach the follower so both can send.
fn paired_and_primed(now: u64) -> (Party, Party) {
    let (mut leader, follower) = two();
    pair(&leader, &follower, now);
    let first = leader.send(&[follower.id], 0, now).unwrap();
    follower.open(&first, now).unwrap();
    (leader, follower)
}

fn controls_of(party: &Party, now: u64) -> HashMap<[u8; 32], ControlRecord> {
    HashMap::from([(party.id, party.control(now))])
}

fn none() -> HashMap<[u8; 32], ControlRecord> {
    HashMap::new()
}

fn assert_talking(leader: &mut Party, follower: &mut Party, now: u64) {
    let down = leader
        .send(&[follower.id], 0, now)
        .expect("leader can send");
    follower
        .open(&down, now)
        .expect("follower opens the leader");
    let up = follower
        .send(&[leader.id], 0, now)
        .expect("follower can send");
    leader.open(&up, now).expect("leader opens the follower");
    assert_eq!(
        leader.session_with(&follower.id),
        follower.session_with(&leader.id),
        "both sides must be on one session"
    );
}

// ── the basics ─────────────────────────────────────────────────────────────────────────────

#[test]
fn a_paired_session_talks_both_ways_and_stays_v3() {
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    for i in 0..20 {
        let down = leader.send(&[follower.id], (i % 2) as u8, now).unwrap();
        assert_eq!(
            down.version(),
            crypto::ENVELOPE_V3,
            "ordinary traffic stays v3"
        );
        follower.open(&down, now).unwrap();
        let up = follower.send(&[leader.id], (i % 2) as u8, now).unwrap();
        assert_eq!(up.version(), crypto::ENVELOPE_V3);
        leader.open(&up, now).unwrap();
    }
    assert_eq!(leader.health(&follower.id, now), Health::Healthy);
    assert_eq!(follower.health(&leader.id, now), Health::Healthy);
}

#[test]
fn the_pair_roles_are_fixed_by_endpoint_order_and_agree() {
    let (leader, follower) = two();
    assert_eq!(leader.m().role(&follower.id), Role::Leader);
    assert_eq!(follower.m().role(&leader.id), Role::Follower);
}

// ── restarting ─────────────────────────────────────────────────────────────────────────────

#[test]
fn a_restart_is_adopted_from_any_one_envelope_and_rides_until_answered() {
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    let before = leader.session_with(&follower.id);

    let prekey = follower.control(now).newest_prekey().unwrap();
    leader
        .m()
        .restart_as_leader(&follower.id, &prekey, None, now)
        .unwrap();
    assert_ne!(leader.session_with(&follower.id), before);

    // Three envelopes go out; the first two are lost. Each carries the restart.
    let lost_1 = leader.send(&[follower.id], 0, now).unwrap();
    let lost_2 = leader.send(&[follower.id], 1, now).unwrap();
    let arrives = leader.send(&[follower.id], 0, now).unwrap();
    for env in [&lost_1, &lost_2, &arrives] {
        assert_eq!(
            env.version(),
            crypto::ENVELOPE_V4,
            "an unanswered restart rides on v4"
        );
    }
    follower
        .open(&arrives, now)
        .expect("adopted from the third envelope alone");
    assert_eq!(
        follower.session_with(&leader.id),
        leader.session_with(&follower.id)
    );

    // Until the follower answers, the leader keeps attaching it.
    let still = leader.send(&[follower.id], 0, now).unwrap();
    assert_eq!(still.version(), crypto::ENVELOPE_V4);
    follower.open(&still, now).unwrap();

    let answer = follower.send(&[leader.id], 0, now).unwrap();
    leader.open(&answer, now).unwrap();
    let after = leader.send(&[follower.id], 0, now).unwrap();
    assert_eq!(after.version(), crypto::ENVELOPE_V3, "answered: back to v3");
    follower.open(&after, now).unwrap();
    assert_talking(&mut leader, &mut follower, now);
}

#[test]
fn a_follower_primes_a_restart_without_consuming_the_fix_it_rides_on() {
    // The 2026-10-03 shape: the follower's process has nobody to hand a fix to, but it must still
    // join the restart — and the fix must still be there for whoever reads it later.
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    let prekey = follower.control(now).newest_prekey().unwrap();
    leader
        .m()
        .restart_as_leader(&follower.id, &prekey, None, now)
        .unwrap();
    let env = leader.send(&[follower.id], 0, now).unwrap();

    let report = follower.pass(&[leader.id], &[&env], &none(), now);
    assert_eq!(report.primed, 1, "the restart was adopted natively");
    assert_eq!(
        follower.session_with(&leader.id),
        leader.session_with(&follower.id)
    );

    // The follower can send on it at once — no reader ever ran.
    let up = follower.send(&[leader.id], 0, now).unwrap();
    leader
        .open(&up, now)
        .expect("the leader opens the follower on the new session");

    // And the envelope that carried the restart still opens, later, for the reader.
    follower
        .open(&env, now)
        .expect("the fix inside was not consumed by priming");
    assert_talking(&mut leader, &mut follower, now);
}

#[test]
fn a_repeated_restart_envelope_is_a_replay_not_a_miss_and_not_a_reinstall() {
    // libsignal `test_repeat_bundle_message`: the same PreKey message delivered again must not
    // re-create the session.
    let now = T0;
    let (mut leader, follower) = paired_and_primed(now);
    let prekey = follower.control(now).newest_prekey().unwrap();
    leader
        .m()
        .restart_as_leader(&follower.id, &prekey, None, now)
        .unwrap();
    let first = leader.send(&[follower.id], 0, now).unwrap();
    let second = leader.send(&[follower.id], 0, now).unwrap();

    follower.open(&first, now).unwrap();
    let adopted = follower.session_with(&leader.id);
    follower.open(&second, now).unwrap();
    assert_eq!(
        follower.session_with(&leader.id),
        adopted,
        "no second install"
    );

    for _ in 0..10 {
        assert!(matches!(
            follower.open(&first, now),
            Err(SessionError::Replayed)
        ));
        assert!(matches!(
            follower.open(&second, now),
            Err(SessionError::Replayed)
        ));
    }
    assert_eq!(follower.health(&leader.id, now), Health::Healthy);
    assert_eq!(follower.session_with(&leader.id), adopted);
}

#[test]
fn an_old_restart_header_cannot_move_a_follower_backwards_even_after_a_process_restart() {
    // The stash keeps whatever versions of a slot it likes. A restart header replayed from before
    // the restart the follower is on must be inert — durably, not only while memory lasts.
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    let prekey = follower.control(now).newest_prekey().unwrap();

    leader
        .m()
        .restart_as_leader(&follower.id, &prekey, None, now)
        .unwrap();
    let old = leader.send(&[follower.id], 0, now).unwrap();
    leader
        .m()
        .restart_as_leader(&follower.id, &prekey, None, now + 1)
        .unwrap();
    let new = leader.send(&[follower.id], 0, now + 1).unwrap();

    follower.open(&new, now + 1).unwrap();
    let current = follower.session_with(&leader.id);
    assert_eq!(current, leader.session_with(&follower.id));

    follower.restart_process();
    assert!(
        follower.open(&old, now + 2).is_err(),
        "the older restart is refused"
    );
    let report = follower.pass(&[leader.id], &[&old], &none(), now + 2);
    assert_eq!(report.primed, 0, "and not primed either");
    assert_eq!(follower.session_with(&leader.id), current);
    assert_talking(&mut leader, &mut follower, now + 2);
}

#[test]
fn whatever_the_follower_sent_before_it_heard_of_a_restart_still_opens() {
    // Sesame's inactive sessions: the follower's position on the old session is its CURRENT
    // position until it learns of the restart, and on last-write-wins it is the only one there is.
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    let prekey = follower.control(now).newest_prekey().unwrap();
    leader
        .m()
        .restart_as_leader(&follower.id, &prekey, None, now)
        .unwrap();

    let straggler = follower.send(&[leader.id], 0, now).unwrap();
    leader
        .open(&straggler, now)
        .expect("opened on the archived session");
    assert_eq!(leader.health(&follower.id, now), Health::Healthy);
    // ...and opening it there does not undo the restart.
    let down = leader.send(&[follower.id], 0, now).unwrap();
    assert_eq!(
        down.version(),
        crypto::ENVELOPE_V4,
        "still awaiting an answer on the new one"
    );
    follower.open(&down, now).unwrap();
    assert_talking(&mut leader, &mut follower, now);
}

#[test]
fn the_archive_is_bounded() {
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    let prekey = follower.control(now).newest_prekey().unwrap();
    let mut stragglers = Vec::new();
    for i in 0..(MAX_PREVIOUS_SESSIONS as u64 + 1) {
        // The follower sends on whatever session it is on, then the leader restarts past it.
        stragglers.push(follower.send(&[leader.id], 0, now + i).unwrap());
        leader
            .m()
            .restart_as_leader(&follower.id, &prekey, None, now + i)
            .unwrap();
        let down = leader.send(&[follower.id], 0, now + i).unwrap();
        follower.open(&down, now + i).unwrap();
    }
    // The newest MAX_PREVIOUS_SESSIONS stragglers still open; the oldest session is gone.
    let (oldest, rest) = stragglers.split_first().unwrap();
    assert!(
        leader.open(oldest, now + 10).is_err(),
        "the oldest session was dropped"
    );
    for straggler in rest {
        leader
            .open(straggler, now + 10)
            .expect("archived sessions still open");
    }
    assert_talking(&mut leader, &mut follower, now + 10);
}

#[test]
fn only_the_leader_restarts_and_only_against_a_fresh_prekey() {
    let now = T0;
    let (leader, follower) = paired_and_primed(now);
    let leader_prekey = leader.control(now).newest_prekey().unwrap();
    assert!(matches!(
        follower
            .m()
            .restart_as_leader(&leader.id, &leader_prekey, None, now),
        Err(SessionError::NotLeader)
    ));

    let prekey = follower.control(now).newest_prekey().unwrap();
    let later = now + PREKEY_MAX_USE_AGE_MS + 1;
    let before = leader.session_with(&follower.id);
    assert!(matches!(
        leader
            .m()
            .restart_as_leader(&follower.id, &prekey, None, later),
        Err(SessionError::StalePrekey)
    ));
    assert_eq!(
        leader.session_with(&follower.id),
        before,
        "nothing installed"
    );
}

#[test]
fn a_restart_header_copied_into_another_authors_envelope_is_inert() {
    // libsignal `prekey_message_sent_from_different_user_is_rejected`. The transcript binds the
    // leader's identity, so a header lifted into an envelope signed by someone else derives a
    // session whose wrap ids match nothing.
    let now = T0;
    let (mut leader, follower) = paired_and_primed(now);
    // `other` must lead the follower too, or the follower would not consider a restart from it.
    let mut other = (0x60u8..)
        .map(|seed| Party::new("x", seed))
        .find(|p| p.id < follower.id)
        .unwrap();
    pair(&other, &follower, now);
    let first = other.send(&[follower.id], 0, now).unwrap();
    follower.open(&first, now).unwrap();

    let prekey = follower.control(now).newest_prekey().unwrap();
    leader
        .m()
        .restart_as_leader(&follower.id, &prekey, None, now)
        .unwrap();
    let genuine = leader.send(&[follower.id], 0, now).unwrap();
    let boot = crypto::verify_v3(&genuine.bytes).unwrap().locators()[0]
        .boot
        .unwrap();

    // `other` restarts too, but we overwrite its header with the leader's before sealing.
    other
        .m()
        .restart_as_leader(&follower.id, &prekey, None, now)
        .unwrap();
    let set = other.m().next_wraps(&[follower.id.to_vec()], now).unwrap();
    let wraps = set
        .wraps
        .into_iter()
        .map(|mut w| {
            w.boot = Some(boot);
            w
        })
        .collect();
    let forged = Envelope {
        author: other.id,
        seq: 999,
        lane: 0,
        bytes: crypto::seal_v3(&other.seed, &other.id, 999, now, 0, b"x", wraps).unwrap(),
    };
    let before_leader = follower.session_with(&leader.id);
    let verified = crypto::verify_v3(&forged.bytes).unwrap();
    assert!(follower.m().open(&other.id, &verified, now).is_err());
    assert_eq!(follower.session_with(&leader.id), before_leader);
}

#[test]
fn a_failed_open_never_changes_what_is_on_disk() {
    // libsignal `prekey_message_failed_decryption_does_not_update_stores`.
    let now = T0;
    let (mut leader, follower) = paired_and_primed(now);
    let third = Party::new("c", 0x33);
    let path = follower.record_path(&leader.id);
    let before = std::fs::read(&path).unwrap();

    // An envelope the leader sealed for someone else entirely.
    pair_any(&leader, &third, now);
    if let Some(env) = leader.send(&[third.id], 0, now) {
        let _ = follower.open(&env, now);
    }
    // A restart against a prekey the follower does not hold.
    let foreign = third.control(now).newest_prekey().unwrap();
    let mut rogue = foreign;
    rogue.id = 4242;
    leader
        .m()
        .restart_as_leader(&follower.id, &rogue, None, now)
        .unwrap();
    let env = leader.send(&[follower.id], 0, now).unwrap();
    assert!(follower.open(&env, now).is_err());
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "a failed open moved stored state"
    );
}

/// Pair two parties in whichever order their ids make leader and follower.
fn pair_any(a: &Party, b: &Party, now: u64) {
    if a.id < b.id {
        pair(a, b, now)
    } else {
        pair(b, a, now)
    }
}

// ── detection ──────────────────────────────────────────────────────────────────────────────

#[test]
fn re_reading_an_opened_envelope_is_never_a_desync() {
    // 2026-10-02: three re-reads in one second of a launch "desynced" a working session.
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    let up = follower.send(&[leader.id], 0, now).unwrap();
    leader.open(&up, now).unwrap();
    for _ in 0..20 {
        assert!(matches!(leader.open(&up, now), Err(SessionError::Replayed)));
    }
    assert_eq!(leader.health(&follower.id, now), Health::Healthy);
    leader.restart_process();
    for _ in 0..20 {
        assert!(matches!(leader.open(&up, now), Err(SessionError::Replayed)));
    }
    assert_eq!(
        leader.health(&follower.id, now),
        Health::Healthy,
        "the chain on disk still knows it was opened after memory is gone"
    );
    assert_talking(&mut leader, &mut follower, now);
}

#[test]
fn a_run_of_distinct_unopenable_envelopes_is_a_desync() {
    let now = T0;
    let (leader, mut follower) = paired_and_primed(now);
    // Give the leader a session the follower does not share — one-sided state loss.
    std::fs::remove_file(leader.record_path(&follower.id)).unwrap();
    let mut rng = StdRng::seed_from_u64(7);
    let eph = XStaticSecret::from(rng.gen::<[u8; 32]>());
    leader
        .m()
        .bootstrap(
            &follower.id,
            rng.gen(),
            rng.gen(),
            XPublicKey::from(&eph).to_bytes(),
            now,
        )
        .unwrap();
    for _ in 0..sessions::DEFAULT_DESYNC_THRESHOLD {
        let up = follower.send(&[leader.id], 0, now).unwrap();
        assert!(matches!(leader.open(&up, now), Err(SessionError::NotForUs)));
    }
    assert_eq!(
        leader.health(&follower.id, now),
        Health::Broken(Broken::Misses)
    );
}

#[test]
fn a_lapse_alone_never_makes_the_leader_restart_but_a_request_does() {
    // §4.5: a device in someone else's hands must not keep tracking by doing nothing.
    let now = T0;
    let (leader, follower) = paired_and_primed(now);
    leader.m().set_t_lapse_ms(HOUR);
    follower.m().set_t_lapse_ms(HOUR);
    let later = now + 2 * HOUR;
    assert_eq!(
        leader.health(&follower.id, later),
        Health::Broken(Broken::Lapsed)
    );

    let report = leader.pass(&[follower.id], &[], &controls_of(&follower, now), later);
    assert_eq!(
        report.restarted, 0,
        "a lapse alone is not grounds for a restart"
    );

    // The follower, alive, sees the lapse too and asks.
    let report = follower.pass(&[leader.id], &[], &none(), later);
    assert_eq!(report.requested, 1);
    let report = leader.pass(&[follower.id], &[], &controls_of(&follower, later), later);
    assert_eq!(report.restarted, 1, "the follower's request is answered");
}

#[test]
fn an_answered_request_is_never_answered_twice_even_across_a_process_restart() {
    let now = T0;
    let (mut leader, follower) = paired_and_primed(now);
    follower.m().set_t_lapse_ms(1);
    let later = now + 10;
    assert_eq!(
        follower.pass(&[leader.id], &[], &none(), later).requested,
        1
    );
    let control = controls_of(&follower, later);

    assert_eq!(
        leader.pass(&[follower.id], &[], &control, later).restarted,
        1
    );
    assert_eq!(
        leader.pass(&[follower.id], &[], &control, later).restarted,
        0
    );
    leader.restart_process();
    assert_eq!(
        leader
            .pass(&[follower.id], &[], &control, later + HOUR)
            .restarted,
        0,
        "answered is recorded on disk with the restart"
    );
}

#[test]
fn requests_are_addressed_by_a_tag_only_the_intended_leader_recognises() {
    let (leader, follower) = two();
    let other = Party::new("o", 0x55);
    let request = iroh_location::session_store::RestartRequest {
        peer: leader.id,
        ts: 5,
        origin_at_request: 0,
    };
    let record = ControlRecord::new(&follower.id, 1, &[], &[request]);
    assert_eq!(record.request_for(&leader.id, &follower.id), Some(5));
    assert_eq!(record.request_for(&other.id, &follower.id), None);
    assert!(
        !record.encode().unwrap().windows(32).any(|w| w == leader.id),
        "the leader's id is not in the record"
    );
}

#[test]
fn the_retired_resync_record_is_not_mistaken_for_a_control_record() {
    #[derive(serde::Serialize)]
    struct ResyncRecordV1 {
        v: u8,
        ephemeral: Vec<u8>,
        ts: u64,
        nonce: Vec<u8>,
    }
    let old = postcard::to_allocvec(&ResyncRecordV1 {
        v: 1,
        ephemeral: vec![7; 32],
        ts: 1,
        nonce: vec![9; 16],
    })
    .unwrap();
    assert!(ControlRecord::decode(&old).is_none());
    let new = ControlRecord::new(&[1; 32], 3, &[], &[]);
    assert_eq!(ControlRecord::decode(&new.encode().unwrap()), Some(new));
}

// ── prekeys ────────────────────────────────────────────────────────────────────────────────

#[test]
fn prekeys_rotate_daily_and_superseded_ones_expire() {
    let now = T0;
    let (_leader, follower) = two();
    let first = follower.control(now).newest_prekey().unwrap();
    assert_eq!(
        follower.control(now + HOUR).newest_prekey().unwrap(),
        first,
        "no rotation within a day"
    );
    let second = follower
        .control(now + PREKEY_ROTATE_MS)
        .newest_prekey()
        .unwrap();
    assert_ne!(second.id, first.id);
    let published = follower.control(now + PREKEY_ROTATE_MS);
    assert_eq!(published.prekeys.len(), 2, "the newest two are published");
    // Long after, only the newest survives.
    let much_later = now + 30 * DAY;
    let record = follower.control(much_later);
    assert!(record.prekeys.iter().all(|p| p.id != first.id));
}

// ── whole scenarios ────────────────────────────────────────────────────────────────────────

/// One round of everything a healthy app does: both recover, both publish, both read.
fn round(
    leader: &mut Party,
    follower: &mut Party,
    now: u64,
) -> (Option<Envelope>, Option<Envelope>) {
    let down = leader.send(&[follower.id], 0, now);
    let up = follower.send(&[leader.id], 0, now);
    let follower_replica: Vec<&Envelope> = down.iter().collect();
    follower.pass(&[leader.id], &follower_replica, &none(), now);
    leader.pass(&[follower.id], &[], &controls_of(follower, now), now);
    if let Some(env) = &down {
        let _ = follower.open(env, now);
    }
    if let Some(env) = &up {
        let _ = leader.open(env, now);
    }
    (down, up)
}

#[test]
fn a_follower_stuck_without_a_sending_chain_asks_and_is_rescued() {
    // 2026-10-02/03: the Pixel sat for a day dropping its friend as `no_sending_chain`, with no
    // verdict anywhere calling that broken.
    let now = T0;
    let (mut leader, mut follower) = two();
    pair(&leader, &follower, now);
    // The leader's envelopes never arrive.
    for _ in 0..5 {
        let _ = leader.send(&[follower.id], 0, now);
    }
    assert!(
        follower.send(&[leader.id], 0, now).is_none(),
        "no sending chain yet"
    );
    let stuck = now + STUCK_NO_SEND_MS;
    assert_eq!(
        follower.health(&leader.id, stuck),
        Health::Broken(Broken::StuckNoSend)
    );
    let report = follower.pass(&[leader.id], &[], &none(), stuck);
    assert_eq!(report.requested, 1);
    let report = leader.pass(&[follower.id], &[], &controls_of(&follower, stuck), stuck);
    assert_eq!(report.restarted, 1);
    let down = leader.send(&[follower.id], 0, stuck).unwrap();
    // The follower's next native pass adopts it from the replica — and, healthy again in the same
    // pass, withdraws its request.
    let report = follower.pass(&[leader.id], &[&down], &none(), stuck);
    assert_eq!((report.primed, report.withdrawn), (1, 1));
    let report = follower.pass(&[leader.id], &[&down], &none(), stuck);
    assert_eq!(report.primed, 0, "already adopted");
    assert!(
        follower.m().requests().unwrap().is_empty(),
        "healthy again: the request is withdrawn"
    );
    assert_talking(&mut leader, &mut follower, stuck);
}

#[test]
fn the_2026_10_03_dead_end_heals_without_a_re_pair() {
    // The leader restarts while the follower is dark; the follower's process dies and comes back
    // with nothing in memory; the follower never runs a reader at all. It must still converge.
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    let control = controls_of(&follower, now);

    // The follower reports a broken session (here: lapsed) and goes dark.
    follower.m().set_t_lapse_ms(1);
    let t1 = now + 10;
    assert_eq!(follower.pass(&[leader.id], &[], &none(), t1).requested, 1);
    let control_with_request = controls_of(&follower, t1);
    drop(control);
    follower.restart_process();
    follower.m().set_t_lapse_ms(sessions::PREKEY_RETAIN_MS);

    // The leader answers, and keeps publishing into the void for hours.
    let t2 = t1 + HOUR;
    assert_eq!(
        leader
            .pass(&[follower.id], &[], &control_with_request, t2)
            .restarted,
        1
    );
    let mut latest = None;
    for i in 0..12 {
        latest = leader.send(&[follower.id], 0, t2 + i * 15 * 60 * 1000);
    }
    let latest = latest.unwrap();

    // Hours later the follower's native runtime wakes: no reader, only the recovery pass.
    let t3 = t2 + 4 * HOUR;
    follower.restart_process();
    follower.m().set_t_lapse_ms(sessions::PREKEY_RETAIN_MS);
    let report = follower.pass(&[leader.id], &[&latest], &none(), t3);
    assert_eq!(report.primed, 1);
    let up = follower
        .send(&[leader.id], 0, t3)
        .expect("can send at once");
    leader
        .open(&up, t3)
        .expect("the leader reads it: one session");
    assert_talking(&mut leader, &mut follower, t3);
}

#[test]
fn both_sides_detecting_at_once_converge_on_one_restart() {
    // libsignal `test_basic_simultaneous_initiate`. Here only the leader can restart, so two
    // detections produce one restart, not two competing ones.
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    leader.m().set_t_lapse_ms(1);
    follower.m().set_t_lapse_ms(1);
    let t = now + 10;
    follower.pass(&[leader.id], &[], &none(), t);
    let controls = controls_of(&follower, t);
    let first = leader.pass(&[follower.id], &[], &controls, t);
    let second = leader.pass(&[follower.id], &[], &controls, t);
    assert_eq!(first.restarted + second.restarted, 1);
    leader.m().set_t_lapse_ms(sessions::PREKEY_RETAIN_MS);
    follower.m().set_t_lapse_ms(sessions::PREKEY_RETAIN_MS);
    round(&mut leader, &mut follower, t);
    assert_talking(&mut leader, &mut follower, t);
}

#[test]
fn a_damaged_follower_record_is_replaced_by_a_restart() {
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    std::fs::write(follower.record_path(&leader.id), b"not a session").unwrap();
    assert_eq!(
        follower.health(&leader.id, now),
        Health::Broken(Broken::Damaged)
    );
    assert_eq!(follower.pass(&[leader.id], &[], &none(), now).requested, 1);
    assert_eq!(
        leader
            .pass(&[follower.id], &[], &controls_of(&follower, now), now)
            .restarted,
        1
    );
    let down = leader.send(&[follower.id], 0, now).unwrap();
    follower
        .open(&down, now)
        .expect("adopted over the damaged record");
    assert_talking(&mut leader, &mut follower, now);
}

#[test]
fn a_damaged_leader_record_is_replaced_by_a_restart() {
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    std::fs::write(leader.record_path(&follower.id), b"not a session").unwrap();
    assert_eq!(
        leader.health(&follower.id, now),
        Health::Broken(Broken::Damaged)
    );
    let report = leader.pass(&[follower.id], &[], &controls_of(&follower, now), now);
    assert_eq!(report.restarted, 1, "the leader acts on its own evidence");
    let down = leader.send(&[follower.id], 0, now).unwrap();
    follower.open(&down, now).unwrap();
    assert_talking(&mut leader, &mut follower, now);
}

#[test]
fn a_follower_that_lost_its_prekeys_asks_again_and_heals() {
    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    let old_controls = controls_of(&follower, now);
    // The leader restarts against a prekey the follower then loses.
    follower.m().set_t_lapse_ms(1);
    follower.pass(&[leader.id], &[], &none(), now + 1);
    let asked = controls_of(&follower, now + 1);
    drop(old_controls);
    std::fs::remove_file(follower.control_path()).unwrap();
    follower.restart_process();
    assert_eq!(
        leader.pass(&[follower.id], &[], &asked, now + 2).restarted,
        1
    );

    // Its envelopes are unopenable to the follower: a run of distinct ones is a desync.
    let mut t = now + 3;
    for _ in 0..sessions::DEFAULT_DESYNC_THRESHOLD {
        let down = leader.send(&[follower.id], 0, t).unwrap();
        assert!(follower.open(&down, t).is_err());
        t += 1;
    }
    assert!(matches!(follower.health(&leader.id, t), Health::Broken(_)));
    let report = follower.pass(&[leader.id], &[], &none(), t);
    assert_eq!(report.requested, 1, "the follower asks again");
    let report = leader.pass(
        &[follower.id],
        &[],
        &controls_of(&follower, t),
        t + RESTART_SETTLE_MS,
    );
    assert_eq!(
        report.restarted, 1,
        "answered against the follower's new prekey"
    );
    let down = leader
        .send(&[follower.id], 0, t + RESTART_SETTLE_MS)
        .unwrap();
    follower.open(&down, t + RESTART_SETTLE_MS).unwrap();
    assert_talking(&mut leader, &mut follower, t + RESTART_SETTLE_MS);
}

#[test]
fn a_leader_leading_two_followers_restarts_one_without_disturbing_the_other() {
    // One envelope, two wraps, one restart header: the other follower must read it as ordinary.
    let now = T0;
    let mut l = Party::new("l", 0x01);
    let mut f1 = Party::new("f1", 0x02);
    let mut f2 = Party::new("f2", 0x03);
    let mut ps = [&mut l, &mut f1, &mut f2];
    ps.sort_by_key(|p| p.id);
    let [l, f1, f2] = ps;
    pair(l, f1, now);
    pair(l, f2, now);
    let first = l.send(&[f1.id, f2.id], 0, now).unwrap();
    f1.open(&first, now).unwrap();
    f2.open(&first, now).unwrap();

    let prekey = f1.control(now).newest_prekey().unwrap();
    l.m().restart_as_leader(&f1.id, &prekey, None, now).unwrap();
    let f2_session = f2.session_with(&l.id);
    let both = l.send(&[f1.id, f2.id], 0, now).unwrap();
    assert_eq!(both.version(), crypto::ENVELOPE_V4);
    f1.open(&both, now).expect("f1 adopts");
    f2.open(&both, now)
        .expect("f2 reads it as ordinary traffic");
    assert_eq!(f2.session_with(&l.id), f2_session, "f2's session untouched");
    assert_eq!(f1.session_with(&l.id), l.session_with(&f1.id));
}

#[test]
fn a_session_written_by_an_older_build_is_read_and_upgraded() {
    use chacha20poly1305::aead::{Aead, KeyInit, Payload};
    use chacha20poly1305::{ChaCha20Poly1305, Nonce};

    let now = T0;
    let (mut leader, mut follower) = paired_and_primed(now);
    // Rewrite the leader's record as a pre-record build would have: a bare session under STATE_V.
    let current = {
        let path = leader.record_path(&follower.id);
        leader.manager = None;
        let store = SessionStore::open(&leader.dir, &leader.seed).unwrap();
        let session = store.load(&follower.id).unwrap().unwrap();
        drop(store);
        let mut hasher = blake3::Hasher::new_derive_key("sc-dr/v1/store");
        hasher.update(&leader.seed);
        let key = *hasher.finalize().as_bytes();
        let mut aad = b"sc-dr/v1/store-aad".to_vec();
        aad.extend_from_slice(&follower.id);
        aad.push(iroh_location::ratchet::STATE_V);
        let nonce = [3u8; 12];
        let ct = ChaCha20Poly1305::new_from_slice(&key)
            .unwrap()
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &session.to_bytes(),
                    aad: &aad,
                },
            )
            .unwrap();
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ct);
        std::fs::write(&path, blob).unwrap();
        session.session_id()
    };
    leader.boot();
    assert_eq!(leader.session_with(&follower.id), Some(current));
    assert_talking(&mut leader, &mut follower, now);
}

// ── randomized: libsignal's `proptest_session_resets` ───────────────────────────────────────

/// What one side can see of the other: the durable slots (latest per lane, re-read freely) and
/// the live queue (each envelope once, maybe dropped or reordered).
#[derive(Default)]
struct Inbox {
    slots: HashMap<u8, Envelope>,
    live: VecDeque<Envelope>,
    control: Option<ControlRecord>,
}

struct World {
    leader: Party,
    follower: Party,
    to_leader: Inbox,
    to_follower: Inbox,
    /// Published but not yet synced: (envelopes, control).
    leader_out: (Vec<Envelope>, Option<ControlRecord>),
    follower_out: (Vec<Envelope>, Option<ControlRecord>),
    now: u64,
    log: Vec<String>,
}

impl World {
    fn new(seed: u64) -> Self {
        let (leader, follower) = {
            let a = Party::new("rl", (seed % 200) as u8 + 1);
            let b = Party::new("rf", (seed % 200) as u8 + 30);
            if a.id < b.id {
                (a, b)
            } else {
                (b, a)
            }
        };
        let now = T0 + seed;
        pair(&leader, &follower, now);
        Self {
            leader,
            follower,
            to_leader: Inbox::default(),
            to_follower: Inbox::default(),
            leader_out: Default::default(),
            follower_out: Default::default(),
            now,
            log: Vec::new(),
        }
    }

    fn parts(
        &mut self,
        leader_side: bool,
    ) -> (
        &mut Party,
        &mut Party,
        &mut Inbox,
        &mut (Vec<Envelope>, Option<ControlRecord>),
    ) {
        if leader_side {
            (
                &mut self.leader,
                &mut self.follower,
                &mut self.to_leader,
                &mut self.leader_out,
            )
        } else {
            (
                &mut self.follower,
                &mut self.leader,
                &mut self.to_follower,
                &mut self.follower_out,
            )
        }
    }

    fn send(&mut self, leader_side: bool, lane: u8) {
        let now = self.now;
        let (me, them, _, out) = self.parts(leader_side);
        if let Some(env) = me.send(&[them.id], lane, now) {
            out.0.push(env);
        }
    }

    /// Everything `from` has published becomes visible to the other side.
    fn sync(&mut self, from_leader: bool) {
        let (out, inbox) = if from_leader {
            (&mut self.leader_out, &mut self.to_follower)
        } else {
            (&mut self.follower_out, &mut self.to_leader)
        };
        for env in out.0.drain(..) {
            inbox.slots.insert(env.lane, env.clone());
            inbox.live.push_back(env);
        }
        if let Some(control) = out.1.take() {
            inbox.control = Some(control);
        }
    }

    fn read_slots(&mut self, leader_side: bool) {
        let now = self.now;
        let (me, _, inbox, _) = self.parts(leader_side);
        let mut slots: Vec<&Envelope> = inbox.slots.values().collect();
        slots.sort_by_key(|e| e.seq);
        for env in slots {
            check(me.open(env, now));
        }
    }

    fn read_live(&mut self, leader_side: bool) {
        let now = self.now;
        let (me, _, inbox, _) = self.parts(leader_side);
        while let Some(env) = inbox.live.pop_front() {
            check(me.open(&env, now));
        }
    }

    fn recover(&mut self, leader_side: bool) {
        let now = self.now;
        let (me, them, inbox, out) = self.parts(leader_side);
        let replica: Vec<&Envelope> = inbox.slots.values().collect();
        let controls: HashMap<[u8; 32], ControlRecord> =
            inbox.control.iter().map(|c| (them.id, c.clone())).collect();
        let report = me.pass(&[them.id], &replica, &controls, now);
        for err in &report.errors {
            assert!(
                !err.contains("poisoned"),
                "{}: recovery error: {err}",
                me.name
            );
        }
        out.1 = Some(me.control(now));
    }

    fn agreed_and_talking(&mut self) -> bool {
        let now = self.now;
        let leader_session = self.leader.session_with(&self.follower.id);
        let follower_session = self.follower.session_with(&self.leader.id);
        if leader_session.is_none() || leader_session != follower_session {
            return false;
        }
        let Some(down) = self.leader.send(&[self.follower.id], 0, now) else {
            return false;
        };
        if self.follower.open(&down, now).is_err() {
            return false;
        }
        let Some(up) = self.follower.send(&[self.leader.id], 0, now) else {
            return false;
        };
        self.leader.open(&up, now).is_ok()
    }
}

/// Opening may fail for many ordinary reasons; it must never fail for one that means the
/// implementation is broken.
fn check(result: Result<(), SessionError>) {
    if let Err(err) = result {
        assert!(
            matches!(
                err,
                SessionError::NotForUs
                    | SessionError::Replayed
                    | SessionError::NoSession
                    | SessionError::Store(_)
                    | SessionError::Ratchet(_)
            ),
            "unexpected open error: {err}"
        );
    }
}

fn run_random_case(seed: u64, steps: usize) {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut w = World::new(seed);
    for step in 0..steps {
        let side = rng.gen_bool(0.5);
        let who = if side { "leader" } else { "follower" };
        let roll = rng.gen_range(0..100);
        let event = match roll {
            0..=24 => {
                let lane = rng.gen_range(0..2);
                w.send(side, lane);
                format!("{who} sends lane {lane}")
            }
            25..=39 => {
                w.sync(side);
                format!("{who}'s publications sync")
            }
            40..=51 => {
                w.read_slots(side);
                format!("{who} re-reads its replica")
            }
            52..=59 => {
                w.read_live(side);
                format!("{who} drains its live queue")
            }
            60..=63 => {
                let (_, _, inbox, _) = w.parts(side);
                inbox.live.pop_front();
                format!("{who} loses a live envelope")
            }
            64..=66 => {
                let (_, _, inbox, _) = w.parts(side);
                let mut v: Vec<_> = inbox.live.drain(..).collect();
                for i in (1..v.len()).rev() {
                    v.swap(i, rng.gen_range(0..=i));
                }
                inbox.live.extend(v);
                format!("{who}'s live queue is reordered")
            }
            67..=81 => {
                w.recover(side);
                format!("{who} runs recovery")
            }
            82..=86 => {
                let (me, _, _, _) = w.parts(side);
                me.restart_process();
                format!("{who}'s process restarts")
            }
            87..=88 => {
                let (me, them, _, _) = w.parts(side);
                let path = me.record_path(&them.id);
                let _ = std::fs::write(path, b"corrupt");
                format!("{who}'s session record is corrupted")
            }
            89 => {
                let (me, _, _, _) = w.parts(side);
                let _ = std::fs::remove_file(me.control_path());
                format!("{who} loses its prekeys")
            }
            _ => {
                let jump = match rng.gen_range(0..10) {
                    0..=5 => rng.gen_range(1..30 * 60 * 1000),
                    6..=8 => rng.gen_range(HOUR..6 * HOUR),
                    _ => rng.gen_range(DAY..4 * DAY),
                };
                w.now += jump;
                format!("clock +{}m", jump / 60_000)
            }
        };
        w.log.push(format!("{step:>3}: {event}"));
    }

    // Quiesce: the app behaving normally, an hour at a time, for up to three days.
    for round in 0..72 {
        for side in [true, false] {
            w.recover(side);
        }
        for side in [true, false] {
            w.send(side, 0);
            w.sync(side);
        }
        for side in [true, false] {
            w.read_live(side);
            w.read_slots(side);
        }
        if w.agreed_and_talking() {
            return;
        }
        w.log.push(format!("quiesce round {round}: not yet"));
        w.now += HOUR;
    }
    panic!(
        "seed {seed}: after three days of normal operation the pair is still not on one session\n{}",
        w.log.join("\n")
    );
}

#[test]
fn randomized_sessions_always_converge() {
    // Override with SC_RESTART_CASES / SC_RESTART_SEED to explore further or replay a failure.
    let cases: u64 = std::env::var("SC_RESTART_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    if let Some(seed) = std::env::var("SC_RESTART_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        run_random_case(seed, 80);
        return;
    }
    for seed in 0..cases {
        run_random_case(seed, 80);
    }
}
