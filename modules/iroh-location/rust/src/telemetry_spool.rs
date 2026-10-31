//! Rust telemetry that survives being offline: every OTLP batch is either delivered or kept.
//!
//! ## Why
//! The SDK's batch processors hand a batch to the exporter once, and a failed POST is the end of
//! it. That is fine on a desk and wrong for this app, whose whole nearby story is two phones with
//! no internet: on 2026-10-31 an iPhone 16 Pro Max took part in three Bump pairings with no route
//! to the collector, and every Rust span it recorded — its own `bump.resolve`, `pair.dial`,
//! `pair.inbound` — was gone, so why its own search never found the Pixel beside it stayed
//! unknowable. Its JS spans of the same minutes arrived later, because `shipper.ts` drains a
//! durable journal. This is the same rule for the core: persist, then drain.
//!
//! ## Shape
//! One [`Shipper`] per signal (traces, logs), driven from the SDK's export thread. A batch is
//! encoded to OTLP protobuf up front, so what is kept is exactly what would have been sent, with
//! its ORIGINAL timestamps and resource. When nothing is queued it is POSTed straight away and
//! touches no disk; when that fails, or something is already queued, it goes to the spool and the
//! spool drains oldest first. Failures back off (5 s doubling to 5 min) so an offline phone does
//! not spend its export thread on connect timeouts.
//!
//! The spool is files under the directory the platform hands [`set_dir`] (the app's caches), or
//! memory until one is set. Both are bounded, oldest dropped first, and a batch older than
//! [`MAX_AGE`] is dropped rather than sent. A collector that answers 4xx (other than 408/429) is
//! refusing the batch, not unreachable: the batch is dropped and draining continues, because a
//! poison batch at the head would otherwise block everything behind it forever — the shape the JS
//! shipper had once.
//!
//! Nothing in here emits `tracing` events while it works: it runs on the exporter's own thread,
//! and an event would be exported by the thing that is exporting it. The one exception is the
//! [`Recovered`] hook, called once a backlog has fully drained, after the work is done; the `otel`
//! exporter turns it into one `telemetry.recovered` span, which rides the next batch.

// Compiled on every target so the queue rules are tested on the host; only the `otel` exporter
// drives it.
#![cfg_attr(not(feature = "otel"), allow(dead_code))]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Per signal, on disk. A pairing's worth of spans is tens of kilobytes; this is hours of a phone.
pub(crate) const MAX_SPOOL_BYTES: u64 = 8 * 1024 * 1024;
/// Per signal, in memory, before the platform has said where the spool lives.
pub(crate) const MAX_MEMORY_BYTES: usize = 2 * 1024 * 1024;
/// Older than this, a batch is dropped rather than sent.
pub(crate) const MAX_AGE: Duration = Duration::from_secs(3 * 24 * 3600);
/// Queued batches sent per export call, so one export cannot hold the export thread for long.
pub(crate) const DRAIN_PER_EXPORT: usize = 16;
const BACKOFF_FIRST: Duration = Duration::from_secs(5);
const BACKOFF_MAX: Duration = Duration::from_secs(300);

static SPOOL_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Where spooled batches live from now on. Created if missing; an unusable directory leaves the
/// spool in memory.
pub(crate) fn set_dir(dir: PathBuf) -> bool {
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    *SPOOL_DIR.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir);
    true
}

fn current_dir() -> Option<PathBuf> {
    SPOOL_DIR.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// What one POST came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PostOutcome {
    Delivered,
    /// The collector refused this batch; sending it again will not change that.
    Refused,
    /// Unreachable, timed out, or a 5xx/408/429: try again later.
    Retry,
}

/// A backlog that has just fully drained: how many spooled batches went out, and how old the
/// oldest was, which is how far back the data that just arrived reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Recovered {
    pub signal: Signal,
    pub batches: u64,
    pub oldest_age: Duration,
}

/// The network half, so the queue rules can be tested without one.
pub(crate) trait Sink: Send + Sync {
    fn post(&self, body: &[u8]) -> PostOutcome;
}

