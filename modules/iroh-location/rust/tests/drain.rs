//! Tests for the drain orchestration, against fakes rather than a node.
//!
//! This is what the ports in `publish.rs` are for. Every case below is a real outcome of a
//! background wake — the network went away half-way, the disk refused a write, the counter could
//! not persist — and not one of them is reachable through a live relay on demand. Before the
//! traits, the only way to exercise `ingest_fix` was to have two phones and wait.

use std::sync::Mutex;

use iroh_location::gate::{BatteryState, FixQualityConfig, GateState};
use iroh_location::publish::{
    DrainEngine, EnqueueOutcome, FixQueue, FlushOutcome, GateStateStore, PublishError, PublishSink,
    Recipients, SeqCounter, StoreError,
};
use iroh_location::LocationFix;

const MINUTE: u64 = 60_000;
const INTERVAL: u64 = 5 * MINUTE;

fn fix(ts: u64, accuracy_m: f64) -> LocationFix {
    LocationFix {
        lat: 47.6062,
        lon: -122.3321,
        accuracy_m,
        heading_deg: 0.0,
        ts,
    }
}

fn healthy_battery() -> BatteryState {
    BatteryState {
        level: 0.9,
        charging: false,
        low_power: false,
    }
}

#[derive(Default)]
struct FakeSeq {
    value: Mutex<u64>,
    fail_after: Mutex<Option<u64>>,
}

impl SeqCounter for FakeSeq {
    fn next(&self) -> Result<u64, StoreError> {
        let mut v = self.value.lock().unwrap();
        if let Some(limit) = *self.fail_after.lock().unwrap() {
            if *v >= limit {
                return Err(StoreError::Io("counter wedged".into()));
            }
        }
        *v += 1;
        Ok(*v)
    }
    fn current(&self) -> u64 {
        *self.value.lock().unwrap()
    }
    fn seed(&self, floor: u64) -> Result<bool, StoreError> {
        let mut v = self.value.lock().unwrap();
        if floor <= *v {
            return Ok(false);
        }
        *v = floor;
        Ok(true)
    }
}

#[derive(Default)]
struct FakeQueue {
    items: Mutex<Vec<LocationFix>>,
    fail_commit: Mutex<bool>,
}

impl FixQueue for FakeQueue {
    fn enqueue(&self, fix: LocationFix) -> Result<EnqueueOutcome, StoreError> {
        let mut items = self.items.lock().unwrap();
        items.push(fix);
        Ok(EnqueueOutcome {
            pending: items.len() as u32,
            overflow_dropped: 0,
        })
    }
    fn peek(&self) -> Option<LocationFix> {
        self.items.lock().unwrap().first().cloned()
    }
    fn commit(&self) -> Result<u32, StoreError> {
        if *self.fail_commit.lock().unwrap() {
            return Err(StoreError::Io("disk full".into()));
        }
        let mut items = self.items.lock().unwrap();
        if items.is_empty() {
            return Ok(0);
        }
        items.remove(0);
        Ok(items.len() as u32)
    }
    fn pending(&self) -> u32 {
        self.items.lock().unwrap().len() as u32
    }
    fn clear(&self) -> Result<(), StoreError> {
        self.items.lock().unwrap().clear();
        Ok(())
    }
}

struct FakeRecipients {
    sharing: Vec<String>,
    watching: Vec<String>,
}

impl Recipients for FakeRecipients {
    fn get(&self) -> Vec<String> {
        self.sharing.clone()
    }
    fn watchers(&self) -> Vec<String> {
        self.watching.clone()
    }
    fn set(&self, _endpoints: &[String]) -> Result<(), StoreError> {
        Ok(())
    }
}

#[derive(Default)]
struct FakeGate(Mutex<GateState>);

impl GateStateStore for FakeGate {
    fn get(&self) -> GateState {
        self.0.lock().unwrap().clone()
    }
    fn set(&self, next: GateState) {
        *self.0.lock().unwrap() = next;
    }
}

