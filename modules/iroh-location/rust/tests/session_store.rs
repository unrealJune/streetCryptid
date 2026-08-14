//! Tests for the encrypted, single-writer ratchet session store.
//!
//! The two properties that matter are the two the design turns on: a second writer in this
//! process is REFUSED (FORWARD-SECRECY.md §4.2 — with sequential state, a second writer is key
//! reuse, not a clobber), and a blob that cannot be read is an ERROR rather than a fresh session
//! (silently restarting at counter zero reuses values the peer has already seen).

use std::path::PathBuf;

use iroh_location::ratchet::{RatchetKeySource, RatchetState, KEY_LEN, SESSION_ID_LEN};
use iroh_location::session_store::{SessionStore, StoreError};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

struct FixedKeys(u8, u32);

impl RatchetKeySource for FixedKeys {
    fn next_ratchet_secret(&mut self) -> XStaticSecret {
        let mut raw = [0u8; KEY_LEN];
        raw[0] = self.0;
        raw[1..5].copy_from_slice(&self.1.to_le_bytes());
        self.1 += 1;
        XStaticSecret::from(raw)
    }
}

const IDENTITY: &[u8] = b"an identity secret, 32 bytes ok!";
const PEER: &[u8] = &[0xbb; 32];
const OTHER_PEER: &[u8] = &[0xcc; 32];

/// A unique scratch directory per test, so the process-wide claim in one test cannot collide with
/// another's. Removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sc-session-store-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn a_session() -> RatchetState {
    let b_boot = XStaticSecret::from([0xB0; KEY_LEN]);
    let b_pub = XPublicKey::from(&b_boot).to_bytes();
    let mut keys = FixedKeys(0xA0, 0);
    RatchetState::bootstrap_initiator([1u8; SESSION_ID_LEN], [7u8; KEY_LEN], b_pub, 0, &mut keys)
        .unwrap()
}

#[test]
fn a_saved_session_round_trips_and_keeps_producing_the_same_keys() {
    let scratch = Scratch::new("roundtrip");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();

    let mut original = a_session();
    store.save(PEER, &original).unwrap();

    let mut loaded = store.load(PEER).unwrap().expect("session was saved");
    let expected = original.next_send().unwrap();
    let got = loaded.next_send().unwrap();
    assert_eq!(expected.header, got.header);
    assert_eq!(expected.kid, got.kid);
    assert_eq!(
        expected.key.use_once(|k| *k),
        got.key.use_once(|k| *k),
        "a reloaded session must continue the same schedule"
    );
}

#[test]
fn an_absent_session_is_none_not_an_error() {
    let scratch = Scratch::new("absent");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();
    assert!(store.load(PEER).unwrap().is_none());
}

#[test]
fn a_second_writer_in_this_process_is_refused() {
    // THE guard. expo-task-manager gives each headless callback a fresh JS context, so the
    // JS-side claim cannot see across them; this refusal is what actually stops two writers.
    let scratch = Scratch::new("second-writer");
    let first = SessionStore::open(&scratch.0, IDENTITY).unwrap();

    let second = SessionStore::open(&scratch.0, IDENTITY);
    assert!(
        matches!(second, Err(StoreError::AlreadyOpen)),
        "a second writer must be refused, got {second:?}"
    );

    // ...and a clean shutdown releases it, or the app could never restart its own node.
    drop(first);
    let reopened = SessionStore::open(&scratch.0, IDENTITY);
    assert!(reopened.is_ok(), "the claim must be released on drop");
}

#[test]
fn the_blob_is_not_plaintext_on_disk() {
    let scratch = Scratch::new("encrypted");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();
    let state = a_session();
    let plaintext = state.to_bytes();
    store.save(PEER, &state).unwrap();

    let on_disk = std::fs::read(scratch.0.join("sessions").join(format!(
        "{}.bin",
        PEER.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )))
    .unwrap();

    assert_ne!(on_disk, plaintext);
    // The chain keys must not appear verbatim anywhere in the file.
    assert!(
        !on_disk
            .windows(KEY_LEN)
            .any(|w| w == &plaintext[1 + SESSION_ID_LEN..1 + SESSION_ID_LEN + KEY_LEN]),
        "the root key appears in cleartext on disk"
    );
}

#[test]
fn a_blob_cannot_be_moved_onto_another_friends_session() {
    // The AAD binds the peer id, so renaming one friend's file over another's fails to
    // authenticate rather than silently installing the wrong session.
    let scratch = Scratch::new("peer-bound");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();
    store.save(PEER, &a_session()).unwrap();

    let sessions = scratch.0.join("sessions");
    let hex = |p: &[u8]| p.iter().map(|b| format!("{b:02x}")).collect::<String>();
    std::fs::copy(
        sessions.join(format!("{}.bin", hex(PEER))),
        sessions.join(format!("{}.bin", hex(OTHER_PEER))),
    )
    .unwrap();

    assert!(matches!(store.load(OTHER_PEER), Err(StoreError::Cipher)));
}

