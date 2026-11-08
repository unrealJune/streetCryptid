//! Stash configuration from the environment. Parsing takes an injectable getter so it is unit-
//! testable without touching the real process environment (the same pattern the pairing-mailbox
//! uses for its clock). All numeric knobs are clamped to sane bounds.

use crate::retention::RetentionPolicy;

/// Control-API port.
pub const DEFAULT_PORT: u16 = 8787;

/// Default latest-fix backstop. Superseded fixes are released regardless of age; this bounds the
/// last fix from an author who goes silent forever.
pub const DEFAULT_RETENTION_HOURS: u64 = 48;
/// Floor: below an hour, a briefly offline reader could miss even the latest dot.
pub const MIN_RETENTION_HOURS: u64 = 1;
/// Ceiling: keeps stale latest dots from becoming effectively forever state (two weeks).
pub const MAX_RETENTION_HOURS: u64 = 24 * 14;

/// How often the prune sweep runs.
pub const DEFAULT_PRUNE_INTERVAL_MIN: u64 = 15;
pub const MIN_PRUNE_INTERVAL_MIN: u64 = 1;
pub const MAX_PRUNE_INTERVAL_MIN: u64 = 24 * 60;

/// How often a repeater reconciles every namespace it holds with its sibling repeaters.
/// Siblings are not guaranteed to be up, so this is the cadence at which two that were both
/// asleep at different times catch each other up — not a liveness heartbeat.
pub const DEFAULT_PEER_SYNC_INTERVAL_MIN: u64 = 5;
pub const MIN_PEER_SYNC_INTERVAL_MIN: u64 = 1;
pub const MAX_PEER_SYNC_INTERVAL_MIN: u64 = 24 * 60;

/// Fully-resolved stash configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StashConfig {
    pub port: u16,
    pub retention: RetentionPolicy,
    pub prune_interval_min: u64,
    /// Custom iroh relay URLs. Empty uses iroh's default n0 relay map.
    pub relay_urls: Vec<String>,
    /// Optional bearer token sent to every custom relay.
    pub relay_token: Option<String>,
    /// Control-API pre-shared key (anti-abuse gate, like the relay auth token). `None` disables
    /// the gate. See [`crate::auth`].
    pub psk: Option<String>,
    /// Where a **persistent** node (a repeater) keeps its replica, blobs, namespace book and — when
    /// `TRAIL_STASH_SECRET_KEY` is unset — its identity. `None` is the hosted stash: RAM only.
    pub data_dir: Option<String>,
    /// Endpoint tickets of sibling repeaters to reconcile every held namespace with.
    pub peers: Vec<String>,
    /// Cadence of that reconciliation.
    pub peer_sync_interval_min: u64,
}

impl StashConfig {
    /// Resolve config from a getter over environment variables. Unset or unparseable values fall
    /// back to the defaults; out-of-range values are clamped rather than rejected.
    ///
    /// Keys represented by `StashConfig`: `PORT`, `TRAIL_STASH_RETENTION_HOURS`,
    /// `TRAIL_STASH_PRUNE_INTERVAL_MIN`, `TRAIL_STASH_PSK`, comma-separated
    /// `TRAIL_STASH_RELAY_URLS`, optional `TRAIL_STASH_RELAY_TOKEN`, and the repeater keys
    /// `TRAIL_STASH_DATA_DIR`, comma-separated `TRAIL_STASH_PEERS` and
    /// `TRAIL_STASH_PEER_SYNC_INTERVAL_MIN`.
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

        let relay_urls = get("TRAIL_STASH_RELAY_URLS")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|url| !url.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let relay_token = get("TRAIL_STASH_RELAY_TOKEN")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let data_dir = get("TRAIL_STASH_DATA_DIR")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let peers = get("TRAIL_STASH_PEERS")
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|ticket| !ticket.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let peer_sync_interval_min = get("TRAIL_STASH_PEER_SYNC_INTERVAL_MIN")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_PEER_SYNC_INTERVAL_MIN)
            .clamp(MIN_PEER_SYNC_INTERVAL_MIN, MAX_PEER_SYNC_INTERVAL_MIN);

        Self {
            port,
            retention: RetentionPolicy::from_hours(hours),
            prune_interval_min,
            relay_urls,
            relay_token,
            psk,
            data_dir,
            peers,
            peer_sync_interval_min,
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
        assert!(cfg.relay_urls.is_empty());
        assert_eq!(cfg.relay_token, None);
        // The hosted stash is the default: no disk, no siblings.
        assert_eq!(cfg.data_dir, None);
        assert!(cfg.peers.is_empty());
        assert_eq!(cfg.peer_sync_interval_min, DEFAULT_PEER_SYNC_INTERVAL_MIN);
    }

    #[test]
    fn repeater_keys_are_parsed_trimmed_and_clamped() {
        let cfg = StashConfig::from_env(getter(&[
            ("TRAIL_STASH_DATA_DIR", " /var/lib/repeater "),
            ("TRAIL_STASH_PEERS", " endpointaaa, ,endpointbbb "),
            ("TRAIL_STASH_PEER_SYNC_INTERVAL_MIN", "0"),
        ]));
        assert_eq!(cfg.data_dir.as_deref(), Some("/var/lib/repeater"));
        assert_eq!(cfg.peers, vec!["endpointaaa", "endpointbbb"]);
        assert_eq!(cfg.peer_sync_interval_min, MIN_PEER_SYNC_INTERVAL_MIN);
        // Whitespace-only is unset, not a relative path named " ".
        assert_eq!(
            StashConfig::from_env(getter(&[("TRAIL_STASH_DATA_DIR", "  ")])).data_dir,
            None
        );
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

    #[test]
    fn custom_relays_are_parsed_and_trimmed() {
        let cfg = StashConfig::from_env(getter(&[
            (
                "TRAIL_STASH_RELAY_URLS",
                " https://relay-one.example.com, ,https://relay-two.example.com ",
            ),
            ("TRAIL_STASH_RELAY_TOKEN", " relay-secret "),
        ]));
        assert_eq!(
            cfg.relay_urls,
            vec![
                "https://relay-one.example.com",
                "https://relay-two.example.com"
            ]
        );
        assert_eq!(cfg.relay_token.as_deref(), Some("relay-secret"));
    }
}
