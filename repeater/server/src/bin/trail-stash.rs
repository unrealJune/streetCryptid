//! `trail-stash` binary — boots the in-memory, ciphertext-blind replica + control API.
//!
//! Requires the `live` feature: `cargo run --features live`.
//!
//! Environment:
//! * `TRAIL_STASH_SECRET_KEY`   — 64 lowercase hex chars (32-byte ed25519 seed). Gives the stash
//!   a stable dialable identity so `EXPO_PUBLIC_TRAIL_STASH_TICKET` survives restarts. It is a
//!   key, not user data — inject it from a secret manager, never commit it. Generate one with
//!   `openssl rand -hex 32`. **Required** for the hosted stash; a repeater (below) without it
//!   keeps a generated one in `<data dir>/secret.key`.
//! * `TRAIL_STASH_DATA_DIR`             — run as a **repeater**: the replica, blobs, grant book and
//!   roster live on disk here and survive restarts, grants arrive over the
//!   `streetcryptid/repeater/1` protocol, and the HTTP control API is not served. While unclaimed
//!   it prints a claim link to stdout. Unset ⇒ the RAM-only hosted stash.
//! * `TRAIL_STASH_PEERS`                — comma-separated endpoint tickets of extra sibling
//!   repeaters; the roster's own repeaters are reconciled with regardless.
//! * `TRAIL_STASH_PEER_SYNC_INTERVAL_MIN` — how often (default 5).
//! * `PORT`                             — control-API port (default 8787).
//! * `TRAIL_STASH_RETENTION_HOURS`      — latest-fix backstop (default 48, clamped 1–336).
//! * `TRAIL_STASH_PRUNE_INTERVAL_MIN`   — prune cadence (default 15).
//! * `TRAIL_STASH_RELAY_URLS`           — comma-separated custom iroh relay URLs.
//! * `TRAIL_STASH_RELAY_TOKEN`          — optional bearer token for the custom relays.
//! * `OTEL_EXPORTER_OTLP_ENDPOINT`      — developer telemetry (`otel` builds only): OTLP/HTTP
//!   base URL of a collector (e.g. `http://otel-collector:4318`). Unset ⇒ telemetry dormant.
//! * `OTEL_SERVICE_NAME`                — telemetry service name (default `trail-stash`).

use std::fmt;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use iroh::SecretKey;
use tracing::{Event, Subscriber};
use tracing_subscriber::fmt::format::{Format, FormatEvent, FormatFields, Writer};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;
use trail_stash::config::StashConfig;
use trail_stash::log_redaction::redact_log_line;
use trail_stash::node::{default_delivery, StashNode, Storage};
use trail_stash::waker::{EnvCredentials, HttpPushWaker, NoopWaker, PushConfig, Waker};

