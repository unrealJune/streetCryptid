//! `node.isolation` — noticing that this phone can reach NOBODY, and doing something about it.
//!
//! ## Why this exists
//!
//! On 2026-10-22 the field-soak iPhone SE showed a friend "parked here 12 hr" in Seattle while she
//! was across the lake, publishing live the whole time. Her phone was fine. The SE was not: from
//! 14:06 UTC every connection it attempted — the stash included — timed out (`trail.push.peer`
//! `silent` to every peer, `friend.pull` spending its whole 20 s budget with nothing answering,
//! `iroh_docs` logging "Failed to establish connection: timed out"), while its relay connections
//! stayed up and the OS said Wi-Fi was connected with the internet reachable. It had done the same
//! for eight hours the day before, and twice it recovered on its own. Nothing noticed, nothing
//! tried anything, and the reader rendered its friend's last state as if it were current.
//!
//! A sleeping friend is silent all the time, so silence from one peer means nothing. Silence from
//! every peer INCLUDING the stash — an always-on server — does: that is this phone, not them.
//!
//! ## What it does
//!
//! [`IsolationTracker`] is pure: it is fed one [`Observation`] per delivery pass (a pull, a push)
//! and per `peer.contact`, and says what to do. The node executes it:
//!
//! 1. **Isolated** after [`SILENT_PASSES_MIN`] consecutive silent passes spanning at least
//!    [`ISOLATION_MIN_MS`]. Any answer from anyone ends it.
//! 2. **`Endpoint::network_change()`** on entry, and again every [`NETWORK_CHANGE_REPEAT_MS`] while
//!    it lasts. It rebinds the sockets and re-runs the net report without touching any state, which
//!    is what the 2026-10-21/22 windows — each opening shortly after a `LinkChangeMajor` — looked
//!    like they needed.
//! 3. **A rebuild** once a network change has had [`REBUILD_AFTER_MS`] to work and has not, and no
//!    rebuild has happened for [`REBUILD_COOLDOWN_MS`]. A rebuild is a new endpoint with no paths
//!    to anyone for seconds, and with an app mounted it costs every pairing session, so it is
//!    rate-limited hard. Who performs it depends on who holds the node: see `LocationNode`.
//!
//! Every transition is a `node.isolation` span (`event` = `entered` / `network_change` /
//! `rebuild` / `recovered`), and [`IsolationStatus`] is on `device.health`. The recovery span says
//! which step was last taken before it ended — the data that answers "does a rebuild help, or does
//! it come back on its own?", which on 2026-10-22 nothing could.
//!
//! The tracker is process-wide ([`tracker`]), not per node: a rebuild replaces the node, and the
//! episode it was meant to end must outlive it.

use std::sync::{Mutex, MutexGuard, OnceLock};

/// Consecutive silent passes before the phone counts as isolated.
pub const SILENT_PASSES_MIN: u32 = 3;
/// …and the least wall time they must span, so a burst of passes in one wake cannot trip it.
pub const ISOLATION_MIN_MS: u64 = 10 * 60 * 1000;
/// How often a network change is repeated while isolated.
pub const NETWORK_CHANGE_REPEAT_MS: u64 = 30 * 60 * 1000;
/// How long a network change gets to work before a rebuild is due.
pub const REBUILD_AFTER_MS: u64 = 10 * 60 * 1000;
/// The least time between two rebuilds — any rebuild, including a settings change.
pub const REBUILD_COOLDOWN_MS: u64 = 60 * 60 * 1000;

/// What one delivery pass, or one contact, said about reachability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Observation {
    /// Somebody answered: a peer reconciled, delivered, or exchanged an envelope with us.
    Answered,
    /// We dialled peers, the stash among them, and nobody answered at all.
    Silent,
}

/// Which pass produced an observation. Telemetry only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Pull,
    Push,
    Contact,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pull => "pull",
            Self::Push => "push",
            Self::Contact => "contact",
        }
    }
}

