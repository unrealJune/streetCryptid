//! `location.runtime` — the native location runtime's account of itself, as spans.
//!
//! ## Why this exists
//!
//! On 2026-10-01 an iPhone drove home for 88 minutes and published nothing. The process was alive
//! the whole time — Loki has its `net_report` every ~25 s — and not one `engine.ingest`,
//! `engine.heartbeat` or `session.recover` span exists for the window, so no location reached Rust
//! at all. Whether Core Location stopped delivering, the main thread stopped servicing it, or the
//! deliveries arrived and the work they spawned never ran, nothing could say: the Swift runtime
//! wrote its state machine to `NSLog`, which never leaves the device, and its only exported view
//! (`device.health`) is emitted by JS, which a background-relaunched process never starts. That
//! process ran for nineteen hours with its motion state, wake reasons and delivery stream invisible.
//!
//! So the runtime reports through the one exporter a JS-free process does have: this crate's.
//! Spans, not `tracing::info!` lines, because Loki's OTLP ingest keeps the message and drops the
//! fields (see `infra/otel/README.md`).
//!
//! ## What may go on it
//!
//! A closed vocabulary. `kind` is an enum, `state` and `reason` are the runtime's own enum
//! spellings, and nothing carries a coordinate — ages, counts, accuracies and speeds only. The one
//! free-text field, `detail`, is for an OS error description and is truncated.

/// What happened. Each kind is either a discrete Core Location event or the periodic pulse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum LocationRuntimeKind {
    /// The runtime armed itself (`start()`): a launch, foreground or background.
    Started,
    /// Periodic summary of what Core Location delivered since the previous pulse. Emitted from a
    /// background timer, NOT from the delivery path, so it still fires when deliveries stop —
    /// which is the case it exists for.
    Pulse,
    /// The main thread did not run a probe within the stall threshold. Core Location delivers on
    /// main, so this is the "alive and deaf" state reported while it is happening.
    MainStalled,
    /// `moving` ⇄ `stopped`. `reason` names what caused it.
    Transition,
    /// A `CLVisit`. `reason` is `arrival` or `departure`.
    Visit,
    /// The stop-anchor fence reported an exit.
    FenceExit,
    /// Core Location paused updates (it should not, with auto-pause off).
    Paused,
    /// Core Location resumed updates.
    Resumed,
    /// `didFailWithError`.
    LocationError,
    /// `monitoringDidFailFor` — a fence we believed armed is not.
    FenceFailed,
    /// Authorization changed. `reason` is the new status.
    Authorization,
}

impl LocationRuntimeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Pulse => "pulse",
            Self::MainStalled => "main_stalled",
            Self::Transition => "transition",
            Self::Visit => "visit",
            Self::FenceExit => "fence_exit",
            Self::Paused => "paused",
            Self::Resumed => "resumed",
            Self::LocationError => "location_error",
            Self::FenceFailed => "fence_failed",
            Self::Authorization => "authorization",
        }
    }
}

/// One `location.runtime` span. `deliveries`, `redeliveries` and `handed_off` count since the
/// previous pulse; `work_started` / `work_finished` are totals for the life of the process.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LocationRuntimeEvent {
    pub kind: LocationRuntimeKind,
    /// `moving` / `stopped`.
    pub state: String,
    /// The wake reason, stop evidence, visit direction or authorization status, by kind.
    pub reason: Option<String>,
    /// `didUpdateLocations` calls.
    pub deliveries: u32,
    /// Of those, deliveries whose newest location was NOT newer than the previous one — Core
    /// Location handing back a position it already gave us. On 2026-10-02 one 22:51 fix came back
    /// every 30 s for 73 minutes, and the first two went out as `live`.
    pub redeliveries: u32,
    /// Publish-path calls (ingest + heartbeat) started and finished in this process. The difference
    /// is the work in flight; one that keeps growing is work spawned that never ran or never
    /// returned, which is what deliveries arriving and no `engine.*` span following would look like.
    pub work_started: u32,
    pub work_finished: u32,
    /// Captures handed to a mounted JS runtime instead of published here.
    pub handed_off: u32,
    /// Since the last `didUpdateLocations`, at emission time.
    pub last_delivery_age_ms: Option<u64>,
    /// How old the newest delivered position was when it arrived (`now - location.timestamp`).
    pub fix_age_at_delivery_ms: Option<u64>,
    pub accuracy_m: Option<f64>,
    /// Negative is Core Location's "unknown", passed through.
    pub speed_mps: Option<f64>,
    /// What the manager is programmed with right now.
    pub desired_accuracy_m: f64,
    pub distance_filter_m: f64,
    /// Round trip of the main-thread probe that preceded this event, when one ran.
    pub main_latency_ms: Option<u64>,
    /// Whether this runtime holds the node (`native`) or hands captures to the app (`app`).
    pub node_owner: String,
    pub candidate_pending: bool,
    pub anchor_armed: bool,
    pub fence_registered: bool,
    /// An OS error description, for the error kinds only.
    pub detail: Option<String>,
}