#[test]
fn another_identity_cannot_read_the_store() {
    let scratch = Scratch::new("wrong-identity");
    {
        let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();
        store.save(PEER, &a_session()).unwrap();
    }
    let other = SessionStore::open(&scratch.0, b"a DIFFERENT identity secret !!!!").unwrap();
    assert!(matches!(other.load(PEER), Err(StoreError::Cipher)));
}

#[test]
fn a_corrupt_blob_is_an_error_never_a_fresh_session() {
    // If this returned Ok(None) the caller would bootstrap at counter zero and reuse every value
    // the peer has already seen. It has to be loud.
    let scratch = Scratch::new("corrupt");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();
    store.save(PEER, &a_session()).unwrap();

    let path = scratch.0.join("sessions").join(format!(
        "{}.bin",
        PEER.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    let mut raw = std::fs::read(&path).unwrap();
    let last = raw.len() - 1;
    raw[last] ^= 0xff;
    std::fs::write(&path, &raw).unwrap();

    assert!(matches!(store.load(PEER), Err(StoreError::Cipher)));

    // Truncation likewise.
    std::fs::write(&path, [0u8; 4]).unwrap();
    assert!(matches!(store.load(PEER), Err(StoreError::Malformed)));
}

#[test]
fn saving_twice_leaves_no_temporary_file_behind() {
    // The write-then-rename path must not litter, or the sessions dir grows a .tmp per publish.
    let scratch = Scratch::new("no-litter");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();
    store.save(PEER, &a_session()).unwrap();
    store.save(PEER, &a_session()).unwrap();

    let leftovers: Vec<_> = std::fs::read_dir(scratch.0.join("sessions"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temporary files were left behind");
}

#[test]
fn a_rolled_back_state_file_reissues_a_counter_that_was_already_spent() {
    // This is the failure `save()`'s fsync exists to prevent, written down as an executable
    // statement of *why* it is there.
    //
    // A power loss between `save()` returning Ok and the data reaching stable storage leaves the
    // previous blob on disk. `next_wraps` has already treated that Ok as "the counter is durable,
    // it is safe to seal", so the next boot re-derives the same position — and in v3 that message
    // key seals a different content key under the same zero nonce, which is the (key, nonce)
    // reuse the whole design exists to prevent.
    //
    // The test simulates the rollback directly, because a real power loss is not reproducible in
    // process. What it pins is the consequence: nothing downstream detects it, so durability at
    // the write is the only thing standing between us and this.
    let scratch = Scratch::new("rollback");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();
    store.save(PEER, &a_session()).unwrap();

    let path = scratch.0.join("sessions").join(format!(
        "{}.bin",
        PEER.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    let snapshot = std::fs::read(&path).unwrap();

    // Spend a counter and persist it, exactly as a publish would.
    let mut state = store.load(PEER).unwrap().unwrap();
    let spent = state.next_send().unwrap();
    let spent_kid = spent.kid;
    let spent_key = spent.key.use_once(|k| *k);
    store.save(PEER, &state).unwrap();

    // ...then roll the file back to before that save, the way a lost page cache would.
    std::fs::write(&path, &snapshot).unwrap();

    let mut rolled_back = store.load(PEER).unwrap().unwrap();
    let reissued = rolled_back.next_send().unwrap();
    assert_eq!(
        reissued.kid, spent_kid,
        "a rolled-back state re-derives the same ratchet position"
    );
    assert_eq!(
        reissued.key.use_once(|k| *k),
        spent_key,
        "and hands out a message key that has already sealed a wrap — the exact (key, nonce) \
         reuse `save()` must fsync to make unreachable"
    );
}

#[test]
fn a_saved_session_is_on_disk_before_save_returns() {
    // The persist-before-publish contract is about *durability*, not visibility, and the part a
    // test can hold is that `save` is fully synchronous: when it returns, the bytes are readable
    // through a completely independent handle, with no buffering left in flight.
    let scratch = Scratch::new("durable");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();

    let mut state = a_session();
    let slot = state.next_send().unwrap();
    store.save(PEER, &state).unwrap();

    let path = scratch.0.join("sessions").join(format!(
        "{}.bin",
        PEER.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    let raw = std::fs::read(&path).expect("the blob must exist the moment save() returns");
    assert!(!raw.is_empty());

    // And the persisted state must be the *advanced* one — persisting the pre-step state would
    // hand the same counter out twice on the next load.
    let mut reloaded = store.load(PEER).unwrap().unwrap();
    let next = reloaded.next_send().unwrap();
    assert_ne!(
        next.kid, slot.kid,
        "the saved state must be the one that already spent the counter"
    );
}

#[test]
fn a_removed_session_is_gone_and_removing_twice_is_fine() {
    let scratch = Scratch::new("remove");
    let store = SessionStore::open(&scratch.0, IDENTITY).unwrap();
    store.save(PEER, &a_session()).unwrap();

    store.remove(PEER).unwrap();
    assert!(store.load(PEER).unwrap().is_none());
    // Revocation runs on paths that may already have cleaned up; it must be idempotent.
    store.remove(PEER).unwrap();
}
