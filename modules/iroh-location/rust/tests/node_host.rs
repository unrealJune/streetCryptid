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
use iroh_location::{DeviceSecrets, LocationFix, LocationNode, ReplicaListener};

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

/// Records every replica announcement it is handed, so a test can say which listener heard what.
#[derive(Default)]
struct Recorder {
    authors: Mutex<Vec<Vec<u8>>>,
}

impl Recorder {
    fn heard(&self, author: &[u8]) -> bool {
        self.authors.lock().unwrap().iter().any(|a| a == author)
    }

    fn heard_anything(&self) -> bool {
        !self.authors.lock().unwrap().is_empty()
    }
}

impl ReplicaListener for Recorder {
    fn on_friend_entries(&self, authors: Vec<Vec<u8>>) {
        self.authors.lock().unwrap().extend(authors);
    }
}

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..600 {
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
    let node = host
        .current()
        .expect("the background runtime still holds it");
    assert!(node.is_started().await);
    assert!(
        node.ticket().await.is_ok(),
        "and it is still a working node"
    );

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
    assert!(
        new.is_started().await,
        "the new one started — so the claims were free"
    );
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
    assert!(
        !a.is_started().await,
        "the old identity's node was shut down first"
    );
    assert_eq!(c.identity_secret(), other.identity_secret());
    assert_eq!(host.snapshot().replacements, 1);
}

// ── The replica listener ─────────────────────────────────────────────────────────────────────────

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn fix_at(ts: u64) -> LocationFix {
    LocationFix {
        lat: 47.6062,
        lon: -122.3321,
        accuracy_m: 4.0,
        heading_deg: 90.0,
        ts,
        state: None,
        published_delta_s: None,
    }
}

/// A friend of `node` on loopback, paired (sessions bootstrapped in-process) and able to publish to
/// it at once. A fresh session's responder cannot send until the initiator has, and the initiator
/// is the lower endpoint id (`initiator_by_endpoint`), so friends are minted until one sorts first.
async fn friend_publishing_to(node: &Arc<LocationNode>, name: &str) -> Arc<LocationNode> {
    for attempt in 0..64 {
        let friend_roots = roots(&format!("{name}-{attempt}"));
        let friend =
            LocationNode::new_at_dirs(None, None, friend_roots.data, friend_roots.state).unwrap();
        if friend.endpoint_id() > node.endpoint_id() {
            continue;
        }
        start(&friend, offline()).await;
        let node_id = hex(&node.endpoint_id());
        let friend_id = hex(&friend.endpoint_id());
        let friend_eph = friend.begin_session(node_id.clone()).await.unwrap();
        let node_eph = node.begin_session(friend_id.clone()).await.unwrap();
        friend.complete_session(node_id, node_eph).await.unwrap();
        node.complete_session(friend_id, friend_eph).await.unwrap();
        return friend;
    }
    panic!("no friend sorted below the node in 64 tries");
}

async fn publish(friend: &LocationNode, to: &LocationNode, seq: u64) {
    let dropped = friend
        .docs_write_ratcheted(
            seq,
            fix_at(1_780_000_000_000 + seq),
            vec![hex(&to.endpoint_id())],
        )
        .await
        .expect("friend publishes");
    assert!(dropped.is_empty(), "no recipient dropped: {dropped:?}");
}

