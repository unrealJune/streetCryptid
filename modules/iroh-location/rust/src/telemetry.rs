//! Developer-only OTLP telemetry (the `otel` feature) + the process-global `tracing` subscriber.
//!
//! ## Why this shape
//! Every diagnostic in this crate — our own spans on the publish/receive/sync paths AND iroh's
//! internal relay / `net_report` / magicsock events — already flows through `tracing`. So the
//! instrumentation stays plain `tracing` calls with zero `#[cfg]` noise at call sites, and OTEL is
//! purely a *subscriber layer* that consumes them. The registry is installed once (idempotently)
//! with an initially-empty [`reload`] slot; [`configure_telemetry`] later swaps the OTLP layers
//! into that slot when the app has a collector endpoint (dev/preview builds only — production
//! never calls it, and store builds compile this whole module down to no-op stubs with
//! `--no-default-features`).
//!
//! ## Correlation model (matches the TS app + trail-stash)
//! Spans carry `sc.author` (short endpoint id), `sc.seq`, and `sc.entry_hash` — the blake3 of the
//! sealed envelope, which is exactly the iroh-blobs content hash the ciphertext-blind stash sees.
//! Developers join phone⇄stash⇄phone activity on those attributes in Tempo; there is no
//! end-to-end W3C context because payloads are E2E-encrypted.

/// First 10 hex chars of an id — enough to join telemetry, short enough for span attributes.
/// Used by every `sc.*` attribute this crate emits (and mirrored by the TS app + trail-stash).
pub(crate) fn short_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(10);
    for b in bytes.iter().take(5) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Blake3 of a sealed envelope, shortened — equals the short form of the iroh-blobs content hash
/// for the same bytes, so sender, stash, and receivers all compute the same join key.
pub(crate) fn envelope_hash(envelope: &[u8]) -> String {
    short_hex(blake3::hash(envelope).as_bytes())
}

/// Default `RUST_LOG`-style filter: sync-focused iroh internals + our own spans.
///
/// `iroh::socket::transports` is held to `warn` because of ONE span. iroh's `Transports::poll_send`
/// is `#[instrument(name = "poll_send")]`, which is INFO by default, so it is opened for every
/// datagram the endpoint sends — no `iroh=info` would have removed it. Every one of them became an
/// OpenTelemetry span parented under the endpoint's lifetime span, which is how a single phone's
/// trace reached 0.5-0.9 GB and was refused by Tempo as `TRACE_TOO_LARGE`, taking every later span
/// on that trace with it. On 2026-09-29 it was 6,206 of the 8,235 spans an iPhone exported in a
/// twenty-minute backgrounded window. The module's only other non-trace event is a single `debug!`;
/// its children (`ip`, `relay`, `custom`) are re-enabled explicitly, because a more specific
/// directive is the only thing that outranks this one. Note that `iroh=` is a string PREFIX, so it
/// also reaches `iroh_blobs`, `iroh_ble_transport` and `iroh_util`.
// Only referenced by the Android logcat pipe when `otel` is off, hence dead on a host no-default
// build.
#[cfg_attr(not(any(feature = "otel", target_os = "android")), allow(dead_code))]
const DEFAULT_FILTER: &str = concat!(
    "warn,iroh=debug,",
    "iroh::socket::transports=warn,",
    "iroh::socket::transports::ip=debug,",
    "iroh::socket::transports::relay=debug,",
    "iroh::socket::transports::custom=debug,",
    "iroh_relay=info,iroh_gossip=info,iroh_docs=info,iroh_location=debug",
);

/// How much the exporter is holding in memory for spans that have not ended.
///
/// `tracing-opentelemetry` keeps every event recorded on a span in that span's builder until the
/// span CLOSES, and some spans never do: iroh's `active-relay` lives as long as its relay actor,
/// and on 2026-10-15..22 a dead relay's actor logged a warning and a retry under it every 16 s for
/// days. That is a heap that grows for as long as the process lives without a single allocation
/// being "leaked" — until [`ledger::CapSpanEvents`], which stops handing a span's events to the
/// exporter at the 128 the SDK would keep. `memory.open_span_events` counts events recorded on
/// open spans (past the cap, more than are buffered), and
/// `memory.heaviest_open_span` names the open span holding the most of them, so a climbing
/// `memory.rust_live_bytes` can be checked against this before anyone reaches for heapprofd.
// Installed by the `otel` subscriber only; a store build compiles it and never uses it.
#[cfg_attr(not(feature = "otel"), allow(dead_code))]
pub(crate) mod ledger {
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
    use std::sync::Mutex;

