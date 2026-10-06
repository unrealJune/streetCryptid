//! The [`Host`] contract, against fakes that do exactly what each test needs — including the two
//! things a real node only does by accident: a shutdown that fails, and one that never returns.
//!
//! The exhaustive test at the bottom is the backstop. Every individual rule has its own test above
//! it, so a failure names the rule; the exhaustive one checks that no SEQUENCE of operations a
//! phone can produce reaches a state those tests did not imagine.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;

use super::*;

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────

/// Process-wide truth the fakes report into: how many nodes are alive right now, and the most
/// there have ever been at once. "At most one node is alive" is `max_live <= 1`.
#[derive(Default)]
struct Ledger {
    live: AtomicUsize,
    max_live: AtomicUsize,
    events: StdMutex<Vec<String>>,
}

impl Ledger {
    fn event(&self, event: impl Into<String>) {
        self.events.lock().unwrap().push(event.into());
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn live(&self) -> usize {
        self.live.load(Ordering::SeqCst)
    }

    fn max_live(&self) -> usize {
        self.max_live.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownMode {
    Clean,
    /// Finishes, releases, and reports an error — `LocationNode::shutdown` on a router error.
    Fails,
    /// Never returns. The 2026-08-18 shape.
    Hangs,
    /// Finishes after this many milliseconds.
    Slow(u64),
}

struct Behaviour {
    shutdown: StdMutex<ShutdownMode>,
    build_fails: AtomicBool,
    start_stored_fails: AtomicBool,
    start_fails: AtomicBool,
}

impl Default for Behaviour {
    fn default() -> Self {
        Self {
            shutdown: StdMutex::new(ShutdownMode::Clean),
            build_fails: AtomicBool::new(false),
            start_stored_fails: AtomicBool::new(false),
            start_fails: AtomicBool::new(false),
        }
    }
}

impl Behaviour {
    fn shutdown_mode(&self) -> ShutdownMode {
        *self.shutdown.lock().unwrap()
    }

    fn set_shutdown(&self, mode: ShutdownMode) {
        *self.shutdown.lock().unwrap() = mode;
    }
}

struct FakeNode {
    id: u64,
    identity: Vec<u8>,
    recv: Vec<u8>,
    /// How the node was started, if it was: `stored`, or `explicit:<relay_auth_token>`.
    started: StdMutex<Option<String>>,
    shut: AtomicBool,
    detaches: AtomicUsize,
    ledger: Arc<Ledger>,
    behaviour: Arc<Behaviour>,
}

impl fmt::Debug for FakeNode {
    // `expect_err` prints the `Ok` side when it fails; the id is all that is worth reading.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FakeNode").field("id", &self.id).finish()
    }
}

impl FakeNode {
    fn started(&self) -> Option<String> {
        self.started.lock().unwrap().clone()
    }

    fn is_shut(&self) -> bool {
        self.shut.load(Ordering::SeqCst)
    }

    fn detaches(&self) -> usize {
        self.detaches.load(Ordering::SeqCst)
    }

    fn mark_shut(&self) {
        if !self.shut.swap(true, Ordering::SeqCst) {
            self.ledger.live.fetch_sub(1, Ordering::SeqCst);
            self.ledger.event(format!("shut:{}", self.id));
        }
    }

    fn start_with(&self, how: String) {
        let mut started = self.started.lock().unwrap();
        // Idempotent, like `LocationNode::start`: the first start wins.
        if started.is_none() {
            self.ledger.event(format!("start:{}:{how}", self.id));
            *started = Some(how);
        }
    }
}

impl HostedNode for FakeNode {
    fn identity_secret(&self) -> Vec<u8> {
        self.identity.clone()
    }

    fn recv_secret(&self) -> Vec<u8> {
        self.recv.clone()
    }

    fn start_stored(&self) -> impl Future<Output = Result<(), LocationError>> + Send {
        async move {
            if self.behaviour.start_stored_fails.load(Ordering::SeqCst) {
                return Err(LocationError::Network("stored start refused".into()));
            }
            self.start_with("stored".into());
            Ok(())
        }
    }

    fn start(
        &self,
        config: TransportConfig,
    ) -> impl Future<Output = Result<(), LocationError>> + Send {
        async move {
            if self.behaviour.start_fails.load(Ordering::SeqCst) {
                return Err(LocationError::Network("explicit start refused".into()));
            }
            self.start_with(format!("explicit:{}", config.relay_auth_token));
            Ok(())
        }
    }

    fn shutdown(&self) -> impl Future<Output = Result<(), LocationError>> + Send {
        async move {
            self.ledger.event(format!("shutdown-begin:{}", self.id));
            match self.behaviour.shutdown_mode() {
                ShutdownMode::Clean => {
                    self.mark_shut();
                    Ok(())
                }
                ShutdownMode::Fails => {
                    self.mark_shut();
                    Err(LocationError::Network("router did not close".into()))
                }
                ShutdownMode::Hangs => std::future::pending().await,
                ShutdownMode::Slow(ms) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    self.mark_shut();
                    Ok(())
                }
            }
        }
    }

    fn detach_app_listeners(&self) -> impl Future<Output = ()> + Send {
        async move {
            self.detaches.fetch_add(1, Ordering::SeqCst);
            self.ledger.event(format!("detach:{}", self.id));
        }
    }
}

struct FakeFactory {
    ledger: Arc<Ledger>,
    behaviour: Arc<Behaviour>,
    next: AtomicU64,
}

impl NodeFactory for FakeFactory {
    type Node = FakeNode;