/// Wait until `node`'s replica holds `author`'s fix at `seq` or later, content included.
async fn replica_holds(node: &LocationNode, author: &[u8], seq: u64) {
    for _ in 0..600 {
        let held = node
            .trail_replica_status()
            .await
            .unwrap()
            .iter()
            .any(|slot| slot.author == author && slot.seq >= seq && slot.has_content);
        if held {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the replica never held seq {seq}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_newest_replica_listener_hears_a_friend_and_a_replaced_one_does_not() {
    let roots = roots("listener-swap");
    let host = NodeHost::isolated();
    let node = host
        .acquire_app(None, None, roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    start(&node, offline()).await;
    let old = Arc::new(Recorder::default());
    let new = Arc::new(Recorder::default());
    node.watch_replica(old.clone());
    // A new JS context attaches: the announcements are now its, not the old one's.
    node.watch_replica(new.clone());

    let friend = friend_publishing_to(&node, "listener-swap-friend").await;
    publish(&friend, &node, 1).await;
    node.import_doc_ticket(friend.doc_ticket().await.unwrap())
        .await
        .unwrap();

    let author = friend.endpoint_id();
    eventually("the newest listener hears the friend", || {
        new.heard(&author)
    })
    .await;
    assert!(
        !old.heard_anything(),
        "a replaced listener must hear nothing more"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_app_leaving_silences_its_listener_but_not_the_replica() {
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
    node.watch_replica(app_listener.clone());

    host.release(NodeHolder::App, BUDGET_MS).await;
    let friend = friend_publishing_to(&node, "detach-friend").await;
    publish(&friend, &node, 1).await;
    node.import_doc_ticket(friend.doc_ticket().await.unwrap())
        .await
        .unwrap();

    // Replication carries on for the background runtime: the entry lands all the same.
    replica_holds(&node, &friend.endpoint_id(), 1).await;
    // Give the announcement every chance to be delivered, then check it went to nobody.
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        !app_listener.heard_anything(),
        "announcements must not flow into a JS context that has gone"
    );
}

/// The 2026-11 docs-only cut's load-bearing claim about restarts: a rebuilt node reopens every
/// friend namespace from the book, puts it straight back into the live engine, and watches it — so
/// a friend's next write reaches it with nobody calling a pull.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rebuilt_node_hears_a_reopened_friend_without_a_pull() {
    let roots = roots("reopen-live");
    let host = NodeHost::isolated();
    let node = host
        .acquire_app(None, None, roots.data.clone(), roots.state.clone())
        .await
        .unwrap();
    start(&node, offline()).await;
    let friend = friend_publishing_to(&node, "reopen-live-friend").await;
    publish(&friend, &node, 1).await;
    node.import_doc_ticket(friend.doc_ticket().await.unwrap())
        .await
        .unwrap();
    let author = friend.endpoint_id();
    replica_holds(&node, &author, 1).await;

    host.restart(offline(), BUDGET_MS).await.unwrap();
    let rebuilt = host.current().unwrap();
    assert!(!Arc::ptr_eq(&node, &rebuilt), "a restart builds a new node");
    let listener = Arc::new(Recorder::default());
    rebuilt.watch_replica(listener.clone());

    publish(&friend, &rebuilt, 2).await;
    eventually("the rebuilt node hears the friend's next fix", || {
        listener.heard(&author)
    })
    .await;
    replica_holds(&rebuilt, &author, 2).await;
}

// ── Two holders driving one node ─────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drains_from_both_holders_on_one_node_serialize_and_all_finish() {
    // Before the host, the second of two holders could not even open the stores. Now both can
    // drive the same node at once — the app ingesting a handed-off capture while the background
    // runtime heartbeats — and every drain must finish rather than interleave or deadlock.
    use iroh_location::gate::BatteryState;

    let roots = roots("drains");
    let keystore = previous_launch(&roots).await;
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
    let background = host
        .acquire_background(keystore.clone(), roots.data.clone(), roots.state.clone())
        .await
        .unwrap()
        .unwrap();
    assert!(Arc::ptr_eq(&node, &background));

    let battery = BatteryState {
        level: 1.0,
        charging: false,
        low_power: false,
    };
    let base = 1_780_000_000_000u64;
    let mut drains = Vec::new();
    for i in 0..6u64 {
        let ingest = node.clone();
        drains.push(tokio::spawn(async move {
            let ts = base + i * 60_000;
            let fix = LocationFix {
                lat: 47.6 + i as f64 * 0.001,
                lon: -122.3,
                accuracy_m: 5.0,
                heading_deg: 0.0,
                ts,
                state: None,
                published_delta_s: None,
            };
            ingest
                .ingest_fix(fix, battery, 60_000, ts)
                .await
                .map(|_| ())
        }));
        let heartbeat = background.clone();
        drains.push(tokio::spawn(async move {
            let ts = base + i * 60_000 + 30_000;
            heartbeat
                .heartbeat_fix(battery, 60_000, ts, None)
                .await
                .map(|_| ())
        }));
    }
    for drain in drains {
        tokio::time::timeout(Duration::from_secs(60), drain)
            .await
            .expect("a drain must finish, not wait forever on another")
            .unwrap()
            .expect("drain");
    }
}
