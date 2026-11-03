use std::sync::Arc;
use std::time::Duration;

use blew::DeviceId;
use iroh::endpoint::{
    AfterHandshakeOutcome, BeforeConnectOutcome, Connection, EndpointHooks, VarInt,
};
use iroh_base::{EndpointAddr, EndpointId, TransportAddr};
use tokio::sync::mpsc;

use crate::transport::conns::{
    BLE_CLOSE_CODE_CONFLICT, BLE_CLOSE_REASON_CONFLICT, ConnHandle, ConnectionRegistry,
    close_evicted_pipes,
};
use crate::transport::priority::{LinkPriority, TrackedConnection};
use crate::transport::routing::{PromoteOutcome, Routing, StableConnId};
use crate::transport::routing::{parse_token_addr, prefix_from_endpoint};
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
    connections: Arc<ConnectionRegistry>,
    idle_linger: Duration,
    link_priority: Arc<LinkPriority>,
}

impl BleDedupHook {
    #[must_use]
    pub(crate) fn new(
        self_endpoint: EndpointId,
        routing: Arc<Routing>,
        tx: mpsc::UnboundedSender<HookEvent>,
        connections: Arc<ConnectionRegistry>,
        idle_linger: Duration,
        link_priority: Arc<LinkPriority>,
    ) -> Self {
        Self {
            self_endpoint,
            routing,
            tx,
            connections,
            idle_linger,
            link_priority,
        }
    }
}

/// Release a pipe once its last connection has closed AND it then stayed unused for `linger`.
/// See [`PIPE_IDLE_LINGER`] for why the wait exists.
async fn report_idle_after_linger(
    connections: &ConnectionRegistry,
    tx: &mpsc::UnboundedSender<HookEvent>,
    endpoint_id: EndpointId,
    stable_id: StableConnId,
    watch_id: u64,
    linger: Duration,
) {
    if !connections.remove_and_is_empty(endpoint_id, stable_id, watch_id) {
        return;
    }
    tokio::time::sleep(linger).await;
    if connections.take_still_idle(endpoint_id, stable_id, watch_id) {
        let _ = tx.send(HookEvent::ConnectionClosed {
            endpoint_id,
            stable_id,
        });
    }
}

/// Close code for a connection turned away because BLE is being kept for other protocols.
pub const BLE_HELD_CLOSE_CODE: u32 = 0x424c_4548;

/// An accepted BLE connection, held weakly so tracking it never keeps it open.
struct BleConnection {
    alpn: Vec<u8>,
    handle: iroh::endpoint::WeakConnectionHandle,
}

impl TrackedConnection for BleConnection {
    fn alpn(&self) -> &[u8] {
        &self.alpn
    }

    fn alive(&self) -> bool {
        self.handle
            .upgrade()
            .is_some_and(|conn| conn.close_reason().is_none())
    }

    fn close_if_on_ble(&self) -> bool {
        let Some(conn) = self.handle.upgrade() else {
            return false;
        };
        let on_ble = conn.paths().iter().any(|path| {
            matches!(path.remote_addr(), TransportAddr::Custom(addr) if addr.id() == BLE_TRANSPORT_ID)
        });
        if on_ble {
            conn.close(VarInt::from_u32(BLE_HELD_CLOSE_CODE), b"ble-reserved");
        }
        on_ble
    }
}

