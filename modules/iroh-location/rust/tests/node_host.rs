//! The node host against REAL nodes: real stores, real writer claims, real endpoints on loopback.
//!
//! `src/host/tests.rs` proves the arbiter's rules against fakes. These prove the property the
//! rules exist for, which only real claims can show: that the app and the background runtime,
//! arriving in any order, never refuse each other's stores — the `AlreadyOpen` that cost a Pixel 10
//! 13.7 hours on 2026-10-03 — and that every way out actually gives the claims back.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iroh_location::host::{NodeHolder, NodeHost, ReleaseOutcome};
use iroh_location::transport::TransportConfig;
use iroh_location::{derive_topic, DeviceSecrets, FixListener, LocationFix, LocationNode};

/// A fresh pair of storage roots per test. Not cleaned up: the OS temp dir is.
struct Roots {
    data: String,
    state: String,
}

fn roots(name: &str) -> Roots {
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "sc-node-host-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    Roots {
        data: dir.join("data").to_string_lossy().into_owned(),
        state: dir.join("state").to_string_lossy().into_owned(),
    }
}

fn offline() -> TransportConfig {
    TransportConfig {
        relay_urls: vec!["https://127.0.0.1:1".into()],
        relay_auth_token: "test-token".into(),
        relay_enabled: false,
        ip_enabled: true,
        ble_enabled: false,
    }
}

async fn start(node: &LocationNode, config: TransportConfig) {
    node.start(
        config.relay_urls,
        config.relay_auth_token,
        config.relay_enabled,
        config.ip_enabled,
        config.ble_enabled,
    )
    .await
    .expect("start node");
}

/// The keystore copy of the identity, as the platform hands it to a JS-free wake.
struct Keystore {
    identity: Option<Vec<u8>>,
    recv: Option<Vec<u8>>,
    reads: AtomicUsize,
}

impl Keystore {
    fn holding(node: &LocationNode) -> Arc<Self> {
        Arc::new(Self {
            identity: Some(node.identity_secret()),
            recv: Some(node.recv_secret()),
            reads: AtomicUsize::new(0),
        })
    }

    fn empty() -> Arc<Self> {
        Arc::new(Self {
            identity: None,
            recv: None,
            reads: AtomicUsize::new(0),
        })
    }
}

impl DeviceSecrets for Keystore {
    fn identity_secret(&self) -> Option<Vec<u8>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.identity.clone()
    }

    fn recv_secret(&self) -> Option<Vec<u8>> {
        self.recv.clone()
    }
}

/// Records every event it is handed, so a test can say which listener heard what.
#[derive(Default)]
struct Recorder {
    statuses: Mutex<Vec<String>>,
}

impl Recorder {
    fn heard(&self, status: &str) -> bool {
        self.statuses.lock().unwrap().iter().any(|s| s == status)
    }
}

impl FixListener for Recorder {
    fn on_fix(
        &self,
        _author: Vec<u8>,
        _seq: u64,
        _fix: LocationFix,
        _backfill: bool,
        _via: String,
        _via_peer: Option<String>,
    ) {
    }

    fn on_opaque(&self, _author: Vec<u8>, _seq: u64) {}

    fn on_status(&self, status: String) {
        self.statuses.lock().unwrap().push(status);
    }
}

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

const BUDGET_MS: u64 = 10_000;