    use tracing::span::{Attributes, Id};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::Context;
    use tracing_subscriber::registry::LookupSpan;
    use tracing_subscriber::Layer;

    static OPEN_SPANS: AtomicU64 = AtomicU64::new(0);
    static OPEN_SPAN_EVENTS: AtomicU64 = AtomicU64::new(0);
    /// (span id, name, events) of the open span with the most events, once it has a lot.
    static HEAVIEST: Mutex<Option<(u64, &'static str, u64)>> = Mutex::new(None);
    /// Below this a span is ordinary and not worth naming.
    const HEAVY: u64 = 256;

    struct Events(AtomicU64);

    /// The most events the exporter is handed for one span. The SDK keeps at most this many when a
    /// span ends (`SpanLimits::max_events_per_span` defaults to 128) and drops the rest, so every
    /// event past it was heap held until the close only to be thrown away, and a span that never
    /// closes held it for the life of the process. On 2026-10-24 a Pixel's iroh socket `actor`
    /// span (the endpoint's lifetime span, which every `iroh::socket` debug line lands on) passed
    /// 512 events in its first half hour, about 1,500 an hour.
    pub(crate) const EXPORTED_EVENTS_PER_SPAN: u64 = 128;

    /// Hands `inner` (the OpenTelemetry trace layer) a span's events only until that span holds
    /// [`EXPORTED_EVENTS_PER_SPAN`]; everything else passes through untouched. The count is the
    /// ledger's, so this must sit INSIDE [`SpanLedger`] in the stack: `Layered` calls the inner
    /// layer first, so the count it reads excludes the event in hand. The events it withholds
    /// still reach Loki through the log bridge, which is a separate layer.
    pub(crate) struct CapSpanEvents<L>(pub L);

    impl<S, L> Layer<S> for CapSpanEvents<L>
    where
        S: Subscriber + for<'a> LookupSpan<'a>,
        L: Layer<S>,
    {
        fn on_register_dispatch(&self, subscriber: &tracing::Dispatch) {
            self.0.on_register_dispatch(subscriber);
        }

        fn on_layer(&mut self, subscriber: &mut S) {
            self.0.on_layer(subscriber);
        }

        fn register_callsite(
            &self,
            metadata: &'static tracing::Metadata<'static>,
        ) -> tracing::subscriber::Interest {
            self.0.register_callsite(metadata)
        }

        fn enabled(&self, metadata: &tracing::Metadata<'_>, ctx: Context<'_, S>) -> bool {
            self.0.enabled(metadata, ctx)
        }

        fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
            self.0.on_new_span(attrs, id, ctx);
        }

        fn on_record(&self, id: &Id, values: &tracing::span::Record<'_>, ctx: Context<'_, S>) {
            self.0.on_record(id, values, ctx);
        }

        fn on_follows_from(&self, id: &Id, follows: &Id, ctx: Context<'_, S>) {
            self.0.on_follows_from(id, follows, ctx);
        }

        fn event_enabled(&self, event: &Event<'_>, ctx: Context<'_, S>) -> bool {
            self.0.event_enabled(event, ctx)
        }

        fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
            let held = ctx
                .event_span(event)
                .and_then(|span| span.extensions().get::<Events>().map(|e| e.0.load(Relaxed)));
            if held.is_some_and(|held| held >= EXPORTED_EVENTS_PER_SPAN) {
                return;
            }
            self.0.on_event(event, ctx);
        }

        fn on_enter(&self, id: &Id, ctx: Context<'_, S>) {
            self.0.on_enter(id, ctx);
        }

        fn on_exit(&self, id: &Id, ctx: Context<'_, S>) {
            self.0.on_exit(id, ctx);
        }

        fn on_close(&self, id: Id, ctx: Context<'_, S>) {
            self.0.on_close(id, ctx);
        }

        fn on_id_change(&self, old: &Id, new: &Id, ctx: Context<'_, S>) {
            self.0.on_id_change(old, new, ctx);
        }

        fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
            self.0.max_level_hint()
        }

        #[doc(hidden)]
        unsafe fn downcast_raw(&self, id: std::any::TypeId) -> Option<*const ()> {
            if id == std::any::TypeId::of::<Self>() {
                return Some(self as *const Self as *const ());
            }
            // SAFETY: forwarded unchanged; `inner` upholds its own contract.
            unsafe { self.0.downcast_raw(id) }
        }
    }

    /// Counts open spans and the events recorded on them (see the module docs).
    pub(crate) struct SpanLedger;

    impl<S> Layer<S> for SpanLedger
    where
        S: Subscriber + for<'a> LookupSpan<'a>,
    {
        fn on_new_span(&self, _attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
            if let Some(span) = ctx.span(id) {
                span.extensions_mut().insert(Events(AtomicU64::new(0)));
                OPEN_SPANS.fetch_add(1, Relaxed);
            }
        }

        fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
            let Some(span) = ctx.event_span(event) else {
                return;
            };
            let Some(events) = span
                .extensions()
                .get::<Events>()
                .map(|e| e.0.fetch_add(1, Relaxed) + 1)
            else {
                return;
            };
            OPEN_SPAN_EVENTS.fetch_add(1, Relaxed);
            // Checked only at powers of two, so the lock is taken a handful of times per span.
            if events >= HEAVY && events.is_power_of_two() {
                let mut heaviest = HEAVIEST.lock().unwrap_or_else(|p| p.into_inner());
                if heaviest.is_none_or(|(_, _, most)| events > most) {
                    *heaviest = Some((span.id().into_u64(), span.name(), events));
                }
            }
        }

        fn on_close(&self, id: Id, ctx: Context<'_, S>) {
            let Some(span) = ctx.span(&id) else {
                return;
            };
            let Some(events) = span.extensions().get::<Events>().map(|e| e.0.load(Relaxed)) else {
                return;
            };
            OPEN_SPANS.fetch_sub(1, Relaxed);
            OPEN_SPAN_EVENTS.fetch_sub(events, Relaxed);
            let mut heaviest = HEAVIEST.lock().unwrap_or_else(|p| p.into_inner());
            if heaviest.is_some_and(|(open, _, _)| open == id.into_u64()) {
                *heaviest = None;
            }
        }
    }

    /// What the ledger holds right now.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct Snapshot {
        pub open_spans: u64,
        pub open_span_events: u64,
        /// `name=events` of the heaviest open span, once one has passed `HEAVY` events.
        pub heaviest: Option<String>,
    }

    pub(crate) fn snapshot() -> Snapshot {
        let heaviest = HEAVIEST
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map(|(_, name, events)| format!("{name}={events}"));
        Snapshot {
            open_spans: OPEN_SPANS.load(Relaxed),
            open_span_events: OPEN_SPAN_EVENTS.load(Relaxed),
            heaviest,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use tracing_subscriber::layer::SubscriberExt;

        #[test]
        fn names_a_long_lived_span_that_keeps_collecting_events() {
            let subscriber = tracing_subscriber::registry().with(SpanLedger);
            tracing::subscriber::with_default(subscriber, || {
                let relay = tracing::info_span!("active-relay-ledger-test");
                {
                    let _in = relay.enter();
                    for _ in 0..HEAVY {
                        tracing::warn!("retry");
                    }
                }
                let held = snapshot();
                assert!(held.open_span_events >= HEAVY, "{held:?}");
                assert!(
                    held.heaviest
                        .as_deref()
                        .is_some_and(|h| h.starts_with("active-relay-ledger-test=")),
                    "{held:?}"
                );
                drop(relay);
                assert_ne!(
                    snapshot()
                        .heaviest
                        .as_deref()
                        .map(|h| h.starts_with("active-relay-ledger-test=")),
                    Some(true)
                );
            });
        }

        #[test]
        fn the_exporter_is_handed_only_the_events_it_will_keep() {
            use std::sync::Arc;

            struct Seen(Arc<AtomicU64>);
            impl<S: Subscriber> Layer<S> for Seen {
                fn on_event(&self, _: &Event<'_>, _: Context<'_, S>) {
                    self.0.fetch_add(1, Relaxed);
                }
            }

            let seen = Arc::new(AtomicU64::new(0));
            // Production order: the capped layer inside the ledger. Fewer than `HEAVY` events, so
            // this span never competes with the test above for `HEAVIEST`.
            let subscriber = tracing_subscriber::registry()
                .with(CapSpanEvents(Seen(seen.clone())))
                .with(SpanLedger);
            let sent = EXPORTED_EVENTS_PER_SPAN + 72;
            assert!(sent < HEAVY);
            tracing::subscriber::with_default(subscriber, || {
                let actor = tracing::info_span!("socket-actor-cap-test");
                {
                    let _in = actor.enter();
                    for _ in 0..sent {
                        tracing::debug!("re-stun");
                    }
                }
                // An event outside any span is not the cap's business.
                tracing::warn!("no span");
            });
            assert_eq!(seen.load(Relaxed), EXPORTED_EVENTS_PER_SPAN + 1);
        }
    }
}

