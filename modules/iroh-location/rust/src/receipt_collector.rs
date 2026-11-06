//! Correlates actual receives, never the ranked list of available paths.
//!
//! A single family accounting for ALL received application frames proves the path.
//! Multiple families, closed/missing paths, or resumed blobs stay unknown: a counter delta
//! includes concurrent streams and cannot prove that THIS update used every observed path.

use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
};

use iroh::endpoint::{AfterHandshakeOutcome, Connection, EndpointHooks, WeakConnectionHandle};
use iroh_blobs::api::{
    blobs::BlobStatus,
    receipt::{DownloadObserver, PendingReceipt},
    Store as BlobStore,
};
use iroh_tickets::endpoint::EndpointTicket;

use crate::{
    contact::PeerRoles,
    delivery::DeliveryStore,
    delivery_stats::{
        self, DeliveryStatistics, Mechanism, PathKind, Receipt, RelaySetup, Source, Store,
    },
    recipients::RecipientStore,
    sessions::{SessionError, SessionManager},
};

const MAX_CONNECTIONS: usize = 1024;
const MAX_ENVELOPE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Default)]
struct RxSnapshot {
    total: u64,
    paths: HashMap<String, (PathKind, u64)>,
    coherent: bool,
}

fn app_frames(stats: &iroh::endpoint::FrameStats) -> u64 {
    stats.stream + stats.datagram
}

fn path_kind(address: &iroh::TransportAddr) -> PathKind {
    match address {
        iroh::TransportAddr::Ip(address) if crate::is_lan_ip(address.ip()) => PathKind::LocalIp,
        iroh::TransportAddr::Ip(_) => PathKind::DirectIp,
        iroh::TransportAddr::Relay(_) => PathKind::Relay,
        // BLE is the only custom transport attached by this node.
        _ => PathKind::Bluetooth,
    }
}

fn snapshot(connection: &Connection) -> RxSnapshot {
    let before = app_frames(&connection.stats().frame_rx);
    let paths = connection
        .paths()
        .iter()
        .map(|path| {
            (
                format!("{:?}", path.id()),
                (
                    path_kind(path.remote_addr()),
                    app_frames(&path.stats().frame_rx),
                ),
            )
        })
        .collect();
    let total = app_frames(&connection.stats().frame_rx);
    RxSnapshot {
        total,
        paths,
        coherent: before == total,
    }
}

fn classify(before: &RxSnapshot, after: &RxSnapshot) -> PathKind {
    if !before.coherent || !after.coherent || after.total <= before.total {
        return PathKind::Unknown;
    }
    let mut counted = 0;
    let mut kind = None;
    for (id, (path, frames)) in &after.paths {
        let previous = before.paths.get(id).map(|(_, n)| *n).unwrap_or(0);
        let Some(delta) = frames.checked_sub(previous) else {
            return PathKind::Unknown;
        };
        if delta == 0 {
            continue;
        }
        counted += delta;
        if kind.is_some_and(|kind| kind != *path) {
            return PathKind::Unknown;
        }
        kind = Some(*path);
    }
    if counted != after.total - before.total {
        return PathKind::Unknown;
    }
    kind.unwrap_or(PathKind::Unknown)
}

fn handshake_relay(connection: &Connection, relay_enabled: bool) -> RelaySetup {
    if !relay_enabled {
        return RelaySetup::No;
    }
    if connection.paths().iter().any(|path| {
        let stats = path.stats();
        path.is_relay() && stats.frame_rx.crypto + stats.frame_tx.crypto > 0
    }) {
        RelaySetup::Yes
    } else {
        // A direct handshake does not rule out earlier relay-assisted signalling.
        RelaySetup::Unknown
    }
}

type MessageKey = ([u8; 32], [u8; 32]);

#[derive(Clone, Copy)]
pub struct Evidence {
    path: PathKind,
    setup: RelaySetup,
    time: (i32, u8),
}

impl Default for Evidence {
    fn default() -> Self {
        Self {
            path: PathKind::Unknown,
            setup: RelaySetup::Unknown,
            time: delivery_stats::local_hour(),
        }
    }
}