    fn build(&self, keys: &NodeKeys, roots: &NodeRoots) -> Result<Arc<FakeNode>, LocationError> {
        if self.behaviour.build_fails.load(Ordering::SeqCst) {
            return Err(LocationError::Crypto("bad identity key".into()));
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let live = self.ledger.live.fetch_add(1, Ordering::SeqCst) + 1;
        self.ledger.max_live.fetch_max(live, Ordering::SeqCst);
        self.ledger.event(format!("build:{id}:{}", roots.state));
        Ok(Arc::new(FakeNode {
            id,
            identity: keys
                .identity
                .clone()
                .unwrap_or_else(|| format!("fresh-{id}").into_bytes()),
            recv: keys
                .recv
                .clone()
                .unwrap_or_else(|| format!("recv-{id}").into_bytes()),
            started: StdMutex::new(None),
            shut: AtomicBool::new(false),
            detaches: AtomicUsize::new(0),
            ledger: self.ledger.clone(),
            behaviour: self.behaviour.clone(),
        }))
    }
}

struct Rig {
    host: Arc<Host<FakeFactory>>,
    ledger: Arc<Ledger>,
    behaviour: Arc<Behaviour>,
}

fn rig() -> Rig {
    let ledger = Arc::new(Ledger::default());
    let behaviour = Arc::new(Behaviour::default());
    let host = Arc::new(Host::new(FakeFactory {
        ledger: ledger.clone(),
        behaviour: behaviour.clone(),
        next: AtomicU64::new(0),
    }));
    Rig {
        host,
        ledger,
        behaviour,
    }
}

fn roots() -> NodeRoots {
    NodeRoots {
        data: "cache/streetcryptid".into(),
        state: "files/streetcryptid".into(),
    }
}

fn keys(identity: &str) -> NodeKeys {
    NodeKeys {
        identity: Some(identity.as_bytes().to_vec()),
        recv: Some(format!("{identity}-recv").into_bytes()),
    }
}

fn config(token: &str) -> TransportConfig {
    TransportConfig {
        relay_urls: vec!["https://relay.example".into()],
        relay_auth_token: token.into(),
        relay_enabled: true,
        ip_enabled: true,
        ble_enabled: false,
    }
}

const BUDGET: Duration = Duration::from_secs(2);

impl Rig {
    async fn app(&self, identity: &str) -> (Arc<FakeNode>, AcquireOutcome) {
        self.host
            .acquire_app(keys(identity), roots(), BUDGET)
            .await
            .expect("app acquire")
    }

    async fn background(&self, identity: &str) -> Option<(Arc<FakeNode>, AcquireOutcome)> {
        let keys = keys(identity);
        self.host
            .acquire_background(move || Some(keys), roots())
            .await
            .expect("background acquire")
    }

