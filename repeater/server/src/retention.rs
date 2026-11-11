//! Retention policy — the stash-side "which ciphertext may we stop holding?" decision,
//! expressed as pure, clock-injectable logic so it is testable without a live replica.
//!
//! This used to be only the app's rolling-window idea (ARCHITECTURE §5): entries whose timestamp
//! is strictly older than `now - retention` are eligible to be pruned. The product no longer reads
//! a friend's back-catalogue from the stash, though — friends render as a single latest dot — so
//! the primary rule is now "latest location fix per author per namespace." The window remains as a
//! backstop for an author who goes silent forever: one fix per author is tiny, but this process is
//! deliberately RAM-only and should not hold even that last blob for an unbounded lifetime.
//!
//! The live node cannot depend on the app crate, so the tiny parser below mirrors the stable
//! iroh-docs key shape from `iroh-location`: location fixes are
//! `hex(author_bytes)/{seq:020}`. Control entries are `ctl/hex(author)` and are not trail history;
//! this module deliberately leaves them alone so a retention sweep cannot drop the live-mode
//! request payload that the app expects to be load-bearing current state.

use std::collections::HashMap;

/// Milliseconds in one hour.
pub const MS_PER_HOUR: u64 = 3_600_000;
/// Key separator between the hex author and the zero-padded sequence number.
pub const KEY_SEP: u8 = b'/';
/// Width of the zero-padded decimal sequence number in app-authored fix keys.
pub const SEQ_WIDTH: usize = 20;
/// Literal leading segment used by app control entries, not location fixes.
pub const CTL_TAG: &str = "ctl";

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

/// A parsed location-fix docs key.
///
/// The author bytes are the first grouping dimension for stash retention: each namespace keeps at
/// most the highest sequence for each author. The docs entry's own author id is intentionally not
/// used here because phones can relay friends' trails; the stable app-level author is the one
/// encoded into the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixKey {
    pub author: Vec<u8>,
    pub seq: u64,
}

/// Decode a location-fix key produced by the app's `encode_key`.
///
/// This is intentionally stricter than the app's general-purpose reader: retention is allowed to
/// release content, so malformed keys fail closed and keep their blobs. In particular `ctl/...`
/// control keys fail at the author segment (`ctl` is not even-length hex) and are never treated as
/// superseded trail fixes. The sequence segment must be exactly 20 ASCII digits, matching the
/// zero-padding that makes lexicographic order line up with numeric order.
pub fn decode_fix_key(key: &[u8]) -> Option<FixKey> {
    let pos = key.iter().position(|&b| b == KEY_SEP)?;
    let author_hex = std::str::from_utf8(&key[..pos]).ok()?;
    let seq_bytes = &key[pos + 1..];
    if author_hex.is_empty()
        || seq_bytes.len() != SEQ_WIDTH
        || !seq_bytes.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let author = hex_decode(author_hex)?;
    if author.is_empty() {
        return None;
    }
    let seq = std::str::from_utf8(seq_bytes).ok()?.parse::<u64>().ok()?;
    Some(FixKey { author, seq })
}

/// One docs entry as seen by the pure release selector.
#[derive(Debug, Clone, Copy)]
pub struct RetentionEntry<'a> {
    /// Raw docs key bytes.
    pub key: &'a [u8],
    /// Entry write timestamp in milliseconds since the Unix epoch.
    pub written_ms: u64,
}

/// Why a location-fix entry's content is eligible for release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseReason {
    /// A newer fix from the same key-encoded author exists in the same namespace.
    Superseded,
    /// This fix is the author's latest known value, but it aged past the configured backstop.
    Expired,
    /// Both rules matched; counted in both telemetry buckets, released once.
    SupersededAndExpired,
}

impl ReleaseReason {
    /// Whether this decision came from the latest-per-author rule.
    pub fn is_superseded(self) -> bool {
        matches!(self, Self::Superseded | Self::SupersededAndExpired)
    }

    /// Whether this decision came from the time-window backstop.
    pub fn is_expired(self) -> bool {
        matches!(self, Self::Expired | Self::SupersededAndExpired)
    }
}

