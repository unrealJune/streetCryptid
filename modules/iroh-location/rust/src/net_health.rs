//! `net.health` — what the endpoint's network looked like since the last pulse.
//!
//! ## The hole this fills
//! From 2026-10-15 a Pixel 10 logged about 6,000 relay failures a day
//! (`Failed to connect to relay server: … tls connection failed: received fatal alert:
//! InternalError`), and nothing could say WHICH relay: the URL lives on iroh's `active-relay` span,
//! and Loki drops span fields (see `loki-drops-event-fields`). Reading it took a Tempo search for a
//! span that only closes when the actor stops. It turned out to be a retired relay named by old
//! tickets (`relay::scrub_addr`), and every phone had one, which no tile showed.
//!
//! So [`RelayTap`] counts iroh's relay-actor warnings by relay host and failure class as they
//! happen, the platform pulse calls [`record_network_health`] every five minutes, and the span it
//! emits carries those counts with the endpoint's own view: which home relays are connected, the
//! last error of any that are not, iroh's socket counters as deltas, the system resolver's
//! successes and failures, and the platform's account of the network it is on (transport,
//! validation, captive portal, VPN, private DNS). `relay.foreign_errors` counts failures against
//! relays outside this node's relay map — after `scrub_addr` it should read 0, and anything else is
//! a stale address that got past it.
//!
//! Counters, not one span per failure: a dead relay retries every 16 s for as long as the process
//! lives, and a span each would be the telemetry pipeline's own outage. Nothing here carries user
//! content — relay hostnames, error classes and byte counts.

use std::collections::BTreeMap;
use std::sync::Mutex;

use iroh::Watcher as _;
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

/// The platform's view of the network the process is on. Every field is optional because each
/// platform can read a different subset (and iOS currently sends none).
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct NetworkContext {
    /// `wifi`, `cellular`, `ethernet`, `bluetooth`, `none`, joined with `+` when several apply.
    #[uniffi(default = None)]
    pub transport: Option<String>,
    /// The OS has validated internet access on it.
    #[uniffi(default = None)]
    pub validated: Option<bool>,
    /// The OS saw a captive portal.
    #[uniffi(default = None)]
    pub captive_portal: Option<bool>,
    /// A VPN carries the default network.
    #[uniffi(default = None)]
    pub vpn: Option<bool>,
    /// `off`, `opportunistic`, or `strict:<server>` (Android private DNS).
    #[uniffi(default = None)]
    pub private_dns: Option<String>,
    /// The default network has a global IPv6 address.
    #[uniffi(default = None)]
    pub has_ipv6: Option<bool>,
}

/// Where the relay actor's messages come from. Its children (`dialing`, `connected`, `tx`) share
/// the prefix.
const RELAY_TARGET: &str = "iroh::socket::transports::relay";
/// The span the relay actor runs under, one per relay URL it talks to.
const RELAY_SPAN: &str = "active-relay";
/// The host recorded for a relay failure with no `active-relay` span in scope. It is not a relay,
/// so it is never counted as a foreign one: on 2026-10-24 the first build of this read
/// `relay.foreign_errors = 4` on a Pixel whose four failures were all against its own home relay,
/// opened before the subscriber could see spans (see `telemetry::imp::idle_slot`).
const UNKNOWN_HOST: &str = "unknown";
/// How much of a message we keep as a sample. Error chains run long; the class is the summary.
const SAMPLE_CHARS: usize = 200;

#[derive(Default)]
struct Tally {
    /// (relay host, failure class) → count.
    relay: BTreeMap<(String, String), u64>,
    relay_sample: Option<String>,
    dns_ok: u64,
    /// (record type, host kind) → count.
    dns_failed: BTreeMap<(&'static str, &'static str), u64>,
    dns_sample: Option<String>,
}

static TALLY: Mutex<Option<Tally>> = Mutex::new(None);

fn with_tally<R>(f: impl FnOnce(&mut Tally) -> R) -> R {
    let mut guard = TALLY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(guard.get_or_insert_with(Tally::default))
}

fn take_tally() -> Tally {
    TALLY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
        .unwrap_or_default()
}

fn truncate(s: &str) -> String {
    match s.char_indices().nth(SAMPLE_CHARS) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_owned(),
    }
}

/// Note a system-resolver lookup that answered. Called by `system_dns`.
#[cfg_attr(
    not(any(target_os = "android", target_vendor = "apple")),
    allow(dead_code)
)]
pub(crate) fn note_dns_ok() {
    with_tally(|t| t.dns_ok += 1);
}

