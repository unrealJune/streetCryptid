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
//! ## Honest capabilities
//! The vendored transport scans continuously and discards RSSI internally; its public API has no
//! active scan toggle, no RSSI, and no explicit discovery-refresh trigger. Rather than invent
//! those, [`BleHandle::capabilities`] reports them as `false`. We DO surface the passive
//! `has_scan_hint` signal (whether a peer's advertisement was seen this session) and the peer
//! snapshot the crate exposes.
//!
//! ## Invite-less stranger bootstrap (endpoint hints)
//! The vendored transport's advertisement embeds only the first 12 bytes of the peer's
//! `EndpointId` (a scan *prefix*), which is not enough to `Endpoint::connect` a stranger you have
//! no invite for. To close that gap we register our OWN read-only GATT identity service carrying
//! the full 32-byte local `EndpointId` (see `imp::IDENTITY_SERVICE_UUID`) alongside — never
//! replacing — the transport's services, and we probe that characteristic on unresolved peers via
//! the retained [`Central`](iroh_ble_transport::Central) to obtain a dial *hint*.
//!
//! **Security:** the hint is UNTRUSTED — it is only ever sufficient to *call* `Endpoint::connect`.
//! Authenticated iroh TLS and the signed pair protocol still bind and reject the real identity, so
//! a spoofed hint cannot impersonate anyone. The hint is surfaced as
//! [`BlePeerView::endpoint_hint`] and is kept strictly separate from
//! [`BlePeerView::verified_endpoint_id`], which is populated only after the iroh handshake.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Radio-level BLE capabilities, reported honestly (see module docs). The pairing-readiness gate
/// is tracked separately by [`crate::pairing::PairCore`] and combined at the UniFFI boundary.
#[derive(Clone, Debug)]
pub struct BleCaps {
    /// A BLE transport is wired into the endpoint on this platform.
    pub available: bool,
    /// The transport exposes an active scan on/off toggle. (It does not.)
    pub active_scan_toggle: bool,
    /// The transport surfaces per-peer RSSI / proximity. (It does not.)
    pub rssi: bool,
    /// The transport exposes an explicit discovery-refresh/boost trigger. (It does not; scanning
    /// is always-on. The passive [`BleHandle::has_scan_hint`] read is available instead.)
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

/// Per-session cache + dedup guard for endpoint-hint probes, keyed by BLE device id string.
///
/// A single [`BleHandle`] shares one of these (via `Arc`, so `Clone` is cheap and every clone
/// sees the same state). It exists to make [`BleHandle::nearby_peers`] cheap and safe to poll
/// repeatedly:
/// * successful hints are cached so we never re-probe a resolved device,
/// * a device with an in-flight probe is skipped (no probe storms across polls),
/// * a device whose probe failed is put on a short cooldown before it can be retried.
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
    /// device ids with a probe currently running.
    in_flight: HashSet<String>,
    /// device id → earliest instant a new probe may start after a failure.
    cooldown_until: HashMap<String, Instant>,
}

#[allow(dead_code)]
impl ProbeCache {
    /// The cached hint for `device_id`, if a prior probe succeeded.
    fn cached(&self, device_id: &str) -> Option<Vec<u8>> {
        self.lock().hints.get(device_id).cloned()
    }

    /// Try to reserve a probe slot for `device_id`. Returns `true` — and marks the device
    /// in-flight — only when there is no cached hint, no probe already running, and any
    /// post-failure cooldown has elapsed as of `now`. The caller MUST then eventually call
    /// [`finish_success`](Self::finish_success) or [`finish_failure`](Self::finish_failure).
    fn begin(&self, device_id: &str, now: Instant) -> bool {
        let mut inner = self.lock();
        if inner.hints.contains_key(device_id) || inner.in_flight.contains(device_id) {
            return false;
        }
        if inner
            .cooldown_until
            .get(device_id)
            .is_some_and(|&t| now < t)
        {
            return false;
        }
        inner.in_flight.insert(device_id.to_owned());
        true
    }

    /// Record a validated hint, clearing the in-flight flag and any cooldown.
    fn finish_success(&self, device_id: &str, hint: Vec<u8>) {
        let mut inner = self.lock();
        inner.in_flight.remove(device_id);
        inner.cooldown_until.remove(device_id);
        inner.hints.insert(device_id.to_owned(), hint);
    }

    /// Clear the in-flight flag and arm a cooldown so this device is not re-probed until
    /// `retry_at` (bounds retry pressure on peers that never answer).
    fn finish_failure(&self, device_id: &str, retry_at: Instant) {
        let mut inner = self.lock();
        inner.in_flight.remove(device_id);
        inner.cooldown_until.insert(device_id.to_owned(), retry_at);
    }

