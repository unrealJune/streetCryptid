//! The native background runtime's way in: build a node from what is on disk, with no JS.
//!
//! `BackgroundLocationRuntime` (iOS) and `NativeBackgroundRuntime` (Android) both call
//! `start_stored` on a freshly built node. Until 2026-09-28 that always failed with `NotStarted`,
//! because it read the transport config from a store only `start` opens — so the JS-free publish
//! path had never published anything, on either platform, and nothing said so.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use iroh_location::transport::TransportConfig;
use iroh_location::{LocationError, LocationNode};

fn node_at(dir: &Path, identity: Option<Vec<u8>>, recv: Option<Vec<u8>>) -> Arc<LocationNode> {
    LocationNode::new_at_dirs(
        identity,
        recv,
        dir.join("data").to_string_lossy().into_owned(),
        dir.join("state").to_string_lossy().into_owned(),
    )
    .expect("construct node")
}

/// A fresh directory per test. Not cleaned up: the OS temp dir is, and a leftover is evidence.
fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sc-native-start-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn offline_config() -> TransportConfig {
    TransportConfig {
        relay_urls: vec!["https://127.0.0.1:1".into()],
        relay_auth_token: "test-token".into(),
        relay_enabled: false,
        ip_enabled: true,
        ble_enabled: false,
    }
}

async fn start_offline(node: &LocationNode) {
    let c = offline_config();
    node.start(
        c.relay_urls,
        c.relay_auth_token,
        c.relay_enabled,
        c.ip_enabled,
        c.ble_enabled,
    )
    .await
    .expect("start node");
}

#[tokio::test]
async fn a_fresh_node_starts_from_the_config_the_app_stored() {
    let dir = temp_root("stored");

    // The app's side: start with explicit settings, mirror them, and go away.
    let app = node_at(&dir, None, None);
    start_offline(&app).await;
    app.set_transport_config(offline_config()).await.unwrap();
    let (identity, recv) = (app.identity_secret(), app.recv_secret());
    app.shutdown().await.unwrap();

    // The native runtime's side: a node built from the same identity and roots, nothing else.
    let native = node_at(&dir, Some(identity), Some(recv));
    native
        .start_stored()
        .await
        .expect("a fresh node must start from the stored config");
    assert!(native.ticket().await.is_ok(), "the node is actually up");
    native.shutdown().await.unwrap();
}

#[tokio::test]
async fn nothing_stored_is_a_refusal_not_a_node_with_no_relays() {
    let dir = temp_root("nothing");
    let native = node_at(&dir, None, None);
    let err = native
        .start_stored()
        .await
        .expect_err("no config, no start");
    assert!(
        !matches!(err, LocationError::NotStarted),
        "must fail on the missing config, not on the node being unstarted: {err}"
    );
}

#[tokio::test]
async fn a_refused_claim_is_refused_before_anything_touches_the_network() {
    let dir = temp_root("refused");
    let app = node_at(&dir, None, None);
    start_offline(&app).await;
    app.set_transport_config(offline_config()).await.unwrap();

    // The mounted app still holds every store; the native runtime asks anyway, as it does on
    // every delivery while the app is open.
    let native = node_at(&dir, Some(app.identity_secret()), Some(app.recv_secret()));
    // Bounded, because the failure this guards is a hang: with the claims taken after the bind, the
    // refused start never returned at all — it waited on the blob/docs stores the app has open.
    let err = tokio::time::timeout(std::time::Duration::from_secs(10), native.start_stored())
        .await
        .expect("a refused claim must return, not wait on the app's stores")
        .expect_err("the app holds the stores");
    // The ratchet session store is the FIRST claim. Being refused there — rather than by the blob
    // store's database lock, which is only opened after the endpoint is bound — is what proves no
    // second endpoint was bound on this identity on the way to the refusal.
    assert!(
        err.to_string().contains("session store is already open"),
        "refused somewhere other than the first claim: {err}"
    );
    assert!(app.ticket().await.is_ok(), "the app's node is untouched");
    app.shutdown().await.unwrap();

    // And once the app lets go, the same node can take over.
    native
        .start_stored()
        .await
        .expect("the stores are free now");
    native.shutdown().await.unwrap();
}
