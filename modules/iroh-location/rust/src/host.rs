//! The one owner of this process's [`LocationNode`].
//!
//! # Why this exists
//!
//! A phone runs two things that need the node: the mounted app (one or more JS contexts, through
//! the Expo module) and the native background runtime (`BackgroundLocationRuntime` on iOS,
//! `NativeBackgroundRuntime` on Android), which publishes when no JS is alive. They used to build a
//! node EACH, and the Rust stores take a process-wide writer claim (`durable.rs`), so whichever
//! asked second was refused. Everything that then went wrong went wrong in the gap between those
//! two nodes:
//!
//! - 2026-09-16: the background runtime built a node on every delivery just to be refused —
//!   187 constructions in a minute, a CPU exception, and a phone iOS stopped waking.
//! - 2026-09-29 / 2026-10-03: the background runtime took the free stores in the seconds between
//!   the app's `createNode` and its `start()`. The app's start was refused, its single retry was
//!   refused identically, `init()` rejected, and a Pixel 10 spent 13.7 hours unable to pair.
//! - The cures were three hand-written copies of the same rules — a sink gate, a claim backoff and
//!   a "handover" that shut one node down so the other could start — in Swift, Kotlin and JS, with
//!   no tests on the two platform copies. Android simply did not have the handover.
//!
//! Two nodes cannot be made to agree reliably. One node cannot disagree with itself. So there is
//! exactly one node per process, and this is the only thing that builds it: the app and the
//! background runtime each take a LEASE on it, and it is shut down when the last lease goes.
//!
//! # The contract
//!
//! Every rule here is a test in this file or in `tests/node_host.rs`.
//!
//! 1. **At most one node is alive.** A new node is built only after the previous one's shutdown has
//!    finished — or its budget has run out, which is the one way a second node can coexist with a
//!    first, and is counted (`shutdown_timeouts`) because it means the claims may still be held.
//! 2. **The app always gets a node.** [`Host::acquire_app`] adopts the live node when the identity
//!    and storage match, and otherwise REPLACES it: running the app as the wrong device is worse
//!    than a rebuild. It never refuses because someone else holds the node.
//! 3. **The background runtime never builds over anyone.** [`Host::acquire_background`] adopts any
//!    live node, whoever built it; it builds only when there is none, and only from key material
//!    the platform already holds (a fresh install has none and gets `None`, not a new identity).
//! 4. **The app starts the node with its settings; the background runtime with the stored ones.**
//!    `start` is idempotent, so whichever comes first wins — and both read the same settings, since
//!    the app mirrors its own into the store on every launch. [`Host::restart`], which is how a
//!    settings change takes effect, starts the new node while still holding the transition lock, so
//!    nothing can start it first with the old ones.
//! 5. **A lease is released exactly once.** Releasing what is not held changes nothing and says so.
//! 6. **The last holder out shuts the node down, bounded.** When the app lets go and the background
//!    runtime still holds the node, it keeps running and the app's listeners are detached instead —
//!    they point into a JS context that is going away.
//! 7. **`generation` changes exactly when [`Host::current`] would answer differently.** Platform
//!    code caches its handle by generation and must never hold one across a change.
//!
//! # The shape
//!
//! [`Host`] is generic over two ports, [`NodeFactory`] and [`HostedNode`], for the reason
//! `publish.rs` gives for `DrainEngine`: the orchestration is the part worth testing, and "the
//! shutdown never returned" is a real outcome that a real node can only produce by accident. The
//! FFI type, [`NodeHost`], binds it to [`LocationNode`] and adds nothing but argument conversion.

use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use tracing::Instrument;

use crate::transport::TransportConfig;
use crate::{DeviceSecrets, LocationError, LocationNode, NodeDirs};

/// Who holds a lease on the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum NodeHolder {
    /// A JS context in the mounted app (or a headless one). Counted: there can be several.
    App,
    /// The native background runtime. A flag: there is one per process.
    Background,
}

impl NodeHolder {
    fn as_str(self) -> &'static str {
        match self {
            NodeHolder::App => "app",
            NodeHolder::Background => "background",
        }
    }
}

