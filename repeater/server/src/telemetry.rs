//! Developer telemetry: OTLP export of `tracing` spans + events (the `otel` feature).
//!
//! ## Shape
//! Instrumentation everywhere else stays plain `tracing` — spans/events are free when nothing
//! subscribes. This module only *consumes* them: [`otel_layers`] hands the binary two extra
//! subscriber layers (an OTLP trace layer and an OTLP log bridge) when
//! `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and `None` otherwise, so a stash without a collector
//! configured runs exactly the pre-telemetry code path.
//!
//! ## Correlation model (matches the phones)
//! The stash is ciphertext-blind, so there is no end-to-end trace through a location ping.
//! Instead spans carry the same join attributes the app and `iroh-location` emit: `sc.entry_hash`
//! (short blake3/content hash of the sealed envelope), `sc.author`, `sc.seq`, `sc.namespace`.
//! Real W3C context flows only where a real channel exists: phones send `traceparent` on control
//! API requests (extracted by [`http_request_span`]) and the waker embeds `traceparent` in the
//! silent push payload so the woken phone can link back to [the push span].
//!
//! ## Redaction
//! Console logging runs every line through [`crate::log_redaction::redact_log_line`]; exported
//! OTLP log **bodies** pass through the same function via [`RedactingLogProcessor`]. Structured
//! *attributes* on logs/spans are NOT redacted (the SDK offers no mutable pass over them):
//! attributes we emit ourselves are short non-identifying hashes by construction, but
//! dependencies' fields ship as-is — acceptable only because the OTLP endpoint is a
//! developer-controlled collector, opted into per deployment, never a hosted log store.

#[cfg(feature = "live")]
/// First 10 hex chars of an id — the `sc.*` join-key form shared with the app and the mobile
/// core. Short enough to be non-identifying (and to survive `redact_log_line`, which only
/// redacts identifier-like runs of 32+ chars).
pub(crate) fn short_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(10);
    for b in bytes.iter().take(5) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// The stash's `service.instance.id`: the short public key hex, stable across restarts (the
/// identity key is pinned by `TRAIL_STASH_SECRET_KEY`).
#[cfg(feature = "live")]
pub fn instance_id(endpoint_id: &iroh::PublicKey) -> String {
    short_hex(endpoint_id.as_bytes())
}

#[cfg(feature = "otel")]
pub use imp::{http_request_span, otel_layers, shutdown, traceparent_of};

#[cfg(feature = "otel")]
mod imp {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use axum::{extract::Request, middleware::Next, response::Response};
    use opentelemetry::KeyValue;
    use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_sdk::logs::{
        BatchLogProcessor, LogProcessor, SdkLogRecord, SdkLoggerProvider,
    };
    use opentelemetry_sdk::propagation::TraceContextPropagator;
    use opentelemetry_sdk::trace::SdkTracerProvider;
    use opentelemetry_sdk::Resource;
    use tracing::Instrument;
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    use tracing_subscriber::registry::LookupSpan;
    use tracing_subscriber::Layer;

    use crate::log_redaction::redact_log_line;

    /// Providers kept for [`shutdown`] so the final batches flush on SIGTERM instead of dying
    /// with the process.
    static PROVIDERS: Mutex<Option<(SdkTracerProvider, SdkLoggerProvider)>> = Mutex::new(None);

    /// Build the OTLP subscriber layers, or `None` when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset —
    /// the runtime gate that keeps the compiled-in feature dormant. `instance_id` should be the
    /// short public key hex so stash spans join under a stable `service.instance.id`.
    pub fn otel_layers<S>(instance_id: &str) -> Option<Vec<Box<dyn Layer<S> + Send + Sync>>>
    where
        S: tracing::Subscriber + for<'a> LookupSpan<'a> + Send + Sync + 'static,
    {
        let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
            .ok()
            .map(|e| e.trim().trim_end_matches('/').to_owned())
            .filter(|e| !e.is_empty())?;
        let service_name = std::env::var("OTEL_SERVICE_NAME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "trail-stash".to_owned());

        // The propagator powers both traceparent extraction (control API) and injection (push
        // payloads / [`traceparent_of`]).
        opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());

        let resource = Resource::builder()
            .with_service_name(service_name)
            .with_attributes([KeyValue::new("service.instance.id", instance_id.to_owned())])
            .build();

        let span_exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(format!("{endpoint}/v1/traces"))
            .build()
            .map_err(|e| eprintln!("telemetry: OTLP span exporter failed to build: {e}"))
            .ok()?;
        let log_exporter = opentelemetry_otlp::LogExporter::builder()
            .with_http()
            .with_endpoint(format!("{endpoint}/v1/logs"))
            .build()
            .map_err(|e| eprintln!("telemetry: OTLP log exporter failed to build: {e}"))
            .ok()?;

        let tracer_provider = SdkTracerProvider::builder()
            .with_batch_exporter(span_exporter)
            .with_resource(resource.clone())
            .build();
        let logger_provider = SdkLoggerProvider::builder()
            .with_log_processor(RedactingLogProcessor(
                BatchLogProcessor::builder(log_exporter).build(),
            ))
            .with_resource(resource)
            .build();

        use opentelemetry::trace::TracerProvider as _;
        let tracer = tracer_provider.tracer("trail-stash");
        let layers: Vec<Box<dyn Layer<S> + Send + Sync>> = vec![
            tracing_opentelemetry::layer().with_tracer(tracer).boxed(),
            OpenTelemetryTracingBridge::new(&logger_provider).boxed(),
        ];

        *PROVIDERS.lock().unwrap() = Some((tracer_provider, logger_provider));
        Some(layers)
    }

