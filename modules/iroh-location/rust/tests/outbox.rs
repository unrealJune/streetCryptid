//! Tests for the native pending-fix queue and the sharing set it seals for.
//!
//! Both exist so the drain path can run with no JS context alive. The properties asserted here are
//! the ones that decide whether a phone that has been unable to publish for hours recovers
//! gracefully or corrupts a trail: order is preserved, the bound discards the oldest, a fix is only
//! removed once it is actually published, and the sharing set fails closed rather than wide.

use std::path::PathBuf;

use iroh_location::outbox::{Outbox, OutboxError, MAX_ITEMS};
use iroh_location::recipients::{RecipientStore, RecipientsError};
use iroh_location::LocationFix;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sc-outbox-{name}"));
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

fn fix(ts: u64) -> LocationFix {
    LocationFix {
        lat: 47.6 + ts as f64 / 1e6,
        lon: -122.3,
        accuracy_m: 8.0,
        heading_deg: 0.0,
        ts,
    }
}

#[test]
fn drains_in_capture_order() {
    // `seq` is assigned at publish time, so draining out of order would file a later capture under
    // an earlier sequence number and a receiver would watch the device jump backwards.
    let scratch = Scratch::new("order");
    let outbox = Outbox::open(&scratch.0).unwrap();
    for ts in [100, 200, 300] {
        outbox.enqueue(fix(ts)).unwrap();
    }

    let mut drained = Vec::new();
    while let Some(next) = outbox.peek() {
        drained.push(next.ts);
        outbox.commit().unwrap();
    }

    assert_eq!(drained, vec![100, 200, 300]);
    assert_eq!(outbox.pending(), 0);
}

#[test]
fn a_queued_fix_survives_reopen() {
    // The entire reason this is not a Vec in memory: the process that captured the fix is usually
    // not the one that gets to publish it.
    let scratch = Scratch::new("durable");
    {
        let outbox = Outbox::open(&scratch.0).unwrap();
        outbox.enqueue(fix(100)).unwrap();
        outbox.enqueue(fix(200)).unwrap();
    }
    let reopened = Outbox::open(&scratch.0).unwrap();

    assert_eq!(reopened.pending(), 2);
    assert_eq!(reopened.peek().unwrap().ts, 100);
}

#[test]
fn peek_leaves_the_fix_queued_until_it_is_committed() {
    // A crash between publishing and committing must cost a duplicate, not a loss: the durable
    // slot is last-write-wins on (author, seq), so a re-publish is invisible while a dropped fix
    // is a hole in someone's trail.
    let scratch = Scratch::new("peek");
    {
        let outbox = Outbox::open(&scratch.0).unwrap();
        outbox.enqueue(fix(100)).unwrap();
        assert_eq!(outbox.peek().unwrap().ts, 100);
        assert_eq!(outbox.pending(), 1, "peek must not consume");
    }
    assert_eq!(Outbox::open(&scratch.0).unwrap().pending(), 1);
}

#[test]
fn commit_on_an_empty_queue_cannot_remove_an_unpublished_fix() {
    let scratch = Scratch::new("double-commit");
    let outbox = Outbox::open(&scratch.0).unwrap();
    outbox.enqueue(fix(100)).unwrap();

    outbox.commit().unwrap();
    outbox.commit().unwrap(); // a retried drain
    outbox.enqueue(fix(200)).unwrap();

    assert_eq!(outbox.peek().unwrap().ts, 200);
}

#[test]
fn the_bound_discards_the_oldest_and_says_how_many() {
    // A real Pixel reached 445 pending in an 11-hour blackout. Which end we discard is the
    // difference between losing trail resolution and losing the friend's current position.
    let scratch = Scratch::new("overflow");
    let outbox = Outbox::open(&scratch.0).unwrap();
    for ts in 0..MAX_ITEMS as u64 {
        let outcome = outbox.enqueue(fix(ts)).unwrap();
        assert_eq!(outcome.overflow_dropped, 0);
    }

    let outcome = outbox.enqueue(fix(9_999)).unwrap();

    assert_eq!(outcome.overflow_dropped, 1);
    assert_eq!(outcome.pending, MAX_ITEMS as u32);
    assert_eq!(
        outbox.peek().unwrap().ts,
        1,
        "the oldest went, not the newest"
    );
}

