//! A simulated BLE radio, for running real iroh endpoints over [`BleTransport`] with no hardware.
//!
//! Added by the streetCryptid project (2026-10). The registry-level mocks in `test_util` stop at
//! the [`PeerCommand`] inbox; nothing exercised the transport the way a phone does — iroh's QUIC
//! connections opening and closing over it, the dedup hook promoting and releasing pipes. That
//! gap is where a whole evening of nearby pairing went on 2026-10-29: every pairing message is a
//! short connection, and the pipe each one used was torn down under the next.
//!
//! [`SimRadio`] stands in for the air between phones. Each node gets a real `BleTransport` built
//! by the same [`BleTransport::assemble`] the platform path uses, over a [`BleInterface`] whose
//! GATT writes and notifications land in the other node's registry inbox exactly as the `blew`
//! event pumps would deliver them: in order, after an optional latency, and only while a central
//! actually holds a link to that peripheral. Link loss is injectable, and every connect and
//! disconnect is recorded, which is what lets a test assert how many pipes a run took.
//!
//! The simulation is GATT-only ([`L2capPolicy::Disabled`]); scanning is explicit
//! ([`SimRadio::discover`]) rather than periodic, so a test controls who has seen whom.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use blew::{BleDevice, DeviceId, DisconnectCause, L2capChannel};
use bytes::Bytes;
use iroh_base::EndpointId;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::error::{BleError, BleResult};
use crate::transport::interface::BleInterface;
use crate::transport::peer::{ChannelHandle, ConnectPath, FragmentSource, PeerCommand};
use crate::transport::routing::{Routing, ScanHintUpdate, prefix_from_endpoint};
use crate::transport::store::InMemoryPeerStore;
use crate::transport::transport::{
    BleTransport, IROH_P2C_CHAR_UUID, L2capPolicy, PROTOCOL_VERSION, iroh_key_uuid,
};

/// Per-node knobs for [`SimRadio::transport`].
#[derive(Debug, Clone)]
pub struct SimNodeConfig {
    /// How long a pipe outlives its last connection. Defaults to the production value.
    pub idle_linger: Duration,
}

impl Default for SimNodeConfig {
    fn default() -> Self {
        Self {
            idle_linger: crate::transport::hook::PIPE_IDLE_LINGER,
        }
    }
}

/// One link-layer event, as the radio saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimLinkEvent {
    /// `central` opened a GATT link to `peripheral`.
    Connected {
        central: DeviceId,
        peripheral: DeviceId,
    },
    /// The link was closed: by its central (`lost == false`) or by the radio (`lost == true`).
    Disconnected {
        central: DeviceId,
        peripheral: DeviceId,
        lost: bool,
    },
}

struct SimNode {
    endpoint_id: EndpointId,
    inbox: mpsc::Sender<PeerCommand>,
    routing: Arc<Routing>,
    /// Ordered delivery into `inbox`: (deliver at, command).
    queue: mpsc::UnboundedSender<(Instant, PeerCommand)>,
}

#[derive(Default)]
struct RadioState {
    nodes: HashMap<DeviceId, SimNode>,
    /// Live GATT links as (central, peripheral).
    links: HashSet<(DeviceId, DeviceId)>,
    /// Unordered pairs currently out of range.
    out_of_range: HashSet<(DeviceId, DeviceId)>,
    latency: Duration,
    connect_delay: Duration,
    log: Vec<SimLinkEvent>,
    next_channel_id: u64,
}

fn pair_key(a: &DeviceId, b: &DeviceId) -> (DeviceId, DeviceId) {
    if a.as_str() <= b.as_str() {
        (a.clone(), b.clone())
    } else {
        (b.clone(), a.clone())
    }
}

impl RadioState {
    fn in_range(&self, a: &DeviceId, b: &DeviceId) -> bool {
        !self.out_of_range.contains(&pair_key(a, b))
    }

    fn deliver(&self, to: &DeviceId, cmd: PeerCommand) {
        if let Some(node) = self.nodes.get(to) {
            let _ = node.queue.send((Instant::now() + self.latency, cmd));
        }
    }

    fn drop_link(&mut self, central: &DeviceId, peripheral: &DeviceId, lost: bool) -> bool {
        if !self.links.remove(&(central.clone(), peripheral.clone())) {
            return false;
        }
        self.log.push(SimLinkEvent::Disconnected {
            central: central.clone(),
            peripheral: peripheral.clone(),
            lost,
        });
        self.deliver(
            peripheral,
            PeerCommand::PeripheralClientUnsubscribed {
                client_id: central.clone(),
                char_uuid: IROH_P2C_CHAR_UUID,
            },
        );
        self.deliver(
            central,
            PeerCommand::CentralDisconnected {
                device_id: peripheral.clone(),
                cause: if lost {
                    DisconnectCause::LinkLoss
                } else {
                    DisconnectCause::LocalClose
                },
            },
        );
        true
    }
}

