use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use blew::DeviceId;
use iroh::endpoint::{AfterHandshakeOutcome, Connection, EndpointHooks};
use iroh_base::{EndpointId, TransportAddr};
use tokio::sync::mpsc;

use crate::transport::routing::parse_token_addr;
use crate::transport::routing::{PromoteOutcome, Routing, StableConnId};
use crate::transport::transport::BLE_TRANSPORT_ID;

/// `EndpointHooks` implementation that runs the pending→routable
/// promotion rule against `routing` the instant iroh's TLS
/// handshake binds a connection to an `EndpointId`.
///
/// Obtain an instance via [`BleTransport::dedup_hook`]:
///
/// ```no_run
/// # use iroh_ble_transport::BleTransport;
/// # use iroh::{Endpoint, SecretKey, endpoint::presets};
/// # async fn example() -> anyhow::Result<()> {
/// # let secret_key = SecretKey::generate();
/// let ble = BleTransport::builder().build(secret_key.public()).await?;
///
/// Endpoint::builder(presets::N0DisableRelay)
///     .hooks(ble.dedup_hook())
///     .add_custom_transport(ble.as_custom_transport())
///     .address_lookup(ble.address_lookup())
///     .secret_key(secret_key)
///     .bind()
///     .await?;
/// # Ok(())
/// # }
/// ```
///
/// [`BleTransport::dedup_hook`]: crate::BleTransport::dedup_hook
///
/// CAVEAT: never store an `Endpoint` on the hook — doing so creates an Arc
/// cycle because the endpoint holds the hook via its own Arc. The `Arc`s
/// this struct holds all point at transport-owned state, not at the
/// endpoint, so there's no cycle.
#[derive(Debug, Clone)]
pub(crate) enum HookEvent {
    VerifiedEndpoint {
        endpoint_id: EndpointId,
        token: Option<u64>,
        /// `DeviceId`s of pipes the `promote()` rule evicted to make room
        /// for this handshake. The forwarder on the transport side turns
        /// each into a `PeerCommand::Stalled` so the old BLE pipes get
        /// drained and closed rather than zombied until their own
        /// `LinkDead` detection or BLE ACL drop.
        evicted_devices: Vec<DeviceId>,
    },
    ConnectionClosed {
        endpoint_id: EndpointId,
        stable_id: StableConnId,
    },
}

/// How long a BLE pipe outlives the last iroh connection that used it.
///
/// streetCryptid's pairing handshake is a run of SHORT connections — one per message (Hello,
/// Reveal, then Accept once the humans have compared figures) — each closed the moment its reply
/// lands. Tearing the pipe down on the last close meant the next message's dial raced the teardown
/// of the pipe it was about to use: on 2026-10-29 a Pixel 10's Reveal was dialled 5 ms before its
/// pipe was torn down and sat out a 15 s connect timeout, and every nearby attempt that evening
/// either died that way or fell back to cellular. Keeping the pipe a while is what lets the next
/// connection find it. Long enough to span the SAS comparison between Reveal and Accept; short
/// enough that a peer who walked off is released long before anyone would notice the radio.
pub const PIPE_IDLE_LINGER: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct BleDedupHook {
    self_endpoint: EndpointId,
    routing: Arc<Routing>,
    tx: mpsc::UnboundedSender<HookEvent>,
    active_connections: Arc<ActiveConnections>,
    idle_linger: Duration,
}

impl BleDedupHook {
    #[must_use]
    pub(crate) fn new(
        self_endpoint: EndpointId,
        routing: Arc<Routing>,
        tx: mpsc::UnboundedSender<HookEvent>,
        active_connections: Arc<ActiveConnections>,
        idle_linger: Duration,
    ) -> Self {
        Self {
            self_endpoint,
            routing,
            tx,
            active_connections,
            idle_linger,
        }
    }
}

type ActiveConnectionKey = (EndpointId, StableConnId);

/// Which iroh connections ride each BLE pipe, and since when a pipe has had none.
///
/// Owned by the transport and shared by every [`BleDedupHook`] it hands out, so two hooks can never
/// disagree about whether a pipe is still in use.
#[derive(Debug, Default)]
pub(crate) struct ActiveConnections {
    next_id: AtomicU64,
    inner: parking_lot::Mutex<ActiveInner>,
}