    async fn release(&self, holder: NodeHolder) -> ReleaseOutcome {
        self.host.release(holder, BUDGET).await
    }
}

// ── Rule 2: the app always gets a node ───────────────────────────────────────────────────────────

#[tokio::test]
async fn an_app_acquire_on_an_empty_host_builds_and_does_not_start() {
    let rig = rig();
    let (node, outcome) = rig.app("alice").await;
    assert_eq!(outcome, AcquireOutcome::Built);
    assert_eq!(node.identity, b"alice");
    assert_eq!(node.started(), None, "the app starts the node itself, with its own settings");
    let snapshot = rig.host.snapshot();
    assert!(snapshot.has_node);
    assert_eq!(snapshot.app_leases, 1);
    assert!(!snapshot.background);
    assert_eq!(snapshot.builds, 1);
}

#[tokio::test]
async fn a_second_app_acquire_for_the_same_identity_adopts() {
    let rig = rig();
    let (first, _) = rig.app("alice").await;
    let (second, outcome) = rig.app("alice").await;
    assert_eq!(outcome, AcquireOutcome::Adopted);
    assert!(Arc::ptr_eq(&first, &second), "adoption must hand over the SAME node");
    let snapshot = rig.host.snapshot();
    assert_eq!(snapshot.app_leases, 2);
    assert_eq!(snapshot.builds, 1);
    assert_eq!(snapshot.adoptions, 1);
}

#[tokio::test]
async fn an_app_acquire_with_no_identity_adopts_whatever_is_live() {
    // A reinstall on iOS: the keychain kept the identity the background runtime built from, the
    // app's secure store did not. The app adopts that node and learns its keys from it.
    let rig = rig();
    let (built, _) = rig.background("alice").await.expect("keys available");
    let (adopted, outcome) = rig
        .host
        .acquire_app(NodeKeys::default(), roots(), BUDGET)
        .await
        .unwrap();
    assert_eq!(outcome, AcquireOutcome::Adopted);
    assert!(Arc::ptr_eq(&built, &adopted));
    assert_eq!(rig.host.snapshot().builds, 1);
}

#[tokio::test]
async fn an_app_acquire_with_no_identity_on_an_empty_host_mints_one() {
    let rig = rig();
    let (node, outcome) = rig
        .host
        .acquire_app(NodeKeys::default(), roots(), BUDGET)
        .await
        .unwrap();
    assert_eq!(outcome, AcquireOutcome::Built);
    assert_eq!(node.identity, b"fresh-1");
}

#[tokio::test]
async fn a_different_identity_replaces_the_live_node_after_it_has_shut_down() {
    let rig = rig();
    let (old, _) = rig.background("alice").await.unwrap();
    let generation = rig.host.generation();

    let (new, outcome) = rig.app("bob").await;
    assert_eq!(outcome, AcquireOutcome::Replaced);
    assert!(old.is_shut(), "the old identity's node must be shut down");
    assert_eq!(new.identity, b"bob");
    assert!(
        rig.host.generation() > generation,
        "a replaced node is a different answer from `current`"
    );
    assert_eq!(
        rig.ledger.max_live(),
        1,
        "the new node is built only once the old one is gone"
    );
    let events = rig.ledger.events();
    let shut = events.iter().position(|e| e == "shut:1").unwrap();
    let built = events.iter().position(|e| e.starts_with("build:2")).unwrap();
    assert!(shut < built, "shutdown must finish before the build: {events:?}");

    // The background lease was not the app's to take: it now refers to the new node.
    let snapshot = rig.host.snapshot();
    assert!(snapshot.background);
    assert_eq!(snapshot.replacements, 1);
    let (adopted, outcome) = rig.background("alice").await.unwrap();
    assert_eq!(outcome, AcquireOutcome::Adopted);
    assert!(Arc::ptr_eq(&adopted, &new));
}

#[tokio::test]
async fn different_storage_roots_are_not_adoptable() {
    let rig = rig();
    let (old, _) = rig.app("alice").await;
    let elsewhere = NodeRoots {
        data: "other/cache".into(),
        state: "other/files".into(),
    };
    let (new, outcome) = rig
        .host
        .acquire_app(keys("alice"), elsewhere, BUDGET)
        .await
        .unwrap();
    assert_eq!(outcome, AcquireOutcome::Replaced);
    assert!(old.is_shut());
    assert!(!Arc::ptr_eq(&old, &new));
    assert_eq!(rig.host.snapshot().app_leases, 2, "both acquires hold a lease");
}

#[tokio::test]
async fn a_failed_build_takes_no_lease() {
    let rig = rig();
    rig.behaviour.build_fails.store(true, Ordering::SeqCst);
    let err = rig
        .host
        .acquire_app(keys("alice"), roots(), BUDGET)
        .await
        .expect_err("the build fails");
    assert!(matches!(err, LocationError::Crypto(_)));
    let snapshot = rig.host.snapshot();
    assert_eq!(snapshot.app_leases, 0);
    assert!(!snapshot.has_node);
    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::NotHeld);
}

// ── Rule 3: the background runtime never builds over anyone ─────────────────────────────────────

#[tokio::test]
async fn the_background_runtime_adopts_the_apps_node() {
    // The 2026-10-03 incident, at the level of the contract: the app has a node it has not started
    // yet, and the background runtime arrives. It must not build a second one.
    let rig = rig();
    let (app, _) = rig.app("alice").await;
    let (background, outcome) = rig.background("alice").await.unwrap();
    assert_eq!(outcome, AcquireOutcome::Adopted);
    assert!(Arc::ptr_eq(&app, &background));
    assert_eq!(rig.host.snapshot().builds, 1);
    assert_eq!(rig.ledger.max_live(), 1);
}

#[tokio::test]
async fn the_background_runtime_adopts_a_node_whatever_identity_it_holds() {
    // The keystore mirror is written after `createNode`, so it can briefly hold an older identity
    // than the app is running. The node the app runs is the one to publish through.
    let rig = rig();
    let (app, _) = rig.app("alice").await;
    let (background, outcome) = rig.background("someone-else").await.unwrap();
    assert_eq!(outcome, AcquireOutcome::Adopted);
    assert!(Arc::ptr_eq(&app, &background));
}

#[tokio::test]
async fn the_background_runtime_reads_no_keys_when_a_node_is_live() {
    let rig = rig();
    rig.app("alice").await;
    let acquired = rig
        .host
        .acquire_background(
            || panic!("a live node must not cost a keystore read"),
            roots(),
        )
        .await
        .unwrap();
    assert!(acquired.is_some());
}

#[tokio::test]
async fn the_background_runtime_never_mints_an_identity() {
    let rig = rig();
    let acquired = rig
        .host
        .acquire_background(|| None, roots())
        .await
        .unwrap();
    assert!(acquired.is_none(), "no keys and no node is `None`, not a new identity");
    let snapshot = rig.host.snapshot();
    assert_eq!(snapshot.builds, 0);
    assert!(!snapshot.background, "no lease is taken when there is nothing to hold");
}

#[tokio::test]
async fn the_background_runtime_builds_from_its_keys_when_nothing_is_live() {
    let rig = rig();
    let (node, outcome) = rig.background("alice").await.unwrap();
    assert_eq!(outcome, AcquireOutcome::Built);
    assert_eq!(node.identity, b"alice");
    assert_eq!(node.recv, b"alice-recv");
    assert_eq!(node.started().as_deref(), Some("stored"));
}

#[tokio::test]
async fn the_background_lease_is_a_flag_not_a_count() {
    // Every capture acquires. A count would need a matching release per capture, and one missed
    // release would keep the node up forever.
    let rig = rig();
    for _ in 0..5 {
        rig.background("alice").await.unwrap();
    }
    let snapshot = rig.host.snapshot();
    assert!(snapshot.background);
    assert_eq!(snapshot.adoptions, 0, "re-acquiring its own lease is not an adoption");
    assert_eq!(rig.release(NodeHolder::Background).await, ReleaseOutcome::ShutDown);
}

// ── Rule 4: who starts the node, with which settings ─────────────────────────────────────────────

#[tokio::test]
async fn the_background_runtime_starts_an_unstarted_app_node_from_the_stored_settings() {
    let rig = rig();
    let (node, _) = rig.app("alice").await;
    rig.background("alice").await.unwrap();
    assert_eq!(node.started().as_deref(), Some("stored"));
    // ...and the app's own start, arriving later, is the idempotent no-op it always was — not the
    // `AlreadyOpen` that cost 13.7 hours.
    node.start(config("app")).await.unwrap();
    assert_eq!(node.started().as_deref(), Some("stored"));
}

#[tokio::test]
async fn the_background_runtime_leaves_a_started_app_node_alone() {
    let rig = rig();
    let (node, _) = rig.app("alice").await;
    node.start(config("app")).await.unwrap();
    rig.background("alice").await.unwrap();
    assert_eq!(node.started().as_deref(), Some("explicit:app"));
}

#[tokio::test]
async fn a_failed_stored_start_keeps_the_lease_and_the_next_acquire_retries_it() {
    let rig = rig();
    rig.behaviour.start_stored_fails.store(true, Ordering::SeqCst);
    let err = rig
        .host
        .acquire_background(|| Some(keys("alice")), roots())
        .await
        .expect_err("the start fails");
    assert!(matches!(err, LocationError::Network(_)));
    let snapshot = rig.host.snapshot();
    assert!(snapshot.background, "the node exists and is ours to retry");
    assert!(snapshot.has_node);

    rig.behaviour.start_stored_fails.store(false, Ordering::SeqCst);
    let (node, outcome) = rig.background("alice").await.unwrap();
    assert_eq!(outcome, AcquireOutcome::Adopted);
    assert_eq!(node.started().as_deref(), Some("stored"));
    assert_eq!(rig.host.snapshot().builds, 1, "the retry reuses the node");
}

// ── Rules 5 and 6: releasing ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn releasing_what_is_not_held_changes_nothing() {
    let rig = rig();
    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::NotHeld);
    assert_eq!(rig.release(NodeHolder::Background).await, ReleaseOutcome::NotHeld);

    rig.background("alice").await.unwrap();
    let before = rig.host.snapshot();
    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::NotHeld);
    assert_eq!(rig.host.snapshot(), before);

    let app_only = self::rig();
    app_only.app("alice").await;
    let before = app_only.host.snapshot();
    assert_eq!(app_only.release(NodeHolder::Background).await, ReleaseOutcome::NotHeld);
    assert_eq!(app_only.host.snapshot(), before);
}

