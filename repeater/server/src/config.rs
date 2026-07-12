//! Stash configuration from the environment. Parsing takes an injectable getter so it is unit-
//! testable without touching the real process environment (the same pattern the pairing-mailbox
//! uses for its clock). All numeric knobs are clamped to sane bounds.

use crate::retention::RetentionPolicy;

/// Control-API port.
pub const DEFAULT_PORT: u16 = 8787;

/// Default retention window. Matches the app's 24–48h view for full offline catch-up.
pub const DEFAULT_RETENTION_HOURS: u64 = 48;
/// Floor: below an hour, a phone that backgrounds briefly could miss its own gap.
pub const MIN_RETENTION_HOURS: u64 = 1;
/// Ceiling: keeps the in-memory footprint bounded (two weeks).
pub const MAX_RETENTION_HOURS: u64 = 24 * 14;

/// How often the prune sweep runs.
pub const DEFAULT_PRUNE_INTERVAL_MIN: u64 = 15;
pub const MIN_PRUNE_INTERVAL_MIN: u64 = 1;
pub const MAX_PRUNE_INTERVAL_MIN: u64 = 24 * 60;

/// Fully-resolved stash configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StashConfig {
    pub port: u16,
    pub retention: RetentionPolicy,
    pub prune_interval_min: u64,
    /// Control-API pre-shared key (anti-abuse gate, like the relay auth token). `None` disables
    /// the gate. See [`crate::auth`].
    pub psk: Option<String>,
}

impl StashConfig {
    /// Resolve config from a getter over environment variables. Unset or unparseable values fall
    /// back to the defaults; out-of-range values are clamped rather than rejected.
    ///
    /// Recognised keys: `PORT`, `TRAIL_STASH_RETENTION_HOURS`, `TRAIL_STASH_PRUNE_INTERVAL_MIN`.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let port = get("PORT")
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|p| *p != 0)
            .unwrap_or(DEFAULT_PORT);

        let hours = get("TRAIL_STASH_RETENTION_HOURS")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_RETENTION_HOURS)
            .clamp(MIN_RETENTION_HOURS, MAX_RETENTION_HOURS);

        let prune_interval_min = get("TRAIL_STASH_PRUNE_INTERVAL_MIN")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_PRUNE_INTERVAL_MIN)
            .clamp(MIN_PRUNE_INTERVAL_MIN, MAX_PRUNE_INTERVAL_MIN);

        let psk = get("TRAIL_STASH_PSK")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        Self {
            port,
            retention: RetentionPolicy::from_hours(hours),
            prune_interval_min,
            psk,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn getter(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn empty_env_uses_defaults() {
        let cfg = StashConfig::from_env(getter(&[]));
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert_eq!(
            cfg.retention,
            RetentionPolicy::from_hours(DEFAULT_RETENTION_HOURS)
        );
        assert_eq!(cfg.prune_interval_min, DEFAULT_PRUNE_INTERVAL_MIN);
    }

    #[test]
    fn parses_custom_values() {
        let cfg = StashConfig::from_env(getter(&[
            ("PORT", "9000"),
            ("TRAIL_STASH_RETENTION_HOURS", "1"),
            ("TRAIL_STASH_PRUNE_INTERVAL_MIN", "5"),
        ]));
        assert_eq!(cfg.port, 9000);
        assert_eq!(cfg.retention, RetentionPolicy::from_hours(1));
        assert_eq!(cfg.prune_interval_min, 5);
    }

    #[test]
    fn clamps_out_of_range() {
        let cfg = StashConfig::from_env(getter(&[
            ("TRAIL_STASH_RETENTION_HOURS", "100000"),
            ("TRAIL_STASH_PRUNE_INTERVAL_MIN", "0"),
        ]));
        assert_eq!(
            cfg.retention,
            RetentionPolicy::from_hours(MAX_RETENTION_HOURS)
        );
        assert_eq!(cfg.prune_interval_min, MIN_PRUNE_INTERVAL_MIN);
    }

    #[test]
    fn junk_falls_back_to_default() {
        let cfg = StashConfig::from_env(getter(&[
            ("PORT", "not-a-port"),
            ("TRAIL_STASH_RETENTION_HOURS", "abc"),
        ]));
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert_eq!(
            cfg.retention,
            RetentionPolicy::from_hours(DEFAULT_RETENTION_HOURS)
        );
    }

    #[test]
    fn zero_port_rejected() {
        let cfg = StashConfig::from_env(getter(&[("PORT", "0")]));
        assert_eq!(cfg.port, DEFAULT_PORT);
    }

    #[test]
    fn psk_parsed_trimmed_and_optional() {
        assert_eq!(StashConfig::from_env(getter(&[])).psk, None);
        assert_eq!(
            StashConfig::from_env(getter(&[("TRAIL_STASH_PSK", "  s3cret  ")])).psk,
            Some("s3cret".to_string())
        );
        // whitespace-only is treated as unset (gate disabled) rather than an empty PSK.
        assert_eq!(
            StashConfig::from_env(getter(&[("TRAIL_STASH_PSK", "   ")])).psk,
            None
        );
    }
}