/// Note a system-resolver lookup that failed — a fault, not a negative answer (NXDOMAIN or no
/// records of the type is an answer). Called by `system_dns`, where the failure is logged.
#[cfg_attr(
    not(any(target_os = "android", target_vendor = "apple")),
    allow(dead_code)
)]
pub(crate) fn note_dns_failure(rr: &'static str, host: &str, reason: &str) {
    with_tally(|t| {
        *t.dns_failed.entry((rr, host_kind(host))).or_default() += 1;
        t.dns_sample = Some(truncate(&format!("{rr} {host}: {reason}")));
    });
}

/// Which kind of name a lookup was for, so the tally stays a handful of rows: relay hostnames, the
/// `_iroh.<z32>` discovery records, and everything else.
fn host_kind(host: &str) -> &'static str {
    if host.starts_with("_iroh.") {
        "discovery"
    } else if relay_hosts()
        .iter()
        .any(|relay| relay == host.trim_end_matches('.'))
    {
        "relay"
    } else {
        "other"
    }
}

fn relay_hosts() -> Vec<String> {
    crate::relay::known_relays()
        .unwrap_or_default()
        .iter()
        .filter_map(|url| url.host_str().map(str::to_owned))
        .collect()
}

/// The relay URL recorded on an `active-relay` span.
struct RelayHost(String);

#[derive(Default)]
struct Fields {
    url: Option<String>,
    message: Option<String>,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "url" => self.url = Some(format!("{value:?}")),
            "message" => self.message = Some(format!("{value:?}")),
            _ => {}
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        match field.name() {
            "url" => self.url = Some(value.to_owned()),
            "message" => self.message = Some(value.to_owned()),
            _ => {}
        }
    }
}

/// The host of a relay URL as iroh prints it (`https://relay.example/`), or the text as given.
fn url_host(url: &str) -> String {
    url.trim_matches('"')
        .parse::<iroh::RelayUrl>()
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.trim_matches('"').to_owned())
}

/// What kind of failure a relay-actor message describes. The classes are what decide the next
/// step: a TLS alert is the far end (or a middlebox) refusing us, `dns` is our resolver, `timeout`
/// and `refused` are reachability, `lost` is a connection that worked and then did not.
pub(crate) fn classify(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if let Some(at) = lower.find("received fatal alert: ") {
        let alert: String = message[at + "received fatal alert: ".len()..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        return format!("tls_alert:{alert}");
    }
    let class = if lower.contains("invalid peer certificate") || lower.contains("certificate") {
        "tls_cert"
    } else if lower.contains("tls") {
        "tls"
    } else if lower.contains("dns") || lower.contains("resolve") {
        "dns"
    } else if lower.contains("timeout") || lower.contains("timed out") || lower.contains("deadline")
    {
        "timeout"
    } else if lower.contains("refused") {
        "refused"
    } else if lower.contains("unreachable") || lower.contains("no route") {
        "unreachable"
    } else if lower.contains("retries exceeded") {
        "retries_exceeded"
    } else if lower.contains("lost connection") || lower.contains("stream error") {
        "lost"
    } else if lower.contains("not authorized") || lower.contains("unauthorized") {
        "unauthorized"
    } else if lower.contains("server reports problem") {
        "server_problem"
    } else if lower.contains("dropping received relay packet") {
        "bad_packet"
    } else {
        "other"
    };
    class.to_owned()
}

/// Counts the relay actor's warnings by relay host and class (see the module docs). Installed by
/// the `otel` subscriber only.
#[cfg_attr(not(feature = "otel"), allow(dead_code))]
pub(crate) struct RelayTap;

impl<S> Layer<S> for RelayTap
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if attrs.metadata().name() != RELAY_SPAN {
            return;
        }
        let mut fields = Fields::default();
        attrs.record(&mut fields);
        if let (Some(url), Some(span)) = (fields.url, ctx.span(id)) {
            span.extensions_mut().insert(RelayHost(url_host(&url)));
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() > Level::WARN || !meta.target().starts_with(RELAY_TARGET) {
            return;
        }
        let host = ctx.event_scope(event).and_then(|scope| {
            scope
                .from_root()
                .find_map(|span| span.extensions().get::<RelayHost>().map(|h| h.0.clone()))
        });
        let mut fields = Fields::default();
        event.record(&mut fields);
        let message = fields.message.unwrap_or_default();
        let host = host.unwrap_or_else(|| UNKNOWN_HOST.to_owned());
        let class = classify(&message);
        with_tally(|t| {
            *t.relay.entry((host.clone(), class)).or_default() += 1;
            t.relay_sample = Some(truncate(&format!("{host}: {message}")));
        });
    }
}