/// A previous launch: the app ran once, stored its settings, and went away — leaving the identity
/// in the keystore and the settings on disk, which is all a JS-free wake ever has.
async fn previous_launch(roots: &Roots) -> Arc<Keystore> {
    let host = NodeHost::isolated();
    let node = host
        .acquire_app(None, None, roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    start(&node, offline()).await;
    node.set_transport_config(offline()).await.unwrap();
    let keystore = Keystore::holding(&node);
    assert_eq!(
        host.release(NodeHolder::App, BUDGET_MS).await,
        ReleaseOutcome::ShutDown
    );
    keystore
}

#[tokio::test]
async fn the_2026_10_03_launch_race_cannot_refuse_the_app() {
    // The app has built its node and not yet started it. The background runtime arrives in that
    // window — on the Pixel it was a self-heal, seven seconds wide — and starts the node from the
    // stored settings. The app's own `start()` then has to succeed. It used to be `AlreadyOpen`.
    let roots = roots("race");
    let keystore = previous_launch(&roots).await;
    let host = NodeHost::isolated();

    let app = host
        .acquire_app(
            keystore.identity.clone(),
            keystore.recv.clone(),
            roots.data.clone(),
            roots.state.clone(),
        )
        .await
        .unwrap();
    let background = host
        .acquire_background(keystore.clone(), roots.data.clone(), roots.state.clone())
        .await
        .unwrap()
        .expect("the keystore holds an identity");

    assert!(Arc::ptr_eq(&app, &background), "one node, two holders");
    assert!(app.is_started().await, "the background runtime started it");
    // The app's start, arriving second, is a no-op on a started node rather than a refusal.
    start(&app, offline()).await;
    assert!(app.ticket().await.is_ok());

    let snapshot = host.snapshot();
    assert_eq!(snapshot.builds, 1);
    assert_eq!(snapshot.app_leases, 1);
    assert!(snapshot.background);
}

#[tokio::test]
async fn the_app_adopts_a_node_the_background_runtime_built_and_started() {
    // The other order: the phone was in a pocket, the background runtime built and started the
    // node with no JS alive, and then the user opened the app.
    let roots = roots("bg-first");
    let keystore = previous_launch(&roots).await;
    let host = NodeHost::isolated();

    let background = host
        .acquire_background(keystore.clone(), roots.data.clone(), roots.state.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(background.is_started().await);

    let app = host
        .acquire_app(
            keystore.identity.clone(),
            keystore.recv.clone(),
            roots.data.clone(),
            roots.state.clone(),
        )
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&app, &background));
    start(&app, offline()).await;
    assert_eq!(host.snapshot().builds, 1);
}

#[tokio::test]
async fn a_live_node_costs_the_background_runtime_no_keystore_read() {
    let roots = roots("no-read");
    let keystore = previous_launch(&roots).await;
    let host = NodeHost::isolated();
    let app = host
        .acquire_app(
            keystore.identity.clone(),
            keystore.recv.clone(),
            roots.data.clone(),
            roots.state.clone(),
        )
        .await
        .unwrap();
    start(&app, offline()).await;
    let reads_before = keystore.reads.load(Ordering::SeqCst);
    for _ in 0..3 {
        host.acquire_background(keystore.clone(), roots.data.clone(), roots.state.clone())
            .await
            .unwrap();
    }
    assert_eq!(keystore.reads.load(Ordering::SeqCst), reads_before);
}

