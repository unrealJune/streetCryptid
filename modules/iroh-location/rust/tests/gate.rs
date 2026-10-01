//! Tests for the native gate — the port of `fix-quality.ts` and the engine's slot grid.
//!
//! These assert parity with the JS policy, because the two run on the same device depending only
//! on whether the app happened to be open. A phone that gated differently in the background would
//! publish a ragged series, and the cadence is the one property of a sealed envelope the stash can
//! read (FORWARD-SECRECY.md §4.1).

use iroh_location::gate::{
    assess_fix, critically_low, due_slots, regrid, BatteryState, FixQualityConfig, FixRejection,
    GateState, GateStore, MAX_BACKFILL_MS,
};
use iroh_location::LocationFix;

const MINUTE: u64 = 60_000;

fn at(ts: u64, accuracy_m: f64) -> LocationFix {
    LocationFix {
        lat: 47.6062,
        lon: -122.3321,
        accuracy_m,
        heading_deg: 0.0,
        ts,
        state: None,
        published_delta_s: None,
    }
}

fn moved(ts: u64, accuracy_m: f64, degrees_north: f64) -> LocationFix {
    LocationFix {
        lat: 47.6062 + degrees_north,
        lon: -122.3321,
        accuracy_m,
        heading_deg: 0.0,
        ts,
        state: None,
        published_delta_s: None,
    }
}

fn cfg() -> FixQualityConfig {
    FixQualityConfig::default()
}

/// A device that has already anchored recently, so the strict tests are the ones being exercised
/// rather than the starvation escape. Anything passing `None` here is testing cold start instead —
/// see `anchors_on_the_first_fix_however_coarse`.
fn anchored(now: u64) -> Option<u64> {
    Some(now.saturating_sub(MINUTE))
}

#[test]
fn accepts_an_ordinary_urban_fix() {
    assert_eq!(
        assess_fix(&at(1_000, 30.0), None, anchored(1_500), 1_500, &cfg()),
        None
    );
}

#[test]
fn refuses_a_tower_derived_fix() {
    assert_eq!(
        assess_fix(&at(1_000, 2_000.0), None, anchored(1_500), 1_500, &cfg()),
        Some(FixRejection::Inaccurate)
    );
}

#[test]
fn anchors_on_the_first_fix_however_coarse() {
    // Regression, 2026-08-30: an iPhone sat at home for 88 minutes with the background runtime
    // running and published nothing. Indoors every Wi-Fi fix landed past `max_accuracy_m`, and
    // because `accept_anything_after_ms` needed a PRIOR acceptance to relax anything, the first
    // fix faced the strictest test the device would ever apply. Nothing anchored, so
    // `last_known_fix` stayed `None` and `heartbeat` returned 0 forever.
    //
    // A device that has accepted nothing is infinitely starved, not zero-starved: there is no
    // position for the strict tests to protect.
    assert_eq!(
        assess_fix(&at(1_000, 2_000.0), None, None, 1_500, &cfg()),
        None
    );
}

#[test]
fn cold_start_still_refuses_a_stale_fix() {
    // The escape relaxes accuracy and speed, never age — otherwise a cold launch would anchor the
    // grid on whatever Core Location had cached from yesterday and republish it as current.
    let now = 60 * MINUTE;
    assert_eq!(
        assess_fix(&at(now - 11 * MINUTE, 10.0), None, None, now, &cfg()),
        Some(FixRejection::Stale)
    );
}

#[test]
fn treats_a_missing_accuracy_radius_as_untestable_not_perfect() {
    // `accuracy_m <= 0` means the provider gave us no radius. Skipping the test we cannot run is
    // not the same as passing it, but it must not reject either — that would drop every fix from
    // a provider that omits the field.
    assert_eq!(
        assess_fix(&at(1_000, 0.0), None, anchored(1_500), 1_500, &cfg()),
        None
    );
}

#[test]
fn refuses_a_stale_fix_even_when_starved() {
    // A replayed cached fix carries no new information, and the heartbeat is already covering the
    // cadence with the last good position — so the age check sits ahead of the escape hatch.
    let now = 60 * MINUTE;
    let starving = Some(now - 30 * MINUTE);
    assert_eq!(
        assess_fix(&at(now - 11 * MINUTE, 10.0), None, starving, now, &cfg()),
        Some(FixRejection::Stale)
    );
}

#[test]
fn stops_being_fussy_once_nothing_has_passed_for_a_long_time() {
    // Otherwise a phone that only ever sees coarse fixes freezes its trail permanently.
    let now = 60 * MINUTE;
    let starved = Some(now - 20 * MINUTE);
    assert_eq!(
        assess_fix(&at(now - 1_000, 5_000.0), None, starved, now, &cfg()),
        None
    );
}

