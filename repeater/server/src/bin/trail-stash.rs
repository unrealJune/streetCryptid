//! `trail-stash` binary — boots the in-memory, ciphertext-blind replica + control API.
//!
//! Requires the `live` feature: `cargo run --features live`.
//!
//! Environment:
//! * `TRAIL_STASH_SECRET_KEY`   — **required**: 64 lowercase hex chars (32-byte ed25519 seed).
//!   Gives the stash a stable dialable identity so `EXPO_PUBLIC_TRAIL_STASH_TICKET` survives
//!   restarts. It is a key, not user data — inject it from a secret manager, never commit it.
//!   Generate one with `openssl rand -hex 32`.
//! * `PORT`                             — control-API port (default 8787).
//! * `TRAIL_STASH_RETENTION_HOURS`      — retention window (default 48, clamped 1–336).
//! * `TRAIL_STASH_PRUNE_INTERVAL_MIN`   — prune cadence (default 15).
//! * `TRAIL_STASH_RELAY_URLS`           — comma-separated custom iroh relay URLs.
//! * `TRAIL_STASH_RELAY_TOKEN`          — optional bearer token for the custom relays.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use iroh::SecretKey;
use tracing_subscriber::EnvFilter;
use trail_stash::config::StashConfig;
use trail_stash::node::{default_delivery, StashNode};
use trail_stash::waker::{EnvCredentials, HttpPushWaker, NoopWaker, PushConfig, Waker};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = StashConfig::from_env(|k| std::env::var(k).ok());
    let secret = load_secret_key()?;

    if config.psk.is_none() {
        tracing::warn!(
            "TRAIL_STASH_PSK is unset — control API is open. Set it (and EXPO_PUBLIC_TRAIL_STASH_PSK in the app) to cut misuse."
        );
    }

    let node = StashNode::spawn(
        secret,
        config.retention,
        &config.relay_urls,
        config.relay_token.as_deref(),
        default_delivery(), // MLS passthrough stub
        build_waker(),      // HttpPushWaker when push env is set, else no-op
    )
    .await
    .context("spawn stash node")?;

    // The one thing an operator needs to copy into the app's env.
    println!("EXPO_PUBLIC_TRAIL_STASH_TICKET={}", node.node_ticket());
    tracing::info!(
        "stash up — retention {}h, prune every {}m",
        config.retention.retention_ms() / trail_stash::retention::MS_PER_HOUR,
        config.prune_interval_min,
    );

    tokio::spawn(Arc::clone(&node).run_prune_loop(config.prune_interval_min));

    let serve = tokio::spawn(Arc::clone(&node).serve_control_api(config.port, config.psk.clone()));

    // Graceful shutdown on Ctrl-C / SIGTERM. Everything is in RAM, so there is nothing to flush.
    tokio::select! {
        _ = shutdown_signal() => tracing::info!("stash: shutdown signal received"),
        res = serve => {
            res.context("control api task")?.context("control api")?;
        }
    }
    Ok(())
}

/// Build the waker from the push environment. Uses [`HttpPushWaker`] when APNs (bundle id) or FCM
/// (project id) routing is configured, otherwise a no-op. Credentials come from `APNS_BEARER` /
/// `FCM_BEARER` via [`EnvCredentials`] (the placeholder until real JWT/OAuth minting lands).
fn build_waker() -> Arc<dyn Waker> {
    let bundle_id = std::env::var("APNS_BUNDLE_ID").ok().filter(|s| !s.is_empty());
    let fcm_project_id = std::env::var("FCM_PROJECT_ID").ok().filter(|s| !s.is_empty());
    if bundle_id.is_none() && fcm_project_id.is_none() {
        tracing::info!("push not configured (no APNS_BUNDLE_ID / FCM_PROJECT_ID) — waker is a no-op");
        return Arc::new(NoopWaker);
    }
    let config = PushConfig {
        apns_host: std::env::var("APNS_HOST").unwrap_or_else(|_| "api.push.apple.com".to_string()),
        bundle_id: bundle_id.unwrap_or_default(),
        fcm_project_id: fcm_project_id.unwrap_or_default(),
    };
    Arc::new(HttpPushWaker::new(config, Arc::new(EnvCredentials)))
}

/// Load the required stable identity seed from `TRAIL_STASH_SECRET_KEY`.
fn load_secret_key() -> Result<SecretKey> {
    let hex = std::env::var("TRAIL_STASH_SECRET_KEY").map_err(|_| {
        anyhow!(
            "TRAIL_STASH_SECRET_KEY is required (64 hex chars). Generate one with: openssl rand -hex 32"
        )
    })?;
    let bytes = decode_hex_32(hex.trim())
        .ok_or_else(|| anyhow!("TRAIL_STASH_SECRET_KEY must be exactly 64 lowercase hex chars"))?;
    Ok(SecretKey::from_bytes(&bytes))
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
