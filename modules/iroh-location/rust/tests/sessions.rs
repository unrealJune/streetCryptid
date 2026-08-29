//! Tests for the recovery half of `SessionManager` — §4.6's detection and resync rules.
//!
//! `ratchet_integration.rs` and `ratchet_conditions.rs` drive whole nodes over real transport;
//! this file drives the manager directly, because the properties here are about what happens when
//! storage or the stash misbehaves, and neither is reachable by being a well-behaved peer.
//!
//! The cases:
//!
//! * a state file that will not decrypt must report **desynced**, not "no session" — it is the one
//!   cause of desync that miss-counting structurally cannot see;
//! * a peer lapsed past `T_lapse` must report **desynced** for the same structural reason, because
//!   a mutual lapse produces no envelopes to miss and sustains itself indefinitely;
//! * a resync record may only replace a session **older than itself**, so a record replayed out of
//!   the stash after a restart cannot restart a working session;
//! * the freshness bound and the re-mint interval must stay in the relationship that keeps a
//!   published record usable.

use std::path::PathBuf;

use iroh_location::ratchet::{KEY_LEN, SESSION_ID_LEN};
use iroh_location::session_store::SessionStore;
use iroh_location::sessions::{SessionManager, RESYNC_FRESHNESS_MS, RESYNC_REMINT_MS};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

const IDENTITY: &[u8] = b"an identity secret, 32 bytes ok!";
const PEER: &[u8] = &[0xbb; 32];

/// A unique scratch directory per test — `SessionStore` holds a process-wide writer claim, so two
/// tests sharing a directory would refuse each other rather than run.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sc-sessions-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn manager(&self) -> SessionManager {
        SessionManager::new(SessionStore::open(&self.0, IDENTITY).unwrap())
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

/// A peer ephemeral public key, as a resync record would carry.
fn peer_ephemeral(tag: u8) -> [u8; KEY_LEN] {
    XPublicKey::from(&XStaticSecret::from([tag; KEY_LEN])).to_bytes()
}

/// Install a session the way an accepted resync record would.
fn apply(manager: &SessionManager, nonce: u8, ts: u64, now_ms: u64) -> bool {
    manager
        .apply_resync(
            PEER,
            [nonce; 16],
            ts,
            [nonce; SESSION_ID_LEN],
            [nonce; KEY_LEN],
            peer_ephemeral(nonce),
            None, // initiator side: we mint our own ratchet key
            now_ms,
        )
        .unwrap()
}

#[test]
fn an_unreadable_state_file_reports_desynced_rather_than_unbootstrapped() {
    // §4.6 names storage corruption as an expected cause of desync, and it is the one cause miss
    // counting cannot reach: every `open` fails at the load, so no miss is ever recorded and the
    // threshold is never crossed. Collapsing the load error into "no session" would report a
    // broken session as one waiting for a bump — the opposite of the truth, and the difference
    // between "resync this" and "go and meet your friend again".
    let scratch = Scratch::new("corrupt-desync");
    let manager = scratch.manager();

    assert!(apply(&manager, 1, 1_000, 1_000), "record should apply");
    assert!(manager.has_session(PEER));
    assert!(
        !manager.is_desynced(PEER, 1_000),
        "a freshly installed session is healthy"
    );

    // Corrupt the blob behind the manager's back, as storage failure or a partial restore would.
    let path = scratch.blob_path();
    let mut raw = std::fs::read(&path).unwrap();
    let last = raw.len() - 1;
    raw[last] ^= 0xff;
    std::fs::write(&path, &raw).unwrap();

    assert!(
        !manager.has_session(PEER),
        "a blob that will not decrypt is not a usable session"
    );
    assert!(
        manager.is_desynced(PEER, 1_000),
        "...but it IS a desync, and must be visible as one so recovery can run"
    );
}