/// What the node should do after an observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    /// Just became isolated.
    Entered { since_ms: u64, silent_passes: u32 },
    /// Call `Endpoint::network_change()`.
    NetworkChange,
    /// Isolation ended.
    Recovered {
        isolated_ms: u64,
        network_changes: u32,
        rebuilds: u32,
        /// The last step taken before the answer came: `none` / `network_change` / `rebuild`.
        last_step: Step,
        since_last_step_ms: u64,
    },
}

/// The last recovery step taken in an episode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    None,
    NetworkChange,
    Rebuild,
}

impl Step {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::NetworkChange => "network_change",
            Self::Rebuild => "rebuild",
        }
    }
}

/// The tracker's state, for `device.health`.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct IsolationStatus {
    /// Whether this phone currently counts as reaching nobody.
    pub isolated: bool,
    /// When the silent streak that made it isolated began (wall clock, ms).
    pub isolated_since_ms: Option<u64>,
    /// Consecutive silent passes in the current streak.
    pub silent_passes: u32,
    /// When anyone last answered (wall clock, ms). `None` until something has, this process.
    pub last_answer_ms: Option<u64>,
    /// Recovery steps taken in the current episode.
    pub network_changes: u32,
    pub rebuilds: u32,
    /// A rebuild is due and has not been done. The mounted app acts on this (`rebindNode`); with
    /// no app holding the node, the node acts on it itself.
    pub rebuild_due: bool,
    /// The last rebuild of the node, for any reason, this process.
    pub last_rebuild_ms: Option<u64>,
    /// Episodes this process has seen, and how many ended.
    pub episodes: u32,
    pub recoveries: u32,
}

/// See the module docs.
#[derive(Debug, Default, Clone)]
pub struct IsolationTracker {
    streak_start_ms: Option<u64>,
    silent_passes: u32,
    isolated: bool,
    last_answer_ms: Option<u64>,
    last_network_change_ms: Option<u64>,
    last_rebuild_ms: Option<u64>,
    last_step: Option<(Step, u64)>,
    episode_network_changes: u32,
    episode_rebuilds: u32,
    episodes: u32,
    recoveries: u32,
}

impl IsolationTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one observation taken at `now_ms`.
    pub fn observe(&mut self, observation: Observation, now_ms: u64) -> Vec<Effect> {
        match observation {
            Observation::Answered => self.answered(now_ms),
            Observation::Silent => self.silent(now_ms),
        }
    }

    fn answered(&mut self, now_ms: u64) -> Vec<Effect> {
        self.last_answer_ms = Some(now_ms);
        let mut effects = Vec::new();
        if self.isolated {
            let since = self.streak_start_ms.unwrap_or(now_ms);
            let (last_step, at) = self.last_step.unwrap_or((Step::None, since));
            self.recoveries += 1;
            effects.push(Effect::Recovered {
                isolated_ms: now_ms.saturating_sub(since),
                network_changes: self.episode_network_changes,
                rebuilds: self.episode_rebuilds,
                last_step,
                since_last_step_ms: now_ms.saturating_sub(at),
            });
        }
        self.streak_start_ms = None;
        self.silent_passes = 0;
        self.isolated = false;
        self.last_network_change_ms = None;
        self.last_step = None;
        self.episode_network_changes = 0;
        self.episode_rebuilds = 0;
        effects
    }

    fn silent(&mut self, now_ms: u64) -> Vec<Effect> {
        let start = *self.streak_start_ms.get_or_insert(now_ms);
        self.silent_passes = self.silent_passes.saturating_add(1);
        let mut effects = Vec::new();
        if !self.isolated
            && self.silent_passes >= SILENT_PASSES_MIN
            && now_ms.saturating_sub(start) >= ISOLATION_MIN_MS
        {
            self.isolated = true;
            self.episodes += 1;
            effects.push(Effect::Entered {
                since_ms: start,
                silent_passes: self.silent_passes,
            });
        }
        if self.isolated {
            let due = self.last_network_change_ms.map_or(true, |at| {
                now_ms.saturating_sub(at) >= NETWORK_CHANGE_REPEAT_MS
            });
            if due {
                self.last_network_change_ms = Some(now_ms);
                self.episode_network_changes += 1;
                self.last_step = Some((Step::NetworkChange, now_ms));
                effects.push(Effect::NetworkChange);
            }
        }
        effects
    }

    /// Whether a rebuild should happen now: isolated, a network change has had its chance, and the
    /// cooldown since the last rebuild has passed.
    pub fn rebuild_due(&self, now_ms: u64) -> bool {
        if !self.isolated {
            return false;
        }
        let Some((_, last_step_at)) = self.last_step else {
            return false;
        };
        if self.episode_network_changes == 0
            || now_ms.saturating_sub(last_step_at) < REBUILD_AFTER_MS
        {
            return false;
        }
        self.last_rebuild_ms
            .map_or(true, |at| now_ms.saturating_sub(at) >= REBUILD_COOLDOWN_MS)
    }

    /// The node was rebuilt at `now_ms`, for whatever reason. Starts the cooldown, and inside an
    /// episode counts as its latest step (a fresh endpoint has rebound everything a network change
    /// would, so the next network change waits its full repeat interval).
    pub fn note_rebuild(&mut self, now_ms: u64) {
        self.last_rebuild_ms = Some(now_ms);
        if self.isolated {
            self.episode_rebuilds += 1;
            self.last_step = Some((Step::Rebuild, now_ms));
            self.last_network_change_ms = Some(now_ms);
        }
    }

    pub fn status(&self, now_ms: u64) -> IsolationStatus {
        IsolationStatus {
            isolated: self.isolated,
            isolated_since_ms: self.isolated.then_some(self.streak_start_ms).flatten(),
            silent_passes: self.silent_passes,
            last_answer_ms: self.last_answer_ms,
            network_changes: self.episode_network_changes,
            rebuilds: self.episode_rebuilds,
            rebuild_due: self.rebuild_due(now_ms),
            last_rebuild_ms: self.last_rebuild_ms,
            episodes: self.episodes,
            recoveries: self.recoveries,
        }
    }
}

