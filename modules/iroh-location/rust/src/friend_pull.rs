//! `friend.pull` — a native runtime's receive-side pull, measured against the OS's allowance.
//!
//! ## Why this exists
//!
//! A pull is the expensive half of a background wake: `sync_latest` dials every delivery peer and
//! waits up to 25 s for a first event, which is the whole of an iOS background window. On
//! 2026-10-09 the fleet showed the app-mounted, backgrounded iPhone — the common case, since the
//! location background mode keeps that process resident — taking thousands of wakes and pulling
//! on none of them, so every friend's dot was stale until the app was opened. Pulling there too
//! means the pull itself has to be watched, because the failure it risks is quiet: a process iOS
//! freezes or kills mid-pull emits nothing at all.
//!
//! So the native caller records one span per pull with the things only it knows — which wake it
//! rode, whether a mounted app was in the background, how much time iOS said it had left before
//! and after, the CPU it cost — beside the [`PullReport`] the core measured. Two outcomes are
//! reported LATE, by whoever notices: `expired` from iOS's background-task expiration handler while
//! the pull is still running, and `stranded` from the next pull, which finds the durable "pull in
//! flight" mark a frozen or killed process never cleared.
//!
//! The network shape of the same pass is on its `trail.sync` span (namespace end reasons, entries);
//! this one is about the budget.
//!
//! ## What may go on it
//!
//! A closed vocabulary, as for `location.runtime`: enum spellings, durations, counts. The one
//! free-text field, `error`, is an error description and is truncated.

use crate::PullReport;

/// How a pull ended, or how it was found to have ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FriendPullOutcome {
    /// The pass returned. Whether anything arrived is in the report.
    Completed,
    /// The pass returned an error (every namespace failed, or the node was not running).
    Failed,
    /// iOS's background-task expiration handler ran while the pull was still in flight: the OS
    /// is about to suspend us, and the pull may not finish. Emitted from the handler itself.
    Expired,
    /// The next pull found this one's in-flight mark still set: the process was frozen or killed
    /// before it could finish, so nothing else could report it. `elapsed_ms` is the mark's age.
    Stranded,
}

impl FriendPullOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Expired => "expired",
            Self::Stranded => "stranded",
        }
    }
}

/// One `friend.pull` span.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FriendPullEvent {
    pub outcome: FriendPullOutcome,
    /// The wake reason the pull rode (`movement`, `periodic`, `refresh`, …).
    pub trigger: String,
    /// `active` / `inactive` / `background` — the app's state as UIKit reported it.
    pub app_state: String,
    /// Whether a mounted JS runtime held the capture sink, i.e. this is the resident-app case.
    pub js_wired: bool,
    /// The deadline handed to `pull_latest`.
    pub budget_ms: u64,
    /// What iOS said was left of the background allowance before and after the pull. `None` when
    /// it reported no limit, which is what a resident location-mode process usually sees.
    pub bg_remaining_start_ms: Option<u64>,
    pub bg_remaining_end_ms: Option<u64>,
    /// Monotonic wall time around the call, measured by the caller (for `Stranded`, the age of
    /// the mark it found).
    pub elapsed_ms: u64,
    /// Process CPU across the pull, all threads, and the Rust core's share of it.
    pub cpu_ms: Option<u64>,
    pub cpu_ms_rust: Option<u64>,
    /// Time since the previous pull started, against the floor that gates them.
    pub since_last_ms: Option<u64>,
    pub floor_ms: u64,
    /// The core's measurement, when the pass returned.
    pub report: Option<PullReport>,
    pub error: Option<String>,
}

/// Longest `error` exported.
const ERROR_MAX: usize = 160;

/// How far past its budget a pull ran, which only happens when the deadline timer could not fire
/// — the process was frozen inside the pull. Zero when it finished in time.
pub fn overrun_ms(elapsed_ms: u64, budget_ms: u64) -> u64 {
    elapsed_ms.saturating_sub(budget_ms)
}