#[test]
fn an_unreadable_queue_starts_empty_rather_than_bricking_the_node() {
    // The opposite of the seq counter's rule, deliberately: unreadable pending fixes are already
    // lost, and refusing to start would turn that into a device that never publishes again.
    let scratch = Scratch::new("corrupt");
    {
        let outbox = Outbox::open(&scratch.0).unwrap();
        outbox.enqueue(fix(100)).unwrap();
    }
    std::fs::write(
        scratch.0.join("outbox").join("queue"),
        b"\xff\xff not postcard",
    )
    .unwrap();

    let reopened = Outbox::open(&scratch.0).unwrap();
    assert_eq!(reopened.pending(), 0);
    assert!(reopened.enqueue(fix(200)).is_ok(), "and it still works");
}

#[test]
fn a_second_live_outbox_is_refused() {
    let scratch = Scratch::new("second-writer");
    let _first = Outbox::open(&scratch.0).unwrap();

    match Outbox::open(&scratch.0) {
        Err(OutboxError::AlreadyOpen) => {}
        other => panic!("expected AlreadyOpen, got {other:?}"),
    }
}

#[test]
fn recipients_round_trip_and_normalise() {
    let scratch = Scratch::new("recipients");
    let store = RecipientStore::open(&scratch.0).unwrap();
    assert!(
        store.get().is_empty(),
        "a device that shares with nobody yet"
    );

    store
        .set(&["BB11".into(), "aa22".into(), "bb11".into()])
        .unwrap();

    // Lowercased so a comparison against a session key cannot miss on case, sorted and deduped so
    // the same set never persists two different ways.
    assert_eq!(store.get(), vec!["aa22".to_string(), "bb11".to_string()]);
    assert_eq!(RecipientStore::open(&scratch.0).unwrap().get(), store.get());
}

#[test]
fn a_rejected_recipient_list_leaves_the_previous_one_intact() {
    // Validation before the write. Half-applying a list would seal for an arbitrary prefix of it.
    let scratch = Scratch::new("recipients-reject");
    let store = RecipientStore::open(&scratch.0).unwrap();
    store.set(&["aa11".into()]).unwrap();

    match store.set(&["aa11".into(), "not-hex".into()]) {
        Err(RecipientsError::Malformed) => {}
        other => panic!("expected Malformed, got {other:?}"),
    }
    assert_eq!(store.get(), vec!["aa11".to_string()]);
}

#[test]
fn an_unreadable_recipient_list_fails_closed() {
    // Guessing wide would seal for someone the user may have removed. Empty publishes to nobody
    // until JS pushes the real list — a visible gap rather than a silent leak.
    let scratch = Scratch::new("recipients-corrupt");
    {
        RecipientStore::open(&scratch.0)
            .unwrap()
            .set(&["aa11".into(), "bb22".into()])
            .unwrap();
    }
    std::fs::write(
        scratch.0.join("recipients").join("sharing"),
        "@@@@\nnot hex either",
    )
    .unwrap();

    assert!(RecipientStore::open(&scratch.0).unwrap().get().is_empty());
}

#[test]
fn sharing_and_watching_are_written_together() {
    // A friend belongs to exactly one list, and they change together. Two separate writes leave a
    // window where someone is in both or in neither — and "neither" silently stops their ratchet
    // contribution and lapses the edge.
    let scratch = Scratch::new("recipients-both");
    let store = RecipientStore::open(&scratch.0).unwrap();

    store
        .set_all(&["AA11".into()], &["bb22".into(), "bb22".into()])
        .unwrap();

    assert_eq!(store.get(), vec!["aa11".to_string()]);
    assert_eq!(store.watchers(), vec!["bb22".to_string()]);

    let reopened = RecipientStore::open(&scratch.0).unwrap();
    assert_eq!(reopened.get(), store.get());
    assert_eq!(reopened.watchers(), store.watchers());
}

#[test]
fn a_bad_watcher_leaves_both_lists_untouched() {
    // Validated before either write, so a bad entry in the second list cannot leave the first
    // replaced and the second stale.
    let scratch = Scratch::new("recipients-both-reject");
    let store = RecipientStore::open(&scratch.0).unwrap();
    store.set_all(&["aa11".into()], &["bb22".into()]).unwrap();

    assert!(store.set_all(&["cc33".into()], &["nope!".into()]).is_err());

    assert_eq!(store.get(), vec!["aa11".to_string()]);
    assert_eq!(store.watchers(), vec!["bb22".to_string()]);
}