#[cfg(feature = "otel")]
mod imp {
    use std::sync::{Mutex, OnceLock};

    use opentelemetry::KeyValue;
    use opentelemetry::{
        trace::{SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState},
        Context,
    };
    use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
    use opentelemetry_sdk::{logs::SdkLoggerProvider, trace::SdkTracerProvider, Resource};
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    use tracing_subscriber::layer::{Layered, SubscriberExt};
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{reload, EnvFilter, Layer, Registry};

    /// The subscriber stack under the reload slot: `Registry` + global `EnvFilter`.
    type Base = Layered<EnvFilter, Registry>;
    /// The reload slot holds a stack of boxed layers — trace + log bridge, or [`idle_slot`].
    type Slot = Vec<Box<dyn Layer<Base> + Send + Sync>>;

    /// What the reload slot holds while nothing is exported. NOT an empty `Vec`:
    /// tracing-subscriber's `Layer for Vec` answers `Interest::never()` when it holds no layers,
    /// and `Layered` lets an outer `never` switch the callsite off for the whole stack. So until
    /// the first `configure`, every span and event in the process was disabled — the ledger, the
    /// relay tap and Android's logcat included — and a span opened in that window stayed disabled
    /// for its whole life. iroh opens its endpoint and relay-actor spans at node start, which on a
    /// JS launch comes before JS configures telemetry: on 2026-10-24 a Pixel's first `net.health`
    /// attributed all four of its relay failures to `unknown`. `Identity` is enabled for
    /// everything and offers no level hint, which leaves both decisions to the `EnvFilter`.
    fn idle_slot() -> Slot {
        vec![tracing_subscriber::layer::Identity::new().boxed()]
    }

    static RELOAD_HANDLE: OnceLock<reload::Handle<Slot, Base>> = OnceLock::new();
    /// Live providers, kept for flush/shutdown when telemetry is reconfigured or drained.
    static PROVIDERS: Mutex<Option<(SdkTracerProvider, SdkLoggerProvider)>> = Mutex::new(None);

    /// Install the process-global subscriber: EnvFilter + empty OTLP reload slot (+ logcat on
    /// Android). Idempotent — `try_init` no-ops once a global subscriber exists (including one a
    /// host test installed), in which case the reload handle is only stored on first success.
    pub(crate) fn init_tracing() {
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new(super::DEFAULT_FILTER));
        let (reload_layer, handle) = reload::Layer::new(idle_slot());

        // The ledger and the relay tap sit OUTSIDE the reload slot: they are what `process.memory`
        // and `net.health` read, and they must count from the first span, before (and whether or
        // not) the app ever configures an exporter.
        let registry = tracing_subscriber::registry()
            .with(filter)
            .with(reload_layer)
            .with(super::ledger::SpanLedger)
            .with(crate::net_health::RelayTap);

