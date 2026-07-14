//! BLE transport integration — target-gated to the platforms streetCryptid ships natively
//! (Android + Apple) where the vendored [`iroh_ble_transport`] crate's `blew` backend compiles.
//!
//! See `docs/social/ARCHITECTURE.md` §2 and `third_party/iroh-ble-transport/`. On mobile we add
//! a BLE [`CustomTransport`](iroh::endpoint::transports::CustomTransport) **alongside** iroh's
//! normal N0 IP/relay transports (we do NOT clear IP transports or disable relay) so nearby peers
//! can pair and sync without internet. On the host (Windows/Linux) builds — used for `cargo test`
//! and the `uniffi-bindgen` CLI — there is no BLE dependency and [`BleHandle`] is an honest,
//! always-unavailable stub.
//!
//! ## Bump rendezvous
//! The transport scanner already receives RSSI, but the old app flow discarded it and relied on a
//! passive identity probe that could take longer than the motion-consent window. Bump restarts the
//! existing scanner on demand, ranks fresh iroh advertisements by RSSI, rejects ambiguous crowds,
//! and resolves the strongest peer's full EndpointId from the transport's own GATT service. No
//! second advertiser/scanner is created, so Android/iOS keep one coherent BLE lifecycle.
//!
//! The advertised key UUID contains the first 12 bytes of the peer's `EndpointId`. The full id is
//! still an UNTRUSTED dial hint until iroh TLS authenticates the connection, and the probe rejects
//! any full identity that does not match that advertised prefix.
//!
//! **Security:** the hint is UNTRUSTED — it is only ever sufficient to *call* `Endpoint::connect`.
//! Authenticated iroh TLS and the signed pair protocol still bind and reject the real identity, so
//! a spoofed hint cannot impersonate anyone. The hint is surfaced as
//! [`BlePeerView::endpoint_hint`] and is kept strictly separate from
//! [`BlePeerView::verified_endpoint_id`], which is populated only after the iroh handshake.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Radio-level BLE capabilities, reported honestly (see module docs). The pairing-readiness gate
/// is tracked separately by [`crate::pairing::PairCore`] and combined at the UniFFI boundary.
#[derive(Clone, Debug)]
pub struct BleCaps {
    /// A BLE transport is wired into the endpoint on this platform.
    pub available: bool,
    /// The app can explicitly refresh the shared scan for foreground Bump resolution.
    pub active_scan_toggle: bool,
    /// Fresh Bump advertisements include RSSI.
    pub rssi: bool,
    /// Bump can restart the shared scanner to force a fresh discovery pass.
    pub discovery_refresh: bool,
}

impl BleCaps {
    #[allow(dead_code)]
    fn unavailable() -> Self {
        Self {
            available: false,
            active_scan_toggle: false,
            rssi: false,
            discovery_refresh: false,
        }
    }
}