#[tokio::test]
async fn the_last_holder_out_shuts_the_node_down() {
    let rig = rig();
    let (node, _) = rig.app("alice").await;
    rig.app("alice").await;
    let generation = rig.host.generation();

    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::StillHeld);
    assert!(!node.is_shut());
    assert_eq!(rig.host.generation(), generation, "nothing `current` answers changed");

    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::ShutDown);
    assert!(node.is_shut());
    assert!(rig.host.current().is_none());
    assert!(rig.host.generation() > generation);
    let snapshot = rig.host.snapshot();
    assert!(!snapshot.has_node);
    assert_eq!(snapshot.shutdowns, 1);
    assert_eq!(rig.ledger.live(), 0);
}

#[tokio::test]
async fn an_app_letting_go_while_the_background_runtime_holds_detaches_and_keeps_running() {
    let rig = rig();
    let (node, _) = rig.app("alice").await;
    rig.background("alice").await.unwrap();

    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::StillHeld);
    assert!(!node.is_shut(), "the background runtime still publishes through it");
    assert_eq!(node.detaches(), 1, "the app's listeners point into a dying JS context");

    assert_eq!(rig.release(NodeHolder::Background).await, ReleaseOutcome::ShutDown);
    assert!(node.is_shut());
}

#[tokio::test]
async fn one_app_context_of_several_letting_go_does_not_detach() {
    let rig = rig();
    let (node, _) = rig.app("alice").await;
    rig.app("alice").await;
    rig.background("alice").await.unwrap();
    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::StillHeld);
    assert_eq!(node.detaches(), 0, "another JS context is still listening");
}