/// The air between simulated phones. Cheap to clone; clones share one radio.
#[derive(Clone, Default)]
pub struct SimRadio {
    state: Arc<Mutex<RadioState>>,
}

impl SimRadio {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Delay applied to every GATT write and notification. Order is preserved.
    pub fn set_latency(&self, latency: Duration) {
        self.state.lock().latency = latency;
    }

    /// How long a central's `connect` takes before the link is up.
    pub fn set_connect_delay(&self, delay: Duration) {
        self.state.lock().connect_delay = delay;
    }

    /// Build a node: a real [`BleTransport`] for `endpoint_id`, reachable as `device`.
    ///
    /// # Panics
    ///
    /// If `device` is already on this radio.
    pub fn transport(
        &self,
        device: &str,
        endpoint_id: EndpointId,
        config: SimNodeConfig,
    ) -> Arc<BleTransport> {
        let device = DeviceId::from(device);
        let (inbox_tx, inbox_rx) = mpsc::channel::<PeerCommand>(256);
        let routing = Arc::new(Routing::new());

        let (queue_tx, mut queue_rx) = mpsc::unbounded_channel::<(Instant, PeerCommand)>();
        let pump_inbox = inbox_tx.clone();
        tokio::spawn(async move {
            while let Some((at, cmd)) = queue_rx.recv().await {
                tokio::time::sleep_until(at).await;
                if pump_inbox.send(cmd).await.is_err() {
                    break;
                }
            }
        });

        {
            let mut state = self.state.lock();
            assert!(
                !state.nodes.contains_key(&device),
                "{device} is already on this radio"
            );
            state.nodes.insert(
                device.clone(),
                SimNode {
                    endpoint_id,
                    inbox: inbox_tx.clone(),
                    routing: Arc::clone(&routing),
                    queue: queue_tx,
                },
            );
        }

        let iface = Arc::new(SimInterface {
            radio: self.clone(),
            me: device,
        });
        BleTransport::assemble(
            endpoint_id,
            iface,
            inbox_tx,
            inbox_rx,
            routing,
            Arc::new(InMemoryPeerStore::new()),
            L2capPolicy::Disabled,
            Arc::new(Mutex::new(HashMap::new())),
            config.idle_linger,
        )
    }

    /// `scanner` hears `advertiser`'s advertisement, as its central event pump would report it.
    ///
    /// # Panics
    ///
    /// If either device is not on this radio.
    pub async fn discover(&self, scanner: &str, advertiser: &str) {
        let (scanner, advertiser) = (DeviceId::from(scanner), DeviceId::from(advertiser));
        let (inbox, routing, advertised) = {
            let state = self.state.lock();
            let node = state.nodes.get(&scanner).expect("scanner is on the radio");
            let adv = state
                .nodes
                .get(&advertiser)
                .expect("advertiser is on the radio");
            (
                node.inbox.clone(),
                Arc::clone(&node.routing),
                adv.endpoint_id,
            )
        };
        let prefix = prefix_from_endpoint(&advertised);
        match routing.note_scan_hint(prefix, advertiser.clone()) {
            ScanHintUpdate::ActivelyBound { .. } => return,
            ScanHintUpdate::Replaced { previous } => {
                let _ = inbox
                    .send(PeerCommand::Forget {
                        device_id: previous,
                    })
                    .await;
            }
            ScanHintUpdate::New | ScanHintUpdate::Unchanged => {}
        }
        let _ = inbox
            .send(PeerCommand::Advertised {
                prefix,
                device: BleDevice {
                    id: advertiser,
                    name: None,
                    rssi: Some(-50),
                    services: vec![iroh_key_uuid(&advertised)],
                },
                rssi: Some(-50),
            })
            .await;
    }

    /// Both devices hear each other.
    pub async fn discover_both(&self, a: &str, b: &str) {
        self.discover(a, b).await;
        self.discover(b, a).await;
    }

    /// Take `a` and `b` out of range: every link between them is lost, and anything in flight is
    /// dropped until [`Self::bring_in_range`].
    pub fn take_out_of_range(&self, a: &str, b: &str) {
        let (a, b) = (DeviceId::from(a), DeviceId::from(b));
        let mut state = self.state.lock();
        state.out_of_range.insert(pair_key(&a, &b));
        state.drop_link(&a, &b, true);
        state.drop_link(&b, &a, true);
    }

    pub fn bring_in_range(&self, a: &str, b: &str) {
        let (a, b) = (DeviceId::from(a), DeviceId::from(b));
        self.state.lock().out_of_range.remove(&pair_key(&a, &b));
    }

    /// Every link event so far, in order.
    #[must_use]
    pub fn log(&self) -> Vec<SimLinkEvent> {
        self.state.lock().log.clone()
    }