/// What a [`Host::release`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ReleaseOutcome {
    /// This holder had no lease. Nothing changed.
    NotHeld,
    /// Released; another holder still has the node, so it keeps running.
    StillHeld,
    /// Released by the last holder, and there was no node to shut down.
    Released,
    /// Last holder out: the node shut down inside the budget.
    ShutDown,
    /// Last holder out: the shutdown finished, but reported an error. The claims are released
    /// either way (`LocationNode::shutdown` clears every store before it returns the error).
    ShutdownFailed,
    /// Last holder out: the shutdown did not finish inside the budget. It keeps running in the
    /// background and the host has forgotten the node; until it finishes, the stores may still be
    /// claimed, so a node built meanwhile may be refused its `start`.
    ShutdownTimedOut,
}

impl ReleaseOutcome {
    fn as_str(self) -> &'static str {
        match self {
            ReleaseOutcome::NotHeld => "not-held",
            ReleaseOutcome::StillHeld => "still-held",
            ReleaseOutcome::Released => "released",
            ReleaseOutcome::ShutDown => "shut-down",
            ReleaseOutcome::ShutdownFailed => "shutdown-failed",
            ReleaseOutcome::ShutdownTimedOut => "shutdown-timed-out",
        }
    }
}

/// How an acquire got its node. Reported on the `node.host.acquire` span.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquireOutcome {
    /// The live node was handed over; nothing was built.
    Adopted,
    /// There was no node, so one was built.
    Built,
    /// The live node belonged to a different identity or storage, so it was shut down and a new
    /// one built in its place. App only.
    Replaced,
}

impl AcquireOutcome {
    fn as_str(self) -> &'static str {
        match self {
            AcquireOutcome::Adopted => "adopted",
            AcquireOutcome::Built => "built",
            AcquireOutcome::Replaced => "replaced",
        }
    }
}

/// Everything the host knows, for `device.health` and for tests.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct HostSnapshot {
    /// Bumped every time [`Host::current`] would answer differently.
    pub generation: u64,
    /// Whether there is a node at all. Not whether it is started — ask the node.
    pub has_node: bool,
    /// Live app leases (JS contexts that called `createNode` and have not called `shutdown`).
    pub app_leases: u32,
    /// Whether the native background runtime holds a lease.
    pub background: bool,
    /// Nodes this host has built.
    pub builds: u64,
    /// Acquires that adopted a live node instead of building one.
    pub adoptions: u64,
    /// App acquires that had to replace a node built for a different identity or storage.
    pub replacements: u64,
    /// Restarts (a settings change: shut down, rebuild, start with the new settings).
    pub restarts: u64,
    /// Shutdowns that finished cleanly inside their budget.
    pub shutdowns: u64,
    /// Shutdowns that finished with an error.
    pub shutdown_failures: u64,
    /// Shutdowns that were still running when their budget ran out.
    pub shutdown_timeouts: u64,
}

/// Key material a node is built from. `None` identity means "generate one" — the app's first
/// launch. The background runtime never passes `None`: see [`Host::acquire_background`].
#[derive(Clone, PartialEq, Eq, Default)]
pub struct NodeKeys {
    pub identity: Option<Vec<u8>>,
    pub recv: Option<Vec<u8>>,
}

impl fmt::Debug for NodeKeys {
    // Secrets. The derive would print them into any assertion message or log line that formats one.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NodeKeys")
            .field("identity", &self.identity.as_ref().map(|_| "<redacted>"))
            .field("recv", &self.recv.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// The two storage roots a node lives under. See [`LocationNode::new_at_dirs`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeRoots {
    pub data: String,
    pub state: String,
}

/// What the host needs from a node.
pub trait HostedNode: Send + Sync + 'static {
    /// The identity this node runs as. Compared on adoption, and reused on [`Host::restart`].
    fn identity_secret(&self) -> Vec<u8>;
    /// The receiving secret, reused on [`Host::restart`].
    fn recv_secret(&self) -> Vec<u8>;
    /// Start from the settings the app last stored. Idempotent on a started node.
    fn start_stored(&self) -> impl Future<Output = Result<(), LocationError>> + Send;
    /// Start with explicit settings. Idempotent on a started node.
    fn start(
        &self,
        config: TransportConfig,
    ) -> impl Future<Output = Result<(), LocationError>> + Send;
    /// Stop, and release every store claim this node holds.
    fn shutdown(&self) -> impl Future<Output = Result<(), LocationError>> + Send;
    /// Stop surfacing events into the app, and keep running. See [`HostedNode`] callers in
    /// [`Host::release`].
    fn detach_app_listeners(&self) -> impl Future<Output = ()> + Send;
}