#[tokio::test]
async fn the_background_runtime_letting_go_never_detaches_the_app() {
    let rig = rig();
    let (node, _) = rig.app("alice").await;
    rig.background("alice").await.unwrap();
    assert_eq!(rig.release(NodeHolder::Background).await, ReleaseOutcome::StillHeld);
    assert_eq!(node.detaches(), 0);
    assert!(!node.is_shut());
}

#[tokio::test]
async fn a_failed_shutdown_still_forgets_the_node_and_says_so() {
    let rig = rig();
    rig.behaviour.set_shutdown(ShutdownMode::Fails);
    rig.app("alice").await;
    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::ShutdownFailed);
    let snapshot = rig.host.snapshot();
    assert!(!snapshot.has_node);
    assert_eq!(snapshot.shutdown_failures, 1);
    assert_eq!(snapshot.shutdowns, 0);
}

#[tokio::test]
async fn a_shutdown_that_never_returns_is_bounded_and_counted() {
    let rig = rig();
    rig.behaviour.set_shutdown(ShutdownMode::Hangs);
    rig.app("alice").await;
    let started = Instant::now();
    let outcome = rig
        .host
        .release(NodeHolder::App, Duration::from_millis(50))
        .await;
    assert_eq!(outcome, ReleaseOutcome::ShutdownTimedOut);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the release must return at its budget, not when the shutdown does"
    );
    let snapshot = rig.host.snapshot();
    assert!(!snapshot.has_node, "a hung node is forgotten, not handed out again");
    assert_eq!(snapshot.shutdown_timeouts, 1);

    // The host is still usable. The one place two nodes can coexist is here, and it is counted.
    rig.behaviour.set_shutdown(ShutdownMode::Clean);
    let (node, outcome) = rig.app("alice").await;
    assert_eq!(outcome, AcquireOutcome::Built);
    assert_eq!(node.id, 2);
    assert_eq!(rig.ledger.max_live(), 2);
}

#[tokio::test]
async fn a_timed_out_shutdown_keeps_running_to_completion() {
    // Abandoning the WAIT must not abandon the shutdown: half a `LocationNode::shutdown` leaves
    // the claims it had not reached yet held for the life of the process.
    let rig = rig();
    rig.behaviour.set_shutdown(ShutdownMode::Slow(150));
    let (node, _) = rig.app("alice").await;
    let outcome = rig
        .host
        .release(NodeHolder::App, Duration::from_millis(20))
        .await;
    assert_eq!(outcome, ReleaseOutcome::ShutdownTimedOut);
    assert!(!node.is_shut());
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(node.is_shut(), "the shutdown finished on its own task");
}

#[tokio::test]
async fn a_release_with_no_node_left_is_released() {
    // Reachable only through a restart whose rebuild failed: the leases outlive the node.
    let rig = rig();
    rig.app("alice").await;
    rig.behaviour.build_fails.store(true, Ordering::SeqCst);
    rig.host
        .restart(config("new"), BUDGET)
        .await
        .expect_err("the rebuild fails");
    let snapshot = rig.host.snapshot();
    assert!(!snapshot.has_node);
    assert_eq!(snapshot.app_leases, 1, "the lease is not the restart's to drop");
    assert_eq!(rig.release(NodeHolder::App).await, ReleaseOutcome::Released);
}

#[tokio::test]
async fn after_a_failed_rebuild_the_next_acquire_builds_again() {
    let rig = rig();
    rig.app("alice").await;
    rig.behaviour.build_fails.store(true, Ordering::SeqCst);
    let _ = rig.host.restart(config("new"), BUDGET).await;
    rig.behaviour.build_fails.store(false, Ordering::SeqCst);
    let (node, outcome) = rig.background("alice").await.unwrap();
    assert_eq!(outcome, AcquireOutcome::Built);
    assert_eq!(node.identity, b"alice");
}