#[derive(Default)]
struct PendingMessages {
    receipts: HashMap<MessageKey, Evidence>,
    order: VecDeque<MessageKey>,
}

pub struct Collector {
    weak: Weak<Self>,
    store: Result<Store, String>,
    sessions: Arc<SessionManager>,
    recipients: Arc<RecipientStore>,
    delivery: Arc<DeliveryStore>,
    connections: Mutex<HashMap<usize, RelaySetup>>,
    pending: Mutex<PendingMessages>,
}

impl std::fmt::Debug for Collector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReceiptCollector").finish_non_exhaustive()
    }
}

impl Collector {
    pub fn new(
        root: &Path,
        identity: &[u8; 32],
        sessions: Arc<SessionManager>,
        recipients: Arc<RecipientStore>,
        delivery: Arc<DeliveryStore>,
    ) -> Arc<Self> {
        let store = Store::open(root, identity, delivery_stats::local_hour().0)
            .map_err(|error| error.to_string());
        if let Err(error) = &store {
            tracing::warn!(%error, "delivery statistics unavailable");
        }
        Arc::new_cyclic(|weak| Self {
            weak: weak.clone(),
            store,
            sessions,
            recipients,
            delivery,
            connections: Mutex::new(HashMap::new()),
            pending: Mutex::new(PendingMessages::default()),
        })
    }

    fn roles(&self) -> PeerRoles {
        let friends = self
            .recipients
            .get()
            .iter()
            .chain(self.recipients.watchers().iter())
            .filter_map(|id| crate::decode_endpoint(id).ok())
            .collect::<Vec<_>>();
        let config = self.delivery.get();
        let stash = config
            .stash_base_url
            .as_ref()
            .and(config.peer_tickets.first())
            .and_then(|ticket| ticket.parse::<EndpointTicket>().ok())
            .map(|ticket| *ticket.endpoint_addr().id.as_bytes());
        PeerRoles::new(friends, stash)
    }

    pub fn statistics(&self) -> anyhow::Result<DeliveryStatistics> {
        self.store
            .as_ref()
            .map_err(|error| anyhow::anyhow!(error.clone()))?
            .snapshot(delivery_stats::local_hour().0)
    }

    fn incomplete(&self, day: i32) {
        if let Ok(store) = &self.store {
            store.mark_incomplete(day);
        }
    }

    fn record(
        &self,
        author: &[u8],
        seq: u64,
        peer: Option<&[u8; 32]>,
        path: PathKind,
        setup: RelaySetup,
        mechanism: Mechanism,
        time: (i32, u8),
    ) {
        let roles = self.roles();
        let Ok(author_id) = <[u8; 32]>::try_from(author) else {
            return;
        };
        if roles.role(&author_id) != "friend" {
            return;
        }
        let source = match peer {
            None => Source::Unknown,
            Some(peer) if *peer == author_id => Source::Author,
            Some(peer) => match roles.role(peer) {
                "friend" => Source::Friend,
                "stash" => Source::Stash,
                _ => Source::Other,
            },
        };
        if let Ok(store) = &self.store {
            if let Err(error) = store.record(
                author,
                seq,
                Receipt {
                    day: time.0,
                    hour: time.1,
                    source,
                    path,
                    relay_setup: setup,
                    mechanism,
                },
            ) {
                tracing::warn!(%error, "delivery statistics receipt not persisted");
            }
        }
    }

    pub fn take_gossip(&self, peer: &[u8; 32], content: &[u8]) -> Evidence {
        let key = (*peer, *blake3::hash(content).as_bytes());
        let mut pending = self.pending.lock().expect("receipt messages poisoned");
        pending.order.retain(|entry| *entry != key);
        pending.receipts.remove(&key).unwrap_or_default()
    }

    pub fn gossip(&self, author: &[u8], seq: u64, peer: &[u8; 32], evidence: Evidence) {
        self.record(
            author,
            seq,
            Some(peer),
            evidence.path,
            evidence.setup,
            Mechanism::Gossip,
            evidence.time,
        );
    }
}

