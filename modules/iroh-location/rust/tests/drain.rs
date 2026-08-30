//! Tests for the drain orchestration, against fakes rather than a node.
//!
//! This is what the ports in `publish.rs` are for. Every case below is a real outcome of a
//! background wake — the network went away half-way, the disk refused a write, the counter could
//! not persist — and not one of them is reachable through a live relay on demand. Before the
//! traits, the only way to exercise `ingest_fix` was to have two phones and wait.

use std::sync::Mutex;

use iroh_location::gate::{BatteryState, FixQualityConfig, GateState};
use iroh_location::publish::{
    DrainEngine, EnqueueOutcome, FixQueue, GateStateStore, PublishError, PublishSink, Recipients,
    SeqCounter, StoreError,
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

struct FakeRecipients(Vec<String>);

impl Recipients for FakeRecipients {
    fn get(&self) -> Vec<String> {
        self.0.clone()
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
    /// Start failing once this many envelopes have gone out — a wake that loses the network.
    fail_after: Mutex<Option<usize>>,
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
            recipients: FakeRecipients(vec!["aa11".into(), "bb22".into()]),
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
async fn a_rejected_first_fix_publishes_nothing_at_all() {
    // Nothing to republish, so there is no slot to fill. The next acceptable fix anchors the grid.
    let h = Harness::new();
    let now = INTERVAL * 10;

    let out = h
        .engine()
        .ingest(fix(now, 9_000.0), healthy_battery(), INTERVAL, now)
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
        recipients: FakeRecipients(vec![]),
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