#[derive(Debug, Default)]
struct ActiveInner {
    open: HashMap<ActiveConnectionKey, HashSet<u64>>,
    /// The watch whose close left a pipe with no connections. A pipe is released only if the SAME
    /// idle period is still running when that watch's linger ends: a connection that came and
    /// went in the meantime started a newer period, with a full linger of its own.
    idle_since: HashMap<ActiveConnectionKey, u64>,
}

impl ActiveConnections {
    fn insert(&self, endpoint_id: EndpointId, stable_id: StableConnId) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let key = (endpoint_id, stable_id);
        let mut inner = self.inner.lock();
        inner.idle_since.remove(&key);
        inner.open.entry(key).or_default().insert(id);
        id
    }

    fn remove_and_is_empty(
        &self,
        endpoint_id: EndpointId,
        stable_id: StableConnId,
        watch_id: u64,
    ) -> bool {
        let mut inner = self.inner.lock();
        let key = (endpoint_id, stable_id);
        let Some(ids) = inner.open.get_mut(&key) else {
            return true;
        };
        ids.remove(&watch_id);
        if ids.is_empty() {
            inner.open.remove(&key);
            inner.idle_since.insert(key, watch_id);
            true
        } else {
            false
        }
    }

    /// True, once, if the idle period `watch_id`'s close began is still running: nothing has
    /// used the pipe since. Consumes the marker so a pipe is released exactly once.
    fn take_still_idle(
        &self,
        endpoint_id: EndpointId,
        stable_id: StableConnId,
        watch_id: u64,
    ) -> bool {
        let mut inner = self.inner.lock();
        let key = (endpoint_id, stable_id);
        if inner.open.contains_key(&key) || inner.idle_since.get(&key) != Some(&watch_id) {
            return false;
        }
        inner.idle_since.remove(&key);
        true
    }
}

/// Release a pipe once its last connection has closed AND it then stayed unused for `linger`.
/// See [`PIPE_IDLE_LINGER`] for why the wait exists.
async fn report_idle_after_linger(
    active: &ActiveConnections,
    tx: &mpsc::UnboundedSender<HookEvent>,
    endpoint_id: EndpointId,
    stable_id: StableConnId,
    watch_id: u64,
    linger: Duration,
) {
    if !active.remove_and_is_empty(endpoint_id, stable_id, watch_id) {
        return;
    }
    tokio::time::sleep(linger).await;
    if active.take_still_idle(endpoint_id, stable_id, watch_id) {
        let _ = tx.send(HookEvent::ConnectionClosed {
            endpoint_id,
            stable_id,
        });
    }
}

impl EndpointHooks for BleDedupHook {
    async fn after_handshake<'a>(&'a self, conn: &'a Connection) -> AfterHandshakeOutcome {
        let remote_endpoint = conn.remote_id();
        // iroh 1.0: `Connection::paths()` returns a snapshot of only the
        // currently-open paths (closed paths are not retained), so the former
        // `!path.is_closed()` filter is dropped — that method no longer exists
        // on the 1.0 `Path` API.
        let paths = conn.paths();
        let token = paths
            .iter()
            .find_map(|path| match path.remote_addr() {
                TransportAddr::Custom(addr) if addr.id() == BLE_TRANSPORT_ID => {
                    parse_token_addr(addr).ok()
                }
                _ => None,
            });

