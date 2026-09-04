//! Tests for the single-writer publish counter.
//!
//! The properties here are the ones the design turns on, and each maps to a way `seq` was
//! previously able to be re-issued from JS: the value is durable *before* it is returned (a
//! process killed mid-publish must not hand the same `author/seq` out twice), a second writer in
//! this process is REFUSED (two headless JS contexts each held their own counter), and a file that
//! cannot be parsed is an ERROR rather than a fresh start at zero (which would re-issue every
//! value this device has ever published).

use std::path::PathBuf;

use iroh_location::seq_store::{SeqError, SeqStore};

/// A unique scratch directory per test, so the process-wide claim in one test cannot collide with
/// another's. Removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sc-seq-store-{name}"));
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

#[test]
fn starts_at_zero_and_hands_out_one_first() {
    let scratch = Scratch::new("fresh");
    let store = SeqStore::open(&scratch.0).unwrap();

    assert_eq!(
        store.current(),
        0,
        "a device that has never published is at 0"
    );
    assert_eq!(store.next().unwrap(), 1);
    assert_eq!(store.next().unwrap(), 2);
    assert_eq!(store.current(), 2);
}

#[test]
fn the_value_is_on_disk_before_next_returns() {
    // The whole invariant: the caller puts the returned value on the wire, so a kill between the
    // return and the next save must not be able to re-issue it.
    let scratch = Scratch::new("durable-before-return");
    let store = SeqStore::open(&scratch.0).unwrap();

    let handed_out = store.next().unwrap();
    let on_disk = std::fs::read_to_string(scratch.0.join("seq").join("counter")).unwrap();

    assert_eq!(on_disk.trim(), handed_out.to_string());
}

#[test]
fn a_reopened_store_never_re_issues() {
    let scratch = Scratch::new("reopen");
    {
        let store = SeqStore::open(&scratch.0).unwrap();
        store.next().unwrap();
        store.next().unwrap();
        store.next().unwrap();
    }
    let reopened = SeqStore::open(&scratch.0).unwrap();

    assert_eq!(reopened.current(), 3);
    assert_eq!(
        reopened.next().unwrap(),
        4,
        "continues, rather than restarting"
    );
}

#[test]
fn a_second_live_writer_is_refused() {
    // This is the case JS structurally could not prevent: expo-task-manager gives each headless
    // callback a fresh context, so each got its own cached counter and each handed out n + 1.
    let scratch = Scratch::new("second-writer");
    let _first = SeqStore::open(&scratch.0).unwrap();

    match SeqStore::open(&scratch.0) {
        Err(SeqError::AlreadyOpen) => {}
        other => panic!("expected AlreadyOpen, got {other:?}"),
    }
}

#[test]
fn the_claim_is_released_on_drop_so_a_clean_restart_reopens() {
    let scratch = Scratch::new("claim-release");
    {
        let _first = SeqStore::open(&scratch.0).unwrap();
    }
    assert!(
        SeqStore::open(&scratch.0).is_ok(),
        "a refusal that outlived the writer would brick the node after every shutdown"
    );
}

#[test]
fn a_malformed_counter_is_an_error_not_a_fresh_start() {
    let scratch = Scratch::new("malformed");
    {
        let store = SeqStore::open(&scratch.0).unwrap();
        store.seed(9_000).unwrap();
    }
    std::fs::write(scratch.0.join("seq").join("counter"), "not a number").unwrap();

    match SeqStore::open(&scratch.0) {
        Err(SeqError::Malformed) => {}
        other => panic!("expected Malformed, got {other:?} — reading it as 0 re-issues everything"),
    }
}

#[test]
fn seed_raises_but_never_lowers() {
    let scratch = Scratch::new("seed");
    let store = SeqStore::open(&scratch.0).unwrap();

    assert!(
        store.seed(500).unwrap(),
        "an unseen floor moves the counter"
    );
    assert_eq!(store.current(), 500);

    assert!(
        !store.seed(500).unwrap(),
        "seeding the same floor twice is a no-op"
    );
    assert!(
        !store.seed(12).unwrap(),
        "a floor below us must never rewind"
    );
    assert_eq!(store.current(), 500);
    assert_eq!(store.next().unwrap(), 501);
}

#[test]
fn a_seeded_floor_survives_reopen() {
    // The migration path: JS reads the old SecureStore value once and seeds it. If that did not
    // persist, the next launch would restart below values already published under the old scheme.
    let scratch = Scratch::new("seed-persist");
    {
        let store = SeqStore::open(&scratch.0).unwrap();
        store.seed(8_706).unwrap();
    }
    let reopened = SeqStore::open(&scratch.0).unwrap();

    assert_eq!(reopened.current(), 8_706);
    assert_eq!(reopened.next().unwrap(), 8_707);
}
