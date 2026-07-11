//! `iroh-location` — streetCryptid's decentralized, E2E-encrypted location core.
//!
//! Wraps iroh 1.0 (QUIC transport) + iroh-gossip 0.101 (live broadcast) and the
//! per-recipient crypto in [`crypto`], exposing a small domain API to Swift/Kotlin via
//! UniFFI (which the Expo module surfaces to React Native).
//!
//! ## Why this crate exists
//! `iroh-ffi` 1.0 exposes ONLY iroh core — gossip/docs/blobs are out of scope — so we
//! ship our own wrapper + UniFFI bindings. See `docs/social/ARCHITECTURE.md`.
//!
//! ## Build status
//! The [`crypto`] module is fully unit-tested and portable. The iroh/gossip wiring below
//! targets the API documented at <https://docs.iroh.computer/connecting/gossip> for iroh
//! 1.0 / iroh-gossip 0.101; exact method names on those (pre-1.0 gossip) crates may need
//! minor adjustment when first compiled against the pinned versions. iroh-docs (durable
//! trail recovery) is added in the `docs-recovery` milestone.

mod ble;
mod crypto;
mod docs;
mod pairing;
mod profile;
mod relay;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
#[cfg(target_os = "android")]
use std::sync::OnceLock;

use iroh::{address_lookup::MemoryLookup, protocol::Router, Endpoint, EndpointId, SecretKey};
use iroh_blobs::{store::fs::FsStore, BlobsProtocol};
use iroh_gossip::{api::Event, net::Gossip, proto::TopicId};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use iroh_tickets::endpoint::EndpointTicket;
use n0_future::StreamExt;
use tokio::sync::Mutex;

use ble::BleHandle;
use docs::{TrailDocs, TrailFix, TrailSink};
use pairing::{
    InviteData, PairCore, PairNotice, PairPhase, PairProtocol, PairResultData, PairSignal,
    PairStateData, SasChallengeData, SasRole,
};
use profile::{ProfileDocs, ProfileFields, ProfileRecord, ProfileSink};

uniffi::setup_scaffolding!();

#[cfg(target_os = "android")]
static ANDROID_APP_CONTEXT_INSTALLED: OnceLock<()> = OnceLock::new();

/// Keep library loading side-effect free. Android context + BLE classloader initialization happens
/// in `IrohAndroidBootstrap.initializeNative` after Kotlin can provide the application context.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "system" fn JNI_OnLoad(
    _vm: *mut jni::sys::JavaVM,
    _reserved: *mut std::ffi::c_void,
) -> jni::sys::jint {
    jni::sys::JNI_VERSION_1_6
}

/// Install a process-lifetime Android application context for iroh's DNS resolver.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_unrealjune_irohlocation_IrohAndroidBootstrap_initializeNative(
    mut unowned_env: jni::EnvUnowned,
    _class: jni::objects::JClass,
    context: jni::objects::JObject,
) -> jni::sys::jint {
    if ANDROID_APP_CONTEXT_INSTALLED.get().is_some() {
        return 0;
    }
    unowned_env
        .with_env(|env| -> jni::errors::Result<jni::sys::jint> {
            let vm = env.get_java_vm()?;
            let global = env.new_global_ref(&context)?;
            let vm_ptr = vm.get_raw().cast();
            let context_ptr = global.as_raw().cast();
            unsafe {
                iroh::dns::install_android_jni_context(vm_ptr, context_ptr);
            }
            // ndk-context requires this jobject to remain valid until process exit.
            std::mem::forget(global);
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                blew::platform::android::init_jvm(vm);
            }))
            .is_err()
            {
                return Ok(jni::sys::JNI_ERR);
            }
            let _ = ANDROID_APP_CONTEXT_INSTALLED.set(());
            Ok(0)
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

/// Domain-separation prefix for deriving a user's gossip topic from their EndpointId.
const TOPIC_PREFIX: &[u8] = b"streetcryptid.loc";

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum LocationError {
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("decode error: {0}")]
    Decode(String),
    #[error("node not started")]
    NotStarted,
}

impl From<crypto::CryptoError> for LocationError {
    fn from(e: crypto::CryptoError) -> Self {
        LocationError::Crypto(e.to_string())
    }
}

/// A decrypted location fix handed to the app.
#[derive(Debug, Clone, uniffi::Record, serde::Serialize, serde::Deserialize)]
pub struct LocationFix {
    pub lat: f64,
    pub lon: f64,
    pub accuracy_m: f64,
    pub heading_deg: f64,
    pub ts: u64,
}

/// A decrypted fix read back from the durable replica (mirrors the TS `NativeIncomingFix`).
#[derive(Debug, Clone, uniffi::Record)]
pub struct IncomingFix {
    pub author: Vec<u8>,
    pub seq: u64,
    pub fix: LocationFix,
}

/// Foreign (Swift/Kotlin/JS) callback for inbound events on a subscription.
#[uniffi::export(with_foreign)]
pub trait FixListener: Send + Sync + 'static {
    /// A fix we could decrypt (someone shared with us). `backfill` is `true` when the fix arrived
    /// via durable range-reconciliation (iroh-docs catch-up) rather than the live gossip path.
    fn on_fix(&self, author: Vec<u8>, seq: u64, fix: LocationFix, backfill: bool);
    /// A fix we received but could NOT decrypt (not addressed to us / revoked). Useful
    /// for presence metrics without leaking content.
    fn on_opaque(&self, author: Vec<u8>, seq: u64);
    /// Membership / connectivity status strings for the harness UI.
    fn on_status(&self, status: String);
    /// Durable-trail sync progress for an author/namespace: `started` | `completed` | `error`,
    /// with the number of recovered envelopes on completion.
    fn on_sync(&self, author: Vec<u8>, status: String, recovered: Option<u64>);
}

/// Derive the gossip topic for a given author's location stream.
#[uniffi::export]
pub fn derive_topic(author_endpoint_id: Vec<u8>) -> Vec<u8> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(TOPIC_PREFIX);
    hasher.update(&author_endpoint_id);
    hasher.finalize().as_bytes().to_vec()
}