        // Run the promotion rule synchronously. This is the only
        // place routing's authority invariants are established.
        // Same-positional-category (peer re-dialed us) always evicts
        // the old and accepts the new — the new handshake completing
        // is authoritative evidence that the peer abandoned the old
        // connection. The evicted pipes' DeviceIds are forwarded so
        // the registry can `Stalled` them into teardown.
        let mut evicted_devices: Vec<DeviceId> = Vec::new();
        let mut close_watch: Option<(StableConnId, u64)> = None;
        if let Some(token) = token {
            let stable_id = StableConnId::from_raw(token);
            match self
                .routing
                .promote(stable_id, &self.self_endpoint, remote_endpoint)
            {
                PromoteOutcome::Rejected => {
                    tracing::info!(
                        %remote_endpoint,
                        %stable_id,
                        "BleDedupHook: rejecting handshake (promotion rule said so)"
                    );
                    let _ = self.tx.send(HookEvent::VerifiedEndpoint {
                        endpoint_id: remote_endpoint,
                        token: Some(token),
                        evicted_devices: Vec::new(),
                    });
                    return AfterHandshakeOutcome::Reject {
                        error_code: noq_proto::VarInt::from_u32(0),
                        reason: b"ble_conflict".to_vec(),
                    };
                }
                PromoteOutcome::Accepted { evicted } => {
                    // Resolve evicted StableConnIds → DeviceIds for
                    // teardown. We do this before logging so the log
                    // can show how many pipes actually had devices
                    // registered (edge case: a pipe might have been
                    // evicted between the promote call and now).
                    for id in &evicted {
                        if let Some(dev) = self.routing.device_for_pipe(*id) {
                            evicted_devices.push(dev);
                        }
                    }
                    tracing::info!(
                        %remote_endpoint,
                        %stable_id,
                        evicted_count = evicted.len(),
                        evicted_devices = evicted_devices.len(),
                        "BleDedupHook: promoted to routable"
                    );
                    let watch_id = self.active_connections.insert(remote_endpoint, stable_id);
                    close_watch = Some((stable_id, watch_id));
                }
            }
        }

        // Forward to the actor loop; the forwarder on the transport
        // side dispatches `PeerCommand::Stalled` for each evicted
        // device so its pipe worker is properly drained.
        let _ = self.tx.send(HookEvent::VerifiedEndpoint {
            endpoint_id: remote_endpoint,
            token,
            evicted_devices,
        });
        if let Some((stable_id, watch_id)) = close_watch {
            // iroh 1.0: use a `WeakConnectionHandle` rather than cloning the
            // `Connection`. A strong clone would disable close-on-drop and keep
            // the connection alive; `weak_handle().closed()` observes closure
            // without holding the connection open (see `EndpointHooks` docs).
            let weak = conn.weak_handle();
            let tx = self.tx.clone();
            let active_connections = Arc::clone(&self.active_connections);
            let linger = self.idle_linger;
            tokio::spawn(async move {
                let _ = weak.closed().await;
                report_idle_after_linger(
                    &active_connections,
                    &tx,
                    remote_endpoint,
                    stable_id,
                    watch_id,
                    linger,
                )
                .await;
            });
        }
        AfterHandshakeOutcome::Accept
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(seed: u8) -> EndpointId {
        iroh_base::SecretKey::from_bytes(&[seed; 32]).public()
    }

    #[test]
    fn active_connections_only_reports_empty_after_last_watch_is_removed() {
        let active = ActiveConnections::default();
        let endpoint_id = endpoint(1);
        let stable_id = StableConnId::for_test(7);

        let first = active.insert(endpoint_id, stable_id);
        let second = active.insert(endpoint_id, stable_id);

        assert!(
            !active.remove_and_is_empty(endpoint_id, stable_id, first),
            "first close must not report empty while another connection is active"
        );
        assert!(
            active.remove_and_is_empty(endpoint_id, stable_id, second),
            "last close reports the peer/stable-id bucket empty"
        );
    }

    fn closed_events(rx: &mut mpsc::UnboundedReceiver<HookEvent>) -> usize {
        let mut n = 0;
        while let Ok(event) = rx.try_recv() {
            if matches!(event, HookEvent::ConnectionClosed { .. }) {
                n += 1;
            }
        }
        n
    }