#[tokio::test]
async fn a_fresh_install_gives_the_background_runtime_nothing() {
    let roots = roots("fresh");
    let host = NodeHost::isolated();
    let acquired = host
        .acquire_background(Keystore::empty(), roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    assert!(acquired.is_none());
    assert_eq!(host.snapshot().builds, 0);
}

#[tokio::test]
async fn the_app_leaving_keeps_the_node_running_for_the_background_runtime() {
    let roots = roots("app-leaves");
    let keystore = previous_launch(&roots).await;
    let host = NodeHost::isolated();
    let app = host
        .acquire_app(
            keystore.identity.clone(),
            keystore.recv.clone(),
            roots.data.clone(),
            roots.state.clone(),
        )
        .await
        .unwrap();
    start(&app, offline()).await;
    host.acquire_background(keystore.clone(), roots.data.clone(), roots.state.clone())
        .await
        .unwrap();

    assert_eq!(
        host.release(NodeHolder::App, BUDGET_MS).await,
        ReleaseOutcome::StillHeld
    );
    let node = host.current().expect("the background runtime still holds it");
    assert!(node.is_started().await);
    assert!(node.ticket().await.is_ok(), "and it is still a working node");

    assert_eq!(
        host.release(NodeHolder::Background, BUDGET_MS).await,
        ReleaseOutcome::ShutDown
    );
    assert!(host.current().is_none());
    assert!(!node.is_started().await);
}

#[tokio::test]
async fn every_way_out_gives_the_claims_back() {
    // A shutdown that left one claim held would make the NEXT node's start `AlreadyOpen` — which a
    // second, independent node on the same roots proves or disproves directly.
    let roots = roots("claims");
    let keystore = previous_launch(&roots).await;

    for holder_order in [
        [NodeHolder::App, NodeHolder::Background],
        [NodeHolder::Background, NodeHolder::App],
    ] {
        let host = NodeHost::isolated();
        let node = host
            .acquire_app(
                keystore.identity.clone(),
                keystore.recv.clone(),
                roots.data.clone(),
                roots.state.clone(),
            )
            .await
            .unwrap();
        start(&node, offline()).await;
        host.acquire_background(keystore.clone(), roots.data.clone(), roots.state.clone())
            .await
            .unwrap();
        for holder in holder_order {
            host.release(holder, BUDGET_MS).await;
        }
        drop(node);

        let independent = LocationNode::new_at_dirs(
            keystore.identity.clone(),
            keystore.recv.clone(),
            roots.data.clone(),
            roots.state.clone(),
        )
        .unwrap();
        independent
            .start_stored()
            .await
            .expect("every claim must be free once the last holder is out");
        independent.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn a_restart_builds_a_new_node_on_freed_claims_and_keeps_the_identity() {
    let roots = roots("restart");
    let keystore = previous_launch(&roots).await;
    let host = NodeHost::isolated();
    let old = host
        .acquire_app(
            keystore.identity.clone(),
            keystore.recv.clone(),
            roots.data.clone(),
            roots.state.clone(),
        )
        .await
        .unwrap();
    start(&old, offline()).await;
    host.acquire_background(keystore.clone(), roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    let generation = host.generation();

    let new = host.restart(offline(), BUDGET_MS).await.expect("restart");
    assert!(!Arc::ptr_eq(&old, &new));
    assert!(!old.is_started().await, "the old node is shut down");
    assert!(new.is_started().await, "the new one started — so the claims were free");
    assert_eq!(new.identity_secret(), old.identity_secret());
    assert_eq!(new.endpoint_id(), old.endpoint_id());
    assert!(host.generation() > generation);
    let snapshot = host.snapshot();
    assert_eq!(snapshot.app_leases, 1);
    assert!(snapshot.background);
    assert!(Arc::ptr_eq(&host.current().unwrap(), &new));
}

#[tokio::test]
async fn a_different_identity_replaces_the_node_and_its_claims() {
    let first = roots("replace-a");
    let host = NodeHost::isolated();
    let a = host
        .acquire_app(None, None, first.data.clone(), first.state.clone())
        .await
        .unwrap();
    start(&a, offline()).await;

    // Same roots, new identity — a reset device. Roots are scoped per identity on disk, so the
    // stores do not even collide; what must not survive is the old node.
    let b = host
        .acquire_app(None, None, first.data.clone(), first.state.clone())
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&a, &b), "no identity given: adopt");

    let other = LocationNode::new(None, None).unwrap();
    let c = host
        .acquire_app(
            Some(other.identity_secret()),
            Some(other.recv_secret()),
            first.data.clone(),
            first.state.clone(),
        )
        .await
        .unwrap();
    assert!(!Arc::ptr_eq(&a, &c));
    assert!(!a.is_started().await, "the old identity's node was shut down first");
    assert_eq!(c.identity_secret(), other.identity_secret());
    assert_eq!(host.snapshot().replacements, 1);
}

// ── The own-topic subscription ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_own_topic_has_one_subscription_however_many_callers_ask() {
    let roots = roots("own-sub");
    let host = NodeHost::isolated();
    let node = host
        .acquire_app(None, None, roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    start(&node, offline()).await;
    let own = derive_topic(node.endpoint_id());

    let app = node
        .clone()
        .subscribe(own.clone(), vec![], Arc::new(Recorder::default()))
        .await
        .unwrap();
    let again = node
        .clone()
        .subscribe(own.clone(), vec![], Arc::new(Recorder::default()))
        .await
        .unwrap();
    let background = node.clone().own_subscription(vec![], None).await.unwrap();
    assert!(Arc::ptr_eq(&app, &again), "a second subscribe adopts");
    assert!(Arc::ptr_eq(&app, &background), "the background runtime adopts too");

    // Every OTHER topic keeps its old behaviour: one subscription per call.
    let friend_topic = derive_topic(vec![7; 32]);
    let first = node
        .clone()
        .subscribe(friend_topic.clone(), vec![], Arc::new(Recorder::default()))
        .await
        .unwrap();
    let second = node
        .clone()
        .subscribe(friend_topic, vec![], Arc::new(Recorder::default()))
        .await
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &second));
}