/// Classify entries from **one namespace** by the stash's content-release policy.
///
/// Two independent rules, and every entry is subject to at least one of them:
///
/// * **Superseded** (fix keys only) — a newer `hex(author)/{seq:020}` fix from the same
///   key-encoded author exists here, so the older ciphertext is dead weight. This is the primary
///   rule and it is age-independent: a burst of a thousand fixes collapses on the next sweep.
/// * **Expired** (every key) — the entry aged past the configured window. This is the backstop,
///   and it deliberately applies to keys this module cannot parse.
///
/// That second point is the load-bearing one, so it is spelled out: it is tempting to make an
/// unparseable key "fail closed" and keep its content, on the grounds that releasing something we
/// do not understand might drop live data. That reasoning is inverted for a RAM-only service.
/// Failing closed on *release* is failing open on *memory* — anything that can write a key we do
/// not recognise (a future key format, a buggy client, a peer with a write capability) could pin
/// unbounded ciphertext in this process forever, which is an OOM, not a conservative default. The
/// window is the only bound that does not depend on understanding the payload, so nothing is
/// exempt from it.
///
/// Control entries (`ctl/hex(author)`) are therefore aged out like anything else, exactly as they
/// were before latest-only retention existed. They are never reported as *superseded*, because a
/// control key is one overwritten-in-place slot per author rather than a history, and treating an
/// unrelated fix as superseding it would be a control-plane data-loss bug. Ageing is safe on the
/// app's own numbers: live-mode requests cap out at a 30-minute TTL (`LIVE_TTL_MAX_MS`) with a
/// 10-minute freshness window, and the shortest window this policy allows is an hour.
///
/// The namespace boundary matters: two namespaces may legitimately contain identical keys from the
/// same author, but retention is a per-grant decision and the live
/// [`ContentIndex`](crate::content::ContentIndex) refcounts the resulting content hashes across
/// namespaces.
pub fn release_decisions(
    entries: &[RetentionEntry<'_>],
    policy: RetentionPolicy,
    now_ms: u64,
) -> Vec<Option<ReleaseReason>> {
    let parsed = entries
        .iter()
        .map(|entry| decode_fix_key(entry.key))
        .collect::<Vec<_>>();

    let mut latest_by_author: HashMap<Vec<u8>, u64> = HashMap::new();
    for key in parsed.iter().flatten() {
        latest_by_author
            .entry(key.author.clone())
            .and_modify(|latest| *latest = (*latest).max(key.seq))
            .or_insert(key.seq);
    }

    entries
        .iter()
        .zip(parsed.iter())
        .map(|(entry, key)| {
            // Supersession needs a parsed fix key; expiry applies to every entry regardless.
            let superseded = key.as_ref().is_some_and(|key| {
                latest_by_author
                    .get(&key.author)
                    .is_some_and(|latest| key.seq < *latest)
            });
            let expired = policy.is_expired(entry.written_ms, now_ms);
            match (superseded, expired) {
                (true, true) => Some(ReleaseReason::SupersededAndExpired),
                (true, false) => Some(ReleaseReason::Superseded),
                (false, true) => Some(ReleaseReason::Expired),
                (false, false) => None,
            }
        })
        .collect()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < b.len() {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_encode(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    fn fix_key(author: &[u8], seq: u64) -> Vec<u8> {
        format!("{}/{seq:0width$}", hex_encode(author), width = SEQ_WIDTH).into_bytes()
    }

    fn ctl_key(author: &[u8]) -> Vec<u8> {
        format!("{CTL_TAG}/{}", hex_encode(author)).into_bytes()
    }

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

    #[test]
    fn parses_only_exact_location_fix_keys() {
        let key = fix_key(&[0xab, 0xcd], 42);
        assert_eq!(
            decode_fix_key(&key),
            Some(FixKey {
                author: vec![0xab, 0xcd],
                seq: 42
            })
        );

        assert!(
            decode_fix_key(&ctl_key(&[0xab, 0xcd])).is_none(),
            "control keys are current-state messages, not location fixes"
        );
        assert!(
            decode_fix_key(b"abcd/42").is_none(),
            "retention fails closed unless the app's zero-padded seq width is present"
        );
        assert!(decode_fix_key(b"abcd/00000000000000000x42").is_none());
    }

    #[test]
    fn superseded_fixes_are_selected_per_author() {
        let policy = RetentionPolicy::from_hours(48);
        let now = 100 * MS_PER_HOUR;
        let fresh = now;
        let author_a_old = fix_key(&[0xa1], 1);
        let author_a_new = fix_key(&[0xa1], 2);
        let author_b_only = fix_key(&[0xb1], 1);
        let entries = [
            RetentionEntry {
                key: &author_a_old,
                written_ms: fresh,
            },
            RetentionEntry {
                key: &author_a_new,
                written_ms: fresh,
            },
            RetentionEntry {
                key: &author_b_only,
                written_ms: fresh,
            },
        ];

        assert_eq!(
            release_decisions(&entries, policy, now),
            vec![Some(ReleaseReason::Superseded), None, None]
        );
    }

    #[test]
    fn time_window_is_a_backstop_for_latest_fixes() {
        let policy = RetentionPolicy::from_hours(1);
        let now = 10 * MS_PER_HOUR;
        let latest_but_stale = fix_key(&[0xa1], 9);
        let entries = [RetentionEntry {
            key: &latest_but_stale,
            written_ms: now - (2 * MS_PER_HOUR),
        }];

        assert_eq!(
            release_decisions(&entries, policy, now),
            vec![Some(ReleaseReason::Expired)]
        );
    }

    #[test]
    fn superseded_and_expired_reasons_are_both_visible() {
        let policy = RetentionPolicy::from_hours(1);
        let now = 10 * MS_PER_HOUR;
        let old = fix_key(&[0xa1], 1);
        let new = fix_key(&[0xa1], 2);
        let entries = [
            RetentionEntry {
                key: &old,
                written_ms: now - (2 * MS_PER_HOUR),
            },
            RetentionEntry {
                key: &new,
                written_ms: now,
            },
        ];

        let decisions = release_decisions(&entries, policy, now);
        assert_eq!(
            decisions,
            vec![Some(ReleaseReason::SupersededAndExpired), None]
        );
        let reason = decisions[0].expect("old fix should be releasable");
        assert!(reason.is_superseded());
        assert!(reason.is_expired());
    }

    #[test]
    fn control_entries_age_out_but_are_never_superseded() {
        let policy = RetentionPolicy::from_hours(1);
        let now = 10 * MS_PER_HOUR;
        let author = [0xa1];
        let old_fix = fix_key(&author, 1);
        let new_fix = fix_key(&author, 2);
        let fresh_control = ctl_key(&author);
        let entries = [
            RetentionEntry {
                key: &old_fix,
                written_ms: now,
            },
            RetentionEntry {
                key: &fresh_control,
                written_ms: now,
            },
            RetentionEntry {
                key: &new_fix,
                written_ms: now,
            },
        ];

        assert_eq!(
            release_decisions(&entries, policy, now),
            vec![Some(ReleaseReason::Superseded), None, None],
            "a fresh ctl/hex(author) slot must survive a fix superseding another fix"
        );

        // ...but it is not immortal. Live-mode requests cap at a 30-minute TTL, so a control entry
        // older than the (minimum one hour) window is dead state, and holding it would exempt a
        // whole key class from the only bound this RAM-only process has.
        let stale_control = [RetentionEntry {
            key: &fresh_control,
            written_ms: now - (9 * MS_PER_HOUR),
        }];
        assert_eq!(
            release_decisions(&stale_control, policy, now),
            vec![Some(ReleaseReason::Expired)]
        );
    }

    #[test]
    fn unparseable_keys_are_still_bounded_by_the_window() {
        let policy = RetentionPolicy::from_hours(1);
        let now = 10 * MS_PER_HOUR;
        // A key this module cannot parse must NOT be exempt from retention. If it were, anything
        // able to write an unrecognised key into a granted namespace could pin ciphertext in this
        // RAM-only process forever — unbounded memory growth, i.e. a denial of service, reached by
        // "safely" declining to release what we do not understand.
        let junk = b"not-a-fix-key".to_vec();
        let truncated_seq = b"a1/42".to_vec();

        let fresh = [
            RetentionEntry {
                key: &junk,
                written_ms: now,
            },
            RetentionEntry {
                key: &truncated_seq,
                written_ms: now,
            },
        ];
        assert_eq!(
            release_decisions(&fresh, policy, now),
            vec![None, None],
            "an unrecognised key is still held while it is fresh"
        );

        let ancient = [
            RetentionEntry {
                key: &junk,
                written_ms: 0,
            },
            RetentionEntry {
                key: &truncated_seq,
                written_ms: 0,
            },
        ];
        assert_eq!(
            release_decisions(&ancient, policy, now),
            vec![Some(ReleaseReason::Expired), Some(ReleaseReason::Expired)],
            "no key class may outlive the retention window"
        );
    }
}