impl EndpointHooks for BleDedupHook {
    /// Hold back a dial that would land on BLE while the link is reserved for other protocols
    /// ([`crate::BleTransport::reserve_links_for`]). "Would land on BLE" is read as "the peer is
    /// in BLE range": nothing else is known before iroh picks a path, and a held link is kept for
    /// a couple of minutes at most.
    async fn before_connect<'a>(
        &'a self,
        remote_addr: &'a EndpointAddr,
        alpn: &'a [u8],
    ) -> BeforeConnectOutcome {
        if self.link_priority.defers(alpn)
            && self
                .routing
                .scan_hint_for_prefix(&prefix_from_endpoint(&remote_addr.id))
                .is_some()
        {
            // Values in the message too: Loki keeps only the message, and "who was dialling a
            // phone in BLE range during pairing, and for what" is the question this line answers.
            let alpn = String::from_utf8_lossy(alpn);
            let remote: String = remote_addr.id.as_bytes()[..5]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            tracing::info!(
                remote_endpoint = %remote_addr.id,
                %alpn,
                "BleDedupHook: holding a dial off BLE (link reserved): {alpn} to {remote}"
            );
            return BeforeConnectOutcome::Reject;
        }
        BeforeConnectOutcome::Accept
    }

    async fn after_handshake<'a>(&'a self, conn: &'a Connection) -> AfterHandshakeOutcome {
        let remote_endpoint = conn.remote_id();
        // `paths()` only ever lists open paths, so no closed-path filter here.
        let token = conn
            .paths()
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
                        error_code: VarInt::from_u32(BLE_CLOSE_CODE_CONFLICT),
                        reason: BLE_CLOSE_REASON_CONFLICT.to_vec(),
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
                    // Close the connections riding the evicted pipes
                    // before the BLE teardown the forwarder kicks off
                    // below: the pipe under them is about to disappear,
                    // and iroh has no way to observe that.
                    close_evicted_pipes(&self.connections, &evicted);
                    let watch_id = self.connections.insert(
                        remote_endpoint,
                        stable_id,
                        Arc::new(conn.weak_handle()) as Arc<dyn ConnHandle>,
                    );
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
            // Never clone the `Connection` out of the hook: a strong handle
            // keeps it alive and disables close-on-drop for its real owner.
            let closed = conn.weak_handle().closed();
            let tx = self.tx.clone();
            let connections = Arc::clone(&self.connections);
            let linger = self.idle_linger;
            tokio::spawn(async move {
                let _ = closed.await;
                report_idle_after_linger(
                    &connections,
                    &tx,
                    remote_endpoint,
                    stable_id,
                    watch_id,
                    linger,
                )
                .await;
            });
        }
        // Checked last, so the pipe is promoted and watched like any other: a connection turned
        // away here is one more close, and the pipe it rode stays for the protocols it is held for.
        if token.is_some() && self.link_priority.defers(conn.alpn()) {
            tracing::info!(
                %remote_endpoint,
                alpn = %String::from_utf8_lossy(conn.alpn()),
                "BleDedupHook: turning a connection away from BLE (link reserved)"
            );
            return AfterHandshakeOutcome::Reject {
                error_code: VarInt::from_u32(BLE_HELD_CLOSE_CODE),
                reason: b"ble-reserved".to_vec(),
            };
        }
        if token.is_some() {
            self.link_priority.track(Box::new(BleConnection {
                alpn: conn.alpn().to_vec(),
                handle: conn.weak_handle(),
            }));
        }
        AfterHandshakeOutcome::Accept
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::conns::RecordingConn;

    fn endpoint(seed: u8) -> EndpointId {
        iroh_base::SecretKey::from_bytes(&[seed; 32]).public()
    }

    #[test]
    fn registry_only_reports_empty_after_last_watch_is_removed() {
        let active = ConnectionRegistry::default();
        let endpoint_id = endpoint(1);
        let stable_id = StableConnId::for_test(7);

        let first = active.insert(
            endpoint_id,
            stable_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );
        let second = active.insert(
            endpoint_id,
            stable_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );

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
        active: &Arc<ConnectionRegistry>,
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
        let active = Arc::new(ConnectionRegistry::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (endpoint_id, stable_id) = (endpoint(3), StableConnId::for_test(10));

        let watch = active.insert(
            endpoint_id,
            stable_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );
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
        let active = Arc::new(ConnectionRegistry::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (endpoint_id, stable_id) = (endpoint(4), StableConnId::for_test(11));

        let hello = active.insert(
            endpoint_id,
            stable_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );
        let hello_closed = spawn_close(&active, &tx, endpoint_id, stable_id, hello);
        settle().await;
        tokio::time::advance(Duration::from_millis(5)).await;
        let reveal = active.insert(
            endpoint_id,
            stable_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );

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
        let active = Arc::new(ConnectionRegistry::default());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (endpoint_id, stable_id) = (endpoint(5), StableConnId::for_test(12));

        let first = active.insert(
            endpoint_id,
            stable_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );
        let first_closed = spawn_close(&active, &tx, endpoint_id, stable_id, first);
        settle().await;
        tokio::time::advance(Duration::from_secs(10)).await;
        let second = active.insert(
            endpoint_id,
            stable_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );
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
    fn registry_buckets_by_stable_id() {
        let active = ConnectionRegistry::default();
        let endpoint_id = endpoint(2);
        let old_id = StableConnId::for_test(8);
        let new_id = StableConnId::for_test(9);

        let old_watch = active.insert(
            endpoint_id,
            old_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );
        let _new_watch = active.insert(
            endpoint_id,
            new_id,
            RecordingConn::new() as Arc<dyn ConnHandle>,
        );

        assert!(
            active.remove_and_is_empty(endpoint_id, old_id, old_watch),
            "old stable-id bucket is empty even if replacement stable-id has an active connection"
        );
    }
}
