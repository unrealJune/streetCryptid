//! Tests for `SessionManager`'s verdicts — §4.6's ways into "this session needs a restart" — on
//! one device, with no peer.
//!
//! `restart_protocol.rs` drives the whole restart exchange between participants; this file pins
//! what one device concludes from what is on its own disk, because those are the cases a
//! well-behaved peer cannot produce:
//!
//! * a state file that will not decrypt must report **broken**, not "no session" — it is the one
//!   cause of desync that miss-counting structurally cannot see;
//! * a peer lapsed past `T_lapse` must report **broken** for the same structural reason, because
//!   a mutual lapse produces no envelopes to miss and sustains itself indefinitely;
//! * a follower with no sending chain for an hour must report **broken** — the state a Pixel sat
//!   in for a day on 2026-10-02/03 while nothing called it anything;
//! * nothing on disk is **not** broken: the fix for that is a pairing, not a restart.

use std::path::PathBuf;

use iroh_location::ratchet::{KEY_LEN, SESSION_ID_LEN};
use iroh_location::session_store::SessionStore;
use iroh_location::sessions::{Broken, Health, Role, SessionManager, STUCK_NO_SEND_MS};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

const IDENTITY: &[u8] = b"an identity secret, 32 bytes ok!";
/// Lower than every peer below, so this device leads them all...
const LEADER_SELF: [u8; 32] = [0x01; 32];
/// ...and higher than every peer below, so this device follows them all.
const FOLLOWER_SELF: [u8; 32] = [0xfe; 32];
const PEER: &[u8] = &[0xbb; 32];

/// A unique scratch directory per test — `SessionStore` holds a process-wide writer claim, so two
/// tests sharing a directory would refuse each other rather than run.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sc-sessions-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn manager(&self, self_id: [u8; 32]) -> SessionManager {
        SessionManager::new(SessionStore::open(&self.0, IDENTITY).unwrap(), self_id)
    }

    fn blob_path(&self) -> PathBuf {
        self.0.join("sessions").join(format!(
            "{}.bin",
            PEER.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Install a paired session as the leader (initiator): it can send at once.
fn pair_as_leader(manager: &SessionManager, now_ms: u64) {
    let eph = XStaticSecret::from([7u8; KEY_LEN]);
    manager
        .bootstrap(
            PEER,
            [1; SESSION_ID_LEN],
            [2; KEY_LEN],
            XPublicKey::from(&eph).to_bytes(),
            now_ms,
        )
        .unwrap();
}

/// Install a paired session as the follower (responder): no sending chain until the leader's
/// first envelope lands.
fn pair_as_follower(manager: &SessionManager, now_ms: u64) {
    manager
        .bootstrap_responder(
            PEER,
            [1; SESSION_ID_LEN],
            [2; KEY_LEN],
            XStaticSecret::from([7u8; KEY_LEN]),
            now_ms,
        )
        .unwrap();
}

#[test]
fn roles_follow_endpoint_order() {
    let scratch = Scratch::new("roles");
    assert_eq!(scratch.manager(LEADER_SELF).role(PEER), Role::Leader);
    drop(scratch);
    let scratch = Scratch::new("roles-2");
    assert_eq!(scratch.manager(FOLLOWER_SELF).role(PEER), Role::Follower);
}

#[test]
fn an_unreadable_state_file_reports_broken_rather_than_unpaired() {
    // §4.6 names storage corruption as an expected cause of desync, and it is the one cause miss
    // counting cannot reach: every `open` fails at the load, so no miss is ever recorded. Calling
    // it "no session" would send the humans back to an in-person bump for a fault a restart fixes.
    let scratch = Scratch::new("corrupt");
    let manager = scratch.manager(LEADER_SELF);
    pair_as_leader(&manager, 1_000);
    assert_eq!(manager.assess(PEER, 1_000).health, Health::Healthy);

    let path = scratch.blob_path();
    let mut raw = std::fs::read(&path).unwrap();
    let last = raw.len() - 1;
    raw[last] ^= 0xff;
    std::fs::write(&path, &raw).unwrap();

    assert!(
        !manager.has_session(PEER),
        "a blob that will not decrypt is not a usable session"
    );
    assert_eq!(
        manager.assess(PEER, 1_000).health,
        Health::Broken(Broken::Damaged),
        "...but it IS broken, and must be visible as such so recovery can run"
    );
    assert!(manager.is_desynced(PEER, 1_000));
}

#[test]
fn a_lapsed_peer_reports_broken_so_recovery_can_break_a_mutual_lapse() {
    // Observed in the field: two paired phones each past `T_lapse` for the other, both publishing
    // every few minutes, every fix sealed for zero recipients, for ~22 hours. Nothing arrives, so
    // no miss is recorded; the file is readable, so the damaged route does not fire either.
    let scratch = Scratch::new("lapsed");
    let manager = scratch.manager(LEADER_SELF).with_t_lapse_ms(10_000);
    pair_as_leader(&manager, 1_000);
    assert_eq!(manager.assess(PEER, 5_000).health, Health::Healthy);
    assert!(manager.has_session(PEER), "the file is intact");
    assert_eq!(
        manager.assess(PEER, 11_000).health,
        Health::Broken(Broken::Lapsed)
    );
}

#[test]
fn a_follower_without_a_sending_chain_for_an_hour_reports_broken() {
    let scratch = Scratch::new("stuck");
    let manager = scratch.manager(FOLLOWER_SELF);
    let t = 1_790_000_000_000;
    pair_as_follower(&manager, t);
    assert_eq!(
        manager.assess(PEER, t + STUCK_NO_SEND_MS - 1).health,
        Health::Healthy,
        "waiting for the leader's first envelope is a moment, not a fault"
    );
    assert_eq!(
        manager.assess(PEER, t + STUCK_NO_SEND_MS).health,
        Health::Broken(Broken::StuckNoSend)
    );
}

#[test]
fn a_leader_without_a_sending_chain_is_not_stuck() {
    // Only a follower waits for the other side. A leader always holds a sending chain; the
    // verdict is about the follower's state and must not leak onto the leader's.
    let scratch = Scratch::new("leader-not-stuck");
    let manager = scratch.manager(LEADER_SELF);
    let t = 1_790_000_000_000;
    pair_as_leader(&manager, t);
    assert_eq!(
        manager.assess(PEER, t + 10 * STUCK_NO_SEND_MS).health,
        Health::Healthy
    );
}

#[test]
fn a_peer_we_never_paired_is_not_broken() {
    // Nothing on disk means there is no session to be out of step with. Reporting broken here
    // would send recovery after a peer whose actual problem is that the two humans have not met.
    let scratch = Scratch::new("absent");
    let manager = scratch.manager(LEADER_SELF);
    assert!(!manager.has_session(PEER));
    assert_eq!(manager.assess(PEER, 1_000).health, Health::NoSession);
    assert!(!manager.is_desynced(PEER, 1_000));
}

#[test]
fn a_re_pair_resets_what_the_leader_has_answered() {
    // A follower's request counter is its own clock, and nothing it asked for under an old
    // relationship is owed under a new one — nor may an old answer swallow a new request.
    let scratch = Scratch::new("repair-answered");
    let manager = scratch.manager(LEADER_SELF);
    pair_as_leader(&manager, 1_000);
    assert_eq!(manager.assess(PEER, 1_000).answered_request_ts, 0);
    pair_as_leader(&manager, 2_000);
    assert_eq!(manager.assess(PEER, 2_000).answered_request_ts, 0);
}