    /// Run the spawned linger task up to its timer without moving the paused clock.
    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    fn spawn_close(
        active: &Arc<ActiveConnections>,
        tx: &mpsc::UnboundedSender<HookEvent>,
        endpoint_id: EndpointId,
        stable_id: StableConnId,
        watch_id: u64,
    ) -> tokio::task::JoinHandle<()> {
        let (active, tx) = (Arc::clone(active), tx.clone());
        tokio::spawn(async move {
            report_idle_after_linger(
                &active,
                &tx,
                endpoint_id,
                stable_id,
                watch_id,
                PIPE_IDLE_LINGER,
            )
            .await;
        })
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_pipe_is_released_only_after_the_linger() {
        let active = Arc::new(ActiveConnections::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (endpoint_id, stable_id) = (endpoint(3), StableConnId::for_test(10));

        let watch = active.insert(endpoint_id, stable_id);
        let task = spawn_close(&active, &tx, endpoint_id, stable_id, watch);
        settle().await;
        tokio::time::advance(PIPE_IDLE_LINGER - Duration::from_millis(1)).await;
        settle().await;
        assert_eq!(closed_events(&mut rx), 0, "released inside the linger");

        tokio::time::advance(Duration::from_millis(2)).await;
        task.await.unwrap();
        assert_eq!(
            closed_events(&mut rx),
            1,
            "an unused pipe is released after it"
        );
    }

    /// The 2026-10-29 Pixel 10 sequence: Hello's connection closes and Reveal's is dialled over
    /// the same pipe 5 ms later. The pipe has to still be there when it arrives.
    #[tokio::test(start_paused = true)]
    async fn a_connection_inside_the_linger_keeps_the_pipe() {
        let active = Arc::new(ActiveConnections::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (endpoint_id, stable_id) = (endpoint(4), StableConnId::for_test(11));

        let hello = active.insert(endpoint_id, stable_id);
        let hello_closed = spawn_close(&active, &tx, endpoint_id, stable_id, hello);
        settle().await;
        tokio::time::advance(Duration::from_millis(5)).await;
        let reveal = active.insert(endpoint_id, stable_id);

        tokio::time::advance(PIPE_IDLE_LINGER).await;
        hello_closed.await.unwrap();
        assert_eq!(
            closed_events(&mut rx),
            0,
            "Hello's linger tore down the pipe Reveal is using"
        );

        // Reveal closes in turn; its own linger, from its own close, is the one that counts.
        let reveal_closed = spawn_close(&active, &tx, endpoint_id, stable_id, reveal);
        settle().await;
        tokio::time::advance(PIPE_IDLE_LINGER + Duration::from_millis(1)).await;
        reveal_closed.await.unwrap();
        assert_eq!(closed_events(&mut rx), 1);
    }

    /// A connection that came AND went during an earlier linger began a newer idle period. The
    /// earlier timer must not cut that one short.
    #[tokio::test(start_paused = true)]
    async fn only_the_latest_idle_period_can_release_the_pipe() {
        let active = Arc::new(ActiveConnections::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (endpoint_id, stable_id) = (endpoint(5), StableConnId::for_test(12));

        let first = active.insert(endpoint_id, stable_id);
        let first_closed = spawn_close(&active, &tx, endpoint_id, stable_id, first);
        settle().await;
        tokio::time::advance(Duration::from_secs(10)).await;
        let second = active.insert(endpoint_id, stable_id);
        let second_closed = spawn_close(&active, &tx, endpoint_id, stable_id, second);
        settle().await;

        // The first linger ends twenty seconds into the second idle period.
        tokio::time::advance(PIPE_IDLE_LINGER - Duration::from_secs(10) + Duration::from_millis(1))
            .await;
        first_closed.await.unwrap();
        assert_eq!(
            closed_events(&mut rx),
            0,
            "a stale idle period released the pipe"
        );

        tokio::time::advance(Duration::from_secs(10)).await;
        second_closed.await.unwrap();
        assert_eq!(closed_events(&mut rx), 1);
    }

    #[test]
    fn active_connections_buckets_by_stable_id() {
        let active = ActiveConnections::default();
        let endpoint_id = endpoint(2);
        let old_id = StableConnId::for_test(8);
        let new_id = StableConnId::for_test(9);

        let old_watch = active.insert(endpoint_id, old_id);
        let _new_watch = active.insert(endpoint_id, new_id);

        assert!(
            active.remove_and_is_empty(endpoint_id, old_id, old_watch),
            "old stable-id bucket is empty even if replacement stable-id has an active connection"
        );
    }
}