/// Generate a fresh device "receiving key" (X25519) keypair -> (secret, public).
#[uniffi::export]
pub fn generate_recv_keypair() -> Vec<Vec<u8>> {
    let (sk, pk) = crypto::generate_recv_keypair();
    vec![sk, pk]
}

/// A verified cryptid **profile** as surfaced to the app (§3). Returned already signature- and
/// endpoint-verified; the bridge can render it directly.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ProfileView {
    pub endpoint_id: Vec<u8>,
    pub epoch: u64,
    pub handle: String,
    pub cryptid_name: String,
    pub sigil: String,
    pub color: String,
    pub recv_pub: Vec<u8>,
    pub ts: u64,
}

/// An out-of-band pairing invite. Carries only immutable bootstrap material (see
/// [`pairing::InviteData`]); mutable data travels later over the authenticated iroh connection.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PairInvite {
    pub version: u8,
    pub invite_id: Vec<u8>,
    pub secret: Vec<u8>,
    pub endpoint_id: Vec<u8>,
    pub endpoint_ticket: String,
    pub expires_at_ms: u64,
}

/// Coarse pairing session phase (UI-facing).
#[derive(Debug, Clone, uniffi::Enum)]
pub enum PairState {
    Handshaking,
    Pending,
    /// The SAS nonces are revealed + verified; both humans must clear the visual gate. No
    /// `PairResult` is reachable from here.
    Verifying,
    LocalAccepted,
    PeerAccepted,
    Complete,
    Rejected,
    Failed,
}

/// A snapshot of a pairing session's state.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PairStateRecord {
    pub session_id: Vec<u8>,
    pub peer_endpoint_id: Vec<u8>,
    pub state: PairState,
    pub local_accepted: bool,
    pub peer_accepted: bool,
    pub initiator: bool,
    /// Whether this session is an invite-less nearby pair (vs invite-based). Fixed at session
    /// creation and unaffected by later accept/reject decisions.
    pub nearby: bool,
    /// Whether the peer's SAS reveal verified (the visual gate is ready/underway).
    pub sas_verified: bool,
    /// Whether this side's human cleared the SAS gate (required before any local accept).
    pub local_sas_confirmed: bool,
}

/// The deterministic SAS role for this side, derived from the pairing transcript.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum SasRoleKind {
    /// Show the target figure and confirm the other human matched it.
    Displayer,
    /// Choose the matching figure among the options.
    Picker,
}

/// The per-session Short Authentication String challenge shown while a pair is `Verifying`.
#[derive(Debug, Clone, uniffi::Record)]
pub struct SasChallenge {
    pub role: SasRoleKind,
    /// Correct figure index (displayer shows it; picker must match it). Never sent on the wire.
    pub target_index: u32,
    /// The picker's shuffled figure indices (includes the target). Empty is never produced.
    pub option_indices: Vec<u32>,
    /// Absolute wall-clock deadline (ms since epoch). Actions after this are terminal.
    pub deadline_ms: u64,
}

/// The kind of a polled pairing event.
#[derive(Debug, Clone, uniffi::Enum)]
pub enum PairEventKind {
    /// A peer wants to pair (or our outbound Hello landed) — prompt the user.
    PendingRequest,
    /// The SAS visual gate is ready — fetch `pair_sas_challenge` and show it.
    Verifying,
    /// The peer sent their accept/reject.
    PeerResponded,
    /// Both sides accepted — call `pair_result`.
    Ready,
    /// The session was rejected by either side.
    Rejected,
    /// The session failed (SAS mismatch/cancel/timeout or a protocol error).
    Failed,
}

/// A polled pairing event (node-level queue; see `poll_pair_events`).
#[derive(Debug, Clone, uniffi::Record)]
pub struct PairEvent {
    pub kind: PairEventKind,
    pub session_id: Vec<u8>,
    pub peer_endpoint_id: Vec<u8>,
    /// Whether this session is an invite-less nearby pair (vs invite-based). Fixed at session
    /// creation and unaffected by later accept/reject decisions.
    pub nearby: bool,
}

/// The result of a completed (bilaterally-accepted) pair. Contains everything the app needs to
/// treat the peer as a friend: identity, dial hint, both read-tickets, and the verified profile.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PairResult {
    pub session_id: Vec<u8>,
    pub peer_endpoint_id: Vec<u8>,
    pub peer_recv_pub: Vec<u8>,
    pub peer_endpoint_ticket: String,
    pub peer_profile_ticket: String,
    pub peer_trail_ticket: String,
    pub peer_profile: Option<ProfileView>,
}

/// Honest BLE capability report (see [`ble`]). `pairing_ready` is the app-level acceptance gate.
#[derive(Debug, Clone, uniffi::Record)]
pub struct BleCapabilities {
    pub available: bool,
    pub active_scan_toggle: bool,
    pub rssi: bool,
    pub discovery_refresh: bool,
    pub pairing_ready: bool,
}

/// A nearby BLE peer surfaced by the transport snapshot (no RSSI — the crate discards it).
///
/// `verified_endpoint_id` and `endpoint_hint` are deliberately separate: the former is trusted
/// (set only after the iroh TLS handshake authenticates the peer), the latter is an UNTRUSTED
/// dial hint read from the peer's identity characteristic. See [`ble::BlePeerView`].
#[derive(Debug, Clone, uniffi::Record)]
pub struct BlePeer {
    pub device_id: String,
    pub phase: String,
    pub verified_endpoint_id: Option<Vec<u8>>,
    /// UNTRUSTED 32-byte dial hint from the peer's identity characteristic. Sufficient only to
    /// *attempt* `Endpoint::connect`; iroh TLS + the signed pair protocol still verify identity.
    /// `None` until a probe succeeds; never implies verification.
    pub endpoint_hint: Option<Vec<u8>>,
    pub consecutive_failures: u32,
    pub connect_path: Option<String>,
}