    /// Lock the inner state, recovering from a poisoned mutex (a panicked probe task must
    /// never permanently wedge hint caching).
    fn lock(&self) -> std::sync::MutexGuard<'_, ProbeCacheInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(any(target_os = "android", target_vendor = "apple"))]
mod imp {
    use super::{parse_endpoint_hint, BleCaps, BlePeerView, ProbeCache};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use iroh::endpoint::Builder;
    use iroh::EndpointId;
    use iroh_ble_transport::{
        AttributePermissions, BlePeerInfo, BlePeerPhase, BleResult, BleTransport, Central,
        CharacteristicProperties, DeviceId, GattCharacteristic, GattService, Peripheral,
    };
    use uuid::Uuid;

    /// streetCryptid identity GATT service — read-only, carries the full 32-byte local
    /// `EndpointId`. Registered on our own peripheral *alongside* the transport's services so a
    /// stranger can read the full id we otherwise only advertise a 12-byte prefix of.
    ///
    /// The UUIDs use a distinct `5c7d1d0x` base (mnemonic "sC") that cannot collide with the
    /// transport's `69726f0x` ("iro") family — see `third_party/iroh-ble-transport` `IROH_*_UUID`
    /// and `KEY_UUID_PREFIX`.
    const IDENTITY_SERVICE_UUID: Uuid = Uuid::from_u128(0x5c7d_1d00_9b6f_4c3a_8e21_0a5b_7c9d_1e2f);
    const IDENTITY_CHAR_UUID: Uuid = Uuid::from_u128(0x5c7d_1d01_9b6f_4c3a_8e21_0a5b_7c9d_1e2f);

    /// How long the peripheral is given to power on before we register the identity service.
    const READY_TIMEOUT: Duration = Duration::from_secs(5);
    /// Upper bound on a single connect → discover → read identity probe.
    const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
    /// Upper bound on the best-effort disconnect that follows a probe.
    const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(3);
    /// Minimum spacing between probe attempts for a peer that has not answered.
    const PROBE_COOLDOWN: Duration = Duration::from_secs(30);

    /// Live BLE handle held by a started node.
    ///
    /// Retains the `central`/`peripheral` we built the transport on: `central` is reused to probe
    /// stranger identity characteristics for dial hints, and `peripheral` is held for the
    /// transport's lifetime so our identity service stays registered. `probe_cache` dedupes and
    /// caches those probes across polls.
    #[derive(Clone)]
    pub struct BleHandle {
        transport: Option<Arc<BleTransport>>,
        central: Option<Arc<Central>>,
        #[allow(dead_code)]
        peripheral: Option<Arc<Peripheral>>,
        probe_cache: ProbeCache,
    }

    /// The read-only identity service exposing `endpoint_id`'s full 32 bytes. Read-only with a
    /// static value keeps it safe on CoreBluetooth (the SIGABRT caveat only affects writable
    /// characteristics that carry a non-empty value).
    fn identity_service(endpoint_id: EndpointId) -> GattService {
        GattService {
            uuid: IDENTITY_SERVICE_UUID,
            primary: false,
            characteristics: vec![GattCharacteristic {
                uuid: IDENTITY_CHAR_UUID,
                properties: CharacteristicProperties::READ,
                permissions: AttributePermissions::READ,
                value: endpoint_id.as_bytes().to_vec(),
                descriptors: vec![],
            }],
        }
    }