#[tokio::test]
async fn the_own_subscription_outlives_a_dropped_handle_and_dies_with_the_node() {
    let roots = roots("own-sub-life");
    let host = NodeHost::isolated();
    let node = host
        .acquire_app(None, None, roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    start(&node, offline()).await;
    let own = derive_topic(node.endpoint_id());

    let first = node
        .clone()
        .subscribe(own.clone(), vec![], Arc::new(Recorder::default()))
        .await
        .unwrap();
    let first_ptr = Arc::as_ptr(&first);
    // JS `unsubscribe` destroys its handle. The background runtime is still publishing through it.
    drop(first);
    let second = node.clone().own_subscription(vec![], None).await.unwrap();
    assert_eq!(Arc::as_ptr(&second), first_ptr, "still the same subscription");
    drop(second);

    host.restart(offline(), BUDGET_MS).await.unwrap();
    let restarted = host.current().unwrap();
    let after = restarted.clone().own_subscription(vec![], None).await.unwrap();
    assert_ne!(
        Arc::as_ptr(&after),
        first_ptr,
        "a new node has its own subscription"
    );
}

/// Two nodes on loopback: `peer` joins `node`'s own topic, which raises `peer-up` on whichever
/// listener `node`'s own subscription is delivering to at that moment.
async fn peer_joins(node: &Arc<LocationNode>, name: &str) -> Arc<LocationNode> {
    let peer_roots = roots(name);
    let peer = LocationNode::new_at_dirs(None, None, peer_roots.data, peer_roots.state).unwrap();
    start(&peer, offline()).await;
    let ticket = node.ticket().await.unwrap();
    // Held for the life of the peer: dropping the handle would leave the topic.
    let sub = peer
        .clone()
        .subscribe(
            derive_topic(node.endpoint_id()),
            vec![ticket],
            Arc::new(Recorder::default()),
        )
        .await
        .unwrap();
    std::mem::forget(sub);
    peer
}

#[tokio::test]
async fn adopting_the_own_subscription_with_a_listener_takes_over_its_events() {
    let roots = roots("listener-swap");
    let host = NodeHost::isolated();
    let node = host
        .acquire_app(None, None, roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    start(&node, offline()).await;
    let own = derive_topic(node.endpoint_id());

    let old = Arc::new(Recorder::default());
    let new = Arc::new(Recorder::default());
    let _a = node
        .clone()
        .subscribe(own.clone(), vec![], old.clone())
        .await
        .unwrap();
    // A new JS context subscribes: the events are now its, not the old one's.
    let _b = node.clone().subscribe(own, vec![], new.clone()).await.unwrap();
    // The background runtime adopting with `None` must NOT silence the app.
    let _c = node.clone().own_subscription(vec![], None).await.unwrap();

    let _peer = peer_joins(&node, "listener-swap-peer").await;
    eventually("peer-up on the newest listener", || new.heard("peer-up")).await;
    assert!(!old.heard("peer-up"), "a replaced listener must hear nothing more");
}

#[tokio::test]
async fn the_app_leaving_silences_its_listener_but_not_the_subscription() {
    let roots = roots("detach");
    let previous = previous_launch(&roots).await;
    let host = NodeHost::isolated();
    let node = host
        .acquire_app(
            previous.identity.clone(),
            previous.recv.clone(),
            roots.data.clone(),
            roots.state.clone(),
        )
        .await
        .unwrap();
    start(&node, offline()).await;
    host.acquire_background(previous.clone(), roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    let app_listener = Arc::new(Recorder::default());
    let own = node
        .clone()
        .subscribe(derive_topic(node.endpoint_id()), vec![], app_listener.clone())
        .await
        .unwrap();

    host.release(NodeHolder::App, BUDGET_MS).await;
    let _peer = peer_joins(&node, "detach-peer").await;
    // Give the join every chance to be delivered, then check it was delivered to nobody.
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(
        !app_listener.heard("peer-up"),
        "events must not flow into a JS context that has gone"
    );
    let still = node.clone().own_subscription(vec![], None).await.unwrap();
    assert!(Arc::ptr_eq(&own, &still), "the background runtime's subscription is untouched");
}
