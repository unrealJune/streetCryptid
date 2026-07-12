//! Retention policy — the "hold updates for a while, then drop" knob, expressed as pure,
//! clock-injectable logic so it is testable without a live replica.
//!
//! The stash applies the *same* rolling-window idea as the app (ARCHITECTURE §5): entries whose
//! timestamp is strictly older than `now - retention` are eligible to be pruned. Making the window
//! configurable (per the Phase-0 decision) is just choosing `retention_hours`.

/// Milliseconds in one hour.
pub const MS_PER_HOUR: u64 = 3_600_000;

/// A retention window. Constructed from a configurable number of hours; all timestamps are ms
/// since the Unix epoch (the same clock the envelopes and iroh-docs entries use).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPolicy {
    retention_ms: u64,
}

impl RetentionPolicy {
    /// Build a policy retaining the last `hours` of entries. Saturating so an absurd window can
    /// never overflow into a bogus cutoff.
    pub fn from_hours(hours: u64) -> Self {
        Self {
            retention_ms: hours.saturating_mul(MS_PER_HOUR),
        }
    }

    /// The window length in milliseconds.
    pub fn retention_ms(&self) -> u64 {
        self.retention_ms
    }

    /// Entries with `ts < cutoff(now)` should be pruned. Saturating so a window larger than `now`
    /// (e.g. tests near the epoch) clamps to 0 rather than wrapping to a huge value.
    pub fn cutoff(&self, now_ms: u64) -> u64 {
        now_ms.saturating_sub(self.retention_ms)
    }

    /// Whether an entry written at `entry_ts_ms` is now outside the window. Uses the same strict
    /// `<` boundary as `docs.rs::keys_to_prune` so an entry exactly at the cutoff is kept.
    pub fn is_expired(&self, entry_ts_ms: u64, now_ms: u64) -> bool {
        entry_ts_ms < self.cutoff(now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutoff_is_now_minus_window() {
        let p = RetentionPolicy::from_hours(48);
        let now = 100 * MS_PER_HOUR;
        assert_eq!(p.cutoff(now), 52 * MS_PER_HOUR);
    }

    #[test]
    fn expiry_uses_strict_older_than_boundary() {
        let p = RetentionPolicy::from_hours(1);
        let now = 10 * MS_PER_HOUR;
        let cutoff = p.cutoff(now); // 9h
        assert!(p.is_expired(cutoff - 1, now)); // strictly older → pruned
        assert!(!p.is_expired(cutoff, now)); // exactly at cutoff → kept
        assert!(!p.is_expired(now, now)); // fresh → kept
    }

    #[test]
    fn saturates_near_epoch_instead_of_wrapping() {
        let p = RetentionPolicy::from_hours(48);
        // now smaller than the window must clamp the cutoff to 0, not wrap around.
        assert_eq!(p.cutoff(MS_PER_HOUR), 0);
        assert!(!p.is_expired(0, MS_PER_HOUR));
    }

    #[test]
    fn short_one_hour_window_supported() {
        let p = RetentionPolicy::from_hours(1);
        assert_eq!(p.retention_ms(), MS_PER_HOUR);
    }
}