#[test]
fn refuses_a_teleport_but_not_stationary_jitter() {
    let prev = at(0, 10.0);
    // ~0.02 degrees north in 2 s is well over 360 km/h.
    assert_eq!(
        assess_fix(
            &moved(2_000, 10.0, 0.02),
            Some(&prev),
            Some(0),
            2_100,
            &cfg()
        ),
        Some(FixRejection::ImplausibleJump)
    );

    // Two coarse fixes at the same place can differ by their own uncertainty without anyone
    // moving; discounting the combined radii is what stops that reading as a teleport.
    let coarse_prev = at(0, 120.0);
    assert_eq!(
        assess_fix(
            &moved(2_000, 120.0, 0.001),
            Some(&coarse_prev),
            Some(0),
            2_100,
            &cfg()
        ),
        None
    );
}

#[test]
fn skips_the_speed_test_for_fixes_milliseconds_apart() {
    // Ordinary jitter over a tiny gap is an implausible velocity by arithmetic alone.
    let prev = at(0, 5.0);
    assert_eq!(
        assess_fix(&moved(100, 5.0, 0.0005), Some(&prev), Some(0), 200, &cfg()),
        None
    );
}

#[test]
fn the_first_publish_of_a_session_lands_on_the_current_slot() {
    // Deferring it a full interval would leave a user who just enabled sharing invisible for five
    // minutes on their friends' maps.
    let plan = due_slots(5 * MINUTE * 3 + 1_000, 5 * MINUTE, None);
    assert_eq!(plan.due, 1);
    assert_eq!(plan.skipped, 0);
    assert_eq!(plan.current_slot, 3);
}

#[test]
fn a_slot_already_covered_owes_nothing() {
    // The common case by far: fixes arrive far faster than the interval and are absorbed.
    let plan = due_slots(5 * MINUTE * 3 + 1_000, 5 * MINUTE, Some(3));
    assert_eq!(plan.due, 0);
    assert_eq!(plan.current_slot, 3);
}

#[test]
fn missed_slots_are_filled_so_the_series_stays_uniform() {
    let interval = 5 * MINUTE;
    let plan = due_slots(interval * 4, interval, Some(1));
    assert_eq!(plan.due, 3, "slots 2, 3 and 4");
    assert_eq!(plan.skipped, 0);
}

#[test]
fn backfill_is_capped_and_says_how_much_it_skipped() {
    // A phone that was dark for eleven hours must not emit 130 envelopes on the way back.
    let interval = 5 * MINUTE;
    let now = interval * 200;
    let plan = due_slots(now, interval, Some(1));

    let max_slots = (MAX_BACKFILL_MS / interval) as u32;
    assert_eq!(plan.due, max_slots, "half an hour's worth, and no more");
    // Everything owed is either filled or accounted for as skipped — no slot is silently lost.
    let owed = (200 - 1) as u32;
    assert_eq!(plan.due + plan.skipped, owed);
    assert!(plan.skipped > 0, "and the gap is reported, not inferred");
}

#[test]
fn critical_battery_suspends_unless_charging() {
    let flat = BatteryState {
        level: 0.03,
        charging: false,
        low_power: true,
    };
    assert!(critically_low(&flat));

    let charging = BatteryState {
        charging: true,
        ..flat
    };
    assert!(!critically_low(&charging), "charging cancels the suspend");

    let unknown = BatteryState {
        level: 1.0,
        charging: false,
        low_power: false,
    };
    assert!(
        !critically_low(&unknown),
        "a platform with no battery API sends 1.0; unknown must not read as critical"
    );
}

#[test]
fn low_power_alone_does_not_suspend() {
    // Low Power Mode degrades accuracy in the JS policy, never the cadence — stretching the
    // interval would put the charge level on the wire, which the stash can read.
    let saver = BatteryState {
        level: 0.8,
        charging: false,
        low_power: true,
    };
    assert!(!critically_low(&saver));
}

// ---------------------------------------------------------------------------
// Upgrade compatibility of the persisted state
// ---------------------------------------------------------------------------

