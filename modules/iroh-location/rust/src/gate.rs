//! Whether a captured fix becomes an envelope, and how many envelopes a wake owes.
//!
//! A port of `fix-quality.ts` and the slot grid in `location-engine.ts`, kept pure so the policy
//! can be tested without a node, an FFI boundary or a clock. The mounted app still runs the JS
//! copy; this one exists so the same decisions can be made in an OS callback with no JS context
//! alive. **The two must agree** — a phone that gates differently depending on whether the app
//! happened to be open would publish an irregular series, and the cadence is the one thing about
//! a sealed envelope the stash can read.
//!
//! # Three things stop a fix, and they are not interchangeable
//!
//! - **Quality** ([`assess_fix`]) refuses a fix the right to become our *position*. It does not
//!   stop the clock: a refused fix falls through to the slot logic, which republishes the last
//!   accepted position, so a stretch of bad GPS looks exactly like a stretch of sitting still.
//! - **The slot grid** ([`due_slots`]) decides how many envelopes are owed. Fixes arrive far
//!   faster than the interval, so the common answer is zero and the fix is simply absorbed.
//! - **Critical battery** suspends publishing outright — a hard stop indistinguishable from the
//!   phone dying, rather than a slow-down that would encode the charge level in the cadence.

use serde::{Deserialize, Serialize};

use crate::LocationFix;

/// Battery inputs to the suspend decision. Supplied by the platform layer with each fix, because
/// the native path has no JS context to ask.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct BatteryState {
    /// 0.0–1.0. A platform that cannot report it should send 1.0 rather than 0.0: unknown must not
    /// read as critical, or a device with no battery API would never publish.
    pub level: f64,
    pub charging: bool,
    /// iOS Low Power Mode / Android battery saver.
    pub low_power: bool,
}

/// Why a fix was refused. Stamped on telemetry as `sc.drop_reason: fix-<reason>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FixRejection {
    Inaccurate,
    Stale,
    ImplausibleJump,
}

impl FixRejection {
    /// The telemetry spelling, matching the JS `sc.drop_reason` values exactly so one query
    /// answers for both paths.
    pub fn as_str(self) -> &'static str {
        match self {
            FixRejection::Inaccurate => "fix-inaccurate",
            FixRejection::Stale => "fix-stale",
            FixRejection::ImplausibleJump => "fix-implausible-jump",
        }
    }
}

/// Tuned for an ambient friend map. Values mirror `DEFAULT_FIX_QUALITY_CONFIG`.
#[derive(Debug, Clone, Copy)]
pub struct FixQualityConfig {
    /// 150 m: loose enough that an ordinary urban fix passes, tight enough to drop tower-derived
    /// ones (500 m to several km). Must stay coarser than the accuracy tier we request, or we
    /// would spend battery on fixes we then throw away.
    pub max_accuracy_m: f64,
    pub max_age_ms: u64,
    /// 100 m/s (360 km/h) — above any car or train, below a cruising airliner. Flying trips it,
    /// and `accept_anything_after_ms` is what recovers the trail afterwards.
    pub max_speed_mps: f64,
    pub accept_anything_after_ms: u64,
    /// Two fixes milliseconds apart turn ordinary jitter into an implausible velocity.
    pub min_speed_test_gap_ms: u64,
}

impl Default for FixQualityConfig {
    fn default() -> Self {
        Self {
            max_accuracy_m: 150.0,
            max_age_ms: 10 * 60_000,
            max_speed_mps: 100.0,
            accept_anything_after_ms: 15 * 60_000,
            min_speed_test_gap_ms: 1_000,
        }
    }
}

/// How far back the heartbeat will fill in missed slots. Mirrors `MAX_BACKFILL_MS`.
pub const MAX_BACKFILL_MS: u64 = 30 * 60_000;

/// Below this charge, publishing suspends unless charging. Mirrors `suspendBelowLevel`.
pub const SUSPEND_BELOW_LEVEL: f64 = 0.05;