#[derive(Default)]
struct FakeSink {
    sent: Mutex<Vec<(u64, u64, Vec<String>)>>,
    /// The watcher lane, kept apart so a test can assert one without the other.
    nulls: Mutex<Vec<(u64, u64, Vec<String>)>>,
    /// Start failing once this many envelopes have gone out — a wake that loses the network.
    fail_after: Mutex<Option<usize>>,
    /// Fail only the watcher lane. It is best-effort, so this must not cost the fix.
    fail_nulls: Mutex<bool>,
    /// How many times the drain asked for the batch to be pushed off the device. This is the
    /// counter that would have caught the 2026-08-31 outage, where every envelope was "published"
    /// into a local replica nothing ever reconciled with.
    flushes: Mutex<u32>,
    /// The stash was unreachable. Must not cost the fixes: they are committed and go out next time.
    fail_flush: Mutex<bool>,
    /// Nowhere to send — stash opted out and an empty pool. A successful call that pushed nothing.
    no_targets: Mutex<bool>,
}

impl PublishSink for FakeSink {
    async fn publish(
        &self,
        seq: u64,
        fix: LocationFix,
        recipients: Vec<String>,
    ) -> Result<(), PublishError> {
        let mut sent = self.sent.lock().unwrap();
        if let Some(limit) = *self.fail_after.lock().unwrap() {
            if sent.len() >= limit {
                return Err(PublishError::Send("network gone".into()));
            }
        }
        sent.push((seq, fix.ts, recipients));
        Ok(())
    }

    async fn publish_null(
        &self,
        seq: u64,
        ts: u64,
        watchers: Vec<String>,
    ) -> Result<(), PublishError> {
        if *self.fail_nulls.lock().unwrap() {
            return Err(PublishError::Send("watcher lane down".into()));
        }
        self.nulls.lock().unwrap().push((seq, ts, watchers));
        Ok(())
    }

    async fn flush(&self) -> Result<FlushOutcome, PublishError> {
        *self.flushes.lock().unwrap() += 1;
        if *self.fail_flush.lock().unwrap() {
            return Err(PublishError::Send("stash unreachable".into()));
        }
        if *self.no_targets.lock().unwrap() {
            return Ok(FlushOutcome::NoTargets);
        }
        Ok(FlushOutcome::Pushed)
    }
}

struct Harness {
    seq: FakeSeq,
    queue: FakeQueue,
    recipients: FakeRecipients,
    gate: FakeGate,
    sink: FakeSink,
}

impl Harness {
    fn new() -> Self {
        Self {
            seq: FakeSeq::default(),
            queue: FakeQueue::default(),
            recipients: FakeRecipients {
                sharing: vec!["aa11".into(), "bb22".into()],
                watching: vec![],
            },
            gate: FakeGate::default(),
            sink: FakeSink::default(),
        }
    }

    fn engine(&self) -> DrainEngine<'_, FakeSink> {
        DrainEngine {
            seq: &self.seq,
            queue: &self.queue,
            recipients: &self.recipients,
            gate: &self.gate,
            sink: &self.sink,
            quality: FixQualityConfig::default(),
        }
    }
}

#[tokio::test]
async fn a_first_fix_publishes_immediately_sealed_for_everyone() {
    let h = Harness::new();
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert!(out.accepted);
    assert_eq!(
        out.enqueued, 1,
        "anchored to the current slot, not deferred"
    );
    assert_eq!(out.published, 1);
    assert_eq!(out.pending, 0);
    let sent = h.sink.sent.lock().unwrap();
    assert_eq!(sent[0].0, 1, "seq assigned at publish time");
    assert_eq!(sent[0].2, vec!["aa11".to_string(), "bb22".to_string()]);
}