#[test]
fn a_lapsed_peer_reports_desynced_so_recovery_can_break_a_mutual_lapse() {
    // The failure this exists to prevent, observed in the field: two paired phones each past
    // `T_lapse` for the other, both publishing fixes every few minutes, every fix sealed for zero
    // recipients, for ~22 hours.
    //
    // It sustains itself by construction. `next_wraps` drops a lapsed recipient before deriving a
    // slot, so they receive nothing; `peer_advanced_ms` only moves when an envelope from them is
    // accepted. Nothing arrives, so no miss is recorded and the miss threshold is never crossed —
    // and the state file is perfectly readable, so the damaged-file route does not fire either.
    // Both existing routes into §4.6 are structurally unreachable, which is exactly why lapse
    // needs its own.
    let scratch = Scratch::new("lapsed-desync");
    let manager = scratch.manager().with_t_lapse_ms(10_000);

    assert!(apply(&manager, 1, 1_000, 1_000), "record should apply");
    assert!(
        !manager.is_desynced(PEER, 5_000),
        "inside T_lapse the session is healthy"
    );

    assert!(
        manager.has_session(PEER),
        "the state file is intact — this is not the damaged-file case"
    );
    assert!(
        manager.is_desynced(PEER, 11_000),
        "past T_lapse the session must be visible to the resync driver, or nothing ever clears it"
    );

    // And recovery genuinely resolves it: a fresh record re-roots the session and stamps
    // `peer_advanced_ms` at the bootstrap, so the lapse is gone rather than merely reported.
    assert!(
        apply(&manager, 2, 11_000, 11_000),
        "recovery record applies"
    );
    assert!(
        !manager.is_desynced(PEER, 11_500),
        "a resync must actually clear the lapse, not just re-report it next tick"
    );
}

#[test]
fn a_peer_we_never_bootstrapped_is_not_desynced() {
    // The other side of the distinction above: nothing on disk means there is no session to be
    // out of step with. Reporting desynced here would send the resync driver after a peer whose
    // actual problem is that the two humans have not met yet.
    let scratch = Scratch::new("absent-not-desynced");
    let manager = scratch.manager();

    assert!(!manager.has_session(PEER));
    assert!(!manager.is_desynced(PEER, 1_000));
}

#[test]
fn a_replayed_resync_record_cannot_restart_a_working_session() {
    // The stash is modelled as hostile, keeps whatever versions of the `rsy` slot it likes, and
    // `seen_nonces` lives in memory by design — so after a restart every record inside the
    // freshness window looks new again. Without a durable bound this is a free denial of service
    // against any pair the stash chooses: replay, and a healthy session restarts.
    let scratch = Scratch::new("resync-replay");
    let now = 10_000_000;

    let first_session = {
        let manager = scratch.manager();
        assert!(apply(&manager, 1, now - 5_000, now), "first resync applies");
        assert!(
            !apply(&manager, 1, now - 5_000, now),
            "the same record twice is a no-op within one process (in-memory nonce dedup)"
        );
        session_fingerprint(&scratch)
    }; // manager dropped: the process-restart boundary, and with it the nonce set

    let manager = scratch.manager();
    assert!(
        !apply(&manager, 1, now - 5_000, now),
        "a record replayed after a restart must NOT restart the session — it is not newer than \
         the one that created it"
    );
    assert_eq!(
        session_fingerprint(&scratch),
        first_session,
        "the working session must be untouched by the replay"
    );

    // A genuinely newer record is still accepted, or the bound would break recovery instead of
    // protecting it.
    assert!(
        apply(&manager, 2, now - 1_000, now),
        "a newer record must still be able to restart the session"
    );
    assert_ne!(
        session_fingerprint(&scratch),
        first_session,
        "a newer record installs a different session"
    );
}

#[test]
fn a_stale_record_is_refused_without_being_an_error() {
    // Refusal is ordinary, not alarming: the stash can serve an old record from the overwritten
    // slot at any time.
    let scratch = Scratch::new("resync-stale");
    let manager = scratch.manager();
    let now = 10_000_000;

    assert!(
        !apply(&manager, 1, now - RESYNC_FRESHNESS_MS - 1, now),
        "a record older than the freshness window is refused"
    );
    assert!(
        !manager.has_session(PEER),
        "and installs nothing while refusing"
    );
}

#[test]
fn the_remint_interval_stays_inside_the_freshness_window() {
    // These two constants only mean anything in relation to each other. If the re-mint interval
    // ever reached the freshness window, a record would expire before it was replaced and
    // `publish_resync` would be back to republishing bytes the peer refuses — the permanent
    // resync deadlock, reintroduced by a constant edit.
    // `const` blocks, so a constant edit that breaks the relationship fails to *compile* rather
    // than waiting for someone to run the suite.
    const {
        assert!(
            RESYNC_REMINT_MS < RESYNC_FRESHNESS_MS,
            "a re-minted record must be published while the previous one is still acceptable"
        )
    };
    const {
        assert!(
            RESYNC_REMINT_MS <= RESYNC_FRESHNESS_MS / 2,
            "and with at least half the window of validity ahead of it, so there is no gap \
             where what we have published is already unusable"
        )
    };
}

/// The on-disk session blob, as an opaque identity. Enough to tell "this session was replaced"
/// from "this session was left alone" without reaching into `RatchetState`'s private fields.
fn session_fingerprint(scratch: &Scratch) -> Vec<u8> {
    std::fs::read(scratch.blob_path()).unwrap()
}
