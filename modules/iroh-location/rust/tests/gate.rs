//! Tests for the native gate — the port of `fix-quality.ts` and the engine's slot grid.
//!
//! These assert parity with the JS policy, because the two run on the same device depending only
//! on whether the app happened to be open. A phone that gated differently in the background would
//! publish a ragged series, and the cadence is the one property of a sealed envelope the stash can
//! read (FORWARD-SECRECY.md §4.1).

use iroh_location::gate::{
    assess_fix, critically_low, due_slots, BatteryState, FixQualityConfig, FixRejection,
    MAX_BACKFILL_MS,
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
        motion: None,
    }
}

fn moved(ts: u64, accuracy_m: f64, degrees_north: f64) -> LocationFix {
    LocationFix {
        lat: 47.6062 + degrees_north,
        lon: -122.3321,
        accuracy_m,
        heading_deg: 0.0,
        ts,
        motion: None,
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