#[tokio::main]
async fn main() -> Result<()> {
    // Secret first: the subscriber wants the public key as `service.instance.id`. A missing key
    // therefore reports via anyhow/stderr instead of a log line — same visibility, earlier exit.
    let config = StashConfig::from_env(|k| std::env::var(k).ok());
    let secret = load_secret_key(config.data_dir.as_deref())?;

    init_tracing(&secret);

    if config.psk.is_none() {
        tracing::warn!(
            "TRAIL_STASH_PSK is unset — control API is open. Set it (and EXPO_PUBLIC_TRAIL_STASH_PSK in the app) to cut misuse."
        );
    }

    let storage = match &config.data_dir {
        Some(dir) => Storage::Persistent(dir.into()),
        None => Storage::Memory,
    };
    let peers = config
        .peers
        .iter()
        .map(|ticket| {
            ticket
                .parse::<iroh_tickets::endpoint::EndpointTicket>()
                .map(|t| t.endpoint_addr().clone())
                .map_err(|e| anyhow!("TRAIL_STASH_PEERS holds an invalid endpoint ticket: {e}"))
        })
        .collect::<Result<Vec<_>>>()?;

    let node = StashNode::spawn_with(
        storage,
        secret,
        config.retention,
        &config.relay_urls,
        config.relay_token.as_deref(),
        default_delivery(), // MLS passthrough stub
        build_waker(),      // HttpPushWaker when push env is set, else no-op
    )
    .await
    .context("spawn stash node")?;

    tracing::info!(
        "stash up — latest-fix backstop {}h, prune every {}m",
        config.retention.retention_ms() / trail_stash::retention::MS_PER_HOUR,
        config.prune_interval_min,
    );
    if std::env::var("TRAIL_STASH_PRINT_TICKET").as_deref() == Ok("1") {
        println!("TRAIL_STASH_TICKET={}", node.node_ticket());
    }

    tokio::spawn(Arc::clone(&node).run_prune_loop(config.prune_interval_min));

    if node.repeater().is_some() {
        // A repeater: grants arrive over `streetcryptid/repeater/1`, from members the roster
        // carries, so the PSK'd HTTP control API is not served at all.
        tracing::info!(
            "repeater: reconciling with siblings every {}m ({} configured by hand)",
            config.peer_sync_interval_min,
            peers.len()
        );
        tokio::spawn(trail_stash::repeater::run_sibling_loop(
            Arc::clone(&node),
            peers,
            std::time::Duration::from_secs(config.peer_sync_interval_min * 60),
        ));
        tokio::spawn(print_claim_links(Arc::clone(&node)));
        shutdown_signal().await;
        tracing::info!("repeater: shutdown signal received");
    } else {
        let serve =
            tokio::spawn(Arc::clone(&node).serve_control_api(config.port, config.psk.clone()));
        // Graceful shutdown on Ctrl-C / SIGTERM. The replica is in RAM with nothing to flush; only
        // buffered telemetry batches (otel builds) need a final drain.
        tokio::select! {
            _ = shutdown_signal() => tracing::info!("stash: shutdown signal received"),
            res = serve => {
                res.context("control api task")?.context("control api")?;
            }
        }
    }
    // A repeater's stores are on disk; close them rather than let the process die mid-write.
    node.shutdown().await;
    #[cfg(feature = "otel")]
    trail_stash::telemetry::shutdown();
    Ok(())
}