/// Record one pull as a `friend.pull` span. Synchronous and cheap, like `record_location_runtime`;
/// safe to call from an expiration handler.
#[uniffi::export]
pub fn record_friend_pull(event: FriendPullEvent) {
    let span = tracing::info_span!(
        "friend.pull",
        pull.outcome = event.outcome.as_str(),
        pull.trigger = event.trigger.as_str(),
        pull.app_state = event.app_state.as_str(),
        pull.js_wired = event.js_wired,
        pull.budget_ms = event.budget_ms,
        pull.elapsed_ms = event.elapsed_ms,
        pull.overrun_ms = overrun_ms(event.elapsed_ms, event.budget_ms),
        pull.floor_ms = event.floor_ms,
        pull.bg_remaining_start_ms = tracing::field::Empty,
        pull.bg_remaining_end_ms = tracing::field::Empty,
        pull.cpu_ms = tracing::field::Empty,
        pull.cpu_ms_rust = tracing::field::Empty,
        pull.since_last_ms = tracing::field::Empty,
        pull.peers_dialed = tracing::field::Empty,
        pull.peers_delivered = tracing::field::Empty,
        pull.entries = tracing::field::Empty,
        pull.namespaces = tracing::field::Empty,
        pull.ns_no_answer = tracing::field::Empty,
        pull.ns_deadline = tracing::field::Empty,
        pull.core_elapsed_ms = tracing::field::Empty,
        pull.error = tracing::field::Empty,
    );
    if let Some(ms) = event.bg_remaining_start_ms {
        span.record("pull.bg_remaining_start_ms", ms);
    }
    if let Some(ms) = event.bg_remaining_end_ms {
        span.record("pull.bg_remaining_end_ms", ms);
    }
    if let Some(ms) = event.cpu_ms {
        span.record("pull.cpu_ms", ms);
    }
    if let Some(ms) = event.cpu_ms_rust {
        span.record("pull.cpu_ms_rust", ms);
    }
    if let Some(ms) = event.since_last_ms {
        span.record("pull.since_last_ms", ms);
    }
    if let Some(report) = &event.report {
        span.record("pull.peers_dialed", report.peers_dialed);
        span.record("pull.peers_delivered", report.peers_delivered);
        span.record("pull.entries", report.entries);
        span.record("pull.namespaces", report.namespaces);
        span.record("pull.ns_no_answer", report.ns_no_answer);
        span.record("pull.ns_deadline", report.ns_deadline);
        span.record("pull.core_elapsed_ms", report.elapsed_ms);
    }
    if let Some(error) = &event.error {
        let bounded: String = error.chars().take(ERROR_MAX).collect();
        span.record("pull.error", bounded.as_str());
    }
    drop(span.entered());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(outcome: FriendPullOutcome) -> FriendPullEvent {
        FriendPullEvent {
            outcome,
            trigger: "movement".into(),
            app_state: "background".into(),
            js_wired: true,
            budget_ms: 20_000,
            bg_remaining_start_ms: Some(29_000),
            bg_remaining_end_ms: Some(27_500),
            elapsed_ms: 1_500,
            cpu_ms: Some(80),
            cpu_ms_rust: Some(60),
            since_last_ms: Some(300_000),
            floor_ms: 300_000,
            report: Some(PullReport {
                elapsed_ms: 1_480,
                peers_requested: 3,
                peers_dialed: 3,
                peers_delivered: 1,
                entries: 2,
                namespaces: 3,
                ns_content_ready: 2,
                ns_no_answer: 1,
                ..PullReport::default()
            }),
            error: Some("x".repeat(500)),
        }
    }

    /// Every outcome records without a subscriber, with and without a report, and an over-long
    /// error does not panic.
    #[test]
    fn records_every_outcome() {
        for outcome in [
            FriendPullOutcome::Completed,
            FriendPullOutcome::Failed,
            FriendPullOutcome::Expired,
            FriendPullOutcome::Stranded,
        ] {
            record_friend_pull(event(outcome));
            record_friend_pull(FriendPullEvent {
                report: None,
                bg_remaining_start_ms: None,
                bg_remaining_end_ms: None,
                cpu_ms: None,
                cpu_ms_rust: None,
                since_last_ms: None,
                error: None,
                ..event(outcome)
            });
        }
    }

    #[test]
    fn outcome_spellings_are_distinct() {
        let all = [
            FriendPullOutcome::Completed,
            FriendPullOutcome::Failed,
            FriendPullOutcome::Expired,
            FriendPullOutcome::Stranded,
        ];
        let spellings: std::collections::HashSet<_> = all.iter().map(|o| o.as_str()).collect();
        assert_eq!(spellings.len(), all.len());
    }

    #[test]
    fn overrun_is_only_time_past_the_budget() {
        assert_eq!(overrun_ms(1_500, 20_000), 0);
        assert_eq!(overrun_ms(20_000, 20_000), 0);
        // Frozen mid-pull: the deadline could not fire, so the excess is the freeze.
        assert_eq!(overrun_ms(620_000, 20_000), 600_000);
    }
}