    /// Flush + shut down the export pipelines. Called on graceful shutdown; a no-op when
    /// telemetry never started.
    pub fn shutdown() {
        if let Some((traces, logs)) = PROVIDERS.lock().unwrap().take() {
            let _ = traces.shutdown();
            let _ = logs.shutdown();
        }
    }

    /// The W3C `traceparent` naming `span`, via the global propagator. `None` when telemetry is
    /// dormant (no propagator → empty carrier) or the span is disabled — callers just skip
    /// embedding it.
    pub fn traceparent_of(span: &tracing::Span) -> Option<String> {
        let cx = span.context();
        let mut carrier: HashMap<String, String> = HashMap::new();
        opentelemetry::global::get_text_map_propagator(|p| p.inject_context(&cx, &mut carrier));
        carrier.remove("traceparent").filter(|tp| !tp.is_empty())
    }

    /// Axum middleware: one span per control-API request, parented on the phone's `traceparent`
    /// header when present — this is where an app→stash trace joins into one tree.
    pub async fn http_request_span(req: Request, next: Next) -> Response {
        let span = tracing::info_span!(
            "http.request",
            http.request.method = %req.method(),
            url.path = %req.uri().path(),
            http.response.status_code = tracing::field::Empty,
        );
        let mut carrier: HashMap<String, String> = HashMap::new();
        for key in ["traceparent", "tracestate"] {
            if let Some(v) = req.headers().get(key).and_then(|v| v.to_str().ok()) {
                carrier.insert(key.to_owned(), v.to_owned());
            }
        }
        if carrier.contains_key("traceparent") {
            let cx = opentelemetry::global::get_text_map_propagator(|p| p.extract(&carrier));
            // Errs only when the span is disabled/closed — nothing to do about it here.
            let _ = span.set_parent(cx);
        }
        let resp = next.run(req).instrument(span.clone()).await;
        span.record("http.response.status_code", resp.status().as_u16());
        resp
    }

    /// Wraps the batch processor to run every log **body** through `redact_log_line` before
    /// export — the OTLP mirror of the console `RedactingFormat`. See the module docs for why
    /// attributes are not covered.
    #[derive(Debug)]
    struct RedactingLogProcessor<P>(P);

    impl<P: LogProcessor> LogProcessor for RedactingLogProcessor<P> {
        fn emit(&self, record: &mut SdkLogRecord, scope: &opentelemetry::InstrumentationScope) {
            use opentelemetry::logs::{AnyValue, LogRecord};
            if let Some(AnyValue::String(s)) = record.body() {
                let redacted = redact_log_line(s.as_str());
                if redacted != s.as_str() {
                    record.set_body(AnyValue::String(redacted.into()));
                }
            }
            self.0.emit(record, scope);
        }

        fn force_flush(&self) -> opentelemetry_sdk::error::OTelSdkResult {
            self.0.force_flush()
        }

        fn shutdown(&self) -> opentelemetry_sdk::error::OTelSdkResult {
            self.0.shutdown()
        }
    }
}

#[cfg(all(test, feature = "live"))]
mod tests {
    use super::*;

    #[test]
    fn short_hex_is_the_ten_char_join_key() {
        assert_eq!(
            short_hex(&[0xab, 0x12, 0xcd, 0x34, 0xef, 0x99]),
            "ab12cd34ef"
        );
    }
}