// ── Rule 1: one node at a time, under concurrency ────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_acquires_on_an_empty_host_build_exactly_once() {
    for _ in 0..50 {
        let rig = rig();
        let host_a = rig.host.clone();
        let host_b = rig.host.clone();
        let app = tokio::spawn(async move {
            host_a
                .acquire_app(keys("alice"), roots(), BUDGET)
                .await
                .unwrap()
                .0
        });
        let background = tokio::spawn(async move {
            host_b
                .acquire_background(|| Some(keys("alice")), roots())
                .await
                .unwrap()
                .unwrap()
                .0
        });
        let (app, background) = (app.await.unwrap(), background.await.unwrap());
        assert!(Arc::ptr_eq(&app, &background), "both sides must get the same node");
        assert_eq!(rig.host.snapshot().builds, 1);
        assert_eq!(rig.ledger.max_live(), 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_is_never_built_while_its_predecessor_is_shutting_down() {
    let rig = rig();
    rig.behaviour.set_shutdown(ShutdownMode::Slow(200));
    rig.app("alice").await;

    let host = rig.host.clone();
    let release = tokio::spawn(async move { host.release(NodeHolder::App, BUDGET).await });
    // Wait until the shutdown is in flight, then ask for a node.
    while !rig.ledger.events().iter().any(|e| e == "shutdown-begin:1") {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let (node, outcome) = rig.app("alice").await;

    assert_eq!(release.await.unwrap(), ReleaseOutcome::ShutDown);
    assert_eq!(outcome, AcquireOutcome::Built);
    assert_eq!(node.id, 2);
    assert_eq!(
        rig.ledger.max_live(),
        1,
        "the new node waited for the old one's claims: {:?}",
        rig.ledger.events()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_contexts_coming_and_going_never_leave_two_nodes() {
    // A mounted app, headless JS sessions and the background runtime, all at once, many times.
    let rig = rig();
    rig.behaviour.set_shutdown(ShutdownMode::Slow(2));
    let mut tasks = Vec::new();
    for i in 0..40u32 {
        let host = rig.host.clone();
        tasks.push(tokio::spawn(async move {
            if i % 3 == 0 {
                host.acquire_background(|| Some(keys("alice")), roots())
                    .await
                    .unwrap();
                tokio::task::yield_now().await;
                host.release(NodeHolder::Background, BUDGET).await;
            } else {
                host.acquire_app(keys("alice"), roots(), BUDGET)
                    .await
                    .unwrap();
                tokio::task::yield_now().await;
                host.release(NodeHolder::App, BUDGET).await;
            }
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let snapshot = rig.host.snapshot();
    assert_eq!(snapshot.app_leases, 0);
    assert!(!snapshot.background);
    assert!(!snapshot.has_node, "everyone left, so the node is gone");
    assert_eq!(rig.ledger.live(), 0);
    assert_eq!(rig.ledger.max_live(), 1, "{:?}", rig.ledger.events());
    assert_eq!(snapshot.builds, snapshot.shutdowns, "every node built was shut down");
}

// ── Restart ──────────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_restart_rebuilds_the_same_identity_and_starts_it_with_the_new_settings() {
    let rig = rig();
    let (old, _) = rig.app("alice").await;
    old.start(config("old")).await.unwrap();
    rig.background("alice").await.unwrap();
    let generation = rig.host.generation();

    let new = rig.host.restart(config("new"), BUDGET).await.unwrap();
    assert!(old.is_shut());
    assert!(!Arc::ptr_eq(&old, &new));
    assert_eq!(new.identity, old.identity);
    assert_eq!(new.recv, old.recv);
    assert_eq!(new.started().as_deref(), Some("explicit:new"));
    assert!(Arc::ptr_eq(&rig.host.current().unwrap(), &new));
    assert!(rig.host.generation() > generation);
    let snapshot = rig.host.snapshot();
    assert_eq!(snapshot.app_leases, 1, "a restart keeps every lease");
    assert!(snapshot.background);
    assert_eq!(snapshot.restarts, 1);
    assert_eq!(rig.ledger.max_live(), 1);
}

#[tokio::test]
async fn a_restart_with_no_node_is_not_started() {
    let rig = rig();
    let err = rig
        .host
        .restart(config("new"), BUDGET)
        .await
        .expect_err("nothing to restart");
    assert!(matches!(err, LocationError::NotStarted));
    assert_eq!(rig.host.snapshot().restarts, 0);
}

#[tokio::test]
async fn a_restart_whose_start_fails_keeps_the_new_node_for_the_next_start() {
    let rig = rig();
    rig.app("alice").await;
    rig.behaviour.start_fails.store(true, Ordering::SeqCst);
    rig.host
        .restart(config("new"), BUDGET)
        .await
        .expect_err("the start fails");
    let current = rig.host.current().expect("the rebuilt node is kept");
    assert_eq!(current.id, 2);
    assert_eq!(current.started(), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_background_runtime_cannot_start_a_restarted_node_with_the_old_settings() {
    // At the moment of a settings change the STORED settings are the old ones. If the background
    // runtime got to the new node first, its `start_stored` would win and the change would be lost.
    let rig = rig();
    rig.behaviour.set_shutdown(ShutdownMode::Slow(100));
    rig.app("alice").await;
    rig.background("alice").await.unwrap();

    let host = rig.host.clone();
    let restart = tokio::spawn(async move { host.restart(config("new"), BUDGET).await });
    while !rig.ledger.events().iter().any(|e| e == "shutdown-begin:1") {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let (during, _) = rig.background("alice").await.unwrap();
    let restarted = restart.await.unwrap().unwrap();

    assert!(Arc::ptr_eq(&during, &restarted), "it waited for, then adopted, the new node");
    assert_eq!(restarted.started().as_deref(), Some("explicit:new"));
}

// ── Rule 7: generation ───────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn adoption_and_lease_changes_do_not_move_the_generation() {
    let rig = rig();
    rig.app("alice").await;
    let generation = rig.host.generation();
    rig.app("alice").await;
    rig.background("alice").await.unwrap();
    rig.release(NodeHolder::App).await;
    rig.release(NodeHolder::Background).await;
    assert_eq!(rig.host.generation(), generation);
}

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn node_keys_never_print_their_secrets() {
    let printed = format!("{:?}", keys("hunter2"));
    assert!(!printed.contains("hunter2"), "{printed}");
    assert!(printed.contains("redacted"));
}

#[test]
fn the_process_host_is_one_host() {
    assert!(Arc::ptr_eq(&node_host(), &node_host()));
    assert!(!Arc::ptr_eq(&node_host(), &NodeHost::isolated()));
}

// ── Exhaustive: every sequence of operations a phone can produce ────────────────────────────────

#[derive(Debug, Clone, Copy)]
enum Op {
    /// The app acquires as `alice`.
    AppAlice,
    /// The app acquires as `bob` — an identity change.
    AppBob,
    /// The app acquires with no stored identity.
    AppFresh,
    /// The background runtime acquires, with `alice`'s keys in the keystore.
    Background,
    /// The background runtime acquires on a fresh install: no keys.
    BackgroundNoKeys,
    ReleaseApp,
    ReleaseBackground,
    Restart,
}

const OPS: [Op; 8] = [
    Op::AppAlice,
    Op::AppBob,
    Op::AppFresh,
    Op::Background,
    Op::BackgroundNoKeys,
    Op::ReleaseApp,
    Op::ReleaseBackground,
    Op::Restart,
];

/// What a correct host does, written as plainly as possible.
#[derive(Debug, Clone, Default)]
struct Model {
    /// (node id, identity) — ids count builds, exactly as the fake factory does.
    node: Option<(u64, Vec<u8>)>,
    app: u32,
    background: bool,
    builds: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Expect {
    Acquired(AcquireOutcome),
    NoNode,
    Release(ReleaseOutcome),
    Restarted,
    NotStarted,
}

impl Model {
    fn build(&mut self, identity: Option<&[u8]>) {
        self.builds += 1;
        let id = self.builds;
        let identity = identity
            .map(<[u8]>::to_vec)
            .unwrap_or_else(|| format!("fresh-{id}").into_bytes());
        self.node = Some((id, identity));
    }

    fn app(&mut self, identity: Option<&[u8]>) -> Expect {
        self.app += 1;
        let adoptable = self.node.as_ref().map(|(_, live)| {
            identity.map_or(true, |id| id == live.as_slice())
        });
        match adoptable {
            Some(true) => Expect::Acquired(AcquireOutcome::Adopted),
            Some(false) => {
                self.build(identity);
                Expect::Acquired(AcquireOutcome::Replaced)
            }
            None => {
                self.build(identity);
                Expect::Acquired(AcquireOutcome::Built)
            }
        }
    }

    fn background(&mut self, keys: bool) -> Expect {
        if self.node.is_some() {
            self.background = true;
            return Expect::Acquired(AcquireOutcome::Adopted);
        }
        if !keys {
            return Expect::NoNode;
        }
        self.build(Some(b"alice"));
        self.background = true;
        Expect::Acquired(AcquireOutcome::Built)
    }

    fn release(&mut self, holder: NodeHolder) -> Expect {
        match holder {
            NodeHolder::App if self.app == 0 => return Expect::Release(ReleaseOutcome::NotHeld),
            NodeHolder::App => self.app -= 1,
            NodeHolder::Background if !self.background => {
                return Expect::Release(ReleaseOutcome::NotHeld)
            }
            NodeHolder::Background => self.background = false,
        }
        if self.app == 0 && !self.background {
            Expect::Release(match self.node.take() {
                Some(_) => ReleaseOutcome::ShutDown,
                None => ReleaseOutcome::Released,
            })
        } else {
            Expect::Release(ReleaseOutcome::StillHeld)
        }
    }

    fn restart(&mut self) -> Expect {
        match self.node.clone() {
            None => Expect::NotStarted,
            Some((_, identity)) => {
                self.build(Some(&identity));
                Expect::Restarted
            }
        }
    }
}

async fn apply(rig: &Rig, op: Op) -> Expect {
    match op {
        Op::AppAlice | Op::AppBob | Op::AppFresh => {
            let keys = match op {
                Op::AppAlice => keys("alice"),
                Op::AppBob => keys("bob"),
                _ => NodeKeys::default(),
            };
            let (_, outcome) = rig.host.acquire_app(keys, roots(), BUDGET).await.unwrap();
            Expect::Acquired(outcome)
        }
        Op::Background | Op::BackgroundNoKeys => {
            let with_keys = matches!(op, Op::Background);
            match rig
                .host
                .acquire_background(move || with_keys.then(|| keys("alice")), roots())
                .await
                .unwrap()
            {
                Some((_, outcome)) => Expect::Acquired(outcome),
                None => Expect::NoNode,
            }
        }
        Op::ReleaseApp => Expect::Release(rig.host.release(NodeHolder::App, BUDGET).await),
        Op::ReleaseBackground => {
            Expect::Release(rig.host.release(NodeHolder::Background, BUDGET).await)
        }
        Op::Restart => match rig.host.restart(config("restart"), BUDGET).await {
            Ok(_) => Expect::Restarted,
            Err(LocationError::NotStarted) => Expect::NotStarted,
            Err(other) => panic!("unexpected restart error: {other}"),
        },
    }
}

fn expected(model: &mut Model, op: Op) -> Expect {
    match op {
        Op::AppAlice => model.app(Some(b"alice")),
        Op::AppBob => model.app(Some(b"bob")),
        Op::AppFresh => model.app(None),
        Op::Background => model.background(true),
        Op::BackgroundNoKeys => model.background(false),
        Op::ReleaseApp => model.release(NodeHolder::App),
        Op::ReleaseBackground => model.release(NodeHolder::Background),
        Op::Restart => model.restart(),
    }
}

async fn check_sequence(sequence: &[Op]) {
    let rig = rig();
    let mut model = Model::default();
    let mut last_generation = rig.host.generation();
    let mut last_current: Option<u64> = None;
    for (step, op) in sequence.iter().enumerate() {
        let want = expected(&mut model, *op);
        let got = apply(&rig, *op).await;
        let context = || format!("sequence {sequence:?}, step {step} ({op:?})");
        assert_eq!(got, want, "outcome: {}", context());

        let snapshot = rig.host.snapshot();
        let current = rig.host.current();
        assert_eq!(snapshot.app_leases, model.app, "app leases: {}", context());
        assert_eq!(snapshot.background, model.background, "background: {}", context());
        assert_eq!(snapshot.builds, model.builds, "builds: {}", context());
        assert_eq!(
            current.as_ref().map(|n| (n.id, n.identity.clone())),
            model.node.clone(),
            "current node: {}",
            context()
        );
        assert_eq!(snapshot.has_node, current.is_some(), "{}", context());
        // Rule 1.
        assert!(rig.ledger.max_live() <= 1, "two nodes alive: {}", context());
        assert_eq!(
            rig.ledger.live(),
            usize::from(current.is_some()),
            "a node alive that the host does not know about: {}",
            context()
        );
        // Nobody holds the node ⇒ there is no node.
        if model.app == 0 && !model.background {
            assert!(current.is_none(), "an unheld node survived: {}", context());
        }
        // Rule 7, both directions.
        let current_id = current.as_ref().map(|n| n.id);
        let generation = rig.host.generation();
        if current_id != last_current {
            assert!(generation > last_generation, "node changed, generation did not: {}", context());
        }
        assert!(generation >= last_generation, "generation went backwards: {}", context());
        last_generation = generation;
        last_current = current_id;
        // A started node is started from the right place: a restart's from its explicit settings.
        if matches!(op, Op::Restart) && want == Expect::Restarted {
            assert_eq!(
                current.unwrap().started().as_deref(),
                Some("explicit:restart"),
                "{}",
                context()
            );
        }
        if matches!(op, Op::Background) {
            assert!(
                rig.host.current().unwrap().started().is_some(),
                "the background runtime's node must be started: {}",
                context()
            );
        }
    }
}

#[test]
fn every_sequence_of_five_operations_keeps_the_contract() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mut sequences = 0u64;
    let mut sequence = Vec::with_capacity(5);
    fn walk(
        runtime: &tokio::runtime::Runtime,
        sequence: &mut Vec<Op>,
        depth: usize,
        count: &mut u64,
    ) {
        if !sequence.is_empty() {
            runtime.block_on(check_sequence(sequence));
            *count += 1;
        }
        if depth == 0 {
            return;
        }
        for op in OPS {
            sequence.push(op);
            walk(runtime, sequence, depth - 1, count);
            sequence.pop();
        }
    }
    walk(&runtime, &mut sequence, 5, &mut sequences);
    // 8 + 8² + … + 8⁵: proof the walk ran, rather than vacuously passing.
    assert_eq!(sequences, 8 + 64 + 512 + 4096 + 32768);
}