/// The process's tracker.
pub fn tracker() -> MutexGuard<'static, IsolationTracker> {
    static TRACKER: OnceLock<Mutex<IsolationTracker>> = OnceLock::new();
    TRACKER
        .get_or_init(|| Mutex::new(IsolationTracker::new()))
        .lock()
        // Plain counters: a panic mid-update leaves nothing worth poisoning the process over.
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Feed the process tracker and emit a `node.isolation` span per transition. Returns the effects
/// for the caller to execute.
pub fn observe(observation: Observation, source: Source) -> Vec<Effect> {
    let now = now_ms();
    let effects = tracker().observe(observation, now);
    for effect in &effects {
        record(effect, source);
    }
    effects
}

/// Note a rebuild in the process tracker, with its span when it was a heal.
pub fn note_rebuild(trigger: &'static str) {
    let now = now_ms();
    let mut tracker = tracker();
    let was_isolated = tracker.status(now).isolated;
    tracker.note_rebuild(now);
    if was_isolated {
        let status = tracker.status(now);
        drop(tracker);
        tracing::info_span!(
            "node.isolation",
            event = "rebuild",
            trigger = trigger,
            rebuilds = status.rebuilds,
            network_changes = status.network_changes,
        )
        .in_scope(|| {});
    }
}

/// The process tracker's status, for `device.health`.
#[uniffi::export]
pub fn isolation_status() -> IsolationStatus {
    tracker().status(now_ms())
}