/// Node-level queue of verified profile updates surfaced by docs live-sync. Uses a std mutex
/// because [`ProfileSink::on_profile_update`] is a synchronous callback.
#[derive(Clone, Default)]
struct ProfileEventQueue(Arc<std::sync::Mutex<VecDeque<ProfileRecord>>>);

impl ProfileEventQueue {
    fn drain(&self) -> Vec<ProfileRecord> {
        self.0
            .lock()
            .map(|mut q| q.drain(..).collect())
            .unwrap_or_default()
    }
}

impl ProfileSink for ProfileEventQueue {
    fn on_profile_update(&self, record: ProfileRecord) {
        if let Ok(mut q) = self.0.lock() {
            q.push_back(record);
        }
    }
}

struct Started {
    endpoint: Endpoint,
    gossip: Gossip,
    trail: Arc<TrailDocs>,
    profile: Arc<ProfileDocs>,
    ble: BleHandle,
    // In-memory address lookup seeded from bootstrap tickets so gossip can dial peers directly
    // on their known LAN/direct addresses (the same-wifi fast path) instead of only via relay/DNS.
    memory: MemoryLookup,
    _router: Router,
}

/// The device node: holds identity + receiving keys and, once started, the iroh
/// endpoint + gossip router.
#[derive(uniffi::Object)]
pub struct LocationNode {
    identity_seed: [u8; 32],
    author: [u8; 32],
    recv_secret: Vec<u8>,
    recv_public: Vec<u8>,
    /// On-disk root for the persistent docs replica + blobs store (durable trail). Derived from
    /// the identity so it stays stable across restarts.
    /// TODO: let the Expo module pass the app's sandbox data dir instead of the OS temp dir.
    data_dir: PathBuf,
    inner: Mutex<Option<Started>>,
    /// The most recently attached listener, reused to surface durable-trail (backfill / sync)
    /// events from the node-level `sync_trail` call.
    listener: Mutex<Option<Arc<dyn FixListener>>>,
    /// Bilateral pairing core (`streetcryptid/pair/1`). Created at construction so its ALPN
    /// handler can be registered on the router in `start`; its live handles are attached there.
    pair: Arc<PairCore>,
    /// Node-level queue of verified profile-update events (drained via `poll_profile_events`).
    profile_events: ProfileEventQueue,
}

#[uniffi::export(async_runtime = "tokio")]
impl LocationNode {
    /// Create (or restore) a node from persisted key material. Pass `None` to generate
    /// fresh keys; then read `identity_secret()` / `recv_secret()` and persist them in
    /// the OS secure store so the EndpointId + receiving key stay stable.
    #[uniffi::constructor]
    pub fn new(
        identity_secret: Option<Vec<u8>>,
        recv_secret: Option<Vec<u8>>,
    ) -> Result<Arc<Self>, LocationError> {
        let secret = match identity_secret {
            Some(bytes) => SecretKey::from_bytes(
                &bytes
                    .try_into()
                    .map_err(|_| LocationError::Decode("bad identity key".into()))?,
            ),
            None => SecretKey::generate(),
        };
        let identity_seed = secret.to_bytes();
        let author = secret.public().as_bytes().to_owned();

        let (recv_secret, recv_public) = match recv_secret {
            Some(sk) => {
                // derive the public half from the stored secret for a stable id.
                let both = derive_recv_public(&sk)?;
                (sk, both)
            }
            None => {
                let (sk, pk) = crypto::generate_recv_keypair();
                (sk, pk)
            }
        };

        Ok(Arc::new(Self {
            identity_seed,
            author,
            recv_secret,
            recv_public: recv_public.clone(),
            data_dir: default_data_dir(&author),
            inner: Mutex::new(None),
            listener: Mutex::new(None),
            pair: PairCore::new(identity_seed, author, recv_public),
            profile_events: ProfileEventQueue::default(),
        }))
    }

    /// Bind the iroh endpoint + spawn the gossip router. Idempotent.
    pub async fn start(
        &self,
        relay_urls: Vec<String>,
        relay_auth_token: String,
    ) -> Result<(), LocationError> {
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let relay_mode = relay::custom_relay_mode(&relay_urls, &relay_auth_token)
            .map_err(LocationError::Network)?;
        let secret = SecretKey::from_bytes(&self.identity_seed);
        #[cfg(any(target_os = "android", target_vendor = "apple"))]
        let endpoint_id = secret.public();

        // Start from the N0 preset (IP transports + pkarr/DNS discovery) with our authenticated
        // relay map. On mobile we
        // ADD a BLE custom transport alongside these — we never clear IP transports or disable
        // relay, so pairing/sync work both nearby (BLE) and over the internet.
        //
        // `memory` is an in-memory address lookup added ALONGSIDE the preset's DNS/pkarr lookups
        // (Builder::address_lookup appends, it does not replace). `subscribe` seeds it with the
        // direct addresses carried in each bootstrap ticket so gossip can dial peers directly.
        let memory = MemoryLookup::new();
        #[allow(unused_mut)]
        let mut builder = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret)
            .relay_mode(relay_mode)
            .address_lookup(memory.clone());

        #[cfg(any(target_os = "android", target_vendor = "apple"))]
        let ble = {
            let (b, handle) = ble::attach(builder, endpoint_id).await;
            builder = b;
            handle
        };
        #[cfg(not(any(target_os = "android", target_vendor = "apple")))]
        let ble = ble::disabled();

        let endpoint = builder
            .bind()
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;

        // Same-wifi/direct fast path: add mDNS (swarm-discovery) local-network address lookup
        // ALONGSIDE the N0 preset's relay + DNS discovery — never replacing it. Added
        // unconditionally on ALL targets: it's harmless on desktop and is the LAN fast path we
        // want on mobile too (BLE above only covers the no-wifi nearby case). Two phones on one
        // wifi can now discover + dial each other directly, with relay/DNS remaining as fallback.
        // (On iOS/Android the OS may require a multicast entitlement / MulticastLock at runtime,
        // but that's a manifest concern, not a build-time one; if mDNS can't start we log and
        // continue on the relay path.)
        match MdnsAddressLookup::builder().build(endpoint.id()) {
            Ok(mdns) => {
                if let Ok(services) = endpoint.address_lookup() {
                    services.add(mdns);
                }
            }
            Err(e) => tracing::warn!("mDNS local discovery unavailable, using relay/DNS only: {e}"),
        }