/// Great-circle distance between two fixes in metres.
fn haversine_metres(a: &LocationFix, b: &LocationFix) -> f64 {
    const R: f64 = 6_371_000.0;
    let d_lat = (b.lat - a.lat).to_radians();
    let d_lon = (b.lon - a.lon).to_radians();
    let lat1 = a.lat.to_radians();
    let lat2 = b.lat.to_radians();
    let h = (d_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * R * h.sqrt().min(1.0).asin()
}

/// Whether the charge level suspends publishing. The only backoff that still applies in live mode.
pub fn critically_low(battery: &BatteryState) -> bool {
    battery.level < SUSPEND_BELOW_LEVEL && !battery.charging
}

/// `None` ⇒ accept the fix; otherwise why it was refused.
pub fn assess_fix(
    fix: &LocationFix,
    last_accepted: Option<&LocationFix>,
    last_accepted_at: Option<u64>,
    now: u64,
    config: &FixQualityConfig,
) -> Option<FixRejection> {
    // Checked even when starved (below): a replayed cached fix carries no new information, and the
    // heartbeat is already covering the cadence with the last good position and its true timestamp.
    if now.saturating_sub(fix.ts) > config.max_age_ms {
        return Some(FixRejection::Stale);
    }

    // Nothing has passed in a long time — stop being fussy rather than let the trail freeze.
    //
    // `None` takes the escape too, and that is the whole point rather than a shortcut. A device
    // that has never accepted anything is not "0 ms starved", it is infinitely starved: there is no
    // position to fall back on, so the strict tests have nothing to protect. Requiring a prior
    // acceptance to relax them made the first fix the strictest one a device would ever face, and
    // an indoor phone whose Wi-Fi fixes all land past `max_accuracy_m` could never anchor the grid
    // at all — `last_known_fix` stays `None`, `heartbeat` returns 0 forever, and the phone looks
    // armed and healthy while publishing nothing. That is exactly how an iPhone spent 2026-08-30
    // sitting at home with the runtime running and 88 minutes since its last publish.
    //
    // Staleness is still checked above, so this cannot anchor on a long-dead cached fix, and the
    // accuracy rides along in the payload — a coarse anchor is honest, a missing one is not.
    match last_accepted_at {
        Some(at) if now.saturating_sub(at) < config.accept_anything_after_ms => {}
        _ => return None,
    }

    // `accuracy_m <= 0` means the provider gave us no radius, not a perfect one. Skip the test we
    // cannot run instead of silently passing it.
    if fix.accuracy_m > 0.0 && fix.accuracy_m > config.max_accuracy_m {
        return Some(FixRejection::Inaccurate);
    }

    if let Some(prev) = last_accepted {
        let dt_ms = fix.ts.saturating_sub(prev.ts);
        if dt_ms >= config.min_speed_test_gap_ms {
            // Discount the combined error radii: two fixes can differ by their own uncertainty
            // without anyone having moved, and calling that a teleport would reject jitter.
            let slack = prev.accuracy_m.max(0.0) + fix.accuracy_m.max(0.0);
            let travelled = (haversine_metres(prev, fix) - slack).max(0.0);
            if travelled / (dt_ms as f64 / 1000.0) > config.max_speed_mps {
                return Some(FixRejection::ImplausibleJump);
            }
        }
    }

    None
}

/// How many envelopes this moment owes, and how many the backfill cap skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlotPlan {
    /// Envelopes to enqueue, each carrying the last known position.
    pub due: u32,
    /// Slots the [`MAX_BACKFILL_MS`] cap declined to fill. Not a bug, but it is a gap in a series
    /// that is supposed to be uniform, so it is reported rather than left to be inferred as one.
    pub skipped: u32,
    /// The slot index to record as published once the caller has enqueued them.
    pub current_slot: u64,
}

/// Decide how many interval slots have come due.
///
/// `last_published_slot` is `None` before the first publish of a session, which anchors the first
/// envelope to the *current* slot rather than deferring it a full interval — a user who just
/// enabled sharing should appear on their friends' maps now, not in five minutes.
pub fn due_slots(now: u64, interval_ms: u64, last_published_slot: Option<u64>) -> SlotPlan {
    let interval_ms = interval_ms.max(1);
    let current_slot = now / interval_ms;
    let last = last_published_slot.unwrap_or_else(|| current_slot.saturating_sub(1));
    if current_slot <= last {
        return SlotPlan {
            due: 0,
            skipped: 0,
            current_slot,
        };
    }

    let max_slots = (MAX_BACKFILL_MS.div_ceil(interval_ms)).max(1);
    let uncapped_from = last + 1;
    let from = uncapped_from.max(current_slot.saturating_sub(max_slots - 1));
    SlotPlan {
        due: (current_slot - from + 1) as u32,
        skipped: (from - uncapped_from) as u32,
        current_slot,
    }
}