struct Scratch(std::path::PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sc-gate-{name}"));
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

/// `GateState` exactly as it was persisted before `last_state` was appended.
///
/// Written by hand rather than captured, so this keeps testing the upgrade even as the current
/// struct grows further — the point is a record that is SHORTER than what the code now expects.
#[derive(serde::Serialize)]
struct LegacyGateState {
    last_known_fix: Option<LegacyStoredFix>,
    last_accepted_at: Option<u64>,
    last_published_slot: Option<u64>,
    last_published_at: Option<u64>,
    last_pushed_at: Option<u64>,
}

#[derive(serde::Serialize)]
struct LegacyStoredFix {
    lat: f64,
    lon: f64,
    accuracy_m: f64,
    heading_deg: f64,
    ts: u64,
}

/// Gate state written by an older build must survive the upgrade with `last_known_fix` intact.
///
/// This is the test that guards the worst regression available in this file. `GateStore::open`
/// falls back to `GateState::default()` on any decode failure, which is right for corruption and
/// catastrophic for a struct change: losing `last_known_fix` leaves `heartbeat` with no position to
/// republish, so it returns 0 and the device publishes NOTHING until it happens to catch a fresh
/// acceptable fix. On a parked phone that is hours, it is silent, and it would have happened to
/// every device at once on upgrade — the 2026-08-30 failure, reintroduced by a field.
#[test]
fn gate_state_written_before_last_state_existed_still_loads() {
    let scratch = Scratch::new("legacy-upgrade");
    let dir = scratch.0.join("gate");
    std::fs::create_dir_all(&dir).unwrap();
    let legacy = LegacyGateState {
        last_known_fix: Some(LegacyStoredFix {
            lat: 47.6062,
            lon: -122.3321,
            accuracy_m: 18.0,
            heading_deg: 0.0,
            ts: 1_786_000_000_000,
        }),
        last_accepted_at: Some(1_786_000_000_000),
        last_published_slot: Some(5_953_333),
        last_published_at: Some(1_786_000_001_000),
        last_pushed_at: Some(1_786_000_002_000),
    };
    std::fs::write(dir.join("state"), postcard::to_allocvec(&legacy).unwrap()).unwrap();

    let state = GateStore::open(&scratch.0).unwrap().get();

    let known = state
        .last_known_fix
        .expect("the position an older build accepted must survive the upgrade");
    assert_eq!(known.ts, 1_786_000_000_000);
    assert_eq!(known.accuracy_m, 18.0);
    assert_eq!(state.last_published_slot, Some(5_953_333));
    assert_eq!(state.last_pushed_at, Some(1_786_000_002_000));
    // Absent rather than defaulted to a state we did not observe.
    assert_eq!(state.last_state, None);
}

/// The round trip a current build does with itself.
#[test]
fn gate_state_round_trips_through_the_store() {
    let scratch = Scratch::new("round-trip");
    let store = GateStore::open(&scratch.0).unwrap();
    let mut next = store.get();
    next.last_state = Some(iroh_location::FIX_STATE_PARKED);
    next.last_published_slot = Some(42);
    store.set(next);

    let reopened = GateStore::open(&scratch.0).unwrap().get();
    assert_eq!(reopened.last_state, Some(iroh_location::FIX_STATE_PARKED));
    assert_eq!(reopened.last_published_slot, Some(42));
}

/// Counts the gate's "could not persist" warnings, from every thread.
struct PersistFailures(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for PersistFailures {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        struct Message(bool);
        impl tracing::field::Visit for Message {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.0 |= format!("{value:?}").contains("could not persist");
                }
            }
        }
        let mut message = Message(false);
        event.record(&mut message);
        if message.0 {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// A burst of concurrent writers persists every state, and leaves the newest one on disk.
///
/// A relaunch delivers several positions within milliseconds and each reaches the gate on its own
/// task. `write_atomic` stages through one fixed temp file, so unserialised writers truncated each
/// other's staging file and lost renames ("gate: could not persist state", in pairs, on an iPhone
/// on 2026-09-29) — and the renames that did land could land out of order, leaving an OLDER state
/// on disk than the one in memory, which is the one a relaunch reads back as `last_known_fix`.
#[test]
fn concurrent_writers_all_persist_and_the_newest_state_wins() {
    use tracing_subscriber::layer::SubscriberExt;
    let failures = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // Global, because the writers are other threads. This is the only test in the binary that
    // installs one.
    tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(PersistFailures(failures.clone())),
    )
    .expect("no other test installs a subscriber");

    let scratch = Scratch::new("concurrent-writers");
    let store = std::sync::Arc::new(GateStore::open(&scratch.0).unwrap());
    let writers: Vec<_> = (0..8u64)
        .map(|writer| {
            let store = store.clone();
            std::thread::spawn(move || {
                for i in 0..50u64 {
                    let mut next = store.get();
                    next.last_published_slot = Some(writer * 1_000 + i);
                    store.set(next);
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }

    assert_eq!(
        failures.load(std::sync::atomic::Ordering::Relaxed),
        0,
        "concurrent writers collided on the staging file"
    );
    let in_memory = store.get().last_published_slot;
    let on_disk = GateStore::open(&scratch.0)
        .unwrap()
        .get()
        .last_published_slot;
    assert_eq!(on_disk, in_memory);
}

#[test]
fn a_stored_slot_ahead_of_the_clock_owes_the_current_slot() {
    // A clock set back, or an index from a different grid. Waiting for the clock to catch up can
    // mean forever, and calling the slot covered would never be persisted — so it is owed now.
    let plan = due_slots(5 * MINUTE * 3 + 1_000, 5 * MINUTE, Some(900));
    assert_eq!(plan.due, 1);
    assert_eq!(plan.current_slot, 3);
}

#[test]
fn regrid_translates_through_time() {
    let wall = 1_790_740_000_000u64;
    let mut state = GateState {
        last_published_slot: Some(wall / MINUTE),
        slot_interval_ms: Some(MINUTE),
        ..GateState::default()
    };
    regrid(&mut state, 5 * MINUTE);
    // The minute that went out ends inside exactly one 5-minute slot.
    assert_eq!(
        state.last_published_slot,
        Some(((wall / MINUTE + 1) * MINUTE - 1) / (5 * MINUTE))
    );
    assert_eq!(state.slot_interval_ms, Some(5 * MINUTE));

    let before = state.clone();
    regrid(&mut state, 5 * MINUTE);
    assert_eq!(
        state.last_published_slot, before.last_published_slot,
        "idempotent"
    );
}