/// A nearby BLE peer as surfaced by the transport's snapshot. Field values that reference foreign
/// types (device id, connect path) are rendered as strings.
///
/// The two endpoint-id fields are deliberately distinct and must never be conflated:
/// * `verified_endpoint_id` — the 32-byte iroh endpoint id **after** the BLE handshake has
///   authenticated the peer over iroh TLS. Trustworthy.
/// * `endpoint_hint` — a 32-byte endpoint id read from the peer's streetCryptid identity GATT
///   characteristic before any handshake. **UNTRUSTED**: only good enough to *attempt*
///   `Endpoint::connect`; iroh TLS + the signed pair protocol still verify the real identity.
#[derive(Clone, Debug)]
pub struct BlePeerView {
    pub device_id: String,
    pub phase: String,
    pub verified_endpoint_id: Option<Vec<u8>>,
    /// Untrusted dial hint from the peer's identity characteristic (see the struct docs). `None`
    /// until a probe succeeds; never implies verification.
    pub endpoint_hint: Option<Vec<u8>>,
    pub consecutive_failures: u32,
    pub connect_path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BumpResolvedPeer {
    pub device_id: String,
    pub endpoint_id: Vec<u8>,
    pub rssi: Option<i16>,
    pub peer_count: u32,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BumpResolveError {
    Unavailable,
    NoPeers,
    Ambiguous { peer_count: u32 },
    ProbeFailed { peer_count: u32, detail: String },
}

/// Validate an untrusted characteristic read as an iroh `EndpointId` dial hint.
///
/// Returns the 32 bytes only when they are exactly 32 bytes long *and* parse as a valid
/// ed25519 curve point (`EndpointId::from_bytes`). This is the sole gate a probed value passes
/// before being surfaced as [`BlePeerView::endpoint_hint`]; it guarantees the app can hand the
/// bytes straight to `Endpoint::connect` without the hint ever being treated as verified.
#[allow(dead_code)]
fn parse_endpoint_hint(bytes: &[u8]) -> Option<Vec<u8>> {
    let arr: [u8; 32] = bytes.try_into().ok()?;
    // Reject anything that is not a real endpoint id; never fails for `EndpointId::as_bytes`.
    iroh::EndpointId::from_bytes(&arr).ok()?;
    Some(arr.to_vec())
}

/// Per-session cache of successfully resolved endpoint hints, keyed by BLE device id string.
#[derive(Clone, Default)]
#[allow(dead_code)]
struct ProbeCache {
    inner: Arc<Mutex<ProbeCacheInner>>,
}

#[derive(Default)]
#[allow(dead_code)]
struct ProbeCacheInner {
    /// device id → validated 32-byte endpoint hint.
    hints: HashMap<String, Vec<u8>>,
}

#[allow(dead_code)]
impl ProbeCache {
    /// The cached hint for `device_id`, if a prior probe succeeded.
    fn cached(&self, device_id: &str) -> Option<Vec<u8>> {
        self.lock().hints.get(device_id).cloned()
    }

    fn store(&self, device_id: &str, hint: Vec<u8>) {
        self.lock().hints.insert(device_id.to_owned(), hint);
    }

    /// Lock the inner state, recovering from a poisoned mutex (a panicked probe task must
    /// never permanently wedge hint caching).
    fn lock(&self) -> std::sync::MutexGuard<'_, ProbeCacheInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(any(target_os = "android", target_vendor = "apple"))]
mod imp {
    use super::{
        parse_endpoint_hint, BleCaps, BlePeerView, BumpResolveError, BumpResolvedPeer, ProbeCache,
    };
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use iroh::endpoint::Builder;
    use iroh::EndpointId;
    use iroh_ble_transport::{
        is_iroh_key_uuid, key_uuid_matches_endpoint, BleDevice, BlePeerInfo, BlePeerPhase,
        BleResult, BleTransport, Central, CentralConfig, CentralEvent, Peripheral, ScanFilter,
        IROH_IDENTITY_CHAR_UUID,
    };
    use tokio_stream::StreamExt;
    use uuid::Uuid;

    const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
    const SCAN_WINDOW: Duration = Duration::from_millis(1400);
    const PROBE_TIMEOUT: Duration = Duration::from_secs(6);
    /// Upper bound on the best-effort disconnect that follows a probe.
    const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(2);
    const REDISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);
    const AMBIGUOUS_RSSI_DELTA_DB: i16 = 7;
    const MAX_PROBE_ATTEMPTS: usize = 2;

    /// Live BLE handle held by a started node.
    ///
    /// Retains the single `central`/`peripheral` pair used by the transport so Bump can perform a
    /// fresh, explicit resolution without competing for another mobile advertiser.
    #[derive(Clone)]
    pub struct BleHandle {
        transport: Option<Arc<BleTransport>>,
        central: Option<Arc<Central>>,
        #[allow(dead_code)]
        peripheral: Option<Arc<Peripheral>>,
        probe_cache: ProbeCache,
        resolve_lock: Arc<tokio::sync::Mutex<()>>,
    }

    /// Construct one shared central + peripheral for iroh traffic and Bump rendezvous.
    async fn setup(
        endpoint_id: EndpointId,
    ) -> BleResult<(Arc<BleTransport>, Arc<Central>, Arc<Peripheral>)> {
        let central = Arc::new(
            Central::with_config(CentralConfig {
                connect_timeout: Some(CONNECT_TIMEOUT),
                ..CentralConfig::default()
            })
            .await?,
        );
        let peripheral = Arc::new(Peripheral::new().await?);

        let transport = BleTransport::builder()
            .central(Arc::clone(&central))
            .peripheral(Arc::clone(&peripheral))
            .build(endpoint_id)
            .await?;
        Ok((transport, central, peripheral))
    }

    /// Build the BLE transport for `endpoint_id` and wire its dedup hook, custom transport, and
    /// address lookup onto `builder` (additive — N0 IP/relay transports stay intact). If the radio
    /// or permission is unavailable, log the failure and return the untouched IP/relay builder.
    pub async fn attach(builder: Builder, endpoint_id: EndpointId) -> (Builder, BleHandle) {
        match setup(endpoint_id).await {
            Ok((transport, central, peripheral)) => {
                let builder = builder
                    .hooks(transport.dedup_hook())
                    .add_custom_transport(transport.as_custom_transport())
                    .address_lookup(transport.address_lookup());
                (
                    builder,
                    BleHandle {
                        transport: Some(transport),
                        central: Some(central),
                        peripheral: Some(peripheral),
                        probe_cache: ProbeCache::default(),
                        resolve_lock: Arc::new(tokio::sync::Mutex::new(())),
                    },
                )
            }
            Err(error) => {
                tracing::warn!(%error, "BLE transport unavailable; continuing with IP/relay");
                (builder, disabled())
            }
        }
    }

    pub fn disabled() -> BleHandle {
        BleHandle {
            transport: None,
            central: None,
            peripheral: None,
            probe_cache: ProbeCache::default(),
            resolve_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn phase_str(p: BlePeerPhase) -> &'static str {
        match p {
            BlePeerPhase::Unknown => "unknown",
            BlePeerPhase::Discovered => "discovered",
            BlePeerPhase::PendingDial => "pending-dial",
            BlePeerPhase::Connecting => "connecting",
            BlePeerPhase::Handshaking => "handshaking",
            BlePeerPhase::Connected => "connected",
            BlePeerPhase::Draining => "draining",
            BlePeerPhase::Reconnecting => "reconnecting",
            BlePeerPhase::Dead => "dead",
            BlePeerPhase::Restoring => "restoring",
            _ => "other",
        }
    }

    fn peer_view(info: &BlePeerInfo) -> BlePeerView {
        BlePeerView {
            device_id: format!("{:?}", info.device_id),
            phase: phase_str(info.phase).to_string(),
            verified_endpoint_id: info.verified_endpoint.map(|id| id.as_bytes().to_vec()),
            // Filled in by the caller from the probe cache; never inferred from the snapshot.
            endpoint_hint: None,
            consecutive_failures: info.consecutive_failures,
            connect_path: info.connect_path.as_ref().map(|p| format!("{p:?}")),
        }
    }

    fn advertised_key_uuid(device: &BleDevice) -> Option<Uuid> {
        device
            .services
            .iter()
            .find(|uuid| is_iroh_key_uuid(uuid))
            .copied()
    }

    fn matching_endpoint_hint(device: &BleDevice, value: &[u8]) -> Option<Vec<u8>> {
        let key_uuid = advertised_key_uuid(device)?;
        let hint = parse_endpoint_hint(value)?;
        let endpoint_bytes: [u8; 32] = hint.as_slice().try_into().ok()?;
        let endpoint = EndpointId::from_bytes(&endpoint_bytes).ok()?;
        key_uuid_matches_endpoint(&key_uuid, &endpoint).then_some(hint)
    }

    async fn probe_endpoint_hint(
        central: &Central,
        transport: &BleTransport,
        device: &BleDevice,
        budget: Duration,
    ) -> Result<Vec<u8>, String> {
        advertised_key_uuid(device).ok_or_else(|| "missing iroh advertisement".to_string())?;
        let read = tokio::time::timeout(std::cmp::min(PROBE_TIMEOUT, budget), async {
            central
                .connect(&device.id)
                .await
                .map_err(|error| format!("connect failed: {error}"))?;
            let services = central
                .discover_services(&device.id)
                .await
                .map_err(|error| format!("service discovery failed: {error}"))?;
            let identity_present = services.iter().any(|service| {
                service
                    .characteristics
                    .iter()
                    .any(|characteristic| characteristic.uuid == IROH_IDENTITY_CHAR_UUID)
            });
            if !identity_present {
                return Err("identity characteristic missing".to_string());
            }
            central
                .read_characteristic(&device.id, IROH_IDENTITY_CHAR_UUID)
                .await
                .map_err(|error| format!("identity read failed: {error}"))
        })
        .await;

        #[cfg(target_os = "android")]
        if !matches!(read, Ok(Ok(_))) {
            let _ = central.refresh(&device.id).await;
        }

        let mut events = central.events();
        transport.expect_probe_disconnect(device.id.clone());
        let _ = tokio::time::timeout(DISCONNECT_TIMEOUT, central.disconnect(&device.id)).await;
        let disconnected = tokio::time::timeout(DISCONNECT_TIMEOUT, async {
            while let Some(event) = events.next().await {
                if matches!(
                    event,
                    CentralEvent::DeviceDisconnected { ref device_id, .. } if *device_id == device.id
                ) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        if !disconnected {
            return Err("identity probe disconnect did not complete".to_string());
        }

        let _ = central.stop_scan().await;
        central
            .start_scan(ScanFilter::default())
            .await
            .map_err(|error| format!("scan restart failed: {error}"))?;
        let rediscovered = tokio::time::timeout(REDISCOVERY_TIMEOUT, async {
            while let Some(event) = events.next().await {
                if matches!(
                    event,
                    CentralEvent::DeviceDiscovered(ref fresh)
                        if fresh.id == device.id && advertised_key_uuid(fresh).is_some()
                ) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        if !rediscovered {
            return Err("identity probe peer was not rediscovered".to_string());
        }

        let value = match read {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err("identity probe timed out".to_string()),
        };
        matching_endpoint_hint(device, &value)
            .ok_or_else(|| "identity did not match the advertised prefix".to_string())
    }

    async fn collect_fresh_devices(central: &Central, budget: Duration) -> Vec<BleDevice> {
        let mut events = central.events();
        let _ = central.stop_scan().await;
        if central.start_scan(ScanFilter::default()).await.is_err() {
            return Vec::new();
        }

        let deadline = tokio::time::Instant::now() + std::cmp::min(SCAN_WINDOW, budget);
        let mut devices = HashMap::<String, BleDevice>::new();
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, events.next()).await {
                Ok(Some(CentralEvent::DeviceDiscovered(device)))
                    if advertised_key_uuid(&device).is_some() =>
                {
                    devices.insert(device.id.to_string(), device);
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        devices.into_values().collect()
    }

    impl BleHandle {
        pub fn available(&self) -> bool {
            self.transport.is_some()
        }

        pub fn capabilities(&self) -> BleCaps {
            BleCaps {
                available: self.available(),
                active_scan_toggle: self.available(),
                rssi: self.available(),
                discovery_refresh: self.available(),
            }
        }

        /// Snapshot the transport's peers. Passive polling never opens a surprise GATT connection;
        /// endpoint hints are populated only by an explicit Bump resolution.
        pub async fn nearby_peers(&self) -> Vec<BlePeerView> {
            let Some(transport) = &self.transport else {
                return Vec::new();
            };
            let peers = transport.snapshot_peers();
            let mut views = Vec::with_capacity(peers.len());
            for info in &peers {
                let mut view = peer_view(info);
                if view.verified_endpoint_id.is_none() {
                    let key = info.device_id.to_string();
                    view.endpoint_hint = self.probe_cache.cached(&key);
                }
                views.push(view);
            }
            views
        }

        pub async fn resolve_bump_peer(
            &self,
            timeout: Duration,
        ) -> Result<BumpResolvedPeer, BumpResolveError> {
            let Some(central) = self.central.clone() else {
                return Err(BumpResolveError::Unavailable);
            };
            let Some(transport) = self.transport.as_ref() else {
                return Err(BumpResolveError::Unavailable);
            };
            let _resolve_guard = self.resolve_lock.lock().await;
            let started = tokio::time::Instant::now();
            let mut devices = collect_fresh_devices(&central, timeout).await;
            if devices.is_empty() {
                return Err(BumpResolveError::NoPeers);
            }
            devices.sort_by(|left, right| {
                right
                    .rssi
                    .unwrap_or(i16::MIN)
                    .cmp(&left.rssi.unwrap_or(i16::MIN))
            });
            let peer_count = u32::try_from(devices.len()).unwrap_or(u32::MAX);
            if let [first, second, ..] = devices.as_slice() {
                if let (Some(first_rssi), Some(second_rssi)) = (first.rssi, second.rssi) {
                    if first_rssi.saturating_sub(second_rssi) <= AMBIGUOUS_RSSI_DELTA_DB {
                        return Err(BumpResolveError::Ambiguous { peer_count });
                    }
                }
            }

            let transport_peers = transport.snapshot_peers();
            let mut last_error = "no candidate could be resolved".to_string();
            for device in devices {
                let key = device.id.to_string();
                let known = transport_peers
                    .iter()
                    .find(|peer| peer.device_id == device.id)
                    .and_then(|peer| peer.verified_endpoint)
                    .map(|endpoint| endpoint.as_bytes().to_vec())
                    .or_else(|| self.probe_cache.cached(&key));
                if let Some(endpoint_id) = known {
                    if matching_endpoint_hint(&device, &endpoint_id).is_some() {
                        return Ok(BumpResolvedPeer {
                            device_id: key,
                            endpoint_id,
                            rssi: device.rssi,
                            peer_count,
                        });
                    }
                }

                for attempt in 0..MAX_PROBE_ATTEMPTS {
                    let elapsed = tokio::time::Instant::now().saturating_duration_since(started);
                    if elapsed >= timeout {
                        break;
                    }
                    match probe_endpoint_hint(&central, transport, &device, timeout - elapsed).await
                    {
                        Ok(endpoint_id) => {
                            self.probe_cache.store(&key, endpoint_id.clone());
                            return Ok(BumpResolvedPeer {
                                device_id: key,
                                endpoint_id,
                                rssi: device.rssi,
                                peer_count,
                            });
                        }
                        Err(error) => {
                            last_error = error;
                            if attempt + 1 < MAX_PROBE_ATTEMPTS {
                                tokio::time::sleep(Duration::from_millis(300)).await;
                            }
                        }
                    }
                }
            }
            Err(BumpResolveError::ProbeFailed {
                peer_count,
                detail: last_error,
            })
        }

        /// Passive read: has this peer's advertisement been seen this session? (No active scan is
        /// triggered; the crate scans continuously.)
        pub fn has_scan_hint(&self, endpoint_id: &[u8]) -> bool {
            let Some(transport) = &self.transport else {
                return false;
            };
            match <[u8; 32]>::try_from(endpoint_id) {
                Ok(arr) => match EndpointId::from_bytes(&arr) {
                    Ok(id) => transport.has_scan_hint_for_endpoint(&id),
                    Err(_) => false,
                },
                Err(_) => false,
            }
        }
    }
}

#[cfg(not(any(target_os = "android", target_vendor = "apple")))]
mod imp {
    use super::{BleCaps, BlePeerView, BumpResolveError, BumpResolvedPeer};
    use std::time::Duration;

    /// Host stub: no BLE radio on this platform.
    #[derive(Clone, Default)]
    pub struct BleHandle;

    /// Host builds have no BLE; return the disabled handle.
    pub fn disabled() -> BleHandle {
        BleHandle
    }

    impl BleHandle {
        pub fn available(&self) -> bool {
            false
        }

        pub fn capabilities(&self) -> BleCaps {
            BleCaps::unavailable()
        }

        /// Async to mirror the mobile handle (which probes/caches). Host has no BLE, so this is
        /// trivially empty.
        #[allow(clippy::unused_async)]
        pub async fn nearby_peers(&self) -> Vec<BlePeerView> {
            Vec::new()
        }

        #[allow(clippy::unused_async)]
        pub async fn resolve_bump_peer(
            &self,
            _timeout: Duration,
        ) -> Result<BumpResolvedPeer, BumpResolveError> {
            Err(BumpResolveError::Unavailable)
        }

        pub fn has_scan_hint(&self, _endpoint_id: &[u8]) -> bool {
            false
        }
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::{parse_endpoint_hint, ProbeCache};

    /// A real, valid 32-byte iroh endpoint id (public key) derived deterministically.
    fn valid_endpoint_bytes() -> Vec<u8> {
        iroh::SecretKey::from_bytes(&[7u8; 32])
            .public()
            .as_bytes()
            .to_vec()
    }

    #[test]
    fn parse_endpoint_hint_accepts_valid_32_byte_id() {
        let bytes = valid_endpoint_bytes();
        let parsed = parse_endpoint_hint(&bytes).expect("valid endpoint id must parse");
        assert_eq!(
            parsed, bytes,
            "the validated hint is the input bytes verbatim"
        );
        assert_eq!(parsed.len(), 32);
        // Round-trips back into an EndpointId — i.e. it is dial-able.
        let arr: [u8; 32] = parsed.try_into().unwrap();
        assert!(iroh::EndpointId::from_bytes(&arr).is_ok());
    }

    #[test]
    fn parse_endpoint_hint_rejects_non_curve_point() {
        // Not every 32-byte string is a valid ed25519 point (~half fail to decompress). Corrupt a
        // real key until dalek refuses it, proving parse rejects non-points — not merely
        // wrong-length inputs.
        let mut bytes: [u8; 32] = valid_endpoint_bytes().try_into().unwrap();
        let mut found = false;
        for i in 0..=u8::MAX {
            bytes[0] = i;
            if iroh::EndpointId::from_bytes(&bytes).is_err() {
                assert!(
                    parse_endpoint_hint(&bytes).is_none(),
                    "a value iroh rejects must not become a hint"
                );
                found = true;
                break;
            }
        }
        assert!(found, "expected some corruption to yield a non-point");
    }

    #[test]
    fn parse_endpoint_hint_rejects_wrong_length() {
        assert!(parse_endpoint_hint(&[]).is_none());
        assert!(parse_endpoint_hint(&[0u8; 31]).is_none());
        assert!(parse_endpoint_hint(&[0u8; 33]).is_none());
        // Even a valid id truncated by one byte must be rejected.
        let mut short = valid_endpoint_bytes();
        short.pop();
        assert!(parse_endpoint_hint(&short).is_none());
    }

    #[test]
    fn probe_cache_starts_empty() {
        let cache = ProbeCache::default();
        assert!(cache.cached("dev-a").is_none());
    }

    #[test]
    fn probe_cache_stores_successful_hints() {
        let cache = ProbeCache::default();
        let hint = valid_endpoint_bytes();
        cache.store("dev-a", hint.clone());
        assert_eq!(cache.cached("dev-a"), Some(hint));
    }
}