        let gossip = Gossip::builder().spawn(endpoint.clone());

        // Durable trail + profile: persistent blobs store + docs replica, both on disk under
        // data_dir. Trail and profile are separate single-writer namespaces on the shared replica.
        std::fs::create_dir_all(&self.data_dir)
            .map_err(|e| LocationError::Network(e.to_string()))?;
        let blobs = FsStore::load(self.data_dir.join("blobs"))
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        let docs = iroh_docs::protocol::Docs::persistent(self.data_dir.clone())
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;

        let router = Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .accept(iroh_docs::ALPN, docs.clone())
            .accept(pairing::PAIR_ALPN, PairProtocol::new(self.pair.clone()))
            .spawn();

        let trail = Arc::new(
            TrailDocs::init(docs.clone(), (*blobs).clone())
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?,
        );
        let profile = Arc::new(
            ProfileDocs::init(docs, (*blobs).clone(), self.data_dir.clone())
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?,
        );

        // Wire the live handles into the pairing core so an Accept can mint our tickets and a
        // completed pair imports the peer's profile/trail namespaces.
        let sink: Arc<dyn ProfileSink> = Arc::new(self.profile_events.clone());
        self.pair
            .attach_runtime(endpoint.clone(), trail.clone(), profile.clone(), sink)
            .await;