impl iroh_gossip::receipt::ReceiveObserver for Collector {
    fn received(&self, connection: &Connection, content: &[u8]) {
        // QUIC may buffer a complete message before the read starts. A lifetime single-family
        // receive history is proof even then; a migrated/multipath history is not.
        let evidence = Evidence {
            path: classify(
                &RxSnapshot {
                    coherent: true,
                    ..RxSnapshot::default()
                },
                &snapshot(connection),
            ),
            setup: self
                .connections
                .lock()
                .expect("receipt connections poisoned")
                .get(&connection.stable_id())
                .copied()
                .unwrap_or(RelaySetup::Unknown),
            time: delivery_stats::local_hour(),
        };
        let key = (
            *connection.remote_id().as_bytes(),
            *blake3::hash(content).as_bytes(),
        );
        let mut pending = self.pending.lock().expect("receipt messages poisoned");
        if pending.receipts.contains_key(&key) {
            return;
        }
        while pending.order.len() >= 4096 {
            if let Some(old) = pending.order.pop_front() {
                pending.receipts.remove(&old);
            }
        }
        pending.order.push_back(key);
        pending.receipts.insert(key, evidence);
    }
}

#[derive(Debug)]
pub struct Hook {
    pub collector: Weak<Collector>,
    pub relay_enabled: bool,
}

impl EndpointHooks for Hook {
    async fn after_handshake(&self, connection: &Connection) -> AfterHandshakeOutcome {
        if let Some(collector) = self.collector.upgrade() {
            if connection.alpn() != iroh_blobs::ALPN && connection.alpn() != iroh_gossip::ALPN {
                return AfterHandshakeOutcome::accept();
            }
            let mut connections = collector
                .connections
                .lock()
                .expect("receipt connections poisoned");
            if connections.len() < MAX_CONNECTIONS {
                connections.insert(
                    connection.stable_id(),
                    handshake_relay(connection, self.relay_enabled),
                );
            }
            drop(connections);
            let blob = if connection.alpn() == iroh_blobs::ALPN {
                let observer: Arc<dyn DownloadObserver> = collector.clone();
                Some(iroh_blobs::api::receipt::register(
                    connection,
                    Arc::downgrade(&observer),
                ))
            } else {
                None
            };
            let gossip = if connection.alpn() == iroh_gossip::ALPN {
                let observer: Arc<dyn iroh_gossip::receipt::ReceiveObserver> = collector.clone();
                Some(iroh_gossip::receipt::register(
                    connection,
                    Arc::downgrade(&observer),
                ))
            } else {
                None
            };
            let weak = collector.weak.clone();
            let id = connection.stable_id();
            let closed = connection.weak_handle().closed();
            tokio::spawn(async move {
                closed.await;
                drop((blob, gossip));
                if let Some(collector) = weak.upgrade() {
                    collector
                        .connections
                        .lock()
                        .expect("receipt connections poisoned")
                        .remove(&id);
                }
            });
        }
        AfterHandshakeOutcome::accept()
    }
}

struct Download {
    collector: Weak<Collector>,
    connection: WeakConnectionHandle,
    before: RxSnapshot,
    setup: RelaySetup,
    peer: [u8; 32],
}

impl DownloadObserver for Collector {
    fn begin(&self, connection: &Connection) -> Box<dyn PendingReceipt> {
        let setup = self
            .connections
            .lock()
            .expect("receipt connections poisoned")
            .get(&connection.stable_id())
            .copied()
            .unwrap_or(RelaySetup::Unknown);
        Box::new(Download {
            collector: self.weak.clone(),
            connection: connection.weak_handle(),
            before: snapshot(connection),
            setup,
            peer: *connection.remote_id().as_bytes(),
        })
    }
}