/// Longest `detail` exported. An OS error string, never user content, but bounded anyway.
const DETAIL_MAX: usize = 160;

/// Record one runtime event as a `location.runtime` span.
///
/// Synchronous and cheap: it opens and closes a span, and the batch exporter does the rest on its
/// own thread. Safe to call from the main thread — and from a background queue while the main
/// thread is wedged, which is when `MainStalled` is emitted.
#[uniffi::export]
pub fn record_location_runtime(event: LocationRuntimeEvent) {
    let span = tracing::info_span!(
        "location.runtime",
        location.event = event.kind.as_str(),
        location.state = event.state.as_str(),
        location.reason = tracing::field::Empty,
        location.deliveries = event.deliveries,
        location.redeliveries = event.redeliveries,
        location.work_started = event.work_started,
        location.work_finished = event.work_finished,
        location.handed_off = event.handed_off,
        location.last_delivery_age_ms = tracing::field::Empty,
        location.fix_age_at_delivery_ms = tracing::field::Empty,
        location.accuracy_m = tracing::field::Empty,
        location.speed_mps = tracing::field::Empty,
        location.desired_accuracy_m = event.desired_accuracy_m,
        location.distance_filter_m = event.distance_filter_m,
        location.main_latency_ms = tracing::field::Empty,
        location.node_owner = event.node_owner.as_str(),
        location.candidate_pending = event.candidate_pending,
        location.anchor_armed = event.anchor_armed,
        location.fence_registered = event.fence_registered,
        location.detail = tracing::field::Empty,
    );
    if let Some(reason) = &event.reason {
        span.record("location.reason", reason.as_str());
    }
    if let Some(age) = event.last_delivery_age_ms {
        span.record("location.last_delivery_age_ms", age);
    }
    if let Some(age) = event.fix_age_at_delivery_ms {
        span.record("location.fix_age_at_delivery_ms", age);
    }
    if let Some(accuracy) = event.accuracy_m {
        span.record("location.accuracy_m", accuracy);
    }
    if let Some(speed) = event.speed_mps {
        span.record("location.speed_mps", speed);
    }
    if let Some(latency) = event.main_latency_ms {
        span.record("location.main_latency_ms", latency);
    }
    if let Some(detail) = &event.detail {
        let bounded: String = detail.chars().take(DETAIL_MAX).collect();
        span.record("location.detail", bounded.as_str());
    }
    drop(span.entered());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: LocationRuntimeKind) -> LocationRuntimeEvent {
        LocationRuntimeEvent {
            kind,
            state: "moving".into(),
            reason: Some("movement".into()),
            deliveries: 3,
            redeliveries: 1,
            work_started: 2,
            work_finished: 2,
            handed_off: 0,
            last_delivery_age_ms: Some(1_200),
            fix_age_at_delivery_ms: Some(40),
            accuracy_m: Some(12.0),
            speed_mps: Some(-1.0),
            desired_accuracy_m: 10.0,
            distance_filter_m: 50.0,
            main_latency_ms: Some(3),
            node_owner: "native".into(),
            candidate_pending: false,
            anchor_armed: false,
            fence_registered: false,
            detail: Some("x".repeat(500)),
        }
    }

    /// Every kind records without a subscriber, and an over-long detail does not panic.
    #[test]
    fn records_every_kind() {
        for kind in [
            LocationRuntimeKind::Started,
            LocationRuntimeKind::Pulse,
            LocationRuntimeKind::MainStalled,
            LocationRuntimeKind::Transition,
            LocationRuntimeKind::Visit,
            LocationRuntimeKind::FenceExit,
            LocationRuntimeKind::Paused,
            LocationRuntimeKind::Resumed,
            LocationRuntimeKind::LocationError,
            LocationRuntimeKind::FenceFailed,
            LocationRuntimeKind::Authorization,
        ] {
            record_location_runtime(event(kind));
        }
    }

    #[test]
    fn kind_spellings_are_distinct() {
        let all = [
            LocationRuntimeKind::Started,
            LocationRuntimeKind::Pulse,
            LocationRuntimeKind::MainStalled,
            LocationRuntimeKind::Transition,
            LocationRuntimeKind::Visit,
            LocationRuntimeKind::FenceExit,
            LocationRuntimeKind::Paused,
            LocationRuntimeKind::Resumed,
            LocationRuntimeKind::LocationError,
            LocationRuntimeKind::FenceFailed,
            LocationRuntimeKind::Authorization,
        ];
        let spellings: std::collections::HashSet<_> = all.iter().map(|k| k.as_str()).collect();
        assert_eq!(spellings.len(), all.len());
    }
}