        #[cfg(target_os = "android")]
        let registry = registry.with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(paranoid_android::AndroidLogMakeWriter::new(
                    "streetcryptid".to_owned(),
                )),
        );

        if registry.try_init().is_ok() {
            let _ = RELOAD_HANDLE.set(handle);
        }
    }

    /// Swap OTLP export in (non-empty endpoint) or out (empty endpoint). Returns whether export
    /// is now active. Rebuilding on every call keeps this idempotent for the JS side, which may
    /// re-run its node bootstrap on fast refresh.
    pub(crate) fn configure(endpoint: String, instance_id: String) -> bool {
        init_tracing();
        let Some(handle) = RELOAD_HANDLE.get() else {
            // A foreign (test-installed) subscriber owns the process — nothing to attach to.
            return false;
        };

        // Drop any previous pipeline first so a reconfigure doesn't leak exporter threads.
        if let Ok(mut guard) = PROVIDERS.lock() {
            if let Some((traces, logs)) = guard.take() {
                let _ = traces.shutdown();
                let _ = logs.shutdown();
            }
        }

        let endpoint = endpoint.trim().trim_end_matches('/').to_owned();
        if endpoint.is_empty() {
            let _ = handle.reload(idle_slot());
            return false;
        }

        let resource = Resource::builder()
            .with_service_name("streetcryptid-core")
            .with_attributes([
                KeyValue::new("service.instance.id", instance_id),
                KeyValue::new("os.type", std::env::consts::OS.to_owned()),
            ])
            .build();

        // Our own exporters rather than opentelemetry-otlp's: theirs drop a batch whose POST fails,
        // and these keep it (`telemetry_spool`).
        let span_exporter = spool_export::SpanSpool::new(&endpoint, &resource);
        let log_exporter = spool_export::LogSpool::new(&endpoint, &resource);

        let tracer_provider = SdkTracerProvider::builder()
            .with_batch_exporter(span_exporter)
            .with_resource(resource.clone())
            .build();
        let logger_provider = SdkLoggerProvider::builder()
            .with_batch_exporter(log_exporter)
            .with_resource(resource)
            .build();

        use opentelemetry::trace::TracerProvider as _;
        let tracer = tracer_provider.tracer("iroh-location");
        let layers: Slot = vec![
            super::ledger::CapSpanEvents(tracing_opentelemetry::layer().with_tracer(tracer))
                .boxed(),
            OpenTelemetryTracingBridge::new(&logger_provider).boxed(),
        ];
        let swapped = handle.reload(layers).is_ok();

        if let Ok(mut guard) = PROVIDERS.lock() {
            *guard = Some((tracer_provider, logger_provider));
        }
        if swapped {
            tracing::info!("telemetry: OTLP export active → {endpoint}");
        }
        swapped
    }

    /// OTLP/HTTP protobuf exporters that hand every batch to a `Shipper`, which delivers it or
    /// keeps it until it can (see `telemetry_spool`).
    mod spool_export {
        use std::sync::OnceLock;
        use std::time::Duration;

        use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
        use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
        use opentelemetry_proto::transform::common::tonic::ResourceAttributesWithSchema;
        use opentelemetry_proto::transform::logs::tonic::group_logs_by_resource_and_scope;
        use opentelemetry_proto::transform::trace::tonic::group_spans_by_resource_and_scope;
        use opentelemetry_sdk::error::OTelSdkResult;
        use opentelemetry_sdk::logs::{LogBatch, LogExporter};
        use opentelemetry_sdk::trace::{SpanData, SpanExporter};
        use opentelemetry_sdk::Resource;
        use prost::Message;

        use crate::telemetry_spool::{PostOutcome, Recovered, Shipper, Signal, Sink};

        /// `telemetry.recovered`: a backlog this phone could not send has just gone out. Its spans
        /// keep their original timestamps, so without this nothing says that the last half hour
        /// of a device's trace arrived late, or that a gap in it was filled in afterwards.
        fn report_recovered(recovered: Recovered) {
            let signal = match recovered.signal {
                Signal::Traces => "traces",
                Signal::Logs => "logs",
            };
            let spool = crate::telemetry_spool::snapshot();
            let span = tracing::info_span!(
                "telemetry.recovered",
                signal,
                batches = recovered.batches,
                oldest_age_ms = recovered.oldest_age.as_millis() as u64,
                spooled_total = spool.spooled_total,
                dropped_total = spool.dropped_total,
            );
            drop(span.entered());
        }

        /// Short on connect: an offline phone finds out in seconds and goes back to spooling.
        const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
        const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

        pub(super) struct HttpSink {
            url: String,
            /// Built on first use, on the export thread: reqwest's blocking client runs a runtime
            /// of its own and must not be created inside a tokio one, which `configure` can be.
            client: OnceLock<Option<reqwest::blocking::Client>>,
        }

        impl HttpSink {
            fn new(url: String) -> Self {
                Self {
                    url,
                    client: OnceLock::new(),
                }
            }
        }

        impl Sink for HttpSink {
            fn post(&self, body: &[u8]) -> PostOutcome {
                let client = self.client.get_or_init(|| {
                    reqwest::blocking::Client::builder()
                        .connect_timeout(CONNECT_TIMEOUT)
                        .timeout(REQUEST_TIMEOUT)
                        .build()
                        .ok()
                });
                let Some(client) = client else {
                    return PostOutcome::Retry;
                };
                let sent = client
                    .post(&self.url)
                    .header(reqwest::header::CONTENT_TYPE, "application/x-protobuf")
                    .body(body.to_vec())
                    .send();
                match sent {
                    Ok(response) => {
                        let status = response.status();
                        if status.is_success() {
                            PostOutcome::Delivered
                        } else if status.is_server_error() || matches!(status.as_u16(), 408 | 429) {
                            PostOutcome::Retry
                        } else {
                            PostOutcome::Refused
                        }
                    }
                    Err(_) => PostOutcome::Retry,
                }
            }
        }

        pub(super) struct SpanSpool {
            shipper: Shipper<HttpSink>,
            resource: ResourceAttributesWithSchema,
        }

        impl SpanSpool {
            pub(super) fn new(endpoint: &str, resource: &Resource) -> Self {
                Self {
                    shipper: Shipper::new(
                        Signal::Traces,
                        HttpSink::new(format!("{endpoint}/v1/traces")),
                    )
                    .on_recovered(report_recovered),
                    resource: resource.into(),
                }
            }
        }

        impl std::fmt::Debug for SpanSpool {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("SpanSpool")
            }
        }

        impl SpanExporter for SpanSpool {
            fn export(
                &self,
                batch: Vec<SpanData>,
            ) -> impl std::future::Future<Output = OTelSdkResult> + Send {
                let request = ExportTraceServiceRequest {
                    resource_spans: group_spans_by_resource_and_scope(batch, &self.resource),
                };
                self.shipper.ship(request.encode_to_vec());
                // Delivered or kept: either way the SDK has nothing to retry or report.
                std::future::ready(Ok(()))
            }

            fn set_resource(&mut self, resource: &Resource) {
                self.resource = resource.into();
            }
        }

        pub(super) struct LogSpool {
            shipper: Shipper<HttpSink>,
            resource: ResourceAttributesWithSchema,
        }

        impl LogSpool {
            pub(super) fn new(endpoint: &str, resource: &Resource) -> Self {
                Self {
                    shipper: Shipper::new(
                        Signal::Logs,
                        HttpSink::new(format!("{endpoint}/v1/logs")),
                    )
                    .on_recovered(report_recovered),
                    resource: resource.into(),
                }
            }
        }

        impl std::fmt::Debug for LogSpool {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("LogSpool")
            }
        }

        impl LogExporter for LogSpool {
            fn export(
                &self,
                batch: LogBatch<'_>,
            ) -> impl std::future::Future<Output = OTelSdkResult> + Send {
                let request = ExportLogsServiceRequest {
                    resource_logs: group_logs_by_resource_and_scope(batch, &self.resource),
                };
                self.shipper.ship(request.encode_to_vec());
                std::future::ready(Ok(()))
            }

            fn set_resource(&mut self, resource: &Resource) {
                self.resource = resource.into();
            }
        }
    }

    /// Force-flush both providers — headless background contexts call this before the OS
    /// suspends the process, otherwise the batch exporters' buffers die with it.
    pub(crate) fn flush() {
        if let Ok(guard) = PROVIDERS.lock() {
            if let Some((traces, logs)) = guard.as_ref() {
                let _ = traces.force_flush();
                let _ = logs.force_flush();
            }
        }
    }

    fn remote_parent(value: &str) -> Option<SpanContext> {
        let mut parts = value.trim().split('-');
        let (Some("00"), Some(trace_id), Some(span_id), Some(flags), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return None;
        };
        let (Ok(trace_id), Ok(span_id), Ok(flags)) = (
            TraceId::from_hex(trace_id),
            SpanId::from_hex(span_id),
            u8::from_str_radix(flags, 16),
        ) else {
            return None;
        };
        let parent = SpanContext::new(
            trace_id,
            span_id,
            TraceFlags::new(flags),
            true,
            TraceState::default(),
        );
        parent.is_valid().then_some(parent)
    }

    pub(crate) fn set_parent(span: &tracing::Span, traceparent: Option<&str>) {
        if let Some(parent) = traceparent.and_then(remote_parent) {
            let _ = span.set_parent(Context::new().with_remote_span_context(parent));
        }
    }

    #[cfg(test)]
    pub(crate) fn parse_parent_for_test(value: &str) -> Option<SpanContext> {
        remote_parent(value)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
        use std::sync::Arc;
        use tracing_subscriber::filter::LevelFilter;

        #[test]
        fn an_empty_slot_would_switch_every_callsite_off_and_the_idle_one_does_not() {
            // The trap itself: an empty `Vec` layer claims "nothing, ever".
            assert_eq!(
                Layer::<Base>::max_level_hint(&Slot::new()),
                Some(LevelFilter::OFF)
            );
            assert_eq!(Layer::<Base>::max_level_hint(&idle_slot()), None);

            struct Opened(Arc<AtomicU64>);
            impl<S: tracing::Subscriber> Layer<S> for Opened {
                fn on_new_span(
                    &self,
                    _: &tracing::span::Attributes<'_>,
                    _: &tracing::span::Id,
                    _: tracing_subscriber::layer::Context<'_, S>,
                ) {
                    self.0.fetch_add(1, Relaxed);
                }
            }

            let opened = Arc::new(AtomicU64::new(0));
            let (slot, _handle) = reload::Layer::new(idle_slot());
            let subscriber = tracing_subscriber::registry()
                .with(EnvFilter::new("trace"))
                .with(slot)
                .with(Opened(opened.clone()));
            tracing::subscriber::with_default(subscriber, || {
                tracing::info_span!("opened-before-any-exporter").in_scope(|| {});
            });
            assert_eq!(opened.load(Relaxed), 1);
        }
    }
}