/// While the repeater is unclaimed, print its claim link to the console as a QR code and as text,
/// and a fresh one each time the old one expires. Both are the https form
/// ([`streetcryptid_repeater::wire::claim_url`]), so the phone's own camera opens streetCryptid on
/// the code and the text pastes into it. Printed with `println!`, not through tracing: the log
/// pipeline redacts identifier-length runs, and this link is meant for exactly one reader, at this
/// screen.
async fn print_claim_links(node: Arc<StashNode>) {
    let Some(repeater) = node.repeater().cloned() else {
        return;
    };
    let mut last = None;
    loop {
        match repeater.claim_secret() {
            None => return,
            Some(secret) if Some(secret) != last => {
                let url = streetcryptid_repeater::wire::claim_url(&node.node_ticket(), &secret);
                let qr = qrcode::QrCode::new(url.as_bytes())
                    .map(|code| {
                        code.render::<qrcode::render::unicode::Dense1x2>()
                            .quiet_zone(true)
                            .build()
                    })
                    .unwrap_or_default();
                println!(
                    "\nUnclaimed repeater. Within {} minutes, scan this with your phone's camera, \
                     or paste the link in streetCryptid (Settings > Repeaters):\n\n{qr}\n\n  {url}\n",
                    trail_stash::repeater::CLAIM_WINDOW_MS / 60_000,
                );
                last = Some(secret);
            }
            Some(_) => {}
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

/// Install the global subscriber: redacted console fmt (exactly the pre-telemetry behavior) plus,
/// on `otel` builds with `OTEL_EXPORTER_OTLP_ENDPOINT` set, the OTLP trace + log layers from
/// [`trail_stash::telemetry`]. `Option<Layer>`/`Vec<Layer>` are layers themselves, so the dormant
/// case composes to a no-op without branching.
fn init_tracing(secret: &SecretKey) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt_layer =
        tracing_subscriber::fmt::layer().event_format(RedactingFormat(Format::default()));

    let registry = tracing_subscriber::registry().with(filter).with(fmt_layer);

    #[cfg(feature = "otel")]
    let registry = registry.with(trail_stash::telemetry::otel_layers(
        &trail_stash::telemetry::instance_id(&secret.public()),
    ));
    #[cfg(not(feature = "otel"))]
    let _ = &secret;

    registry.init();
}

struct RedactingFormat(Format);

impl<S, N> FormatEvent<S, N> for RedactingFormat
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
    N: for<'writer> FormatFields<'writer> + 'static,
{
    fn format_event(
        &self,
        ctx: &tracing_subscriber::fmt::FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let mut formatted = String::new();
        self.0
            .format_event(ctx, Writer::new(&mut formatted), event)?;
        writer.write_str(&redact_log_line(&formatted))
    }
}

/// Build the waker from the push environment. Uses [`HttpPushWaker`] when APNs (bundle id) or FCM
/// (project id) routing is configured, otherwise a no-op. Credentials come from `APNS_BEARER` /
/// `FCM_BEARER` via [`EnvCredentials`] (the placeholder until real JWT/OAuth minting lands).
fn build_waker() -> Arc<dyn Waker> {
    let bundle_id = std::env::var("APNS_BUNDLE_ID")
        .ok()
        .filter(|s| !s.is_empty());
    let fcm_project_id = std::env::var("FCM_PROJECT_ID")
        .ok()
        .filter(|s| !s.is_empty());
    if bundle_id.is_none() && fcm_project_id.is_none() {
        tracing::info!(
            "push not configured (no APNS_BUNDLE_ID / FCM_PROJECT_ID) — waker is a no-op"
        );
        return Arc::new(NoopWaker);
    }
    let config = PushConfig {
        apns_host: std::env::var("APNS_HOST").unwrap_or_else(|_| "api.push.apple.com".to_string()),
        bundle_id: bundle_id.unwrap_or_default(),
        fcm_project_id: fcm_project_id.unwrap_or_default(),
    };
    Arc::new(HttpPushWaker::new(config, Arc::new(EnvCredentials)))
}

/// Load the stable identity seed: `TRAIL_STASH_SECRET_KEY` when set; otherwise, for a repeater,
/// `<data dir>/secret.key`, generated on first boot. The hosted stash has no disk and still
/// requires the variable.
fn load_secret_key(data_dir: Option<&str>) -> Result<SecretKey> {
    if let Ok(hex) = std::env::var("TRAIL_STASH_SECRET_KEY") {
        let bytes = decode_hex_32(hex.trim()).ok_or_else(|| {
            anyhow!("TRAIL_STASH_SECRET_KEY must be exactly 64 lowercase hex chars")
        })?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let Some(dir) = data_dir else {
        return Err(anyhow!(
            "TRAIL_STASH_SECRET_KEY is required (64 hex chars). Generate one with: openssl rand -hex 32"
        ));
    };
    let path = std::path::Path::new(dir).join("secret.key");
    match std::fs::read_to_string(&path) {
        Ok(hex) => {
            let bytes = decode_hex_32(hex.trim())
                .ok_or_else(|| anyhow!("{} is not 64 lowercase hex chars", path.display()))?;
            Ok(SecretKey::from_bytes(&bytes))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // The identity IS the repeater: friends' apps hold its endpoint id. Losing this file
            // means pairing a new repeater, so it is written once and never regenerated over an
            // unreadable one (that is the arm above, which fails).
            let secret = SecretKey::generate();
            let hex: String = secret
                .to_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            std::fs::create_dir_all(dir).with_context(|| format!("create {dir}"))?;
            write_private(&path, hex.as_bytes())
                .with_context(|| format!("write {}", path.display()))?;
            Ok(secret)
        }
        Err(e) => Err(anyhow!("read {}: {e}", path.display())),
    }
}

/// Write a file only its owner can read (on Unix; Windows inherits the directory's ACL).
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

/// Decode exactly 32 bytes from 64 lowercase hex chars.
fn decode_hex_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    let b = s.as_bytes();
    for i in 0..32 {
        let hi = lower_hex(b[2 * i])?;
        let lo = lower_hex(b[2 * i + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

fn lower_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

/// Resolve on Ctrl-C (SIGINT) or, on Unix, SIGTERM — the signal Kubernetes/Docker send on pod
/// termination. Without the SIGTERM arm the container would ignore it and get SIGKILLed after the
/// grace period. Everything is in RAM, so there is nothing to flush; this just exits promptly.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => tracing::warn!("failed to install SIGTERM handler: {e}"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