#[tokio::test]
async fn extra_fixes_inside_one_slot_are_absorbed() {
    // The common case: fixes arrive far faster than the interval.
    let h = Harness::new();
    let base = INTERVAL * 10;
    let engine = h.engine();

    engine
        .ingest(fix(base, 20.0), healthy_battery(), INTERVAL, base)
        .await
        .unwrap();
    let out = engine
        .ingest(
            fix(base + 5_000, 20.0),
            healthy_battery(),
            INTERVAL,
            base + 5_000,
        )
        .await
        .unwrap();

    assert_eq!(out.enqueued, 0);
    assert_eq!(h.sink.sent.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_rejected_fix_still_lets_the_heartbeat_republish() {
    // The property that makes bad GPS indistinguishable from sitting still: quality refuses the
    // fix the right to become our position, but it does not stop the clock.
    let h = Harness::new();
    let base = INTERVAL * 10;
    let engine = h.engine();
    engine
        .ingest(fix(base, 20.0), healthy_battery(), INTERVAL, base)
        .await
        .unwrap();

    let later = base + INTERVAL;
    let out = engine
        .ingest(fix(later, 5_000.0), healthy_battery(), INTERVAL, later)
        .await
        .unwrap();

    assert!(!out.accepted, "the tower fix is refused");
    assert_eq!(out.enqueued, 1, "but the slot still goes out");
    let sent = h.sink.sent.lock().unwrap();
    assert_eq!(sent[1].1, base, "carrying the LAST GOOD position");
}

#[tokio::test]
async fn a_coarse_first_fix_still_anchors_the_grid() {
    // Regression, 2026-08-30: an iPhone at home held `Always`, had the runtime running, and
    // published nothing for 88 minutes. Indoors every fix it saw was Wi-Fi-derived and past
    // `max_accuracy_m`, and the old gate needed a PRIOR acceptance before it would relax — so the
    // very first fix faced the strictest test the device would ever apply, nothing ever anchored,
    // and `heartbeat` had no position to repeat for the rest of the evening.
    //
    // A device with no position has nothing for the strict tests to protect. Anchoring coarsely and
    // saying so beats not anchoring at all: the accuracy rides along in the payload.
    let h = Harness::new();
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(fix(now, 9_000.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert!(out.accepted, "the first fix anchors however coarse it is");
    assert_eq!(out.enqueued, 1);
    assert_eq!(out.published, 1);
}

#[tokio::test]
async fn a_rejected_first_fix_publishes_nothing_at_all() {
    // Nothing to republish, so there is no slot to fill. The next acceptable fix anchors the grid.
    //
    // Staleness is the one refusal a cold start still makes — the escape above relaxes accuracy and
    // speed, never age, or a cold launch would anchor on whatever the OS had cached from yesterday
    // and republish it as current.
    let h = Harness::new();
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(
            fix(now - 11 * MINUTE, 10.0),
            healthy_battery(),
            INTERVAL,
            now,
        )
        .await
        .unwrap();

    assert!(!out.accepted);
    assert_eq!(out.enqueued, 0);
    assert_eq!(out.published, 0);
    assert!(h.sink.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn critical_battery_suspends_without_discarding_the_position() {
    let h = Harness::new();
    let now = INTERVAL * 10;
    let flat = BatteryState {
        level: 0.02,
        charging: false,
        low_power: true,
    };

    let out = h
        .engine()
        .ingest(fix(now, 20.0), flat, INTERVAL, now)
        .await
        .unwrap();

    assert!(out.suspended);
    assert!(
        out.accepted,
        "the fix is real; we simply are not sending it"
    );
    assert_eq!(out.published, 0);
    // And it is remembered, so the first fix after charging resumes from a known position.
    assert_eq!(h.gate.get().last_known_fix.unwrap().ts, now);
}

#[tokio::test]
async fn a_wake_that_loses_the_network_keeps_the_rest_queued() {
    // "Three of five made it" is the normal shape of a background wake, not an error.
    let h = Harness::new();
    *h.sink.fail_after.lock().unwrap() = Some(2);
    let base = INTERVAL * 10;
    let engine = h.engine();
    engine
        .ingest(fix(base, 20.0), healthy_battery(), INTERVAL, base)
        .await
        .unwrap();

    // Five slots have gone by with no publishing.
    let later = base + INTERVAL * 5;
    let out = engine
        .ingest(fix(later, 20.0), healthy_battery(), INTERVAL, later)
        .await
        .unwrap();

    assert_eq!(out.enqueued, 5);
    assert_eq!(out.published, 1, "the sink accepted one more, then refused");
    assert_eq!(
        out.pending, 4,
        "and the rest are still there for the next wake"
    );
}

#[tokio::test]
async fn the_slot_is_not_republished_after_a_failed_send() {
    // Gate state is saved before the drain precisely so a half-finished wake does not re-enqueue
    // slots it already queued. Re-running them would double-publish once the network came back.
    let h = Harness::new();
    *h.sink.fail_after.lock().unwrap() = Some(0);
    let now = INTERVAL * 10;
    let engine = h.engine();

    engine
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();
    let again = engine
        .ingest(
            fix(now + 1_000, 20.0),
            healthy_battery(),
            INTERVAL,
            now + 1_000,
        )
        .await
        .unwrap();

    assert_eq!(again.enqueued, 0);
    assert_eq!(again.pending, 1, "still one queued, not two");
}

#[tokio::test]
async fn a_counter_that_cannot_persist_stops_the_drain() {
    // The one failure that corrupts rather than delays: handing out a seq we failed to record
    // would let a later launch re-issue it under a different payload.
    let h = Harness::new();
    *h.seq.fail_after.lock().unwrap() = Some(0);
    let now = INTERVAL * 10;

    let err = h
        .engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap_err();

    assert!(matches!(err, PublishError::Store(_)));
    assert!(h.sink.sent.lock().unwrap().is_empty());
    assert_eq!(h.queue.pending(), 1, "the fix is kept for the next wake");
}

#[tokio::test]
async fn a_failed_commit_stops_the_drain_rather_than_republishing_forever() {
    // Without this the loop would peek the same fix, publish it again, fail to commit again — a
    // hot loop burning seq numbers and battery for as long as the disk stayed unhappy.
    let h = Harness::new();
    *h.queue.fail_commit.lock().unwrap() = true;
    let now = INTERVAL * 10;

    let err = h
        .engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap_err();

    assert!(matches!(err, PublishError::Store(_)));
    assert_eq!(
        h.sink.sent.lock().unwrap().len(),
        1,
        "published exactly once"
    );
}

#[tokio::test]
async fn a_long_blackout_backfills_up_to_the_cap_and_reports_the_rest() {
    let h = Harness::new();
    let base = INTERVAL * 10;
    let engine = h.engine();
    engine
        .ingest(fix(base, 20.0), healthy_battery(), INTERVAL, base)
        .await
        .unwrap();

    // Eleven and a half hours — the real Pixel blackout.
    let later = base + 690 * MINUTE;
    let out = engine
        .ingest(fix(later, 20.0), healthy_battery(), INTERVAL, later)
        .await
        .unwrap();

    assert_eq!(out.enqueued, 6, "half an hour of slots, not 138");
    assert!(out.slots_skipped > 0);
    assert_eq!(out.published, 6);
}

#[tokio::test]
async fn envelopes_leave_in_capture_order() {
    // seq is assigned at publish time, so an out-of-order drain would file a later capture under
    // an earlier sequence number and a receiver would watch the device walk backwards.
    let h = Harness::new();
    let base = INTERVAL * 10;
    let engine = h.engine();
    engine
        .ingest(fix(base, 20.0), healthy_battery(), INTERVAL, base)
        .await
        .unwrap();
    let later = base + INTERVAL * 3;
    engine
        .ingest(fix(later, 20.0), healthy_battery(), INTERVAL, later)
        .await
        .unwrap();

    let sent = h.sink.sent.lock().unwrap();
    let seqs: Vec<u64> = sent.iter().map(|s| s.0).collect();
    assert_eq!(seqs, vec![1, 2, 3, 4]);
}

#[tokio::test]
async fn sharing_with_nobody_still_advances_the_grid() {
    // An empty recipient list is what a fresh or fail-closed native store reports. The envelope is
    // sealed for nobody rather than skipped, so the cadence stays uniform — a gap here would be
    // visible to the stash as "this device stopped".
    let h = Harness {
        recipients: FakeRecipients {
            sharing: vec![],
            watching: vec![],
        },
        ..Harness::new()
    };
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert_eq!(out.published, 1);
    assert!(h.sink.sent.lock().unwrap()[0].2.is_empty());
}

/// A watch-only friend receives no position, but must still receive our ratchet contribution on the
/// same cadence — that envelope is the only thing keeping the edge from lapsing at `T_lapse`
/// (FORWARD-SECRECY.md §4.1). Dropping it is the mutual-lapse failure that took a day to find.
fn watched_harness() -> Harness {
    Harness {
        recipients: FakeRecipients {
            sharing: vec!["aa11".into()],
            watching: vec!["cc33".into()],
        },
        ..Harness::new()
    }
}

#[tokio::test]
async fn a_watch_only_friend_gets_a_null_envelope_on_the_same_cadence() {
    let h = watched_harness();
    let now = INTERVAL * 10;

    h.engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    let nulls = h.sink.nulls.lock().unwrap();
    assert_eq!(nulls.len(), 1, "one per published fix");
    assert_eq!(
        nulls[0].2,
        vec!["cc33".to_string()],
        "sealed for the watcher"
    );
    assert_eq!(
        nulls[0].1, now,
        "carrying the tick's timestamp, not a position"
    );
}

#[tokio::test]
async fn the_two_lanes_never_share_a_seq() {
    // Same `(author, seq)` would put them in one last-write-wins slot, where the second silently
    // erases the first.
    let h = watched_harness();
    let base = INTERVAL * 10;
    let engine = h.engine();
    engine
        .ingest(fix(base, 20.0), healthy_battery(), INTERVAL, base)
        .await
        .unwrap();
    let later = base + INTERVAL;
    engine
        .ingest(fix(later, 20.0), healthy_battery(), INTERVAL, later)
        .await
        .unwrap();

    let fix_seqs: Vec<u64> = h.sink.sent.lock().unwrap().iter().map(|s| s.0).collect();
    let null_seqs: Vec<u64> = h.sink.nulls.lock().unwrap().iter().map(|s| s.0).collect();

    assert_eq!(fix_seqs, vec![1, 3]);
    assert_eq!(null_seqs, vec![2, 4]);
    for seq in &null_seqs {
        assert!(!fix_seqs.contains(seq), "lanes must not collide on seq");
    }
}

#[tokio::test]
async fn a_failing_watcher_lane_does_not_cost_the_fix() {
    // Best-effort by design: the fix has already gone out and been committed, and a watcher edge
    // carries no position. Retaining the fix here would re-publish one that already left.
    let h = watched_harness();
    *h.sink.fail_nulls.lock().unwrap() = true;
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert_eq!(out.published, 1);
    assert_eq!(out.pending, 0, "the fix was committed, not retained");
    assert_eq!(h.sink.sent.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn no_watchers_means_no_null_envelopes_and_no_burned_seq() {
    // The common case. Burning a counter per tick for nobody would advance `seq` at twice the rate
    // for every user with no watch-only edges.
    let h = Harness::new();
    let now = INTERVAL * 10;

    h.engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert!(h.sink.nulls.lock().unwrap().is_empty());
    assert_eq!(h.seq.current(), 1, "only the fix consumed a seq");
}

#[tokio::test]
async fn a_heartbeat_republishes_the_last_position_when_no_fix_arrives() {
    // The cadence has to be uniform whether or not the phone is moving: it is the one property of
    // a sealed envelope the stash can read, so a series that stops when its owner sits still is a
    // series that leaks when its owner sits still.
    let h = Harness::new();
    let base = INTERVAL * 10;
    let engine = h.engine();
    engine
        .ingest(fix(base, 20.0), healthy_battery(), INTERVAL, base)
        .await
        .unwrap();

    let later = base + INTERVAL * 2;
    let out = engine
        .heartbeat(healthy_battery(), INTERVAL, later)
        .await
        .unwrap();

    assert_eq!(out.enqueued, 2, "both elapsed slots");
    assert_eq!(out.published, 2);
    let sent = h.sink.sent.lock().unwrap();
    // Carrying the ORIGINAL capture timestamp, so a heartbeat is honest about the position's age
    // rather than pretending it is current.
    assert_eq!(sent[1].1, base);
    assert_eq!(sent[2].1, base);
}

#[tokio::test]
async fn a_heartbeat_inside_a_covered_slot_publishes_nothing() {
    let h = Harness::new();
    let now = INTERVAL * 10;
    let engine = h.engine();
    engine
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    let out = engine
        .heartbeat(healthy_battery(), INTERVAL, now + 1_000)
        .await
        .unwrap();

    assert_eq!(out.enqueued, 0);
    assert_eq!(h.sink.sent.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_heartbeat_before_the_first_fix_does_nothing() {
    // Nothing has passed the gate, so there is no position to repeat.
    let h = Harness::new();

    let out = h
        .engine()
        .heartbeat(healthy_battery(), INTERVAL, INTERVAL * 10)
        .await
        .unwrap();

    assert_eq!(out.enqueued, 0);
    assert!(!out.suspended);
    assert!(h.sink.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_heartbeat_respects_the_battery_suspend() {
    let h = Harness::new();
    let base = INTERVAL * 10;
    let engine = h.engine();
    engine
        .ingest(fix(base, 20.0), healthy_battery(), INTERVAL, base)
        .await
        .unwrap();

    let flat = BatteryState {
        level: 0.02,
        charging: false,
        low_power: false,
    };
    let out = engine
        .heartbeat(flat, INTERVAL, base + INTERVAL * 3)
        .await
        .unwrap();

    assert!(out.suspended);
    assert_eq!(out.enqueued, 0);
}

// --- Getting the batch off the device -------------------------------------------------------
//
// `publish` writes the local replica and broadcasts to a swarm that is empty on a background wake.
// Until something reconciles with a peer, a "published" envelope has not left the phone. These are
// the tests that were missing on 2026-08-31, when two phones spent a day publishing into their own
// replicas while the trail stash received nothing from either.

#[tokio::test]
async fn a_drain_that_published_pushes_the_batch_off_the_device() {
    let h = Harness::new();
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert_eq!(out.published, 1);
    assert_eq!(
        *h.sink.flushes.lock().unwrap(),
        1,
        "a published envelope that is never pushed has not left the phone"
    );
}

#[tokio::test]
async fn one_push_per_drain_not_one_per_envelope() {
    // Reconciliation moves everything the namespace holds, so a dial per fix would pay N dials to
    // send a superset of the same thing.
    let h = Harness::new();
    let base = INTERVAL * 10;
    // Three slots come due at once — the shape of a wake after the phone was frozen.
    let out = h
        .engine()
        .ingest(
            fix(base + INTERVAL * 3, 20.0),
            healthy_battery(),
            INTERVAL,
            base + INTERVAL * 3,
        )
        .await
        .unwrap();

    assert!(out.published >= 1);
    assert_eq!(
        *h.sink.flushes.lock().unwrap(),
        1,
        "one push per drain, however many envelopes it sent"
    );
}

#[tokio::test]
async fn a_drain_that_published_nothing_does_not_push() {
    // Most wakes on a stationary phone. A push here is a dial per pool member for no new data.
    let h = Harness::new();
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .heartbeat(healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert_eq!(out.published, 0, "nothing has ever passed the gate");
    assert_eq!(*h.sink.flushes.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_failed_push_does_not_retain_fixes_that_already_went_out() {
    // The fixes are on the wire and committed; the stash being unreachable must not make the drain
    // look like it failed, or the next wake republishes envelopes that already left.
    let h = Harness::new();
    *h.sink.fail_flush.lock().unwrap() = true;
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert_eq!(out.published, 1, "the envelope reached the wire");
    assert_eq!(
        out.pending, 0,
        "and was committed, not retained for a retry"
    );
    assert_eq!(*h.sink.flushes.lock().unwrap(), 1);
}

#[tokio::test]
async fn a_drain_records_when_it_published_and_when_it_pushed() {
    // `device.health` derives "how long has this phone been failing to publish" from these. They
    // used to be stamped only by the JS publish path, which the native drain replaced — so on
    // 2026-08-31 a phone that had published 37 envelopes that afternoon reported a publish age of
    // 672 minutes, and read as eleven hours dead.
    let h = Harness::new();
    let now = INTERVAL * 10;

    h.engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    let state = h.gate.get();
    assert_eq!(state.last_published_at, Some(now));
    assert_eq!(state.last_pushed_at, Some(now));
}

#[tokio::test]
async fn a_push_that_failed_leaves_the_publish_stamp_standing_alone() {
    // The gap between the two is the diagnosis: published but never pushed is a phone talking to
    // its own replica, and collapsing them into one "last seen" would hide exactly that.
    let h = Harness::new();
    *h.sink.fail_flush.lock().unwrap() = true;
    let now = INTERVAL * 10;

    h.engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    let state = h.gate.get();
    assert_eq!(state.last_published_at, Some(now));
    assert_eq!(state.last_pushed_at, None, "nothing left the device");
}

#[tokio::test]
async fn a_wake_that_published_nothing_moves_neither_stamp() {
    let h = Harness::new();
    let now = INTERVAL * 10;

    h.engine()
        .heartbeat(healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    let state = h.gate.get();
    assert_eq!(state.last_published_at, None);
    assert_eq!(state.last_pushed_at, None);
}

#[tokio::test]
async fn a_flush_with_nowhere_to_send_is_not_recorded_as_a_push() {
    // The bug this exists to stop: "nothing to push to" and "pushed" were the same `Ok`, so a
    // phone with the stash opted out and an empty pool stamped `last_pushed_at` on every drain and
    // reported a fresh push forever. That is the same lying watermark the native stamps replaced.
    let h = Harness::new();
    *h.sink.no_targets.lock().unwrap() = true;
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(fix(now, 20.0), healthy_battery(), INTERVAL, now)
        .await
        .unwrap();

    assert_eq!(
        out.published, 1,
        "it still reached the live lane and the replica"
    );
    let state = h.gate.get();
    assert_eq!(state.last_published_at, Some(now));
    assert_eq!(
        state.last_pushed_at, None,
        "nothing left the device, so nothing may claim to have"
    );
    assert_eq!(
        *h.sink.flushes.lock().unwrap(),
        1,
        "the flush was still attempted"
    );
}
