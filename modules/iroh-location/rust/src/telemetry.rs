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

#[cfg(feature = "otel")]
mod imp {
    use std::sync::{Mutex, OnceLock};

    use opentelemetry::KeyValue;
    use opentelemetry::{
        trace::{SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState},
        Context,
    };
    use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_sdk::{logs::SdkLoggerProvider, trace::SdkTracerProvider, Resource};
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    use tracing_subscriber::layer::{Layered, SubscriberExt};
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{reload, EnvFilter, Layer, Registry};

    /// The subscriber stack under the reload slot: `Registry` + global `EnvFilter`.
    type Base = Layered<EnvFilter, Registry>;
    /// The reload slot holds a (possibly empty) stack of boxed layers — trace + log bridge.
    type Slot = Vec<Box<dyn Layer<Base> + Send + Sync>>;

    static RELOAD_HANDLE: OnceLock<reload::Handle<Slot, Base>> = OnceLock::new();
    /// Live providers, kept for flush/shutdown when telemetry is reconfigured or drained.
    static PROVIDERS: Mutex<Option<(SdkTracerProvider, SdkLoggerProvider)>> = Mutex::new(None);

    /// Install the process-global subscriber: EnvFilter + empty OTLP reload slot (+ logcat on
    /// Android). Idempotent — `try_init` no-ops once a global subscriber exists (including one a
    /// host test installed), in which case the reload handle is only stored on first success.
    pub(crate) fn init_tracing() {
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new(super::DEFAULT_FILTER));
        let (reload_layer, handle) = reload::Layer::new(Slot::new());

        let registry = tracing_subscriber::registry()
            .with(filter)
            .with(reload_layer);

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
            let _ = handle.reload(Slot::new());
            return false;
        }

        let resource = Resource::builder()
            .with_service_name("streetcryptid-core")
            .with_attributes([
                KeyValue::new("service.instance.id", instance_id),
                KeyValue::new("os.type", std::env::consts::OS.to_owned()),
            ])
            .build();

        let span_exporter = match opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(format!("{endpoint}/v1/traces"))
            .build()
        {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("telemetry: building OTLP span exporter failed: {e}");
                return false;
            }
        };
        let log_exporter = match opentelemetry_otlp::LogExporter::builder()
            .with_http()
            .with_endpoint(format!("{endpoint}/v1/logs"))
            .build()
        {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("telemetry: building OTLP log exporter failed: {e}");
                return false;
            }
        };

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
            tracing_opentelemetry::layer().with_tracer(tracer).boxed(),
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