/// iroh's own socket counters, kept so each record reports what changed since the last one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Counters {
    conns_opened: u64,
    conns_closed: u64,
    holepunch_attempts: u64,
    paths_direct: u64,
    paths_relay: u64,
    relay_home_change: u64,
    link_change: u64,
    send_ip_bytes: u64,
    send_relay_bytes: u64,
    recv_ip_bytes: u64,
    recv_relay_bytes: u64,
    net_reports: u64,
}

impl Counters {
    fn read(endpoint: &iroh::Endpoint) -> Self {
        let m = endpoint.metrics();
        let s = &m.socket;
        Self {
            conns_opened: s.num_conns_opened.get(),
            conns_closed: s.num_conns_closed.get(),
            holepunch_attempts: s.holepunch_attempts.get(),
            paths_direct: s.paths_direct.get(),
            paths_relay: s.paths_relay.get(),
            relay_home_change: s.relay_home_change.get(),
            link_change: s.actor_link_change.get(),
            send_ip_bytes: s.send_ipv4.get() + s.send_ipv6.get(),
            send_relay_bytes: s.send_relay.get(),
            recv_ip_bytes: s.recv_data_ipv4.get() + s.recv_data_ipv6.get(),
            recv_relay_bytes: s.recv_data_relay.get(),
            net_reports: m.net_report.reports.get(),
        }
    }

    /// `self - earlier`, field by field. A counter that went backwards belongs to a new endpoint,
    /// and the caller passes zeros for those, so saturation only guards a race.
    fn since(self, earlier: Self) -> Self {
        Self {
            conns_opened: self.conns_opened.saturating_sub(earlier.conns_opened),
            conns_closed: self.conns_closed.saturating_sub(earlier.conns_closed),
            holepunch_attempts: self
                .holepunch_attempts
                .saturating_sub(earlier.holepunch_attempts),
            paths_direct: self.paths_direct.saturating_sub(earlier.paths_direct),
            paths_relay: self.paths_relay.saturating_sub(earlier.paths_relay),
            relay_home_change: self
                .relay_home_change
                .saturating_sub(earlier.relay_home_change),
            link_change: self.link_change.saturating_sub(earlier.link_change),
            send_ip_bytes: self.send_ip_bytes.saturating_sub(earlier.send_ip_bytes),
            send_relay_bytes: self
                .send_relay_bytes
                .saturating_sub(earlier.send_relay_bytes),
            recv_ip_bytes: self.recv_ip_bytes.saturating_sub(earlier.recv_ip_bytes),
            recv_relay_bytes: self
                .recv_relay_bytes
                .saturating_sub(earlier.recv_relay_bytes),
            net_reports: self.net_reports.saturating_sub(earlier.net_reports),
        }
    }
}

/// The counters at the last record, and the node generation they were read from.
static LAST: Mutex<Option<(u64, Counters)>> = Mutex::new(None);

/// What the endpoint reported, when there was one to ask.
struct EndpointView {
    /// `host=up` / `host=down`, comma-joined.
    home: String,
    home_down: u64,
    home_last_error: Option<String>,
    delta: Counters,
}

fn endpoint_view(generation: u64, endpoint: &iroh::Endpoint) -> EndpointView {
    let statuses = endpoint.home_relay_status().get();
    let mut home = Vec::with_capacity(statuses.len());
    let mut home_down = 0;
    let mut home_last_error = None;
    for status in &statuses {
        let host = status
            .url()
            .host_str()
            .map(str::to_owned)
            .unwrap_or_else(|| status.url().to_string());
        if status.is_connected() {
            home.push(format!("{host}=up"));
        } else {
            home_down += 1;
            home.push(format!("{host}=down"));
            if home_last_error.is_none() {
                home_last_error = status
                    .last_error()
                    .map(|e| truncate(&format!("{host}: {e:#}")));
            }
        }
    }
    let now = Counters::read(endpoint);
    let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let earlier = match *last {
        Some((seen, counters)) if seen == generation => counters,
        _ => Counters::default(),
    };
    *last = Some((generation, now));
    EndpointView {
        home: home.join(","),
        home_down,
        home_last_error,
        delta: now.since(earlier),
    }
}