impl PendingReceipt for Download {
    fn complete(
        self: Box<Self>,
        store: BlobStore,
        hash: iroh_blobs::Hash,
        previous_bytes: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let time = delivery_stats::local_hour();
        let path = if previous_bytes == 0 {
            self.connection
                .upgrade()
                .map(|connection| classify(&self.before, &snapshot(&connection)))
                .unwrap_or(PathKind::Unknown)
        } else {
            PathKind::Unknown
        };
        Box::pin(async move {
            let inspect = async {
                let status = store.blobs().status(hash).await?;
                let BlobStatus::Complete { size } = status else {
                    return Ok::<(), anyhow::Error>(());
                };
                if size > MAX_ENVELOPE_BYTES {
                    if let Some(collector) = self.collector.upgrade() {
                        collector.incomplete(time.0);
                    }
                    tracing::warn!(size, "delivery statistics skipped an oversized blob");
                    return Ok(());
                }
                let bytes = store.blobs().get_bytes(hash).await?;
                let Ok(envelope) = crate::crypto::verify_v3(&bytes) else {
                    return Ok(());
                };
                let Some(collector) = self.collector.upgrade() else {
                    return Ok(());
                };
                let payload =
                    match collector
                        .sessions
                        .preview(&envelope.author, &envelope, crate::now_ms())
                    {
                        Ok(payload) => payload,
                        Err(
                            SessionError::NoSession
                            | SessionError::NotForUs
                            | SessionError::Replayed,
                        ) => return Ok(()),
                        Err(error) => return Err(error.into()),
                    };
                let fix = match crate::decode_fix_payload(&payload) {
                    Ok(fix) => fix,
                    Err(error) => {
                        tracing::warn!(%error, "delivery statistics ignored an invalid location payload");
                        return Ok(());
                    }
                };
                if fix.is_some() {
                    collector.record(
                        &envelope.author,
                        envelope.seq,
                        (previous_bytes == 0).then_some(&self.peer),
                        path,
                        if previous_bytes == 0 {
                            self.setup
                        } else {
                            RelaySetup::Unknown
                        },
                        Mechanism::Sync,
                        time,
                    );
                }
                Ok(())
            };
            match tokio::time::timeout(std::time::Duration::from_secs(2), inspect).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    if let Some(collector) = self.collector.upgrade() {
                        collector.incomplete(time.0);
                    }
                    tracing::warn!(%error, "delivery statistics could not inspect completed blob");
                }
                Err(_) => {
                    if let Some(collector) = self.collector.upgrade() {
                        collector.incomplete(time.0);
                    }
                    tracing::warn!("delivery statistics blob inspection timed out");
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::{
        address_lookup::memory::MemoryLookup, endpoint::presets, protocol::Router, Endpoint,
        RelayMode,
    };
    use iroh_blobs::{store::mem::MemStore, BlobsProtocol};
    use n0_future::StreamExt;

    #[tokio::test]
    async fn native_receipts_correlate_the_actual_supplier_without_consuming_the_fix() {
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let root =
                std::env::temp_dir().join(format!("sc-receipt-network-{}", rand::random::<u64>()));
            let author_seed = [11; 32];
            let author = ed25519_dalek::SigningKey::from_bytes(&author_seed)
                .verifying_key()
                .to_bytes();
            let recipient_seed = [22; 32];
            let recipient = ed25519_dalek::SigningKey::from_bytes(&recipient_seed)
                .verifying_key()
                .to_bytes();
            let sender_sessions = SessionManager::new(
                crate::session_store::SessionStore::open(&root.join("sender"), &author_seed)
                    .unwrap(),
                author,
            );
            let sessions = Arc::new(SessionManager::new(
                crate::session_store::SessionStore::open(&root.join("receiver"), &recipient_seed)
                    .unwrap(),
                recipient,
            ));
            let now = crate::now_ms();
            let ephemeral = x25519_dalek::StaticSecret::from([33; 32]);
            sender_sessions
                .bootstrap(
                    &recipient,
                    [1; 16],
                    [2; 32],
                    x25519_dalek::PublicKey::from(&ephemeral).to_bytes(),
                    now,
                )
                .unwrap();
            sessions
                .bootstrap_responder(&author, [1; 16], [2; 32], ephemeral, now)
                .unwrap();
            let recipients = Arc::new(RecipientStore::open(&root.join("receiver")).unwrap());
            let author_hex = iroh::EndpointId::from_bytes(&author).unwrap().to_string();
            recipients.set(std::slice::from_ref(&author_hex)).unwrap();
            let delivery = Arc::new(DeliveryStore::open(&root.join("receiver")).unwrap());
            let collector = Collector::new(
                &root.join("receiver"),
                &recipient_seed,
                sessions.clone(),
                recipients.clone(),
                delivery.clone(),
            );
            let source = Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Disabled)
                .bind()
                .await
                .unwrap();
            let memory = MemoryLookup::new();
            memory.add_endpoint_info(source.addr());
            let destination = Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Disabled)
                .address_lookup(memory)
                .hooks(Hook {
                    collector: Arc::downgrade(&collector),
                    relay_enabled: false,
                })
                .bind()
                .await
                .unwrap();
            let source_store = MemStore::new();
            let destination_store = MemStore::new();
            let source_gossip = iroh_gossip::net::Gossip::builder().spawn(source.clone());
            let destination_gossip = iroh_gossip::net::Gossip::builder().spawn(destination.clone());
            let source_router = Router::builder(source.clone())
                .accept(iroh_blobs::ALPN, BlobsProtocol::new(&source_store, None))
                .accept(iroh_gossip::ALPN, source_gossip.clone())
                .spawn();
            let destination_router = Router::builder(destination.clone())
                .accept(iroh_gossip::ALPN, destination_gossip.clone())
                .spawn();
            let downloader = destination_store.downloader(&destination);
            let fix = crate::LocationFix {
                lat: 1.0,
                lon: 2.0,
                accuracy_m: 5.0,
                heading_deg: 0.0,
                ts: 1,
                state: Some(crate::FIX_STATE_PARKED),
                published_delta_s: Some(3600),
            };
            let seal = |seq, fix: Option<&crate::LocationFix>| {
                let wraps = sender_sessions
                    .next_wraps(&[recipient.to_vec()], now)
                    .unwrap()
                    .wraps;
                crate::crypto::seal_v3(
                    &author_seed,
                    &author,
                    seq,
                    now,
                    0,
                    &crate::encode_fix_payload(fix).unwrap(),
                    wraps,
                )
                .unwrap()
            };
            let snapshot = || {
                collector
                    .store
                    .as_ref()
                    .unwrap()
                    .snapshot(delivery_stats::local_hour().0 + 1)
                    .unwrap()
            };
            let bytes = seal(1, Some(&fix));
            let tag = source_store.add_slice(&bytes).await.unwrap();
            downloader.download(tag.hash, [source.id()]).await.unwrap();
            let report = snapshot();
            assert_eq!(report.counts.len(), 1);
            assert_eq!(
                report.counts[0].source, "other",
                "the content supplier is not the author"
            );
            assert_eq!(report.counts[0].relay_setup, "no");
            assert_ne!(report.counts[0].path, "unknown");
            assert_eq!(
                report.counts[0].hour,
                delivery_stats::local_hour().1,
                "not the fix's old timestamp"
            );
            let verified = crate::crypto::verify_v3(&bytes).unwrap();
            assert!(
                sessions.open(&author, &verified, now).is_ok(),
                "collection must not consume the ratchet"
            );
            downloader.download(tag.hash, [source.id()]).await.unwrap();
            collector.gossip(&author, 1, source.id().as_bytes(), Evidence::default());
            assert_eq!(snapshot().counts.iter().map(|r| r.count).sum::<u64>(), 1);

            let null = source_store.add_slice(seal(2, None)).await.unwrap();
            downloader.download(null.hash, [source.id()]).await.unwrap();
            assert_eq!(
                snapshot().counts.iter().map(|r| r.count).sum::<u64>(),
                1,
                "null acknowledgements do not count"
            );

            delivery
                .set(crate::delivery::DeliveryConfig {
                    stash_base_url: Some("https://unused.invalid".into()),
                    peer_tickets: vec![EndpointTicket::new(source.addr()).to_string()],
                    ..Default::default()
                })
                .unwrap();
            let heartbeat = source_store.add_slice(seal(3, Some(&fix))).await.unwrap();
            downloader
                .download(heartbeat.hash, [source.id()])
                .await
                .unwrap();
            assert!(snapshot()
                .counts
                .iter()
                .any(|r| r.source == "stash" && r.count == 1));

            recipients
                .set(&[author_hex, source.id().to_string()])
                .unwrap();
            let topic = iroh_gossip::proto::TopicId::from([44; 32]);
            let mut source_topic = source_gossip.subscribe(topic, vec![]).await.unwrap();
            let mut destination_topic = destination_gossip
                .subscribe_and_join(topic, vec![source.id()])
                .await
                .unwrap();
            source_topic.joined().await.unwrap();
            let live = seal(4, Some(&fix));
            source_topic.broadcast(live.into()).await.unwrap();
            loop {
                if let iroh_gossip::api::Event::Received(message) =
                    destination_topic.next().await.unwrap().unwrap()
                {
                    let evidence =
                        collector.take_gossip(message.delivered_from.as_bytes(), &message.content);
                    assert_ne!(
                        evidence.path,
                        PathKind::Unknown,
                        "per-message connection hook"
                    );
                    assert_eq!(evidence.setup, RelaySetup::No);
                    collector.gossip(&author, 4, message.delivered_from.as_bytes(), evidence);
                    break;
                }
            }
            assert!(snapshot()
                .counts
                .iter()
                .any(|r| r.source == "friend" && r.mechanism == "gossip"));
            collector.record(
                &author,
                5,
                Some(&author),
                PathKind::Bluetooth,
                RelaySetup::Unknown,
                Mechanism::Gossip,
                delivery_stats::local_hour(),
            );
            assert!(snapshot().counts.iter().any(|r| r.source == "author"));
            let resumed = destination_store
                .add_slice(seal(6, Some(&fix)))
                .await
                .unwrap();
            let connection = destination
                .connect(source.addr(), iroh_blobs::ALPN)
                .await
                .unwrap();
            Box::new(Download {
                collector: Arc::downgrade(&collector),
                connection: connection.weak_handle(),
                before: snapshot_connection(&connection),
                setup: RelaySetup::No,
                peer: *source.id().as_bytes(),
            })
            .complete(destination_store.as_ref().clone(), resumed.hash, 1)
            .await;
            assert!(snapshot().counts.iter().any(|r| r.source == "unknown"
                && r.path == "unknown"
                && r.relay_setup == "unknown"));
            source_router.shutdown().await.unwrap();
            destination_router.shutdown().await.unwrap();
            drop((collector, sessions, recipients, delivery, sender_sessions));
            std::fs::remove_dir_all(root).unwrap();
        })
        .await
        .expect("native receipt test timed out");
    }

    fn snapshot_connection(connection: &Connection) -> RxSnapshot {
        super::snapshot(connection)
    }

    fn sample(total: u64, paths: &[(&str, PathKind, u64)]) -> RxSnapshot {
        RxSnapshot {
            total,
            coherent: true,
            paths: paths
                .iter()
                .map(|(id, kind, n)| (id.to_string(), (*kind, *n)))
                .collect(),
        }
    }

    #[test]
    fn measures_received_data_not_the_open_fallback_or_transmit_choice() {
        let before = sample(
            10,
            &[
                ("relay", PathKind::Relay, 10),
                ("ip", PathKind::DirectIp, 0),
            ],
        );
        let after = sample(
            14,
            &[
                ("relay", PathKind::Relay, 10),
                ("ip", PathKind::DirectIp, 4),
            ],
        );
        assert_eq!(classify(&before, &after), PathKind::DirectIp);
    }

    #[test]
    fn ambiguous_concurrent_streams_missing_paths_and_races_are_unknown() {
        let before = sample(10, &[("relay", PathKind::Relay, 10)]);
        for after in [
            sample(
                14,
                &[
                    ("relay", PathKind::Relay, 11),
                    ("ip", PathKind::DirectIp, 3),
                ],
            ),
            sample(14, &[("ip", PathKind::DirectIp, 3)]),
            sample(10, &[("relay", PathKind::Relay, 10)]),
            RxSnapshot {
                coherent: false,
                ..sample(14, &[("relay", PathKind::Relay, 14)])
            },
        ] {
            assert_eq!(classify(&before, &after), PathKind::Unknown);
        }
    }
}