/// How the host builds a node.
pub trait NodeFactory: Send + Sync + 'static {
    type Node: HostedNode;
    fn build(&self, keys: &NodeKeys, roots: &NodeRoots) -> Result<Arc<Self::Node>, LocationError>;
}

struct Slot<N> {
    node: Arc<N>,
    roots: NodeRoots,
}

struct State<N> {
    slot: Option<Slot<N>>,
    app_leases: u32,
    background: bool,
    stats: HostSnapshot,
}

impl<N> State<N> {
    /// Change what [`Host::current`] answers. Every such change goes through here, which is what
    /// keeps rule 7 a property of the code rather than of every call site remembering it.
    fn set_slot(&mut self, slot: Option<Slot<N>>) {
        self.slot = slot;
        self.stats.generation += 1;
    }

    fn holders(&self) -> u32 {
        self.app_leases + u32::from(self.background)
    }
}

/// The lease arbiter. See the module docs for the contract.
pub struct Host<F: NodeFactory> {
    factory: F,
    /// Serializes every transition — build, replace, last-out shutdown, restart.
    ///
    /// Held across the bounded shutdown ON PURPOSE: a node built while its predecessor is still
    /// shutting down would be refused its `start` by claims the predecessor has not yet released,
    /// which is the failure this whole module exists to remove. The wait is bounded by the
    /// shutdown budget, so it is finite, and it is only ever paid by a transition.
    transitions: tokio::sync::Mutex<()>,
    /// Never held across an await.
    state: StdMutex<State<F::Node>>,
}