    /// How many GATT links were opened between `a` and `b`, in either direction.
    #[must_use]
    pub fn connects_between(&self, a: &str, b: &str) -> usize {
        let key = pair_key(&DeviceId::from(a), &DeviceId::from(b));
        self.log()
            .iter()
            .filter(|event| match event {
                SimLinkEvent::Connected {
                    central,
                    peripheral,
                } => pair_key(central, peripheral) == key,
                SimLinkEvent::Disconnected { .. } => false,
            })
            .count()
    }

    /// Whether any GATT link between `a` and `b` is up right now.
    #[must_use]
    pub fn linked(&self, a: &str, b: &str) -> bool {
        let (a, b) = (DeviceId::from(a), DeviceId::from(b));
        let state = self.state.lock();
        state.links.contains(&(a.clone(), b.clone())) || state.links.contains(&(b, a))
    }
}

/// One node's view of the radio.
struct SimInterface {
    radio: SimRadio,
    me: DeviceId,
}

#[async_trait]
impl BleInterface for SimInterface {
    async fn connect(&self, device_id: &DeviceId) -> BleResult<ChannelHandle> {
        let delay = self.radio.state.lock().connect_delay;
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let mut state = self.radio.state.lock();
        let Some(peer) = state.nodes.get(device_id) else {
            return Err(BleError::Timeout { stage: "connect" });
        };
        if !state.in_range(&self.me, device_id) {
            return Err(BleError::Timeout { stage: "connect" });
        }
        let prefix = peer.routing.prefix_for_device(&self.me);
        state.links.insert((self.me.clone(), device_id.clone()));
        state.log.push(SimLinkEvent::Connected {
            central: self.me.clone(),
            peripheral: device_id.clone(),
        });
        // What the peripheral's `blew` pump reports once the central has subscribed to P2C —
        // which `BlewDriver::connect` does before it returns.
        state.deliver(
            device_id,
            PeerCommand::PeripheralClientSubscribed {
                client_id: self.me.clone(),
                char_uuid: IROH_P2C_CHAR_UUID,
                prefix,
            },
        );
        state.next_channel_id += 1;
        Ok(ChannelHandle {
            id: state.next_channel_id,
            path: ConnectPath::Gatt,
        })
    }

    async fn disconnect(&self, device_id: &DeviceId) -> BleResult<()> {
        // Only a central can drop a GATT link; a peripheral asking is a no-op, as on a phone.
        self.radio
            .state
            .lock()
            .drop_link(&self.me, device_id, false);
        Ok(())
    }

    async fn write_c2p(&self, device_id: &DeviceId, bytes: Bytes) -> BleResult<()> {
        let state = self.radio.state.lock();
        if !state.links.contains(&(self.me.clone(), device_id.clone())) {
            return Err(BleError::NotConnected);
        }
        state.deliver(
            device_id,
            PeerCommand::InboundGattFragment {
                device_id: self.me.clone(),
                source: FragmentSource::PeripheralReceivedC2p,
                bytes,
            },
        );
        Ok(())
    }

    async fn notify_p2c(&self, device_id: &DeviceId, bytes: Bytes) -> BleResult<()> {
        let state = self.radio.state.lock();
        if !state.links.contains(&(device_id.clone(), self.me.clone())) {
            return Err(BleError::NotConnected);
        }
        state.deliver(
            device_id,
            PeerCommand::InboundGattFragment {
                device_id: self.me.clone(),
                source: FragmentSource::CentralReceivedP2c,
                bytes,
            },
        );
        Ok(())
    }

    async fn read_psm(&self, _device_id: &DeviceId) -> BleResult<Option<u16>> {
        Ok(None)
    }

    async fn read_version(&self, _device_id: &DeviceId) -> BleResult<Option<u8>> {
        Ok(Some(PROTOCOL_VERSION))
    }

    async fn open_l2cap(&self, _device_id: &DeviceId, _psm: u16) -> BleResult<L2capChannel> {
        Err(BleError::Unsupported)
    }

    async fn start_scan(&self) -> BleResult<()> {
        Ok(())
    }

    async fn stop_scan(&self) -> BleResult<()> {
        Ok(())
    }

    async fn rebuild_server(&self) -> BleResult<()> {
        Ok(())
    }

    async fn restart_advertising(&self) -> BleResult<()> {
        Ok(())
    }

    async fn restart_l2cap_listener(&self) -> BleResult<Option<u16>> {
        Ok(None)
    }

    async fn is_powered(&self) -> bool {
        true
    }

    async fn refresh(&self, _device_id: &DeviceId) -> BleResult<()> {
        Ok(())
    }

    async fn mtu(&self, _device_id: &DeviceId) -> u16 {
        // What an iPhone typically negotiates; small enough that QUIC packets fragment.
        185
    }
}