/// `host class=n; …`, most frequent first.
fn summarize<K: std::fmt::Display>(rows: impl IntoIterator<Item = (K, u64)>) -> String {
    let mut rows: Vec<(String, u64)> = rows.into_iter().map(|(k, n)| (k.to_string(), n)).collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    rows.iter()
        .map(|(k, n)| format!("{k}={n}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// The node's endpoint, if it is started and its lock is free this instant.
fn live_endpoint(
    node: Option<std::sync::Arc<crate::LocationNode>>,
) -> (&'static str, Option<iroh::Endpoint>) {
    let Some(node) = node else {
        return ("none", None);
    };
    let Ok(guard) = node.inner.try_lock() else {
        return ("busy", None);
    };
    let endpoint = guard.as_ref().map(|started| started.endpoint.clone());
    drop(guard);
    match endpoint {
        None => ("stopped", None),
        Some(endpoint) => ("live", Some(endpoint)),
    }
}

/// Record one `net.health` span: the tallies since the last call (which this resets) and the live
/// endpoint's state. Sync and bounded: it reads the node with `try_lock`, and a node lock someone
/// is holding is reported as `net.node = busy` rather than waited for — the pulse must never be
/// the thing that queues behind a wedged call (see `tests/node_lock.rs`).
#[uniffi::export]
pub fn record_network_health(trigger: String, context: Option<NetworkContext>) {
    let host = crate::host::node_host();
    let generation = host.generation();
    let (node_state, endpoint) = live_endpoint(host.current());
    let view = endpoint.map(|ep| endpoint_view(generation, &ep));
    let tally = take_tally();

    let known = relay_hosts();
    let relay_errors: u64 = tally.relay.values().sum();
    let foreign_errors: u64 = tally
        .relay
        .iter()
        .filter(|((host, _), _)| !known.is_empty() && host != UNKNOWN_HOST && !known.contains(host))
        .map(|(_, n)| n)
        .sum();
    let dns_failed: u64 = tally.dns_failed.values().sum();

    let span = tracing::info_span!(
        "net.health",
        net.trigger = trigger.as_str(),
        net.node = node_state,
        relay.home = tracing::field::Empty,
        relay.home_down = tracing::field::Empty,
        relay.home_last_error = tracing::field::Empty,
        relay.errors = relay_errors,
        relay.foreign_errors = foreign_errors,
        relay.error_classes = tracing::field::Empty,
        relay.error_sample = tracing::field::Empty,
        dns.ok = tally.dns_ok,
        dns.failed = dns_failed,
        dns.failed_by_kind = tracing::field::Empty,
        dns.failure_sample = tracing::field::Empty,
        ep.conns_opened = tracing::field::Empty,
        ep.conns_closed = tracing::field::Empty,
        ep.holepunch_attempts = tracing::field::Empty,
        ep.paths_direct = tracing::field::Empty,
        ep.paths_relay = tracing::field::Empty,
        ep.relay_home_change = tracing::field::Empty,
        ep.link_change = tracing::field::Empty,
        ep.send_ip_bytes = tracing::field::Empty,
        ep.send_relay_bytes = tracing::field::Empty,
        ep.recv_ip_bytes = tracing::field::Empty,
        ep.recv_relay_bytes = tracing::field::Empty,
        ep.net_reports = tracing::field::Empty,
        net.transport = tracing::field::Empty,
        net.validated = tracing::field::Empty,
        net.captive_portal = tracing::field::Empty,
        net.vpn = tracing::field::Empty,
        net.private_dns = tracing::field::Empty,
        net.has_ipv6 = tracing::field::Empty,
    );
    if !tally.relay.is_empty() {
        span.record(
            "relay.error_classes",
            summarize(
                tally
                    .relay
                    .iter()
                    .map(|((host, class), n)| (format!("{host} {class}"), *n)),
            )
            .as_str(),
        );
    }
    if let Some(sample) = &tally.relay_sample {
        span.record("relay.error_sample", sample.as_str());
    }
    if !tally.dns_failed.is_empty() {
        span.record(
            "dns.failed_by_kind",
            summarize(
                tally
                    .dns_failed
                    .iter()
                    .map(|((rr, kind), n)| (format!("{rr} {kind}"), *n)),
            )
            .as_str(),
        );
    }
    if let Some(sample) = &tally.dns_sample {
        span.record("dns.failure_sample", sample.as_str());
    }
    if let Some(view) = &view {
        span.record("relay.home", view.home.as_str());
        span.record("relay.home_down", view.home_down);
        if let Some(error) = &view.home_last_error {
            span.record("relay.home_last_error", error.as_str());
        }
        let d = view.delta;
        for (field, value) in [
            ("ep.conns_opened", d.conns_opened),
            ("ep.conns_closed", d.conns_closed),
            ("ep.holepunch_attempts", d.holepunch_attempts),
            ("ep.paths_direct", d.paths_direct),
            ("ep.paths_relay", d.paths_relay),
            ("ep.relay_home_change", d.relay_home_change),
            ("ep.link_change", d.link_change),
            ("ep.send_ip_bytes", d.send_ip_bytes),
            ("ep.send_relay_bytes", d.send_relay_bytes),
            ("ep.recv_ip_bytes", d.recv_ip_bytes),
            ("ep.recv_relay_bytes", d.recv_relay_bytes),
            ("ep.net_reports", d.net_reports),
        ] {
            span.record(field, value);
        }
    }
    if let Some(context) = context {
        if let Some(v) = &context.transport {
            span.record("net.transport", v.as_str());
        }
        if let Some(v) = &context.private_dns {
            span.record("net.private_dns", v.as_str());
        }
        for (field, value) in [
            ("net.validated", context.validated),
            ("net.captive_portal", context.captive_portal),
            ("net.vpn", context.vpn),
            ("net.has_ipv6", context.has_ipv6),
        ] {
            if let Some(value) = value {
                span.record(field, value);
            }
        }
    }
    drop(span.entered());
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    /// The tally is process-wide, and these tests take it.
    static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn classifies_the_failures_the_fleet_has_logged() {
        for (message, class) in [
            (
                "Failed to connect to relay server: unable to connect: tls connection failed: \
                 received fatal alert: InternalError",
                "tls_alert:InternalError",
            ),
            (
                "Failed to connect to relay server: timeout (>10s) trying to establish a connection",
                "timeout",
            ),
            (
                "Failed to connect to relay server: unable to connect: deadline has elapsed",
                "timeout",
            ),
            (
                "Failed to connect to relay server: unable to connect: Resolve failed, IPv4: \
                 Request timed out",
                "dns",
            ),
            (
                "Lost connection to relay server: Client stream read failed: Stream error: peer \
                 closed connection",
                "lost",
            ),
            ("retries exceeded", "retries_exceeded"),
            ("something new", "other"),
        ] {
            assert_eq!(classify(message), class, "{message}");
        }
    }

    #[test]
    fn counts_relay_warnings_by_the_host_of_their_active_relay_span() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        take_tally();
        let subscriber = tracing_subscriber::registry().with(RelayTap);
        tracing::subscriber::with_default(subscriber, || {
            let relay = tracing::info_span!(
                target: "iroh::socket::transports::relay::actor",
                "active-relay",
                url = %"https://iroh-wus.junephilip.com/"
            );
            let _relay = relay.enter();
            let dialing =
                tracing::info_span!(target: "iroh::socket::transports::relay::actor", "dialing");
            let _dialing = dialing.enter();
            for _ in 0..3 {
                tracing::warn!(
                    target: "iroh::socket::transports::relay::actor",
                    "Failed to connect to relay server: tls connection failed: received fatal \
                     alert: InternalError"
                );
            }
            // Below WARN, and outside the relay target: neither is counted.
            tracing::debug!(target: "iroh::socket::transports::relay::actor", "retry in 16s");
            tracing::warn!(target: "iroh_location", "unrelated");
        });
        let tally = take_tally();
        assert_eq!(
            tally.relay.get(&(
                "iroh-wus.junephilip.com".to_owned(),
                "tls_alert:InternalError".to_owned()
            )),
            Some(&3)
        );
        assert_eq!(tally.relay.values().sum::<u64>(), 3);
    }

    #[test]
    fn counter_deltas_saturate_rather_than_wrap() {
        let later = Counters {
            conns_opened: 5,
            send_relay_bytes: 100,
            ..Default::default()
        };
        let earlier = Counters {
            conns_opened: 2,
            send_relay_bytes: 400,
            ..Default::default()
        };
        let d = later.since(earlier);
        assert_eq!(d.conns_opened, 3);
        assert_eq!(d.send_relay_bytes, 0);
    }

    #[test]
    fn records_without_a_node_and_without_context() {
        let _serial = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        record_network_health("pulse".into(), None);
        record_network_health(
            "pulse".into(),
            Some(NetworkContext {
                transport: Some("wifi".into()),
                private_dns: Some("strict:dns.example".into()),
                validated: Some(true),
                ..Default::default()
            }),
        );
    }
}