#[cfg(not(feature = "otel"))]
mod imp {
    /// Without `otel`, preserve the pre-telemetry behavior exactly: a logcat subscriber on
    /// Android, nothing anywhere else.
    pub(crate) fn init_tracing() {
        #[cfg(target_os = "android")]
        {
            use tracing_subscriber::prelude::*;
            use tracing_subscriber::{fmt, EnvFilter};
            let filter = EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(super::DEFAULT_FILTER));
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(fmt::layer().with_ansi(false).with_writer(
                    paranoid_android::AndroidLogMakeWriter::new("streetcryptid".to_owned()),
                ))
                .try_init();
        }
    }

    pub(crate) fn configure(_endpoint: String, _instance_id: String) -> bool {
        false
    }

    pub(crate) fn flush() {}

    pub(crate) fn set_parent(_span: &tracing::Span, _traceparent: Option<&str>) {}
}

pub(crate) use imp::init_tracing;
pub(crate) use imp::set_parent;

/// Point developer telemetry at an OTLP/HTTP collector (`http://<lan-ip>:4318`), or disable it by
/// passing an empty endpoint. Returns whether export is active — always `false` when the crate was
/// built without the `otel` feature (store builds), so the uniffi surface is identical either way
/// and the app never needs to know how the binary was compiled. `instance_id` should be the short
/// endpoint id so Rust-side spans join the app's under one `service.instance.id`.
#[uniffi::export]
pub fn configure_telemetry(endpoint: String, instance_id: String) -> bool {
    imp::configure(endpoint, instance_id)
}