/// The gate's state across wakes.
///
/// Persisted, unlike the JS engine's in-memory equivalent, and that difference is the point. The
/// JS copy re-anchors on every cold start because a mounted app rarely has one; the native path
/// exists precisely for the phone whose process keeps dying, and a gate that re-anchored each time
/// would emit a ragged series instead of the uniform cadence §4.1 relies on.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GateState {
    /// Latest position that passed the confidence gate, republished for slots that produce no fix
    /// — and for slots whose only fixes were rejected.
    pub last_known_fix: Option<LocationFix>,
    pub last_accepted_at: Option<u64>,
    /// Index of the last wall-clock slot we put an envelope on the wire for.
    pub last_published_slot: Option<u64>,
    /// When a drain last put at least one envelope on the wire (ms since epoch).
    ///
    /// A *slot* index is not a time: it says which grid cell we covered, not when we managed it,
    /// and it does not move at all on a wake that published nothing. `device.health` needs "how
    /// long has this phone been failing to publish", which only a timestamp answers.
    ///
    /// It lives here rather than in the JS watermark row because the native drain is now the only
    /// publish path, and the JS row is only written by callers that path bypasses — so
    /// `last_publish_age_ms` read 672 minutes on 2026-08-31 for a phone that had published 37
    /// envelopes that afternoon.
    pub last_published_at: Option<u64>,
    /// When a push last completed and the batch actually left the device (ms since epoch).
    ///
    /// Distinct from [`Self::last_published_at`] on purpose: publishing writes the local replica,
    /// and the gap between these two is exactly the failure that made a phone look healthy while
    /// delivering nothing.
    pub last_pushed_at: Option<u64>,
}

/// Durable home for [`GateState`], next to the outbox it feeds.
///
/// No writer claim: unlike the counter, a torn or lost gate state costs at most one duplicated or
/// skipped slot, and both are already normal outcomes of a process dying mid-wake. Paying for a
/// claim here would buy nothing and would add a second way for the node to refuse to start.
#[derive(Debug)]
pub struct GateStore {
    dir: std::path::PathBuf,
    path: std::path::PathBuf,
    current: std::sync::Mutex<GateState>,
}

impl GateStore {
    /// Load the persisted gate state, or a fresh one.
    ///
    /// Unreadable state reads as fresh: every field is a cache of something re-derivable from the
    /// next fix, so starting over costs one re-anchored slot rather than correctness.
    pub fn open(state_dir: &std::path::Path) -> std::io::Result<Self> {
        let dir = state_dir.join("gate");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("state");
        let current = match std::fs::read(&path) {
            Ok(raw) => postcard::from_bytes::<GateState>(&raw).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => GateState::default(),
            Err(e) => return Err(e),
        };
        Ok(Self {
            dir,
            path,
            current: std::sync::Mutex::new(current),
        })
    }

    pub fn get(&self) -> GateState {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Replace the state and persist it. Best-effort on the write: the in-memory copy is updated
    /// either way, because refusing to advance the slot after a failed save would republish the
    /// same slot on every fix for as long as the disk stayed unhappy.
    pub fn set(&self, next: GateState) {
        let bytes = postcard::to_allocvec(&next).ok();
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = next;
        if let Some(bytes) = bytes {
            if let Err(err) = crate::durable::write_atomic(&self.dir, &self.path, &bytes) {
                tracing::warn!(error = %err, "gate: could not persist state");
            }
        }
    }
}

impl crate::publish::GateStateStore for GateStore {
    fn get(&self) -> GateState {
        GateStore::get(self)
    }

    fn set(&self, next: GateState) {
        GateStore::set(self, next)
    }
}