        *guard = Some(Started {
            endpoint,
            gossip,
            trail,
            profile,
            ble,
            memory,
            _router: router,
        });
        Ok(())
    }

    /// Shut down protocol handlers and close the endpoint before releasing this node.
    pub async fn shutdown(&self) -> Result<(), LocationError> {
        let started = self.inner.lock().await.take();
        if let Some(started) = started {
            started
                ._router
                .shutdown()
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?;
        }
        *self.listener.lock().await = None;
        Ok(())
    }

    /// This device's EndpointId (== envelope `author`).
    pub fn endpoint_id(&self) -> Vec<u8> {
        self.author.to_vec()
    }

    /// The ed25519 identity secret — persist in the OS secure store.
    pub fn identity_secret(&self) -> Vec<u8> {
        self.identity_seed.to_vec()
    }

    /// The X25519 receiving secret — persist in the OS secure store.
    pub fn recv_secret(&self) -> Vec<u8> {
        self.recv_secret.clone()
    }

    /// The X25519 receiving PUBLIC key — this is the "receiving key" you hand to a friend
    /// so they can wrap fixes for you.
    pub fn recv_public(&self) -> Vec<u8> {
        self.recv_public.clone()
    }

    /// A shareable endpoint ticket (dialing info) for the contact card / bootstrap.
    pub async fn ticket(&self) -> Result<String, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let addr = started.endpoint.addr();
        Ok(EndpointTicket::new(addr).to_string())
    }

    /// Subscribe to a topic and start forwarding decrypted fixes to `listener`.
    ///
    /// `bootstrap` are peer EndpointTickets (e.g. from friends' contact cards) that are
    /// already in the topic. Returns a handle used to publish our own fixes.
    pub async fn subscribe(
        self: Arc<Self>,
        topic: Vec<u8>,
        bootstrap: Vec<String>,
        listener: Arc<dyn FixListener>,
    ) -> Result<Arc<Subscription>, LocationError> {
        let topic_id = TopicId::from_bytes(
            topic
                .try_into()
                .map_err(|_| LocationError::Decode("topic must be 32 bytes".into()))?,
        );

        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;

        // Collect bootstrap peer ids AND seed each ticket's full node addr (id + LAN/direct
        // socket addrs + relay) into our in-memory address lookup. This lets gossip dial the peer
        // DIRECTLY on its known addresses — the same-wifi fast path — instead of waiting on
        // relay/DNS resolution. The N0 preset's pkarr/DNS discovery still resolves peers over the
        // internet as a fallback. Seeding never fails, so it can't abort the subscribe; a
        // malformed ticket still surfaces the existing parse error.
        let mut bootstrap_ids: Vec<EndpointId> = Vec::new();
        for t in &bootstrap {
            let ticket: EndpointTicket = t
                .parse()
                .map_err(|_| LocationError::Decode("bad endpoint ticket".into()))?;
            started
                .memory
                .add_endpoint_info(ticket.endpoint_addr().clone());
            bootstrap_ids.push(ticket.endpoint_addr().id);
        }

        let (sender, mut receiver) = started
            .gossip
            .subscribe(topic_id, bootstrap_ids)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?
            .split();
        drop(guard);

        let recv_secret = self.recv_secret.clone();
        let cb = listener.clone();

        // Remember the listener so node-level `sync_trail` can surface backfill / sync events.
        *self.listener.lock().await = Some(listener.clone());

        // Pump inbound gossip events -> decrypt -> callback.
        let receive_task = tokio::spawn(async move {
            cb.on_status("subscribed".to_string());
            while let Some(event) = receiver.next().await {
                match event {
                    Ok(Event::Received(msg)) => match crypto::open(&recv_secret, &msg.content) {
                        Ok(opened) => {
                            if let Ok(fix) = postcard::from_bytes::<LocationFix>(&opened.payload) {
                                cb.on_fix(opened.author.to_vec(), opened.seq, fix, false);
                            }
                        }
                        Err(crypto::CryptoError::NotARecipient) => {
                            // best-effort presence signal without content
                            cb.on_opaque(Vec::new(), 0);
                        }
                        Err(_) => {}
                    },
                    Ok(Event::NeighborUp(_)) => cb.on_status("peer-up".to_string()),
                    Ok(Event::NeighborDown(_)) => cb.on_status("peer-down".to_string()),
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            cb.on_status("unsubscribed".to_string());
        });

        Ok(Arc::new(Subscription {
            node: self.clone(),
            sender: Mutex::new(sender),
            receive_task: StdMutex::new(Some(receive_task)),
        }))
    }

    // ── Durable trail (iroh-docs) — see docs/social/ARCHITECTURE.md §5–6 ──────────────────

    /// Seal `fix` for `recipients` and write it to OUR docs namespace under key `author/seq`,
    /// mirroring the gossip broadcast. Produces the identical sealed bytes as
    /// [`Subscription::publish`], so per-recipient revocation carries over. `_subscription_id`
    /// ties the write to our own topic/namespace; a node owns a single trail namespace, so it is
    /// accepted for API parity with the TS contract but not otherwise needed.
    pub async fn docs_write(
        &self,
        _subscription_id: String,
        seq: u64,
        epoch: u32,
        fix: LocationFix,
        recipients: Vec<Vec<u8>>,
    ) -> Result<(), LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let payload =
            postcard::to_allocvec(&fix).map_err(|_| LocationError::Decode("encode fix".into()))?;
        let envelope = crypto::seal(
            &self.identity_seed,
            &self.author,
            seq,
            fix.ts,
            epoch,
            &payload,
            &recipients,
        )?;
        let ns = started.trail.own_namespace();
        started
            .trail
            .write(ns, &self.author, seq, envelope)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(())
    }

    /// Kick off range-based set reconciliation across our own + imported friend namespaces to
    /// recover envelopes missed while offline. When `peer_ticket` is present, every namespace
    /// explicitly syncs with that endpoint (the trail stash). Recovered, decryptable fixes are
    /// surfaced via the attached [`FixListener`] as `on_fix(.., backfill = true)`; progress via
    /// `on_sync`.
    pub async fn sync_trail(
        &self,
        since_ts: u64,
        peer_ticket: Option<String>,
    ) -> Result<(), LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let trail = started.trail.clone();
        drop(guard);

        let peers = peer_ticket
            .map(|ticket| {
                ticket
                    .parse::<EndpointTicket>()
                    .map(|ticket| vec![ticket.endpoint_addr().clone()])
                    .map_err(|_| LocationError::Decode("bad sync peer endpoint ticket".into()))
            })
            .transpose()?
            .unwrap_or_default();
        let listener = self.listener.lock().await.clone();
        let sink = ListenerSink { listener };
        trail
            .sync_all(since_ts, peers, &sink, &self.recv_secret)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(())
    }

    /// Read decrypted fixes for `author` (self or a friend) from the local replica, `fix.ts >=
    /// since_ts`.
    pub async fn read_trail(
        &self,
        author: Vec<u8>,
        since_ts: u64,
    ) -> Result<Vec<IncomingFix>, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let fixes = started
            .trail
            .read_trail(&author, since_ts, &self.recv_secret)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(fixes
            .into_iter()
            .filter_map(trail_fix_to_incoming)
            .collect())
    }

    /// Explicitly drop durable entries older than `older_than_ts`.
    pub async fn prune_trail(&self, older_than_ts: u64) -> Result<(), LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let ns = started.trail.own_namespace();
        started
            .trail
            .prune(ns, older_than_ts)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(())
    }

    /// A shareable docs **read-ticket** granting replication of our trail namespace (the
    /// swarm-join half of a grant). Goes in the contact card.
    pub async fn doc_ticket(&self) -> Result<String, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let ns = started.trail.own_namespace();
        started
            .trail
            .read_ticket(ns)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Import a friend's docs **read-ticket** (from their contact card) so we replicate their trail
    /// namespace and can recover their missed fixes via [`sync_trail`]. This grants only
    /// replication; reading still requires our per-recipient wrap in each envelope (ARCHITECTURE §6).
    pub async fn import_doc_ticket(&self, ticket: String) -> Result<(), LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        started
            .trail
            .import_ticket(&ticket)
            .await
            .map(|_| ())
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    // ── Profile docs namespace — see docs/social/ARCHITECTURE.md §3 ────────────────────────

    /// Sign + publish our profile to the dedicated profile namespace, returning the new epoch.
    /// The epoch is monotonic and wall-clock-anchored so it keeps strictly increasing across node
    /// restarts (the in-memory epoch counter resets, but `now_ms()` does not), which the readers'
    /// rollback guard requires.
    pub async fn publish_profile(
        &self,
        handle: String,
        cryptid_name: String,
        sigil: String,
        color: String,
    ) -> Result<u64, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let fields = ProfileFields {
            handle,
            cryptid_name,
            sigil,
            color,
        };
        let last = started.profile.last_epoch(&self.author).await;
        let epoch = now_ms().max(last.saturating_add(1));
        let bytes = profile::build_signed(
            &self.identity_seed,
            &self.author,
            &self.recv_public,
            epoch,
            now_ms(),
            &fields,
        )
        .map_err(|e| LocationError::Decode(e.to_string()))?;
        started
            .profile
            .publish(&self.author, epoch, bytes)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(epoch)
    }

    /// A shareable **read**-ticket for our profile namespace. Also exchanged automatically inside
    /// a pairing Accept, so friends usually don't need to import it by hand.
    pub async fn profile_ticket(&self) -> Result<String, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        started
            .profile
            .ticket()
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Import a friend's profile read-ticket and begin replicating + live-syncing their profile;
    /// accepted updates surface via [`poll_profile_events`](Self::poll_profile_events).
    pub async fn import_profile_ticket(&self, ticket: String) -> Result<(), LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let ns = started
            .profile
            .import_ticket(&ticket)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        let sink: Arc<dyn ProfileSink> = Arc::new(self.profile_events.clone());
        started.profile.watch(ns, sink);
        Ok(())
    }

    /// Read the newest verified profile for `endpoint_id` (self or a friend) from the local
    /// replica. `None` if absent or not yet replicated.
    pub async fn read_profile(
        &self,
        endpoint_id: Vec<u8>,
    ) -> Result<Option<ProfileView>, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let rec = started
            .profile
            .read_for_endpoint(&endpoint_id)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(rec.map(|r| profile_view(&r)))
    }

    /// Drain profile-update events surfaced by docs live-sync since the last poll.
    pub async fn poll_profile_events(&self) -> Vec<ProfileView> {
        self.profile_events
            .drain()
            .iter()
            .map(profile_view)
            .collect()
    }

    // ── Bilateral pairing (`streetcryptid/pair/1`) — see ARCHITECTURE.md §4 ────────────────

    /// Set whether we accept invite-less **nearby** (e.g. BLE) pairing Hellos. Invite-based
    /// pairing is always allowed. This is an app-level acceptance gate, not a radio control.
    pub fn set_pairing_ready(&self, ready: bool) {
        self.pair.set_pairing_ready(ready);
    }

    /// Whether invite-less nearby pairing is currently accepted.
    pub fn pairing_ready(&self) -> bool {
        self.pair.pairing_ready()
    }

    /// Mint a one-shot, time-limited invite carrying only immutable bootstrap material.
    pub async fn create_invite(&self, ttl_secs: u64) -> Result<PairInvite, LocationError> {
        let inv = self
            .pair
            .create_invite(ttl_secs)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(invite_to_uniffi(&inv))
    }

    /// Begin an invite-based pair from a decoded [`PairInvite`]. Returns the session id.
    pub async fn initiate_pair(&self, invite: PairInvite) -> Result<Vec<u8>, LocationError> {
        let inv = invite_from_uniffi(&invite)?;
        let sid = self
            .pair
            .initiate_by_invite(&inv)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(sid.to_vec())
    }

    /// Begin an invite-based pair from an opaque invite token (`scpair1:…`). Returns the session id.
    pub async fn initiate_pair_by_ticket(&self, token: String) -> Result<Vec<u8>, LocationError> {
        let inv =
            pairing::decode_invite(&token).map_err(|e| LocationError::Decode(e.to_string()))?;
        let sid = self
            .pair
            .initiate_by_invite(&inv)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(sid.to_vec())
    }

    /// Begin an invite-less **nearby** pair with a peer discovered over BLE (they must be
    /// pairing-ready). Returns the deterministic session id.
    pub async fn initiate_pair_nearby(
        &self,
        peer_endpoint_id: Vec<u8>,
    ) -> Result<Vec<u8>, LocationError> {
        let ep: [u8; 32] = peer_endpoint_id
            .try_into()
            .map_err(|_| LocationError::Decode("endpoint id must be 32 bytes".into()))?;
        let sid = self
            .pair
            .initiate_nearby(ep)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(sid.to_vec())
    }

    /// Accept or reject a pending pairing session. `accept == true` **requires the local SAS
    /// visual check to be confirmed first** (via [`submit_pair_choice`](Self::submit_pair_choice)
    /// or [`confirm_pair_display`](Self::confirm_pair_display)); otherwise it errors, which closes
    /// the door on legacy/premature acceptance. `accept == false` is a cancel/reject path. A
    /// friendship result is emitted only after BOTH sides accept — poll for a `Ready` event, then
    /// call [`pair_result`](Self::pair_result).
    pub async fn respond_pair(
        &self,
        session_id: Vec<u8>,
        accept: bool,
    ) -> Result<(), LocationError> {
        let sid = session_id_arr(&session_id)?;
        self.pair
            .respond(&sid, accept)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// The active SAS visual challenge for a session, or `None` if the gate isn't live (not yet
    /// verified, complete/terminal, or expired). It remains available after an on-time local
    /// confirmation so the UI can show that this phone is waiting for its peer.
    pub async fn pair_sas_challenge(
        &self,
        session_id: Vec<u8>,
    ) -> Result<Option<SasChallenge>, LocationError> {
        let sid = session_id_arr(&session_id)?;
        Ok(self
            .pair
            .sas_challenge(&sid)
            .await
            .as_ref()
            .map(sas_challenge))
    }

    /// Picker action: submit the chosen figure index. A correct choice latches the local SAS and
    /// sends `Accept`; a wrong / late choice is terminal (no retry in the same session).
    pub async fn submit_pair_choice(
        &self,
        session_id: Vec<u8>,
        chosen_index: u32,
    ) -> Result<(), LocationError> {
        let sid = session_id_arr(&session_id)?;
        let choice = u16::try_from(chosen_index)
            .map_err(|_| LocationError::Decode("chosen index out of range".into()))?;
        self.pair
            .submit_sas_choice(&sid, choice)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Displayer action: confirm whether the other human matched the shown figure. `true` latches
    /// the local SAS and sends `Accept`; `false` (or a late action) is terminal.
    pub async fn confirm_pair_display(
        &self,
        session_id: Vec<u8>,
        matched: bool,
    ) -> Result<(), LocationError> {
        let sid = session_id_arr(&session_id)?;
        self.pair
            .confirm_sas_display(&sid, matched)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Cancel a pairing under SAS verification — terminal (requires a fresh attempt).
    pub async fn cancel_pair(&self, session_id: Vec<u8>) -> Result<(), LocationError> {
        let sid = session_id_arr(&session_id)?;
        self.pair
            .cancel_sas(&sid)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Drain pairing events (pending requests, peer responses, ready, rejects) since the last poll.
    pub async fn poll_pair_events(&self) -> Vec<PairEvent> {
        self.pair
            .poll_notices()
            .await
            .iter()
            .map(pair_event)
            .collect()
    }

    /// Inspect a single session's current state, or `None` if unknown.
    pub async fn pair_state(
        &self,
        session_id: Vec<u8>,
    ) -> Result<Option<PairStateRecord>, LocationError> {
        let sid = session_id_arr(&session_id)?;
        Ok(self
            .pair
            .session_state(&sid)
            .await
            .as_ref()
            .map(state_record))
    }

    /// List all known pairing sessions.
    pub async fn list_pair_sessions(&self) -> Vec<PairStateRecord> {
        self.pair
            .list_sessions()
            .await
            .iter()
            .map(state_record)
            .collect()
    }

    /// The completed-pair result for a session, enriched with the peer's verified latest profile
    /// (once replicated). `None` until both sides have accepted.
    pub async fn pair_result(
        &self,
        session_id: Vec<u8>,
    ) -> Result<Option<PairResult>, LocationError> {
        let sid = session_id_arr(&session_id)?;
        let data = match self.pair.result_data(&sid).await {
            Some(d) => d,
            None => return Ok(None),
        };
        let guard = self.inner.lock().await;
        let peer_profile = match guard.as_ref() {
            Some(started) => started
                .profile
                .read_for_endpoint(&data.peer_endpoint)
                .await
                .ok()
                .flatten()
                .map(|r| profile_view(&r)),
            None => None,
        };
        Ok(Some(pair_result(&data, peer_profile)))
    }

    // ── BLE status (Android/Apple only; honest stub elsewhere) — ARCHITECTURE.md §2 ────────

    /// Whether a BLE transport is wired into this node's endpoint on this platform.
    pub async fn ble_available(&self) -> bool {
        let guard = self.inner.lock().await;
        guard.as_ref().map(|s| s.ble.available()).unwrap_or(false)
    }

    /// Honest BLE capability report combined with the app-level pairing-ready gate. The transport
    /// exposes no active scan toggle / RSSI / discovery-refresh, so those are always `false`.
    pub async fn ble_capabilities(&self) -> BleCapabilities {
        let guard = self.inner.lock().await;
        let caps = guard.as_ref().map(|s| s.ble.capabilities());
        let pairing_ready = self.pair.pairing_ready();
        match caps {
            Some(c) => BleCapabilities {
                available: c.available,
                active_scan_toggle: c.active_scan_toggle,
                rssi: c.rssi,
                discovery_refresh: c.discovery_refresh,
                pairing_ready,
            },
            None => BleCapabilities {
                available: false,
                active_scan_toggle: false,
                rssi: false,
                discovery_refresh: false,
                pairing_ready,
            },
        }
    }

    /// Snapshot of nearby BLE peers surfaced by the transport (empty on host / when unavailable).
    /// No RSSI/proximity is included — the vendored crate discards it.
    ///
    /// The node mutex is released before probing: `nearby_peers().await` may open a short-lived BLE
    /// connection to read a stranger's identity characteristic, so we clone the handle, drop the
    /// guard, then await — never holding the lock across the probe.
    pub async fn nearby_ble_peers(&self) -> Vec<BlePeer> {
        let handle = {
            let guard = self.inner.lock().await;
            match guard.as_ref() {
                Some(started) => started.ble.clone(),
                None => return Vec::new(),
            }
        };
        handle.nearby_peers().await.iter().map(ble_peer).collect()
    }

    /// Passive proximity hint: has this peer's BLE advertisement been seen this session? This is
    /// the honest substitute for RSSI/active-scan the vendored crate does not expose; it triggers
    /// no active scan (the transport scans continuously). Always `false` on host / when unavailable.
    pub async fn ble_has_scan_hint(&self, endpoint_id: Vec<u8>) -> bool {
        let guard = self.inner.lock().await;
        guard
            .as_ref()
            .map(|s| s.ble.has_scan_hint(&endpoint_id))
            .unwrap_or(false)
    }
}

/// Default on-disk root for the persistent trail store when the host doesn't supply one.
fn default_data_dir(author: &[u8; 32]) -> PathBuf {
    let mut name = String::with_capacity(64);
    for b in author {
        name.push_str(&format!("{b:02x}"));
    }
    std::env::temp_dir().join("streetcryptid").join(name)
}

/// Current unix time in milliseconds.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Convert a verified [`ProfileRecord`] into the UniFFI [`ProfileView`].
fn profile_view(r: &ProfileRecord) -> ProfileView {
    ProfileView {
        endpoint_id: r.endpoint_id.clone(),
        epoch: r.epoch,
        handle: r.handle.clone(),
        cryptid_name: r.cryptid_name.clone(),
        sigil: r.sigil.clone(),
        color: r.color.clone(),
        recv_pub: r.recv_pub.clone(),
        ts: r.ts,
    }
}

/// A 16-byte session id from a UniFFI byte vector.
fn session_id_arr(v: &[u8]) -> Result<[u8; 16], LocationError> {
    <[u8; 16]>::try_from(v).map_err(|_| LocationError::Decode("session id must be 16 bytes".into()))
}

fn phase_to_state(p: PairPhase) -> PairState {
    match p {
        PairPhase::Handshaking => PairState::Handshaking,
        PairPhase::Pending => PairState::Pending,
        PairPhase::Verifying => PairState::Verifying,
        PairPhase::LocalAccepted => PairState::LocalAccepted,
        PairPhase::PeerAccepted => PairState::PeerAccepted,
        PairPhase::Complete => PairState::Complete,
        PairPhase::Rejected => PairState::Rejected,
        PairPhase::Failed => PairState::Failed,
    }
}

fn signal_to_kind(s: PairSignal) -> PairEventKind {
    match s {
        PairSignal::PendingRequest => PairEventKind::PendingRequest,
        PairSignal::Verifying => PairEventKind::Verifying,
        PairSignal::PeerResponded => PairEventKind::PeerResponded,
        PairSignal::Ready => PairEventKind::Ready,
        PairSignal::Rejected => PairEventKind::Rejected,
        PairSignal::Failed => PairEventKind::Failed,
    }
}

fn state_record(d: &PairStateData) -> PairStateRecord {
    PairStateRecord {
        session_id: d.session_id.to_vec(),
        peer_endpoint_id: d.peer_endpoint.to_vec(),
        state: phase_to_state(d.phase),
        local_accepted: d.local_accepted,
        peer_accepted: d.peer_accepted,
        initiator: d.initiator,
        nearby: d.nearby,
        sas_verified: d.sas_verified,
        local_sas_confirmed: d.local_sas_confirmed,
    }
}

fn sas_challenge(c: &SasChallengeData) -> SasChallenge {
    SasChallenge {
        role: match c.role {
            SasRole::Displayer => SasRoleKind::Displayer,
            SasRole::Picker => SasRoleKind::Picker,
        },
        target_index: c.target_index as u32,
        option_indices: c.option_indices.iter().map(|i| *i as u32).collect(),
        deadline_ms: c.deadline_ms,
    }
}

fn pair_event(n: &PairNotice) -> PairEvent {
    PairEvent {
        kind: signal_to_kind(n.signal),
        session_id: n.session_id.to_vec(),
        peer_endpoint_id: n.peer_endpoint.to_vec(),
        nearby: n.nearby,
    }
}

fn pair_result(d: &PairResultData, peer_profile: Option<ProfileView>) -> PairResult {
    PairResult {
        session_id: d.session_id.to_vec(),
        peer_endpoint_id: d.peer_endpoint.to_vec(),
        peer_recv_pub: d.peer_recv_pub.to_vec(),
        peer_endpoint_ticket: d.peer_endpoint_ticket.clone(),
        peer_profile_ticket: d.peer_profile_ticket.clone(),
        peer_trail_ticket: d.peer_trail_ticket.clone(),
        peer_profile,
    }
}

fn invite_to_uniffi(inv: &InviteData) -> PairInvite {
    PairInvite {
        version: inv.version,
        invite_id: inv.invite_id.to_vec(),
        secret: inv.secret.to_vec(),
        endpoint_id: inv.endpoint_id.to_vec(),
        endpoint_ticket: inv.endpoint_ticket.clone(),
        expires_at_ms: inv.expires_at_ms,
    }
}

fn invite_from_uniffi(inv: &PairInvite) -> Result<InviteData, LocationError> {
    Ok(InviteData {
        version: inv.version,
        invite_id: <[u8; 16]>::try_from(inv.invite_id.as_slice())
            .map_err(|_| LocationError::Decode("invite id must be 16 bytes".into()))?,
        secret: <[u8; 16]>::try_from(inv.secret.as_slice())
            .map_err(|_| LocationError::Decode("invite secret must be 16 bytes".into()))?,
        endpoint_id: <[u8; 32]>::try_from(inv.endpoint_id.as_slice())
            .map_err(|_| LocationError::Decode("endpoint id must be 32 bytes".into()))?,
        endpoint_ticket: inv.endpoint_ticket.clone(),
        expires_at_ms: inv.expires_at_ms,
    })
}

fn ble_peer(p: &ble::BlePeerView) -> BlePeer {
    BlePeer {
        device_id: p.device_id.clone(),
        phase: p.phase.clone(),
        verified_endpoint_id: p.verified_endpoint_id.clone(),
        endpoint_hint: p.endpoint_hint.clone(),
        consecutive_failures: p.consecutive_failures,
        connect_path: p.connect_path.clone(),
    }
}

/// Encode a [`PairInvite`] into an opaque, dependency-free `scpair1:<hex>` token for QR / links.
#[uniffi::export]
pub fn encode_pair_invite(invite: PairInvite) -> Result<String, LocationError> {
    let inv = invite_from_uniffi(&invite)?;
    pairing::encode_invite(&inv).map_err(|e| LocationError::Decode(e.to_string()))
}

/// Decode an opaque `scpair1:<hex>` token back into a [`PairInvite`].
#[uniffi::export]
pub fn decode_pair_invite(token: String) -> Result<PairInvite, LocationError> {
    let inv = pairing::decode_invite(&token).map_err(|e| LocationError::Decode(e.to_string()))?;
    Ok(invite_to_uniffi(&inv))
}

/// Convert a decrypted [`TrailFix`] into the UniFFI [`IncomingFix`], decoding the payload.
fn trail_fix_to_incoming(tf: TrailFix) -> Option<IncomingFix> {
    let fix = postcard::from_bytes::<LocationFix>(&tf.payload).ok()?;
    Some(IncomingFix {
        author: tf.author,
        seq: tf.seq,
        fix,
    })
}

/// Bridges [`docs::TrailSink`] callbacks to the foreign [`FixListener`] for durable-trail events.
struct ListenerSink {
    listener: Option<Arc<dyn FixListener>>,
}

impl TrailSink for ListenerSink {
    fn on_backfill(&self, author: Vec<u8>, seq: u64, payload: Vec<u8>) {
        if let Some(listener) = &self.listener {
            if let Ok(fix) = postcard::from_bytes::<LocationFix>(&payload) {
                listener.on_fix(author, seq, fix, true);
            }
        }
    }

    fn on_sync_status(&self, author: Vec<u8>, status: String, recovered: Option<u64>) {
        if let Some(listener) = &self.listener {
            listener.on_sync(author, status, recovered);
        }
    }
}

/// Derive the X25519 public key from a stored receiving secret (round-trips a seal to
/// self would be wasteful; instead we re-import and read the public half).
fn derive_recv_public(recv_secret: &[u8]) -> Result<Vec<u8>, LocationError> {
    use hpke::{Deserializable, Serializable};
    let sk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(recv_secret)
        .map_err(|_| LocationError::Decode("bad recv key".into()))?;
    let pk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::sk_to_pk(&sk);
    Ok(pk.to_bytes().to_vec())
}

/// A live topic subscription; publish fixes through it.
#[derive(uniffi::Object)]
pub struct Subscription {
    node: Arc<LocationNode>,
    sender: Mutex<iroh_gossip::api::GossipSender>,
    receive_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Ok(mut task) = self.receive_task.lock() {
            if let Some(task) = task.take() {
                task.abort();
            }
        }
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl Subscription {
    /// Seal `fix` for `recipients` (each = a friend's 32-byte receiving public key) and
    /// broadcast it on the topic. Recipients NOT in this list cannot decrypt it —
    /// that's how revocation works.
    pub async fn publish(
        &self,
        seq: u64,
        epoch: u32,
        fix: LocationFix,
        recipients: Vec<Vec<u8>>,
    ) -> Result<(), LocationError> {
        let payload =
            postcard::to_allocvec(&fix).map_err(|_| LocationError::Decode("encode fix".into()))?;
        let envelope = crypto::seal(
            &self.node.identity_seed,
            &self.node.author,
            seq,
            fix.ts,
            epoch,
            &payload,
            &recipients,
        )?;
        let sender = self.sender.lock().await;
        sender
            .broadcast(envelope.into())
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(())
    }
}