fn record(effect: &Effect, source: Source) {
    match *effect {
        Effect::Entered {
            since_ms,
            silent_passes,
        } => {
            tracing::info_span!(
                "node.isolation",
                event = "entered",
                source = source.as_str(),
                silent_passes = silent_passes,
                silent_ms = now_ms().saturating_sub(since_ms),
            )
            .in_scope(|| {
                tracing::warn!("node.isolation: no peer, not even the stash, is answering")
            });
        }
        Effect::NetworkChange => {
            tracing::info_span!(
                "node.isolation",
                event = "network_change",
                source = source.as_str(),
            )
            .in_scope(|| {});
        }
        Effect::Recovered {
            isolated_ms,
            network_changes,
            rebuilds,
            last_step,
            since_last_step_ms,
        } => {
            tracing::info_span!(
                "node.isolation",
                event = "recovered",
                source = source.as_str(),
                isolated_ms = isolated_ms,
                network_changes = network_changes,
                rebuilds = rebuilds,
                last_step = last_step.as_str(),
                since_last_step_ms = since_last_step_ms,
            )
            .in_scope(|| {});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60 * 1000;

    fn silent_every(t: &mut IsolationTracker, from: u64, step: u64, n: u32) -> Vec<Effect> {
        let mut all = Vec::new();
        for i in 0..n {
            all.extend(t.observe(Observation::Silent, from + step * i as u64));
        }
        all
    }

    #[test]
    fn one_silent_pass_is_nothing() {
        let mut t = IsolationTracker::new();
        assert!(t.observe(Observation::Silent, 0).is_empty());
        assert!(!t.status(0).isolated);
    }

    #[test]
    fn many_passes_in_one_wake_do_not_isolate() {
        let mut t = IsolationTracker::new();
        // Ten silent passes inside two minutes: count reached, wall time not.
        let effects = silent_every(&mut t, 0, 12_000, 10);
        assert!(effects.is_empty());
        assert!(!t.status(2 * MIN).isolated);
    }

    #[test]
    fn enough_passes_over_enough_time_isolate_and_network_change_at_once() {
        let mut t = IsolationTracker::new();
        let effects = silent_every(&mut t, 0, 5 * MIN, 3);
        assert_eq!(
            effects,
            vec![
                Effect::Entered {
                    since_ms: 0,
                    silent_passes: 3
                },
                Effect::NetworkChange
            ]
        );
        let status = t.status(10 * MIN);
        assert!(status.isolated);
        assert_eq!(status.isolated_since_ms, Some(0));
        assert_eq!(status.network_changes, 1);
        assert_eq!(status.episodes, 1);
    }

    #[test]
    fn an_answer_resets_the_streak_before_isolation() {
        let mut t = IsolationTracker::new();
        silent_every(&mut t, 0, 5 * MIN, 2);
        assert!(t.observe(Observation::Answered, 9 * MIN).is_empty());
        // Two more silent passes: a fresh streak, not the old one plus two.
        assert!(silent_every(&mut t, 10 * MIN, 5 * MIN, 2).is_empty());
        assert!(!t.status(15 * MIN).isolated);
    }

    #[test]
    fn network_change_repeats_on_its_interval_not_every_pass() {
        let mut t = IsolationTracker::new();
        silent_every(&mut t, 0, 5 * MIN, 3); // isolated at 10 min, first network change
        let later = silent_every(&mut t, 15 * MIN, 5 * MIN, 5); // 15..35 min
        assert_eq!(
            later
                .iter()
                .filter(|e| **e == Effect::NetworkChange)
                .count(),
            0,
            "nothing before 30 min have passed since the first"
        );
        let again = t.observe(Observation::Silent, 40 * MIN);
        assert_eq!(again, vec![Effect::NetworkChange]);
        assert_eq!(t.status(40 * MIN).network_changes, 2);
    }

    #[test]
    fn rebuild_waits_for_the_network_change_to_have_its_chance() {
        let mut t = IsolationTracker::new();
        silent_every(&mut t, 0, 5 * MIN, 3); // network change at 10 min
        assert!(!t.rebuild_due(10 * MIN));
        assert!(!t.rebuild_due(19 * MIN));
        assert!(t.rebuild_due(20 * MIN));
    }

    #[test]
    fn rebuild_is_rate_limited_by_the_cooldown() {
        let mut t = IsolationTracker::new();
        silent_every(&mut t, 0, 5 * MIN, 3);
        assert!(t.rebuild_due(20 * MIN));
        t.note_rebuild(20 * MIN);
        assert!(!t.rebuild_due(20 * MIN));
        // Still isolated, network change repeats 30 min after the rebuild …
        assert_eq!(
            t.observe(Observation::Silent, 50 * MIN),
            vec![Effect::NetworkChange]
        );
        // … and the next rebuild waits for the hour, not just the 10 min after that change.
        assert!(!t.rebuild_due(70 * MIN));
        assert!(t.rebuild_due(80 * MIN));
        assert_eq!(t.status(80 * MIN).rebuilds, 1);
    }

    #[test]
    fn a_settings_rebuild_outside_an_episode_still_starts_the_cooldown() {
        let mut t = IsolationTracker::new();
        t.note_rebuild(0);
        silent_every(&mut t, MIN, 5 * MIN, 3); // isolated at 11 min
        assert!(
            !t.rebuild_due(21 * MIN + 1),
            "within the hour of the settings rebuild"
        );
        assert!(t.rebuild_due(60 * MIN));
        assert_eq!(
            t.status(60 * MIN).rebuilds,
            0,
            "the settings rebuild is not the episode's"
        );
    }

    #[test]
    fn recovery_reports_the_last_step_and_resets_the_episode() {
        let mut t = IsolationTracker::new();
        silent_every(&mut t, 0, 5 * MIN, 3); // network change at 10
        t.note_rebuild(25 * MIN);
        let effects = t.observe(Observation::Answered, 27 * MIN);
        assert_eq!(
            effects,
            vec![Effect::Recovered {
                isolated_ms: 27 * MIN,
                network_changes: 1,
                rebuilds: 1,
                last_step: Step::Rebuild,
                since_last_step_ms: 2 * MIN,
            }]
        );
        let status = t.status(27 * MIN);
        assert!(!status.isolated);
        assert_eq!(status.isolated_since_ms, None);
        assert_eq!((status.network_changes, status.rebuilds), (0, 0));
        assert_eq!((status.episodes, status.recoveries), (1, 1));
        assert_eq!(
            status.last_rebuild_ms,
            Some(25 * MIN),
            "the cooldown outlives the episode"
        );
        assert!(!status.rebuild_due);
    }

    #[test]
    fn an_answer_outside_isolation_reports_nothing() {
        let mut t = IsolationTracker::new();
        assert!(t.observe(Observation::Answered, 0).is_empty());
        assert_eq!(t.status(0).last_answer_ms, Some(0));
    }

    #[test]
    fn a_clock_that_goes_backwards_does_not_panic_or_isolate() {
        let mut t = IsolationTracker::new();
        t.observe(Observation::Silent, 100 * MIN);
        t.observe(Observation::Silent, 0);
        t.observe(Observation::Silent, 50 * MIN);
        assert!(!t.status(0).isolated);
        assert!(!t.rebuild_due(0));
    }

    /// Every sequence of up to six events (silent / answered / rebuild) at 5-minute spacing keeps
    /// the invariants: rebuild_due implies isolated and at least one network change; never two
    /// rebuilds inside the cooldown; counters reset with the episode.
    #[test]
    fn invariants_over_short_sequences() {
        #[derive(Clone, Copy)]
        enum Ev {
            Silent,
            Answer,
            Rebuild,
        }
        let all = [Ev::Silent, Ev::Answer, Ev::Rebuild];
        fn walk(seq: &mut Vec<Ev>, depth: usize, all: &[Ev; 3]) {
            if depth == 0 {
                check(seq);
                return;
            }
            for ev in all {
                seq.push(*ev);
                walk(seq, depth - 1, all);
                seq.pop();
            }
        }
        fn check(seq: &[Ev]) {
            let mut t = IsolationTracker::new();
            let mut rebuilds: Vec<u64> = Vec::new();
            for (i, ev) in seq.iter().enumerate() {
                let now = (i as u64 + 1) * 5 * MIN;
                match ev {
                    Ev::Silent => {
                        t.observe(Observation::Silent, now);
                    }
                    Ev::Answer => {
                        t.observe(Observation::Answered, now);
                        let s = t.status(now);
                        assert!(!s.isolated && s.silent_passes == 0 && s.network_changes == 0);
                    }
                    Ev::Rebuild => {
                        if t.rebuild_due(now) {
                            if let Some(last) = rebuilds.last() {
                                assert!(now - last >= REBUILD_COOLDOWN_MS);
                            }
                            rebuilds.push(now);
                        }
                        t.note_rebuild(now);
                    }
                }
                let s = t.status(now);
                if s.rebuild_due {
                    assert!(s.isolated);
                    assert!(s.network_changes >= 1);
                }
                assert!(s.recoveries <= s.episodes);
            }
        }
        walk(&mut Vec::new(), 6, &all);
    }
}