/// Where Rust telemetry that could not be sent waits for the collector (the app's caches
/// directory). Until this is called it waits in memory, bounded, and dies with the process. Call it
/// before [`configure_telemetry`]; calling it again moves future batches, not queued ones. Returns
/// whether the directory is usable; always `false` without the `otel` feature.
#[uniffi::export]
pub fn set_telemetry_spool_dir(dir: String) -> bool {
    if cfg!(feature = "otel") {
        crate::telemetry_spool::set_dir(std::path::PathBuf::from(dir))
    } else {
        false
    }
}

/// Flush buffered telemetry. Headless background tasks await this before returning — the OS may
/// freeze the process the moment the task completes, taking unexported batches with it. Async
/// (via a blocking task) because `force_flush` blocks until export or timeout, which must never
/// stall the JS bridge thread.
#[uniffi::export(async_runtime = "tokio")]
pub async fn flush_telemetry() {
    let _ = tokio::task::spawn_blocking(imp::flush).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_hex_takes_first_five_bytes() {
        assert_eq!(
            short_hex(&[0xab, 0x12, 0xcd, 0x34, 0xef, 0xff]),
            "ab12cd34ef"
        );
        assert_eq!(short_hex(&[0x01]), "01");
    }

    /// The per-datagram `poll_send` span is filtered out, and nothing around it is.
    ///
    /// Emits through a real `EnvFilter` built from `DEFAULT_FILTER`, with the exact targets the
    /// iroh callsites have, so this breaks if a directive is reordered, mistyped, or outranked.
    #[test]
    fn default_filter_drops_the_per_datagram_span_and_keeps_its_neighbours() {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::layer::SubscriberExt;

        #[derive(Clone, Default)]
        struct Seen(Arc<Mutex<Vec<String>>>);
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Seen {
            fn on_new_span(
                &self,
                attrs: &tracing::span::Attributes<'_>,
                _: &tracing::span::Id,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                let meta = attrs.metadata();
                self.0
                    .lock()
                    .unwrap()
                    .push(format!("{}:{}", meta.target(), meta.name()));
            }
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                self.0
                    .lock()
                    .unwrap()
                    .push(event.metadata().target().to_string());
            }
        }

        let seen = Seen::default();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new(DEFAULT_FILTER))
            .with(seen.clone());
        tracing::subscriber::with_default(subscriber, || {
            let _send = tracing::info_span!(target: "iroh::socket::transports", "poll_send");
            tracing::debug!(target: "iroh::socket::transports::relay::actor", "relay");
            tracing::debug!(target: "iroh::socket::transports::ip", "ip");
            tracing::warn!(target: "iroh::socket::transports", "rebind failed");
            let _connect = tracing::info_span!(target: "iroh::endpoint", "connect");
            tracing::debug!(target: "iroh::net_report", "net report");
            tracing::debug!(target: "iroh_location", "ours");
            tracing::debug!(target: "iroh_docs::engine::live", "docs noise");
        });

        let seen = seen.0.lock().unwrap().clone();
        assert!(!seen.iter().any(|s| s.ends_with(":poll_send")), "{seen:?}");
        for kept in [
            "iroh::socket::transports::relay::actor",
            "iroh::socket::transports::ip",
            "iroh::socket::transports",
            "iroh::endpoint:connect",
            "iroh::net_report",
            "iroh_location",
        ] {
            assert!(
                seen.iter().any(|s| s == kept),
                "{kept} was filtered: {seen:?}"
            );
        }
        assert!(
            !seen.iter().any(|s| s == "iroh_docs::engine::live"),
            "{seen:?}"
        );
    }

    #[test]
    fn envelope_hash_is_stable_and_short() {
        let a = envelope_hash(b"sealed bytes");
        assert_eq!(a.len(), 10);
        assert_eq!(a, envelope_hash(b"sealed bytes"));
        assert_ne!(a, envelope_hash(b"other bytes"));
    }

    #[cfg(feature = "otel")]
    #[test]
    fn parses_valid_w3c_parent_and_rejects_invalid_context() {
        let trace_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let span_id = "bbbbbbbbbbbbbbbb";
        let parent = imp::parse_parent_for_test(&format!("00-{trace_id}-{span_id}-01"))
            .expect("valid traceparent");
        assert_eq!(parent.trace_id().to_string(), trace_id);
        assert_eq!(parent.span_id().to_string(), span_id);
        assert!(parent.is_remote());
        assert!(parent.is_sampled());

        assert!(imp::parse_parent_for_test("not-a-traceparent").is_none());
        assert!(
            imp::parse_parent_for_test(&format!("00-{}-{span_id}-01", "0".repeat(32))).is_none()
        );
        assert!(
            imp::parse_parent_for_test(&format!("00-{trace_id}-{}-01", "0".repeat(16))).is_none()
        );
    }
}