impl<F: NodeFactory> Host<F> {
    pub fn new(factory: F) -> Self {
        Self {
            factory,
            transitions: tokio::sync::Mutex::new(()),
            state: StdMutex::new(State {
                slot: None,
                app_leases: 0,
                background: false,
                stats: HostSnapshot::default(),
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State<F::Node>> {
        // A panic while holding this lock leaves counters, not invariants, half-updated: every
        // write below is a single assignment or a `set_slot`. Recover rather than poison the node
        // for the rest of the process.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The node, if there is one. Platform code caches this by [`Self::generation`].
    pub fn current(&self) -> Option<Arc<F::Node>> {
        self.state().slot.as_ref().map(|slot| slot.node.clone())
    }

    pub fn generation(&self) -> u64 {
        self.state().stats.generation
    }

    pub fn snapshot(&self) -> HostSnapshot {
        let state = self.state();
        HostSnapshot {
            has_node: state.slot.is_some(),
            app_leases: state.app_leases,
            background: state.background,
            ..state.stats.clone()
        }
    }

    /// Take an app lease: adopt the live node, or build one. Never starts it — the app does that,
    /// with its own settings. See rule 2.
    pub async fn acquire_app(
        &self,
        keys: NodeKeys,
        roots: NodeRoots,
        replace_budget: Duration,
    ) -> Result<(Arc<F::Node>, AcquireOutcome), LocationError> {
        let span = tracing::info_span!(
            "node.host.acquire",
            holder = "app",
            outcome = tracing::field::Empty,
            generation = tracing::field::Empty,
            app_leases = tracing::field::Empty,
            background = tracing::field::Empty,
            error = tracing::field::Empty,
        );
        async {
            let result = self.acquire_app_inner(keys, roots, replace_budget).await;
            self.record_acquire(&result.as_ref().map(|(_, outcome)| *outcome));
            result
        }
        .instrument(span)
        .await
    }

    async fn acquire_app_inner(
        &self,
        keys: NodeKeys,
        roots: NodeRoots,
        replace_budget: Duration,
    ) -> Result<(Arc<F::Node>, AcquireOutcome), LocationError> {
        let _transition = self.transitions.lock().await;
        let live = self
            .state()
            .slot
            .as_ref()
            .map(|slot| (slot.node.clone(), slot.roots.clone()));
        let mut outcome = AcquireOutcome::Built;
        if let Some((node, live_roots)) = live {
            // `None` means "whatever is stored", which is how the live node was built too.
            let same_identity = keys
                .identity
                .as_ref()
                .map_or(true, |identity| *identity == node.identity_secret());
            if same_identity && live_roots == roots {
                let mut state = self.state();
                state.app_leases += 1;
                state.stats.adoptions += 1;
                return Ok((node, AcquireOutcome::Adopted));
            }
            // A different device, or different storage: not adoptable. The app wins; whoever else
            // held the old node gets the new one on its next acquire.
            {
                let mut state = self.state();
                state.set_slot(None);
                state.stats.replacements += 1;
            }
            self.shutdown_bounded(node, replace_budget).await;
            outcome = AcquireOutcome::Replaced;
        }
        let node = self.factory.build(&keys, &roots)?;
        let mut state = self.state();
        state.set_slot(Some(Slot {
            node: node.clone(),
            roots,
        }));
        state.app_leases += 1;
        state.stats.builds += 1;
        Ok((node, outcome))
    }

    /// Take the background lease: adopt any live node, or build one from `keys`, then make sure it
    /// is started from the stored settings. `Ok(None)` when there is no node and no key material —
    /// a fresh install whose app has never run. See rule 3.
    ///
    /// `keys` is only called when a node has to be built, so a live node costs no keystore read.
    /// The lease is taken even if the start then fails: the node exists and is ours to retry, and
    /// the next call does exactly that.
    pub async fn acquire_background<K>(
        &self,
        keys: K,
        roots: NodeRoots,
    ) -> Result<Option<(Arc<F::Node>, AcquireOutcome)>, LocationError>
    where
        K: FnOnce() -> Option<NodeKeys> + Send,
    {
        let span = tracing::info_span!(
            "node.host.acquire",
            holder = "background",
            outcome = tracing::field::Empty,
            generation = tracing::field::Empty,
            app_leases = tracing::field::Empty,
            background = tracing::field::Empty,
            error = tracing::field::Empty,
        );
        async {
            let result = self.acquire_background_inner(keys, roots).await;
            match &result {
                Ok(Some((_, outcome))) => self.record_acquire(&Ok(*outcome)),
                Ok(None) => {
                    tracing::Span::current().record("outcome", "no-identity");
                }
                Err(err) => self.record_acquire(&Err(err)),
            }
            result
        }
        .instrument(span)
        .await
    }

    async fn acquire_background_inner<K>(
        &self,
        keys: K,
        roots: NodeRoots,
    ) -> Result<Option<(Arc<F::Node>, AcquireOutcome)>, LocationError>
    where
        K: FnOnce() -> Option<NodeKeys> + Send,
    {
        let (node, outcome) = {
            let _transition = self.transitions.lock().await;
            let live = self.current();
            let (node, outcome) = match live {
                Some(node) => (node, AcquireOutcome::Adopted),
                None => {
                    let Some(keys) = keys() else {
                        return Ok(None);
                    };
                    let node = self.factory.build(&keys, &roots)?;
                    let mut state = self.state();
                    state.set_slot(Some(Slot {
                        node: node.clone(),
                        roots,
                    }));
                    state.stats.builds += 1;
                    (node, AcquireOutcome::Built)
                }
            };
            let mut state = self.state();
            if !state.background {
                state.background = true;
                if outcome == AcquireOutcome::Adopted {
                    state.stats.adoptions += 1;
                }
            }
            (node, outcome)
        };
        // Outside the transition lock: a start awaits the endpoint bind and the BLE radio, which
        // the node bounds itself, and an app launch must not queue behind that. A shutdown that
        // lands meanwhile waits on the node's own `starting` lock and then takes the node down;
        // this caller's next acquire finds no node and builds afresh.
        node.start_stored().await?;
        Ok(Some((node, outcome)))
    }

    /// Return a lease. The last one out shuts the node down within `budget`. See rules 5 and 6.
    pub async fn release(&self, holder: NodeHolder, budget: Duration) -> ReleaseOutcome {
        let span = tracing::info_span!(
            "node.host.release",
            holder = holder.as_str(),
            outcome = tracing::field::Empty,
            generation = tracing::field::Empty,
            app_leases = tracing::field::Empty,
            background = tracing::field::Empty,
            waited_ms = tracing::field::Empty,
        );
        async {
            let started = Instant::now();
            let outcome = self.release_inner(holder, budget).await;
            let current = tracing::Span::current();
            current.record("outcome", outcome.as_str());
            current.record("waited_ms", started.elapsed().as_millis() as u64);
            self.record_state();
            outcome
        }
        .instrument(span)
        .await
    }

    async fn release_inner(&self, holder: NodeHolder, budget: Duration) -> ReleaseOutcome {
        enum Next<N> {
            Nothing,
            Detach(Arc<N>),
            ShutDown(Arc<N>),
        }
        let _transition = self.transitions.lock().await;
        let next = {
            let mut state = self.state();
            match holder {
                NodeHolder::App if state.app_leases == 0 => return ReleaseOutcome::NotHeld,
                NodeHolder::App => state.app_leases -= 1,
                NodeHolder::Background if !state.background => return ReleaseOutcome::NotHeld,
                NodeHolder::Background => state.background = false,
            }
            if state.holders() == 0 {
                match state.slot.take() {
                    Some(slot) => {
                        state.stats.generation += 1;
                        Next::ShutDown(slot.node)
                    }
                    None => return ReleaseOutcome::Released,
                }
            } else if holder == NodeHolder::App && state.app_leases == 0 {
                state
                    .slot
                    .as_ref()
                    .map_or(Next::Nothing, |slot| Next::Detach(slot.node.clone()))
            } else {
                Next::Nothing
            }
        };
        match next {
            Next::Nothing => ReleaseOutcome::StillHeld,
            Next::Detach(node) => {
                // Bounded like everything else on this path. A detach that does not finish leaves
                // events flowing into a JS context that is going away, which is noise, not harm.
                if tokio::time::timeout(budget, node.detach_app_listeners())
                    .await
                    .is_err()
                {
                    tracing::warn!("node.host: detaching the app's listeners did not finish");
                }
                ReleaseOutcome::StillHeld
            }
            Next::ShutDown(node) => self.shutdown_bounded(node, budget).await,
        }
    }

    /// Shut the node down and build it again with `config`, keeping every lease. How a change of
    /// transport settings (or a Bluetooth permission granted after construction) takes effect.
    ///
    /// The new node is started BEFORE the transition lock is released, so the background runtime
    /// cannot get in first and start it from the stored settings — which, at the moment of a
    /// settings change, are by definition the old ones.
    pub async fn restart(
        &self,
        config: TransportConfig,
        budget: Duration,
    ) -> Result<Arc<F::Node>, LocationError> {
        let span = tracing::info_span!(
            "node.host.restart",
            outcome = tracing::field::Empty,
            shutdown = tracing::field::Empty,
            generation = tracing::field::Empty,
            app_leases = tracing::field::Empty,
            background = tracing::field::Empty,
            error = tracing::field::Empty,
        );
        async {
            let result = self.restart_inner(config, budget).await;
            let current = tracing::Span::current();
            match &result {
                Ok(_) => {
                    current.record("outcome", "restarted");
                }
                Err(err) => {
                    current.record("outcome", "failed");
                    current.record("error", tracing::field::display(err));
                }
            }
            self.record_state();
            result
        }
        .instrument(span)
        .await
    }

    async fn restart_inner(
        &self,
        config: TransportConfig,
        budget: Duration,
    ) -> Result<Arc<F::Node>, LocationError> {
        let _transition = self.transitions.lock().await;
        let old = {
            let mut state = self.state();
            let Some(slot) = state.slot.take() else {
                return Err(LocationError::NotStarted);
            };
            state.stats.generation += 1;
            state.stats.restarts += 1;
            slot
        };
        let keys = NodeKeys {
            identity: Some(old.node.identity_secret()),
            recv: Some(old.node.recv_secret()),
        };
        let shutdown = self.shutdown_bounded(old.node, budget).await;
        tracing::Span::current().record("shutdown", shutdown.as_str());
        let node = self.factory.build(&keys, &old.roots)?;
        {
            let mut state = self.state();
            state.set_slot(Some(Slot {
                node: node.clone(),
                roots: old.roots,
            }));
            state.stats.builds += 1;
        }
        node.start(config).await?;
        Ok(node)
    }

    /// Shut `node` down on its own task and wait at most `budget` for it.
    ///
    /// Spawned rather than awaited in place so that running out of budget abandons the WAIT, not
    /// the shutdown: dropping a half-finished `LocationNode::shutdown` would leave whichever claims
    /// it had not reached yet held for good. AGENTS.md: never await native teardown unbounded.
    async fn shutdown_bounded(&self, node: Arc<F::Node>, budget: Duration) -> ReleaseOutcome {
        let task = tokio::spawn(async move { node.shutdown().await });
        let outcome = match tokio::time::timeout(budget, task).await {
            Ok(Ok(Ok(()))) => ReleaseOutcome::ShutDown,
            Ok(Ok(Err(err))) => {
                tracing::warn!(error = %err, "node.host: shutdown reported an error");
                ReleaseOutcome::ShutdownFailed
            }
            Ok(Err(join)) => {
                tracing::warn!(error = %join, "node.host: shutdown task did not complete");
                ReleaseOutcome::ShutdownFailed
            }
            Err(_) => {
                tracing::warn!(
                    budget_ms = budget.as_millis() as u64,
                    "node.host: shutdown still running when its budget ran out"
                );
                ReleaseOutcome::ShutdownTimedOut
            }
        };
        let mut state = self.state();
        match outcome {
            ReleaseOutcome::ShutDown => state.stats.shutdowns += 1,
            ReleaseOutcome::ShutdownFailed => state.stats.shutdown_failures += 1,
            ReleaseOutcome::ShutdownTimedOut => state.stats.shutdown_timeouts += 1,
            _ => {}
        }
        outcome
    }

    fn record_acquire(&self, result: &Result<AcquireOutcome, &LocationError>) {
        let current = tracing::Span::current();
        match result {
            Ok(outcome) => {
                current.record("outcome", outcome.as_str());
            }
            Err(err) => {
                current.record("outcome", "failed");
                current.record("error", tracing::field::display(err));
            }
        }
        self.record_state();
    }

    fn record_state(&self) {
        let snapshot = self.snapshot();
        let current = tracing::Span::current();
        current.record("generation", snapshot.generation);
        current.record("app_leases", snapshot.app_leases);
        current.record("background", snapshot.background);
    }
}

// ── The real thing ──────────────────────────────────────────────────────────────────────────────

impl HostedNode for LocationNode {
    fn identity_secret(&self) -> Vec<u8> {
        LocationNode::identity_secret(self)
    }

    fn recv_secret(&self) -> Vec<u8> {
        LocationNode::recv_secret(self)
    }

    fn start_stored(&self) -> impl Future<Output = Result<(), LocationError>> + Send {
        LocationNode::start_stored(self)
    }

    fn start(
        &self,
        config: TransportConfig,
    ) -> impl Future<Output = Result<(), LocationError>> + Send {
        async move {
            LocationNode::start(
                self,
                config.relay_urls,
                config.relay_auth_token,
                config.relay_enabled,
                config.ip_enabled,
                config.ble_enabled,
            )
            .await
        }
    }

    fn shutdown(&self) -> impl Future<Output = Result<(), LocationError>> + Send {
        LocationNode::shutdown(self)
    }

    fn detach_app_listeners(&self) -> impl Future<Output = ()> + Send {
        LocationNode::detach_app_listeners(self)
    }
}

/// Builds [`LocationNode`]s under the platform's storage roots.
pub struct LocationNodeFactory;

impl NodeFactory for LocationNodeFactory {
    type Node = LocationNode;

    fn build(
        &self,
        keys: &NodeKeys,
        roots: &NodeRoots,
    ) -> Result<Arc<LocationNode>, LocationError> {
        crate::new_location_node_at(
            keys.identity.clone(),
            keys.recv.clone(),
            NodeDirs::Roots {
                data: roots.data.clone().into(),
                state: roots.state.clone().into(),
            },
        )
    }
}

/// How long an app acquire may wait for a node of the wrong identity to shut down.
const REPLACE_BUDGET: Duration = Duration::from_secs(5);

/// The process's node host, as the platforms see it. Every method is a thin conversion over
/// [`Host`]; the contract lives there.
#[derive(uniffi::Object)]
pub struct NodeHost {
    host: Host<LocationNodeFactory>,
}

/// The process-wide host. There is one per process, and it is the only thing that builds a node.
#[uniffi::export]
pub fn node_host() -> Arc<NodeHost> {
    static HOST: OnceLock<Arc<NodeHost>> = OnceLock::new();
    HOST.get_or_init(NodeHost::isolated).clone()
}

impl NodeHost {
    /// A host of its own, NOT the process's. For tests, which run many in one process; the
    /// platforms must use [`node_host`].
    pub fn isolated() -> Arc<Self> {
        Arc::new(Self {
            host: Host::new(LocationNodeFactory),
        })
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl NodeHost {
    /// Take an app lease. Call once per `createNode`, and [`Self::release`] once per `shutdown`.
    pub async fn acquire_app(
        &self,
        identity_secret: Option<Vec<u8>>,
        recv_secret: Option<Vec<u8>>,
        data_root: String,
        state_root: String,
    ) -> Result<Arc<LocationNode>, LocationError> {
        self.host
            .acquire_app(
                NodeKeys {
                    identity: identity_secret,
                    recv: recv_secret,
                },
                NodeRoots {
                    data: data_root,
                    state: state_root,
                },
                REPLACE_BUDGET,
            )
            .await
            .map(|(node, _)| node)
    }

    /// Take (or keep) the background lease and return a started node. `None` before the app has
    /// ever run. Cheap when the node is already up: no keystore read, no construction.
    pub async fn acquire_background(
        &self,
        secrets: Arc<dyn DeviceSecrets>,
        data_root: String,
        state_root: String,
    ) -> Result<Option<Arc<LocationNode>>, LocationError> {
        self.host
            .acquire_background(
                move || {
                    Some(NodeKeys {
                        identity: Some(secrets.identity_secret()?),
                        recv: Some(secrets.recv_secret()?),
                    })
                },
                NodeRoots {
                    data: data_root,
                    state: state_root,
                },
            )
            .await
            .map(|acquired| acquired.map(|(node, _)| node))
    }

    /// Return a lease. The last one out shuts the node down within `timeout_ms`.
    pub async fn release(&self, holder: NodeHolder, timeout_ms: u64) -> ReleaseOutcome {
        self.host
            .release(holder, Duration::from_millis(timeout_ms))
            .await
    }

    /// Rebuild the node with new settings, keeping every lease. Holders must re-read
    /// [`Self::current`] afterwards; the old node is shut down.
    pub async fn restart(
        &self,
        config: TransportConfig,
        timeout_ms: u64,
    ) -> Result<Arc<LocationNode>, LocationError> {
        self.host
            .restart(config, Duration::from_millis(timeout_ms))
            .await
    }

    pub fn current(&self) -> Option<Arc<LocationNode>> {
        self.host.current()
    }

    pub fn generation(&self) -> u64 {
        self.host.generation()
    }

    pub fn snapshot(&self) -> HostSnapshot {
        self.host.snapshot()
    }
}

#[cfg(test)]
mod tests;