/// Counters across both signals, for `process.memory`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Snapshot {
    /// Batches waiting now, and their bytes.
    pub backlog_batches: u64,
    pub backlog_bytes: u64,
    /// Batches that went to the spool because a send failed or something was ahead of them.
    pub spooled_total: u64,
    /// Spooled batches later delivered.
    pub replayed_total: u64,
    /// Batches given up on: refused, too old, or pushed out by the bound.
    pub dropped_total: u64,
}

static SPOOLED: AtomicU64 = AtomicU64::new(0);
static REPLAYED: AtomicU64 = AtomicU64::new(0);
static DROPPED: AtomicU64 = AtomicU64::new(0);
/// Process-wide, with the pid beside it in the name: two shippers, or a previous process, can
/// write in the same nanosecond.
static FILE_SEQ: AtomicU64 = AtomicU64::new(0);
static BACKLOG_BATCHES: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];
static BACKLOG_BYTES: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];

pub(crate) fn snapshot() -> Snapshot {
    Snapshot {
        backlog_batches: BACKLOG_BATCHES.iter().map(|c| c.load(Relaxed)).sum(),
        backlog_bytes: BACKLOG_BYTES.iter().map(|c| c.load(Relaxed)).sum(),
        spooled_total: SPOOLED.load(Relaxed),
        replayed_total: REPLAYED.load(Relaxed),
        dropped_total: DROPPED.load(Relaxed),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Signal {
    Traces,
    Logs,
}

impl Signal {
    fn prefix(self) -> &'static str {
        match self {
            Signal::Traces => "traces-",
            Signal::Logs => "logs-",
        }
    }

    fn index(self) -> usize {
        match self {
            Signal::Traces => 0,
            Signal::Logs => 1,
        }
    }
}

struct MemoryItem {
    at: SystemTime,
    body: Vec<u8>,
}

struct State {
    memory: VecDeque<MemoryItem>,
    memory_bytes: usize,
    failures: u32,
    backoff_until: Option<Instant>,
}

/// Delivers one signal's batches, keeping whatever it cannot deliver yet.
pub(crate) struct Shipper<S: Sink> {
    signal: Signal,
    sink: S,
    /// `None` reads the process-wide directory from [`set_dir`]; tests pin their own.
    dir_override: Option<PathBuf>,
    state: Mutex<State>,
    on_recovered: Option<fn(Recovered)>,
}

enum Queued {
    Memory(SystemTime),
    File(PathBuf, u64, SystemTime),
}

impl Queued {
    fn at(&self) -> SystemTime {
        match self {
            Queued::Memory(at) | Queued::File(_, _, at) => *at,
        }
    }
}

impl<S: Sink> Shipper<S> {
    pub(crate) fn new(signal: Signal, sink: S) -> Self {
        Self::with_dir(signal, sink, None)
    }

    pub(crate) fn with_dir(signal: Signal, sink: S, dir_override: Option<PathBuf>) -> Self {
        Self {
            signal,
            sink,
            dir_override,
            state: Mutex::new(State {
                memory: VecDeque::new(),
                memory_bytes: 0,
                failures: 0,
                backoff_until: None,
            }),
            on_recovered: None,
        }
    }

    /// Call `hook` each time a backlog has fully drained.
    pub(crate) fn on_recovered(mut self, hook: fn(Recovered)) -> Self {
        self.on_recovered = Some(hook);
        self
    }

    fn dir(&self) -> Option<PathBuf> {
        self.dir_override.clone().or_else(current_dir)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Deliver `body` (one encoded OTLP export request), or keep it for later.
    pub(crate) fn ship(&self, body: Vec<u8>) {
        self.ship_at(body, Instant::now(), SystemTime::now());
    }

    fn ship_at(&self, body: Vec<u8>, now: Instant, wall: SystemTime) {
        let backing_off = self.lock().backoff_until.is_some_and(|until| now < until);
        if !backing_off && self.queued(wall).is_empty() {
            match self.sink.post(&body) {
                PostOutcome::Delivered => {
                    self.note_success();
                    return;
                }
                PostOutcome::Refused => {
                    DROPPED.fetch_add(1, Relaxed);
                    return;
                }
                PostOutcome::Retry => self.note_failure(now),
            }
            self.keep(body, wall);
            return;
        }
        self.keep(body, wall);
        if !backing_off {
            self.drain(now, wall);
        }
    }

    /// Send queued batches oldest first until one fails or the per-call budget is spent.
    fn drain(&self, now: Instant, wall: SystemTime) {
        let mut replayed = 0u64;
        let mut oldest: Option<SystemTime> = None;
        for _ in 0..DRAIN_PER_EXPORT {
            let Some(head) = self.queued(wall).into_iter().next() else {
                self.note_success();
                // The batch `ship` just queued counts: it waited behind the backlog.
                if replayed > 1 {
                    if let (Some(hook), Some(oldest)) = (self.on_recovered, oldest) {
                        hook(Recovered {
                            signal: self.signal,
                            batches: replayed,
                            oldest_age: wall.duration_since(oldest).unwrap_or_default(),
                        });
                    }
                }
                return;
            };
            oldest.get_or_insert(head.at());
            let body = match &head {
                Queued::Memory(_) => match self.lock().memory.front() {
                    Some(item) => item.body.clone(),
                    None => continue,
                },
                Queued::File(path, _, _) => match std::fs::read(path) {
                    Ok(body) => body,
                    Err(_) => {
                        let _ = std::fs::remove_file(path);
                        continue;
                    }
                },
            };
            match self.sink.post(&body) {
                PostOutcome::Delivered => {
                    REPLAYED.fetch_add(1, Relaxed);
                    replayed += 1;
                    self.remove(&head);
                }
                PostOutcome::Refused => {
                    DROPPED.fetch_add(1, Relaxed);
                    self.remove(&head);
                }
                PostOutcome::Retry => {
                    self.note_failure(now);
                    return;
                }
            }
        }
        self.publish_backlog(wall);
    }

    fn keep(&self, body: Vec<u8>, wall: SystemTime) {
        SPOOLED.fetch_add(1, Relaxed);
        if let Some(dir) = self.dir() {
            if self.write_file(&dir, &body, wall).is_ok() {
                self.trim_files(&dir, wall);
                self.publish_backlog(wall);
                return;
            }
        }
        let mut state = self.lock();
        state.memory_bytes += body.len();
        state.memory.push_back(MemoryItem { at: wall, body });
        while state.memory_bytes > MAX_MEMORY_BYTES {
            let Some(old) = state.memory.pop_front() else {
                break;
            };
            state.memory_bytes -= old.body.len();
            DROPPED.fetch_add(1, Relaxed);
        }
        drop(state);
        self.publish_backlog(wall);
    }

    fn write_file(&self, dir: &Path, body: &[u8], wall: SystemTime) -> std::io::Result<()> {
        let nanos = wall
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let seq = FILE_SEQ.fetch_add(1, Relaxed);
        let pid = std::process::id();
        // Zero-padded so a name sort is a time sort; written aside and renamed so a reader never
        // sees half a batch, and a process killed mid-write leaves only a `.tmp` that is ignored.
        let name = format!("{}{nanos:024}-{pid}-{seq:08}.pb", self.signal.prefix());
        let tmp = dir.join(format!("{name}.tmp"));
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, dir.join(name))
    }

    /// Everything waiting, oldest first: memory (it predates the directory) then files.
    fn queued(&self, wall: SystemTime) -> Vec<Queued> {
        let mut out = Vec::new();
        {
            let mut state = self.lock();
            while state
                .memory
                .front()
                .is_some_and(|item| too_old(item.at, wall))
            {
                if let Some(old) = state.memory.pop_front() {
                    state.memory_bytes -= old.body.len();
                    DROPPED.fetch_add(1, Relaxed);
                }
            }
            out.extend(state.memory.iter().map(|item| Queued::Memory(item.at)));
        }
        if let Some(dir) = self.dir() {
            for (path, len, at) in self.files(&dir) {
                if too_old(at, wall) {
                    let _ = std::fs::remove_file(&path);
                    DROPPED.fetch_add(1, Relaxed);
                    continue;
                }
                out.push(Queued::File(path, len, at));
            }
        }
        out
    }

    /// This signal's finished spool files, oldest first, with their sizes and write times.
    fn files(&self, dir: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut files: Vec<(String, PathBuf, u64, SystemTime)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                if !name.starts_with(self.signal.prefix()) || !name.ends_with(".pb") {
                    return None;
                }
                let at = name_time(&name, self.signal.prefix())?;
                let len = entry.metadata().ok()?.len();
                Some((name, entry.path(), len, at))
            })
            .collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        files
            .into_iter()
            .map(|(_, path, len, at)| (path, len, at))
            .collect()
    }

    fn trim_files(&self, dir: &Path, _wall: SystemTime) {
        let files = self.files(dir);
        let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
        for (path, len, _) in files {
            if total <= MAX_SPOOL_BYTES {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total -= len;
                DROPPED.fetch_add(1, Relaxed);
            }
        }
    }

    fn remove(&self, item: &Queued) {
        match item {
            Queued::Memory(_) => {
                let mut state = self.lock();
                if let Some(old) = state.memory.pop_front() {
                    state.memory_bytes -= old.body.len();
                }
            }
            Queued::File(path, _, _) => {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    fn publish_backlog(&self, wall: SystemTime) {
        let queued = self.queued(wall);
        let memory_bytes = self.lock().memory_bytes as u64;
        let file_bytes: u64 = queued
            .iter()
            .map(|q| match q {
                Queued::File(_, len, _) => *len,
                Queued::Memory(_) => 0,
            })
            .sum();
        BACKLOG_BATCHES[self.signal.index()].store(queued.len() as u64, Relaxed);
        BACKLOG_BYTES[self.signal.index()].store(memory_bytes + file_bytes, Relaxed);
    }

    fn note_success(&self) {
        let mut state = self.lock();
        state.failures = 0;
        state.backoff_until = None;
        drop(state);
        BACKLOG_BATCHES[self.signal.index()].store(0, Relaxed);
        BACKLOG_BYTES[self.signal.index()].store(0, Relaxed);
    }

    fn note_failure(&self, now: Instant) {
        let mut state = self.lock();
        state.failures = state.failures.saturating_add(1);
        let factor = 1u32 << state.failures.saturating_sub(1).min(8);
        let delay = BACKOFF_FIRST.saturating_mul(factor).min(BACKOFF_MAX);
        state.backoff_until = Some(now + delay);
    }
}

fn too_old(at: SystemTime, wall: SystemTime) -> bool {
    wall.duration_since(at).is_ok_and(|age| age > MAX_AGE)
}

/// The write time encoded in a spool file's name.
fn name_time(name: &str, prefix: &str) -> Option<SystemTime> {
    let nanos: u128 = name.strip_prefix(prefix)?.split('-').next()?.parse().ok()?;
    let secs = u64::try_from(nanos / 1_000_000_000).ok()?;
    let sub = u32::try_from(nanos % 1_000_000_000).ok()?;
    UNIX_EPOCH.checked_add(Duration::new(secs, sub))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// A collector whose answers the test scripts, recording what reached it.
    #[derive(Clone, Default)]
    struct FakeSink {
        answers: Arc<Mutex<VecDeque<PostOutcome>>>,
        /// Answer once the script runs out.
        otherwise: Arc<Mutex<Option<PostOutcome>>>,
        received: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl FakeSink {
        fn down() -> Self {
            let sink = Self::default();
            *sink.otherwise.lock().unwrap() = Some(PostOutcome::Retry);
            sink
        }
        fn set(&self, outcome: PostOutcome) {
            *self.otherwise.lock().unwrap() = Some(outcome);
        }
        fn script(&self, outcomes: &[PostOutcome]) {
            self.answers
                .lock()
                .unwrap()
                .extend(outcomes.iter().copied());
        }
        fn received(&self) -> Vec<Vec<u8>> {
            self.received.lock().unwrap().clone()
        }
    }

    impl Sink for FakeSink {
        fn post(&self, body: &[u8]) -> PostOutcome {
            let outcome = self
                .answers
                .lock()
                .unwrap()
                .pop_front()
                .or(*self.otherwise.lock().unwrap())
                .unwrap_or(PostOutcome::Delivered);
            if outcome == PostOutcome::Delivered {
                self.received.lock().unwrap().push(body.to_vec());
            }
            outcome
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sc-spool-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_reachable_collector_gets_each_batch_once_and_nothing_touches_disk() {
        let dir = temp_dir("online");
        let sink = FakeSink::default();
        let shipper = Shipper::with_dir(Signal::Traces, sink.clone(), Some(dir.clone()));
        shipper.ship(b"one".to_vec());
        shipper.ship(b"two".to_vec());
        assert_eq!(sink.received(), vec![b"one".to_vec(), b"two".to_vec()]);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn batches_recorded_offline_arrive_in_order_once_the_collector_is_back() {
        let dir = temp_dir("offline");
        let sink = FakeSink::down();
        let shipper = Shipper::with_dir(Signal::Traces, sink.clone(), Some(dir.clone()));
        let t0 = Instant::now();
        let wall = SystemTime::now();
        shipper.ship_at(b"a".to_vec(), t0, wall);
        // Inside the backoff: kept without a send attempt.
        shipper.ship_at(b"b".to_vec(), t0 + Duration::from_secs(1), wall);
        assert!(sink.received().is_empty());
        assert_eq!(shipper.files(&dir).len(), 2);

        sink.set(PostOutcome::Delivered);
        shipper.ship_at(b"c".to_vec(), t0 + BACKOFF_MAX, wall);
        assert_eq!(
            sink.received(),
            vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()]
        );
        assert!(shipper.files(&dir).is_empty());
    }

    #[test]
    fn a_drained_backlog_reports_how_far_back_it_reached() {
        static SEEN: Mutex<Vec<Recovered>> = Mutex::new(Vec::new());
        fn hook(recovered: Recovered) {
            SEEN.lock().unwrap().push(recovered);
        }
        let dir = temp_dir("recovered");
        let sink = FakeSink::down();
        let shipper =
            Shipper::with_dir(Signal::Traces, sink.clone(), Some(dir.clone())).on_recovered(hook);
        let t0 = Instant::now();
        let then = SystemTime::now();
        shipper.ship_at(b"a".to_vec(), t0, then);
        shipper.ship_at(b"b".to_vec(), t0 + Duration::from_secs(1), then);
        sink.set(PostOutcome::Delivered);
        let later = then + Duration::from_secs(600);
        shipper.ship_at(b"c".to_vec(), t0 + BACKOFF_MAX, later);
        assert_eq!(
            *SEEN.lock().unwrap(),
            vec![Recovered {
                signal: Signal::Traces,
                batches: 3,
                oldest_age: Duration::from_secs(600),
            }]
        );
        // Nothing queued, nothing to report.
        shipper.ship_at(b"d".to_vec(), t0 + BACKOFF_MAX, later);
        assert_eq!(SEEN.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_spool_left_by_a_previous_process_is_drained_by_the_next() {
        let dir = temp_dir("restart");
        let wall = SystemTime::now();
        {
            let shipper = Shipper::with_dir(Signal::Logs, FakeSink::down(), Some(dir.clone()));
            shipper.ship_at(b"before".to_vec(), Instant::now(), wall);
        }
        let sink = FakeSink::default();
        let shipper = Shipper::with_dir(Signal::Logs, sink.clone(), Some(dir.clone()));
        shipper.ship_at(b"after".to_vec(), Instant::now(), wall);
        assert_eq!(sink.received(), vec![b"before".to_vec(), b"after".to_vec()]);
    }

    #[test]
    fn a_refused_batch_at_the_head_does_not_block_the_ones_behind_it() {
        let dir = temp_dir("poison");
        let sink = FakeSink::down();
        let shipper = Shipper::with_dir(Signal::Traces, sink.clone(), Some(dir.clone()));
        let t0 = Instant::now();
        let wall = SystemTime::now();
        shipper.ship_at(b"poison".to_vec(), t0, wall);
        shipper.ship_at(b"fine".to_vec(), t0 + Duration::from_secs(1), wall);
        sink.set(PostOutcome::Delivered);
        sink.script(&[PostOutcome::Refused]);
        shipper.ship_at(b"later".to_vec(), t0 + BACKOFF_MAX, wall);
        assert_eq!(sink.received(), vec![b"fine".to_vec(), b"later".to_vec()]);
    }

    #[test]
    fn signals_keep_separate_spools_in_one_directory() {
        let dir = temp_dir("signals");
        let wall = SystemTime::now();
        let traces = Shipper::with_dir(Signal::Traces, FakeSink::down(), Some(dir.clone()));
        traces.ship_at(b"span".to_vec(), Instant::now(), wall);
        let logs_sink = FakeSink::default();
        let logs = Shipper::with_dir(Signal::Logs, logs_sink.clone(), Some(dir.clone()));
        logs.ship_at(b"log".to_vec(), Instant::now(), wall);
        assert_eq!(logs_sink.received(), vec![b"log".to_vec()]);
        assert_eq!(traces.files(&dir).len(), 1);
    }

    #[test]
    fn the_disk_spool_is_bounded_and_drops_the_oldest() {
        let dir = temp_dir("bound");
        let shipper = Shipper::with_dir(Signal::Traces, FakeSink::down(), Some(dir.clone()));
        let chunk = vec![0u8; (MAX_SPOOL_BYTES / 4) as usize + 1];
        let t0 = Instant::now();
        let wall = SystemTime::now();
        for i in 0..6 {
            let mut body = chunk.clone();
            body[0] = i;
            shipper.ship_at(body, t0 + Duration::from_millis(u64::from(i)), wall);
        }
        let files = shipper.files(&dir);
        let total: u64 = files.iter().map(|(_, len, _)| *len).sum();
        assert!(total <= MAX_SPOOL_BYTES);
        assert_eq!(files.len(), 3);
        // The survivors are the newest three.
        let first = std::fs::read(&files[0].0).unwrap();
        assert_eq!(first[0], 3);
    }

    #[test]
    fn without_a_directory_batches_wait_in_memory() {
        let sink = FakeSink::down();
        let shipper = Shipper::with_dir(Signal::Traces, sink.clone(), None);
        // Only meaningful while no process-wide directory has been set by another test.
        if current_dir().is_some() {
            return;
        }
        let t0 = Instant::now();
        let wall = SystemTime::now();
        shipper.ship_at(b"m1".to_vec(), t0, wall);
        sink.set(PostOutcome::Delivered);
        shipper.ship_at(b"m2".to_vec(), t0 + BACKOFF_MAX, wall);
        assert_eq!(sink.received(), vec![b"m1".to_vec(), b"m2".to_vec()]);
    }

    #[test]
    fn a_batch_past_its_age_is_dropped_not_sent() {
        let dir = temp_dir("age");
        let sink = FakeSink::down();
        let shipper = Shipper::with_dir(Signal::Traces, sink.clone(), Some(dir.clone()));
        let old = SystemTime::now() - MAX_AGE - Duration::from_secs(60);
        shipper.ship_at(b"stale".to_vec(), Instant::now(), old);
        sink.set(PostOutcome::Delivered);
        shipper.ship_at(
            b"fresh".to_vec(),
            Instant::now() + BACKOFF_MAX,
            SystemTime::now(),
        );
        assert_eq!(sink.received(), vec![b"fresh".to_vec()]);
    }

    #[test]
    fn spool_file_names_sort_by_time() {
        let t = UNIX_EPOCH + Duration::new(1_790_000_000, 5);
        let nanos = t.duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let name = format!("traces-{nanos:024}-4242-00000001.pb");
        assert_eq!(name_time(&name, "traces-"), Some(t));
    }
}