    /// Construct our own central + peripheral, register the identity service on the peripheral
    /// *before* the transport begins advertising, then build the transport on top of them.
    async fn setup(
        endpoint_id: EndpointId,
    ) -> BleResult<(Arc<BleTransport>, Arc<Central>, Arc<Peripheral>)> {
        let central = Arc::new(Central::new().await?);
        let peripheral = Arc::new(Peripheral::new().await?);

        // `add_service` requires a powered peripheral, so wait for readiness first. The transport's
        // own `construct()` waits again (idempotent) before registering its services and starting
        // advertising, guaranteeing our service is present before any advertising begins.
        peripheral.wait_ready(READY_TIMEOUT).await?;
        peripheral
            .add_service(&identity_service(endpoint_id))
            .await?;

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

    /// Whether a peer in this phase should have its identity characteristic probed. We only probe
    /// freshly `Discovered` strangers: the transport has not connected to them yet (it dials only
    /// when iroh has pending sends), so our short probe cannot collide with an active transport
    /// GATT/L2CAP pipe. Every other live phase already has, or is actively establishing, a
    /// transport connection.
    fn should_probe(phase: BlePeerPhase) -> bool {
        matches!(phase, BlePeerPhase::Discovered)
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

    /// Probe a peer's identity characteristic for its full endpoint id. The connect → discover →
    /// read sequence is bounded by [`PROBE_TIMEOUT`]; the disconnect afterwards is best-effort and
    /// separately bounded. Returns the validated 32-byte hint, or `None` on any timeout, error, or
    /// invalid value — the caller keeps IP/relay and transport state untouched on `None`.
    async fn probe_endpoint_hint(central: &Central, device_id: &DeviceId) -> Option<Vec<u8>> {
        let read = tokio::time::timeout(PROBE_TIMEOUT, async {
            central.connect(device_id).await?;
            central.discover_services(device_id).await?;
            let value = central
                .read_characteristic(device_id, IDENTITY_CHAR_UUID)
                .await?;
            Ok::<Vec<u8>, iroh_ble_transport::BlewError>(value)
        })
        .await;

        // Always release the link we opened, regardless of the read outcome.
        let _ = tokio::time::timeout(DISCONNECT_TIMEOUT, central.disconnect(device_id)).await;

        match read {
            Ok(Ok(value)) => parse_endpoint_hint(&value),
            Ok(Err(error)) => {
                tracing::debug!(%error, "endpoint-hint probe read failed");
                None
            }
            Err(_) => {
                tracing::debug!("endpoint-hint probe timed out");
                None
            }
        }
    }

    impl BleHandle {
        pub fn available(&self) -> bool {
            self.transport.is_some()
        }

        pub fn capabilities(&self) -> BleCaps {
            // The transport is present, but the crate exposes no active toggle / RSSI / refresh.
            BleCaps {
                available: self.available(),
                active_scan_toggle: false,
                rssi: false,
                discovery_refresh: false,
            }
        }

        /// Snapshot the transport's peers, attaching a cached endpoint hint to any peer that has no
        /// verified endpoint yet, and kicking off a bounded background probe for freshly discovered
        /// strangers we have not resolved. No lock is held across `.await`: probes run on spawned
        /// tasks and their results surface on a subsequent call.
        pub async fn nearby_peers(&self) -> Vec<BlePeerView> {
            let Some(transport) = &self.transport else {
                return Vec::new();
            };
            let peers = transport.snapshot_peers();
            let now = Instant::now();
            let mut views = Vec::with_capacity(peers.len());
            for info in &peers {
                let mut view = peer_view(info);
                // Only unresolved peers get a hint; a verified endpoint supersedes any hint.
                if view.verified_endpoint_id.is_none() {
                    let key = info.device_id.to_string();
                    if let Some(hint) = self.probe_cache.cached(&key) {
                        view.endpoint_hint = Some(hint);
                    } else if should_probe(info.phase) && self.probe_cache.begin(&key, now) {
                        self.spawn_probe(info.device_id.clone(), key);
                    }
                }
                views.push(view);
            }
            views
        }

        /// Spawn a background probe for `device_id`, recording success or failure in the cache on
        /// completion (a failure arms a cooldown so a silent peer is not hammered).
        fn spawn_probe(&self, device_id: DeviceId, key: String) {
            let Some(central) = self.central.clone() else {
                self.probe_cache
                    .finish_failure(&key, Instant::now() + PROBE_COOLDOWN);
                return;
            };
            let cache = self.probe_cache.clone();
            tokio::spawn(async move {
                match probe_endpoint_hint(&central, &device_id).await {
                    Some(hint) => cache.finish_success(&key, hint),
                    None => cache.finish_failure(&key, Instant::now() + PROBE_COOLDOWN),
                }
            });
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
    use super::{BleCaps, BlePeerView};

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

        pub fn has_scan_hint(&self, _endpoint_id: &[u8]) -> bool {
            false
        }
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::{parse_endpoint_hint, ProbeCache};
    use std::time::{Duration, Instant};

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
    fn probe_cache_begin_dedupes_in_flight_probes() {
        let cache = ProbeCache::default();
        let now = Instant::now();
        assert!(cache.begin("dev-a", now), "first probe is admitted");
        assert!(
            !cache.begin("dev-a", now),
            "a second probe while one is in-flight is rejected"
        );
        // A different device is independent.
        assert!(cache.begin("dev-b", now));
    }

    #[test]
    fn probe_cache_caches_success_and_never_reprobes() {
        let cache = ProbeCache::default();
        let now = Instant::now();
        assert!(cache.cached("dev-a").is_none());

        assert!(cache.begin("dev-a", now));
        let hint = valid_endpoint_bytes();
        cache.finish_success("dev-a", hint.clone());

        assert_eq!(cache.cached("dev-a"), Some(hint));
        // Once cached, begin never admits another probe — not now, not far in the future.
        assert!(!cache.begin("dev-a", now));
        assert!(!cache.begin("dev-a", now + Duration::from_secs(3600)));
    }

    #[test]
    fn probe_cache_failure_arms_cooldown_then_allows_retry() {
        let cache = ProbeCache::default();
        let t0 = Instant::now();
        assert!(cache.begin("dev-a", t0));

        let retry_at = t0 + Duration::from_secs(30);
        cache.finish_failure("dev-a", retry_at);

        // Still in cooldown → rejected.
        assert!(!cache.begin("dev-a", t0 + Duration::from_secs(10)));
        assert!(!cache.begin("dev-a", retry_at - Duration::from_nanos(1)));
        // Failure did not cache a hint.
        assert!(cache.cached("dev-a").is_none());
        // Cooldown elapsed → a fresh probe is admitted again.
        assert!(cache.begin("dev-a", retry_at));
    }
}
