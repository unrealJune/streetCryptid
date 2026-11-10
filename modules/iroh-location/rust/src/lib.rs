//! `iroh-location` — streetCryptid's decentralized, E2E-encrypted location core.
//!
//! Wraps iroh (QUIC transport) + iroh-docs/iroh-blobs (the one location transport) and the
//! per-recipient crypto in [`crypto`], exposing a small domain API to Swift/Kotlin via
//! UniFFI (which the Expo module surfaces to React Native).
//!
//! ## The transport, in one paragraph
//! Every fix is sealed into one envelope and written to the author's own iroh-docs namespace
//! (one slot per author). Delivery is that namespace replicating: iroh-docs' live engine
//! broadcasts a local insert to every peer syncing the namespace (it uses iroh-gossip for that
//! internally — nothing else in this crate speaks gossip), a drain pushes it to the stash and the
//! pool by set reconciliation, and a reader pulls. Readers learn of new entries from their own
//! replica, never from a separate live channel. See `docs.rs` and `docs/social/ARCHITECTURE.md`.
//!
//! ## Why this crate exists
//! `iroh-ffi` exposes ONLY iroh core — gossip/docs/blobs are out of scope — so we ship our own
//! wrapper + UniFFI bindings.

/// Rust's share of the native heap, counted by a wrapper around the system allocator.
mod alloc_stats;
mod ble;
mod contact;
pub mod crypto;
pub mod delivery;
mod docs;
mod durable;
/// `friend.pull` spans: a native runtime's receive-side pull, with what it cost against the OS's
/// background allowance (see the module docs).
pub mod friend_pull;
pub mod gate;
mod h3;
/// `node.isolation`: noticing this phone reaches nobody, and healing it (see the module docs).
pub mod isolation;
/// `location.runtime` spans: the native location runtime reporting itself (see the module docs).
pub mod location_runtime;
/// Festival-mesh radio capsules: the outer wrapper that carries an envelope over open
/// radio without a linkable identity (pure; see `mesh.rs` and `docs/mesh/DESIGN.md`).
pub mod mesh;
/// Native MVT tile/bundle decoder for the map pipeline (pure; see `mvt.rs`).
pub mod mvt;
/// `net.health` spans: relay failures by host, the endpoint's counters, the platform's network.
pub mod net_health;
/// Which docs namespaces a node reopens on every start, in `state_dir` (see the module docs).
pub mod ns_book;
pub mod outbox;
pub mod own_log;
pub mod pad;
mod pairing;
/// `process.memory` spans: the platform runtime sampling its own process (see the module docs).
pub mod process_memory;
mod profile;
pub mod publish;
pub mod ratchet;
pub mod recipients;
pub mod restart;
pub mod seq_store;
pub mod session_store;
pub mod sessions;
mod stash;
pub mod transport;

/// The `mesh_epoch` every DOCS-path envelope carries.
///
/// The envelope's epoch field belongs to the mesh capsule layer (`crypto::Envelope::mesh_epoch`).
/// The docs path has no 15-minute epoch, so it writes a constant — and it is a constant rather
/// than a parameter deliberately: FORWARD-SECRECY.md §7 step 4 separates the two meanings, and a
/// caller-supplied value would leave them merged in the signed AAD by convention only.
///
/// The docs-path key epoch is the per-wrap `i` in the v3 ratchet header (§4.7), not this.
pub const DOCS_MESH_EPOCH: u32 = 0;
pub mod host;
mod relay;
/// iroh's DNS through the OS resolver on Apple and Android, never a nameserver list.
mod system_dns;
mod telemetry;
mod telemetry_spool;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
#[cfg(target_os = "android")]
use std::sync::OnceLock;
use std::sync::RwLock as StdRwLock;

use iroh::{protocol::Router, Endpoint, EndpointAddr, EndpointId, SecretKey};
use iroh_blobs::{store::fs::FsStore, BlobsProtocol};
use iroh_gossip::net::Gossip;
use iroh_mdns_address_lookup::MdnsAddressLookup;
use iroh_tickets::endpoint::EndpointTicket;
use tokio::sync::Mutex;

use ble::BleHandle;
use docs::TrailDocs;
use pairing::{
    InviteData, PairCore, PairNotice, PairPhase, PairProtocol, PairResultData, PairSignal,
    PairStateData, SasChallengeData, SasRole,
};
use profile::{ProfileDocs, ProfileFields, ProfileRecord, ProfileSink};
pub use telemetry::{
    configure_telemetry, flush_telemetry, push_telemetry_now, set_telemetry_spool_dir,
    TelemetryPush,
};

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

/// Upper bound on `Endpoint::bind` in [`LocationNode::start`].
///
/// Generous, because binding legitimately waits on relay DNS and a first network probe on a cold
/// radio, and a `start` that fails is a `start` the caller has to retry. It exists only to make
/// the wait finite: `start` is on the launch path, so anything unbounded there is a hung splash
/// screen rather than a slow one.
const ENDPOINT_BIND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// How long [`LocationNode::cancel_pair`] waits for the peer to hear about a cancel before it
/// returns and lets delivery finish in the background.
const CANCEL_PAIR_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

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

impl From<mesh::MeshError> for LocationError {
    fn from(e: mesh::MeshError) -> Self {
        match e {
            mesh::MeshError::Malformed | mesh::MeshError::UnsupportedVersion(_) => {
                LocationError::Decode(e.to_string())
            }
            _ => LocationError::Crypto(e.to_string()),
        }
    }
}

/// A decrypted location fix handed to the app.
///
/// The first five fields describe a **position**. The last two describe the **envelope that
/// carried it**, and they are the difference between a friend who has stopped moving and a friend
/// whose phone has died — which looked identical on the map until 2026-09-05, because the only
/// clock the UI had was [`ts`](Self::ts), and a heartbeat deliberately preserves the ORIGINAL `ts`
/// (see [`crate::publish::DrainEngine::heartbeat`]).
///
/// They are stamped at seal time by [`crate::publish::DrainEngine::drain`] and are `None`
/// everywhere else: on capture, in the outbox, and in the gate's `last_known_fix`. A position does
/// not have a "when was this sent" or a "was the phone parked"; a transmission does.
///
/// `None` on a *received* fix means the sender predates these fields. See [`decode_fix_payload`]
/// for why that decodes rather than failing.
#[derive(Debug, Clone, uniffi::Record, serde::Serialize, serde::Deserialize)]
pub struct LocationFix {
    pub lat: f64,
    pub lon: f64,
    pub accuracy_m: f64,
    pub heading_deg: f64,
    pub ts: u64,
    /// Why the position is what it is, as one of `FIX_STATE_*`.
    ///
    /// A plain `u8` rather than an enum: an unknown future value from a newer peer must degrade to
    /// "I do not recognise this" rather than fail the whole payload.
    pub state: Option<u8>,
    /// Seconds between [`ts`](Self::ts) and the moment this envelope was sealed.
    ///
    /// Delta-encoded rather than absolute because it is always small and always non-negative — a
    /// position cannot be sent before it is measured — and a varint of a day's worth of seconds is
    /// three bytes where an absolute epoch-ms is six. The receiver reads liveness as
    /// `ts + published_delta_s * 1000`, which is a different clock from `ts` itself: a parked phone
    /// republishes an hours-old position from a process that is alive right now.
    pub published_delta_s: Option<u32>,
}

/// The frozen on-disk twin of [`LocationFix`].
///
/// The outbox and the gate persist positions with postcard, and both DISCARD everything on a
/// decode failure — `outbox.rs` starts with an empty queue, `gate.rs` falls back to
/// `GateState::default()`. That fallback is deliberate and correct for corruption, but it makes a
/// struct change indistinguishable from corruption: a `GateState` that loses `last_known_fix` has
/// nothing for `heartbeat` to republish, so it returns 0 and the phone publishes nothing until it
/// happens to catch a fresh acceptable fix. On a parked phone that is hours. It is the 2026-08-30
/// silence exactly, and growing [`LocationFix`] would have re-armed it on every device at once, on
/// upgrade, with no way to tell it had happened.
///
/// So storage gets a type that never changes, and the FFI/wire type is free to grow. The envelope
/// stamps are absent here rather than stored as `None` — they describe a transmission that has not
/// happened yet, and a queued fix has no answer for them.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StoredFix {
    pub lat: f64,
    pub lon: f64,
    pub accuracy_m: f64,
    pub heading_deg: f64,
    pub ts: u64,
}

impl From<&LocationFix> for StoredFix {
    fn from(f: &LocationFix) -> Self {
        Self {
            lat: f.lat,
            lon: f.lon,
            accuracy_m: f.accuracy_m,
            heading_deg: f.heading_deg,
            ts: f.ts,
        }
    }
}

impl From<&StoredFix> for LocationFix {
    fn from(f: &StoredFix) -> Self {
        Self {
            lat: f.lat,
            lon: f.lon,
            accuracy_m: f.accuracy_m,
            heading_deg: f.heading_deg,
            ts: f.ts,
            state: None,
            published_delta_s: None,
        }
    }
}

/// The position is fresh: it passed the confidence gate on this wake.
pub const FIX_STATE_LIVE: u8 = 1;
/// The phone has parked. The position is the anchor it settled on and will not advance until it
/// moves again — so a silence that follows this envelope is *explained*, and the UI should say
/// "parked", not "offline".
///
/// This is the whole reason the field exists. Liveness cannot be inferred from contact continuing,
/// because on iOS it does not: parked publishing rides on `BGProcessing` wakes the OS grants a
/// handful of times a day, so the observed gap between contacts is p50 5 min but p90 92 min with a
/// 17-hour maximum — on a phone that was working the entire time. A declaration survives that
/// silence; a heartbeat does not.
pub const FIX_STATE_PARKED: u8 = 2;
/// The phone is not parked, but nothing passed the gate — indoors, a tunnel, reduced accuracy. The
/// position is the last accepted one and the person may be moving. Distinct from
/// [`FIX_STATE_PARKED`] because "parked at the pub" and "somewhere on the Underground" are
/// different sentences, and only the sender can tell them apart (see `IngestOutcome::rejection`).
pub const FIX_STATE_NO_FIX: u8 = 3;

/// A decrypted fix read back from the durable replica (mirrors the TS `NativeIncomingFix`).
#[derive(Debug, Clone, uniffi::Record)]
pub struct IncomingFix {
    pub author: Vec<u8>,
    pub seq: u64,
    pub fix: LocationFix,
}

/// A decrypted ratcheted envelope read from the durable replica.
///
/// `kind` is `fix` or `null`; `fix` is present only for the fix lane. Keeping null envelopes in
/// this result lets the app observe the symmetric return path instead of silently discarding the
/// very messages that keep a one-directional relationship's ratchet alive.
#[derive(Debug, Clone, uniffi::Record)]
pub struct RatchetEvent {
    pub author: Vec<u8>,
    pub seq: u64,
    pub ts: u64,
    pub kind: String,
    pub fix: Option<LocationFix>,
    /// Hex EndpointId of the peer that served this author's entry during the last reconciliation,
    /// when one was observed. `None` means the entry was already in the replica — read back, not
    /// just delivered — so there is no serving peer to name.
    pub via_peer: Option<String>,
}

/// Foreign (Swift/Kotlin) access to this device's identity, wherever the platform keeps it.
///
/// The background drain path has to build a node with no JS context alive, and the identity it
/// needs lives in the OS keystore that `expo-secure-store` writes: the iOS Keychain under
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, and Android Keystore-wrapped preferences.
/// Rust cannot read either, and it should not want to — where a secret lives, and what unlock
/// class guards it, is exactly the kind of decision that belongs to the platform.
///
/// # Why a port rather than a file
///
/// The obvious shortcut is to copy the identity secret into the Rust state dir, where the node
/// could read it directly. That trades a real security property for convenience: FORWARD-SECRECY.md
/// §1's threat model is a **seized device**, and the whole point of the keystore's accessibility
/// class is that a locked phone's identity is not readable. A plain file in the app's data dir is,
/// so the shortcut would quietly widen the exposure the ratchet exists to bound.
///
/// So the secret stays where the OS protects it and crosses this seam on demand instead. The cost
/// is one callback per node construction; the benefit is that `session_store`'s key — which is
/// derived from this secret — inherits the platform's protection class rather than the filesystem's.
///
/// # Contract
///
/// - `None` means **not provisioned yet**, not an error: a fresh install has no identity until the
///   app has run once. A background wake that gets `None` should do nothing and wait, rather than
///   generate an identity the user's friends have never seen.
/// - Implementations must be safe to call from a background thread while the device is locked,
///   which is what the "after first unlock" class buys and why a `WhenUnlocked` item would not do.
#[uniffi::export(with_foreign)]
pub trait DeviceSecrets: Send + Sync + 'static {
    /// The long-lived identity seed. Also the input to the session store's key derivation.
    fn identity_secret(&self) -> Option<Vec<u8>>;
    /// The envelope receiving secret.
    fn recv_secret(&self) -> Option<Vec<u8>>;
}

/// Foreign (Swift/Kotlin) callback: friends' slots changed in the local replica.
///
/// The replica is the only inbound path. Every friend namespace this node replicates is in the
/// iroh-docs live engine, which takes entries from whichever peer has them — the author's own phone
/// broadcasting a write, the stash, or a friend relaying a copy — and this is how the app hears
/// that one landed. It carries no fix: opening an envelope advances the ratchet, which only the
/// app's read (`read_latest_ratcheted_events`) may do, so the callback says WHO changed and the app
/// reads. Called once per burst of deliveries, after their content is local.
#[uniffi::export(with_foreign)]
pub trait ReplicaListener: Send + Sync + 'static {
    /// Envelope authors (32-byte endpoint ids) whose fix or null slot is newly readable.
    fn on_friend_entries(&self, authors: Vec<Vec<u8>>);
}

/// Where replica notifications go — swappable while the node runs, and kept across restarts.
///
/// The node is shared by the mounted app and the native background runtime (see [`host`]), and the
/// app's listener points into a JS context that can be torn down while the node keeps running.
/// `None` is silence, not loss: the entry is in the replica either way; nothing surfaces it.
#[derive(Clone, Default)]
pub(crate) struct ReplicaListenerCell(Arc<StdRwLock<Option<Arc<dyn ReplicaListener>>>>);

impl ReplicaListenerCell {
    /// A poisoned lock reads as silence rather than a panic in the watcher: a listener that
    /// panicked once is not one worth delivering to again.
    fn get(&self) -> Option<Arc<dyn ReplicaListener>> {
        self.0.read().ok().and_then(|slot| slot.clone())
    }

    fn set(&self, listener: Option<Arc<dyn ReplicaListener>>) {
        if let Ok(mut slot) = self.0.write() {
            *slot = listener;
        }
    }
}

/// Generate a fresh device "receiving key" (X25519) keypair -> (secret, public).
#[uniffi::export]
pub fn generate_recv_keypair() -> Vec<Vec<u8>> {
    let (sk, pk) = crypto::generate_recv_keypair();
    vec![sk, pk]
}

/// Decode an SCB1 privacy bundle of MVT tiles into one flat SCG1 geometry buffer
/// for the map renderer (see [`mvt`]). Stateless and thread-safe; the Expo module
/// runs it off the JS thread so 340k-feature bundles no longer block Hermes.
#[uniffi::export]
pub fn decode_mvt_bundle(bundle: Vec<u8>) -> Result<Vec<u8>, LocationError> {
    mvt::decode_bundle(&bundle).map_err(LocationError::Decode)
}

/// Decode one coarse XYZ MVT tile (z ≤ anchor) into a flat SCG1 geometry buffer.
#[uniffi::export]
pub fn decode_mvt_tile(bytes: Vec<u8>, z: u32, x: u32, y: u32) -> Vec<u8> {
    mvt::decode_tile(&bytes, z, x, y)
}

/// Enumerate canonical H3 cells for a latitude/longitude polygon off the JS thread.
#[uniffi::export]
pub fn h3_cells_for_polygon(
    coordinates: Vec<f64>,
    resolution: u8,
) -> Result<Vec<String>, LocationError> {
    h3::cells_for_polygon(&coordinates, resolution).map_err(LocationError::Decode)
}

// ---------------------------------------------------------------------------------------------
// Festival mesh (docs/mesh/DESIGN.md, W1). Pure capsule crypto + the mailbox store; no radio.
// The BLE/ESP-NOW transports live in `modules/mesh-radio/` (W3) and the antenna firmware (W2),
// both of which move these bytes without ever holding a key.
// ---------------------------------------------------------------------------------------------

/// Wire + policy constants for the mesh, so the TS orchestration layer never hardcodes them.
#[derive(Debug, Clone, uniffi::Record)]
pub struct MeshConstants {
    /// Capsule wire version currently emitted.
    pub capsule_v: u8,
    /// Epoch length in seconds (900 = 15 min).
    pub epoch_secs: u64,
    pub tag_len: u32,
    pub dedup_len: u32,
    /// Bytes of plaintext header (`v || epoch || tag`) — all a bare antenna parses.
    pub header_len: u32,
    /// Capsules retained per tag by a mailbox.
    pub ring_depth: u32,
    /// Cap on tags in one BLE Query message (§4.1).
    pub max_query_tags: u32,
}

#[uniffi::export]
pub fn mesh_constants() -> MeshConstants {
    MeshConstants {
        capsule_v: mesh::CAPSULE_V,
        epoch_secs: mesh::EPOCH_SECS,
        tag_len: mesh::TAG_LEN as u32,
        dedup_len: mesh::DEDUP_LEN as u32,
        header_len: mesh::HEADER_LEN as u32,
        ring_depth: mesh::RING_DEPTH as u32,
        max_query_tags: mesh::MAX_QUERY_TAGS as u32,
    }
}

/// A friend as the mesh needs them: the two public halves of their contact card.
#[derive(Debug, Clone, uniffi::Record)]
pub struct MeshPeer {
    /// 32-byte ed25519 EndpointId (the envelope author id).
    pub endpoint_id: Vec<u8>,
    /// 32-byte X25519 receiving public key.
    pub recv_public: Vec<u8>,
}

/// What one [`LocationNode::pull_latest`] pass cost and found. The same numbers are on its
/// `trail.sync` span; returning them lets the native caller put them on `friend.pull` beside the
/// things only it knows (the wake, the OS's time allowance, the CPU spent).
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct PullReport {
    /// Wall time inside the pass. Read against the budget: well past it means the process was
    /// frozen mid-pull, since the deadline timer could not fire while it was.
    pub elapsed_ms: u64,
    pub peers_requested: u32,
    pub peers_dialed: u32,
    /// Peers that delivered at least one entry.
    pub peers_delivered: u32,
    /// Entries that landed in the replica.
    pub entries: u32,
    /// Namespaces reconciled (our own plus one per friend).
    pub namespaces: u32,
    /// Namespaces that errored before they could wait.
    pub namespaces_failed: u32,
    /// How the others ended — see `docs::SyncEnd`. `ns_no_answer` is time spent on nobody.
    pub ns_content_ready: u32,
    pub ns_closed: u32,
    pub ns_idle: u32,
    pub ns_no_answer: u32,
    pub ns_deadline: u32,
}

/// A mailbox address we expect traffic on, plus who/when it belongs to.
#[derive(Debug, Clone, uniffi::Record)]
pub struct MeshTag {
    pub tag: Vec<u8>,
    pub author: Vec<u8>,
    pub epoch: u32,
}

/// The plaintext prefix of a capsule.
#[derive(Debug, Clone, uniffi::Record)]
pub struct MeshHeader {
    pub v: u8,
    pub epoch: u32,
    pub tag: Vec<u8>,
    /// `blake3(capsule)[..16]` — the dedup key every relay tier keys on.
    pub dedup_key: Vec<u8>,
}

/// Outcome of offering a capsule to a [`MeshCapsuleStore`].
#[derive(Debug, Clone, uniffi::Record)]
pub struct MeshInsert {
    pub accepted: bool,
    /// `accepted` | `malformed` | `bad_version` | `stale_epoch` | `future_epoch` | `duplicate`.
    /// Stamp this as `sc.drop_reason` on the caller's span (`infra/otel/README.md`).
    pub reason: String,
    pub dedup_key: Vec<u8>,
}

/// Mailbox occupancy, for the dev screen and the BLE Node Info characteristic.
#[derive(Debug, Clone, uniffi::Record)]
pub struct MeshStats {
    pub capsules: u64,
    pub tags: u64,
    pub epoch: u32,
}

/// Which 15-minute epoch a unix timestamp (seconds) falls in.
#[uniffi::export]
pub fn mesh_epoch(now_secs: u64) -> u32 {
    mesh::epoch_at(now_secs)
}

/// Every mailbox address addressed **to me** across `{e-1, e, e+1}` — the BLE Query set.
///
/// Peers whose card fails key-length validation are skipped rather than failing the sweep. The
/// caller chunks the result to [`MeshConstants::max_query_tags`] per Query message.
#[uniffi::export]
pub fn mesh_expected_tags(
    recv_secret: Vec<u8>,
    peers: Vec<MeshPeer>,
    now_secs: u64,
) -> Vec<MeshTag> {
    let peers: Vec<mesh::Peer> = peers
        .into_iter()
        .map(|p| mesh::Peer {
            endpoint_id: p.endpoint_id,
            recv_public: p.recv_public,
        })
        .collect();
    mesh::expected_tags(&recv_secret, &peers, now_secs)
        .into_iter()
        .map(|t| MeshTag {
            tag: t.tag.to_vec(),
            author: t.author,
            epoch: t.epoch,
        })
        .collect()
}

/// Parse `{v, epoch, tag}` + dedup key from a capsule. No key material involved — this is
/// exactly what a bare antenna does.
#[uniffi::export]
pub fn mesh_capsule_header(capsule: Vec<u8>) -> Result<MeshHeader, LocationError> {
    let header = mesh::parse_header(&capsule)?;
    Ok(MeshHeader {
        v: header.v,
        epoch: header.epoch,
        tag: header.tag.to_vec(),
        dedup_key: mesh::dedup_key(&capsule).to_vec(),
    })
}

/// Wrap one already-sealed envelope for one recipient.
#[uniffi::export]
pub fn mesh_capsule_seal(
    recv_secret: Vec<u8>,
    author_endpoint_id: Vec<u8>,
    recipient_recv_public: Vec<u8>,
    envelope: Vec<u8>,
    epoch: u32,
) -> Result<Vec<u8>, LocationError> {
    Ok(mesh::seal(
        &recv_secret,
        &author_endpoint_id,
        &recipient_recv_public,
        &envelope,
        epoch,
    )?)
}

/// Unwrap a capsule to the inner envelope bytes. The envelope's ed25519 signature is **not**
/// checked here — that happens in `crypto::open`, i.e. in [`mesh_open_fix`].
#[uniffi::export]
pub fn mesh_capsule_open(
    recv_secret: Vec<u8>,
    author: MeshPeer,
    capsule: Vec<u8>,
) -> Result<Vec<u8>, LocationError> {
    Ok(mesh::open(
        &recv_secret,
        &author.endpoint_id,
        &author.recv_public,
        &capsule,
    )?)
}

/// Seal one fix into **one capsule per recipient**, ready for Submit over BLE.
///
/// Each capsule carries its own envelope wrapped for that recipient alone (DESIGN §3.2): smaller
/// frames, and group membership never leaves the device. Going through this function rather than
/// [`mesh_capsule_seal`] is what makes that structural instead of a convention.
#[uniffi::export]
pub fn mesh_seal_fix(
    identity_secret: Vec<u8>,
    recv_secret: Vec<u8>,
    author_endpoint_id: Vec<u8>,
    seq: u64,
    mesh_epoch: u32,
    fix: LocationFix,
    recipients: Vec<MeshPeer>,
) -> Result<Vec<Vec<u8>>, LocationError> {
    let span = tracing::info_span!(
        "mesh.seal",
        sc.author = %telemetry::short_hex(&author_endpoint_id),
        sc.seq = seq,
        mesh_epoch,
        recipients = recipients.len(),
    );
    let _guard = span.enter();

    let payload = pad::pad(
        &postcard::to_allocvec(&fix).map_err(|_| LocationError::Decode("encode fix".into()))?,
    )
    .map_err(|e| LocationError::Decode(e.to_string()))?;
    let mut capsules = Vec::with_capacity(recipients.len());
    for recipient in &recipients {
        let envelope = crypto::seal(
            &identity_secret,
            &author_endpoint_id,
            seq,
            fix.ts,
            mesh_epoch,
            &payload,
            std::slice::from_ref(&recipient.recv_public),
        )?;
        let capsule = mesh::seal(
            &recv_secret,
            &author_endpoint_id,
            &recipient.recv_public,
            &envelope,
            mesh_epoch,
        )?;
        // `sc.entry_hash` stays the envelope hash (the join key the stash and receivers share);
        // `sc.capsule_hash` is the radio-tier dedup key that antennas and mailboxes key on.
        tracing::debug!(
            sc.entry_hash = %telemetry::envelope_hash(&envelope),
            sc.capsule_hash = %telemetry::short_hex(&mesh::dedup_key(&capsule)),
            bytes = capsule.len(),
            "mesh capsule sealed"
        );
        capsules.push(capsule);
    }
    Ok(capsules)
}

/// Capsule -> envelope -> verified, decrypted fix. The inverse of [`mesh_seal_fix`] for one
/// capsule; feeds the **existing** friend-presence path, so the map needs no mesh awareness.
#[uniffi::export]
pub fn mesh_open_fix(
    recv_secret: Vec<u8>,
    author: MeshPeer,
    capsule: Vec<u8>,
) -> Result<IncomingFix, LocationError> {
    let capsule_hash = telemetry::short_hex(&mesh::dedup_key(&capsule));
    let envelope = mesh::open(
        &recv_secret,
        &author.endpoint_id,
        &author.recv_public,
        &capsule,
    )
    .inspect_err(|e| {
        tracing::debug!(
            sc.author = %telemetry::short_hex(&author.endpoint_id),
            sc.capsule_hash = %capsule_hash,
            sc.drop_reason = "capsule_open",
            error = %e,
            "mesh capsule rejected"
        );
    })?;
    let opened = crypto::open(&recv_secret, &envelope).inspect_err(|e| {
        tracing::debug!(
            sc.author = %telemetry::short_hex(&author.endpoint_id),
            sc.capsule_hash = %capsule_hash,
            sc.entry_hash = %telemetry::envelope_hash(&envelope),
            sc.drop_reason = "envelope_open",
            error = %e,
            "mesh envelope rejected"
        );
    })?;
    // A null fix has no position to hand back, and this signature has no way to say "healthy but
    // empty" — so it is an error here. The mesh path does not publish them today (§8.1 leaves
    // mesh forward secrecy open); if it ever does, this needs an Option-shaped return.
    let fix = decode_fix_payload(&opened.payload)?.ok_or_else(|| {
        tracing::debug!(
            sc.author = %telemetry::short_hex(&author.endpoint_id),
            sc.capsule_hash = %capsule_hash,
            sc.drop_reason = "null_fix",
            "mesh capsule carried a null fix"
        );
        LocationError::Decode("null fix".into())
    })?;
    Ok(IncomingFix {
        author: opened.author.to_vec(),
        seq: opened.seq,
        fix,
    })
}

/// A mailbox: capsules indexed by rotating tag, newest-first, bounded per tag and overall.
///
/// Held by the phone (what it has fetched, so a Query can carry a `have` set) and — once W4
/// lands — by a smart node. Capsule interiors are opaque here, exactly as in firmware.
#[derive(uniffi::Object)]
pub struct MeshCapsuleStore {
    inner: StdMutex<mesh::Store>,
}

#[uniffi::export]
impl MeshCapsuleStore {
    /// `capacity` bounds the number of distinct tags held; each holds up to `ring_depth`
    /// capsules. This is the PSRAM/RAM knob (DESIGN Q6).
    #[uniffi::constructor]
    pub fn new(capacity: u32) -> Self {
        Self {
            inner: StdMutex::new(mesh::Store::new(capacity as usize)),
        }
    }

    /// Offer a capsule. A drop here is a drop-decision point: the returned `reason` is the
    /// `sc.drop_reason` value to stamp.
    pub fn insert(&self, capsule: Vec<u8>, now_secs: u64) -> MeshInsert {
        let dedup = mesh::dedup_key(&capsule);
        let outcome = self
            .inner
            .lock()
            .expect("mesh store mutex")
            .insert(&capsule, now_secs);
        if !outcome.accepted() {
            tracing::debug!(
                sc.capsule_hash = %telemetry::short_hex(&dedup),
                sc.drop_reason = outcome.as_str(),
                "mesh capsule not stored"
            );
        }
        MeshInsert {
            accepted: outcome.accepted(),
            reason: outcome.as_str().to_string(),
            dedup_key: dedup.to_vec(),
        }
    }

    /// The live position for a tag — the most recently arrived capsule.
    pub fn latest(&self, tag: Vec<u8>) -> Option<Vec<u8>> {
        let tag: [u8; mesh::TAG_LEN] = tag.try_into().ok()?;
        self.inner
            .lock()
            .expect("mesh store mutex")
            .latest(&tag)
            .map(|b| b.to_vec())
    }

    /// Dedup keys already held for `tags` — the `have` set sent with a BLE Query.
    pub fn have(&self, tags: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let tags = to_tag_array(tags);
        self.inner
            .lock()
            .expect("mesh store mutex")
            .have(&tags)
            .into_iter()
            .map(|k| k.to_vec())
            .collect()
    }

    /// Capsules matching `tags` minus everything in `have` — the Deliver set a node would send.
    pub fn deliver(&self, tags: Vec<Vec<u8>>, have: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let tags = to_tag_array(tags);
        let have: Vec<[u8; mesh::DEDUP_LEN]> =
            have.into_iter().filter_map(|k| k.try_into().ok()).collect();
        self.inner
            .lock()
            .expect("mesh store mutex")
            .deliver(&tags, &have)
    }

    /// Drop everything that has fallen out of the acceptance window. Returns the count removed.
    pub fn prune(&self, now_secs: u64) -> u64 {
        self.inner.lock().expect("mesh store mutex").prune(now_secs) as u64
    }

    pub fn stats(&self, now_secs: u64) -> MeshStats {
        let (capsules, tags) = self.inner.lock().expect("mesh store mutex").stats();
        MeshStats {
            capsules,
            tags,
            epoch: mesh::epoch_at(now_secs),
        }
    }
}

/// Drop wrong-length tags rather than failing the whole call: a truncated BLE frame must not
/// blind a sync to every other tag in the batch.
fn to_tag_array(tags: Vec<Vec<u8>>) -> Vec<[u8; mesh::TAG_LEN]> {
    tags.into_iter().filter_map(|t| t.try_into().ok()).collect()
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

/// A friend's endpoint id and X25519 receiving public key, both hex. See
/// [`LocationNode::set_recipient_keys`].
#[derive(Debug, Clone, uniffi::Record)]
pub struct RecipientKey {
    pub endpoint_id: String,
    pub recv_public: String,
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

/// One endpoint address as exposed by iroh's live path table.
#[derive(Debug, Clone, uniffi::Record)]
pub struct TransportAddressDiagnostic {
    /// `relay` | `ip` | `custom`.
    pub kind: String,
    /// Full display form (`relay:https://…`, `ip:host:port`, or the custom transport address).
    pub address: String,
    /// Whether a remote path is actively carrying traffic. `None` for local advertised addresses,
    /// whose presence does not prove another endpoint is using them.
    pub active: Option<bool>,
}

/// Iroh's current address knowledge for one requested peer.
#[derive(Debug, Clone, uniffi::Record)]
pub struct PeerTransportDiagnostic {
    pub endpoint_id: Vec<u8>,
    /// False when iroh has no retained path information for this peer.
    pub known: bool,
    pub addresses: Vec<TransportAddressDiagnostic>,
}

/// Live endpoint transport snapshot used by the in-app diagnostics.
#[derive(Debug, Clone, uniffi::Record)]
pub struct TransportDiagnostics {
    pub local_addresses: Vec<TransportAddressDiagnostic>,
    pub peers: Vec<PeerTransportDiagnostic>,
}

/// One author's fix slot in the LOCAL durable replica — what this device could hand to a peer.
///
/// Companion to [`TransportDiagnostics`]: a diagnostics read, carrying no location data, so it
/// needs no decrypt and no gate. See [`docs::ReplicaSlot`] for why this is not the same question
/// as "have we seen this author's fix" — app storage keeps what the app surfaced, while
/// reconciliation serves out of the replica.
#[derive(Debug, Clone, uniffi::Record)]
pub struct TrailReplicaAuthor {
    /// The author's endpoint id (their ed25519 verifying key).
    pub author: Vec<u8>,
    /// The envelope's `seq`, from its signed plaintext header. `0` when `has_content` is false.
    pub seq: u64,
    /// The envelope's `ts` — when the author took the fix, not when we stored it. `0` when
    /// `has_content` is false.
    pub fix_ts: u64,
    /// Whether we hold a readable signed envelope for this author, and not merely a docs record
    /// pointing at a blob that never landed. False means there is nothing to serve, which is a
    /// different failure from "the transfer broke".
    pub has_content: bool,
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

/// Result of one explicit Bump rendezvous attempt.
#[derive(Debug, Clone, uniffi::Record)]
pub struct BumpResolution {
    /// `resolved` | `unavailable` | `noPeers` | `ambiguous` | `probeFailed`.
    pub status: String,
    /// Resolved peer EndpointId when `status == "resolved"`.
    pub endpoint_id: Option<Vec<u8>>,
    pub device_id: Option<String>,
    pub rssi: Option<i16>,
    /// Number of fresh iroh advertisements observed during this attempt.
    pub peer_count: u32,
    /// Diagnostic detail suitable for logs and actionable UI copy.
    pub detail: String,
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

/// What [`LocationNode::grant_stash`] registers.
enum StashGrant {
    /// One newly imported friend ticket.
    One(String),
    /// Our trail and every friend's; `floored` defers to [`stash::REGRANT_FLOOR_MS`].
    All { floored: bool },
}

struct Started {
    endpoint: Endpoint,
    trail: Arc<TrailDocs>,
    profile: Arc<ProfileDocs>,
    ble: BleHandle,
    _router: Router,
}

/// Every live handle a started node holds, cloned out from under [`LocationNode::inner`].
///
/// ## Why this type exists
/// `inner` is the ONE process-wide node lock, and every JS-visible native call goes through it.
/// Holding it across an `await` therefore does not merely slow that call down — it stops the whole
/// phone: the pairing poll that opens the SAS gate, `ble_capabilities`, `transport_diagnostics`,
/// the publish path and the inbound `PairProtocol` handler all queue behind whatever the holder is
/// waiting for. If that await is a docs import aimed at a peer that is not reachable, nothing ever
/// releases it and only force-quitting the app clears it.
///
/// That is not hypothetical. On 2026-09-10 a busy docs engine produced `pairing.poll` spans of
/// 47-131 s. On 2026-09-17 00:50 UTC a long-distance pair completed its SAS, and ACKNOWLEDGE —
/// which imported the new friend's docs ticket for a brand-new, internet-unreachable peer — wedged
/// both phones: `pool.friend_added` never landed on one of them, its `pairing.poll` cadence
/// stopped dead within a second, and `app.previous_run` records three force-quits over the next
/// three minutes. Both sides then sat on "REACHING THEM" for every retry, because the inbound pair
/// handler needs the same docs engine to build its reply and so stopped answering dials.
///
/// So: take the handles, drop the guard, then do the work. Every handle here is cheap to clone
/// (`Endpoint` is a handle type; the docs are `Arc`), and cloning a handle is exactly what makes
/// the release safe — a `shutdown` that replaces `inner` cannot pull the engine out from under an
/// in-flight call, it can only stop being the node the NEXT call sees.
#[derive(Clone)]
struct Live {
    endpoint: Endpoint,
    trail: Arc<TrailDocs>,
    profile: Arc<ProfileDocs>,
    ble: BleHandle,
}

impl LocationNode {
    /// Stop surfacing replica changes into the app; keep the node, and every namespace, running.
    ///
    /// What [`host`] does when the last app holder lets go while the background runtime still
    /// holds the node. The app's listener points into a JS context that is going away; the live
    /// engine keeps replicating for the background runtime regardless.
    pub(crate) async fn detach_app_listeners(&self) {
        self.replica_listener.set(None);
    }

    /// Grant the trail stash replication of our trail namespace and every friend's (see
    /// [`stash`]). Does nothing when the stash is not opted into. The HTTP runs on its own task, so
    /// no caller ever waits on the stash; what this awaits is local (the delivery store and one
    /// docs ticket).
    async fn grant_stash(&self, scope: StashGrant, reason: &'static str) {
        use tracing::Instrument;
        let Some(live) = self.live_opt().await else {
            return;
        };
        let config = match self.delivery_store().await {
            Ok(store) => store.get(),
            Err(_) => return,
        };
        let Some((base_url, psk)) = config.stash() else {
            return;
        };
        let base_url = base_url.to_string();
        let tickets = match scope {
            StashGrant::One(ticket) => vec![ticket],
            StashGrant::All { floored } => {
                let now = now_ms();
                if floored && !stash::regrant_due(self.stash_grant_at.load(Ordering::Relaxed), now)
                {
                    return;
                }
                self.stash_grant_at.store(now, Ordering::Relaxed);
                let mut tickets = Vec::new();
                match live.trail.read_ticket(live.trail.own_namespace()).await {
                    Ok(own) => tickets.push(own),
                    Err(err) => {
                        tracing::warn!(error = %err, "stash grant: no ticket for our trail")
                    }
                }
                tickets.extend(live.trail.friend_tickets());
                tickets
            }
        };
        if tickets.is_empty() {
            return;
        }
        let span = tracing::info_span!(
            "stash.grant",
            sc.author = %telemetry::short_hex(&self.author),
            reason,
            namespaces = tickets.len(),
            registered = tracing::field::Empty,
            failed = tracing::field::Empty,
        );
        tokio::spawn(
            async move {
                let report = stash::register(&base_url, psk.as_deref(), &tickets).await;
                let current = tracing::Span::current();
                current.record("registered", report.registered);
                current.record("failed", report.failed);
            }
            .instrument(span),
        );
    }

    /// Clone this node's live handles and RELEASE the node lock. See [`Live`].
    ///
    /// Every method below that touches the endpoint or the docs engines starts here. The
    /// rule it enforces is one line long and has cost us two multi-day outages when broken: the
    /// `inner` guard must never be alive across an `await`.
    async fn live(&self) -> Result<Live, LocationError> {
        self.live_opt().await.ok_or(LocationError::NotStarted)
    }

    /// [`Self::live`] for the callers whose honest answer to "not started" is a default, not an
    /// error (BLE capability reads, diagnostics).
    async fn live_opt(&self) -> Option<Live> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref()?;
        Some(Live {
            endpoint: started.endpoint.clone(),
            trail: started.trail.clone(),
            profile: started.profile.clone(),
            ble: started.ble.clone(),
        })
    }
}

// The process-global `tracing` subscriber (Android logcat pipe + the optional OTLP developer
// telemetry reload slot) lives in `telemetry.rs` — see the module docs there for the layering
// and the `sc.*` correlation model.

/// The device node: holds identity + receiving keys and, once started, the iroh
/// endpoint and its docs/blobs router.
#[derive(uniffi::Object)]
pub struct LocationNode {
    identity_seed: [u8; 32],
    author: [u8; 32],
    recv_secret: Vec<u8>,
    recv_public: Vec<u8>,
    /// Which node this is within this process. See [`NODE_ORDINAL`]; carried here so later spans
    /// can say WHICH node they came from, not only that a node existed.
    ordinal: u64,
    /// When the last full stash grant ran (ms), for the floor on the untracked-slots trigger.
    /// In memory on purpose: every process grants once at start regardless. See [`stash`].
    stash_grant_at: AtomicU64,
    /// On-disk root for the persistent docs replica + blobs store (durable trail). Derived from
    /// the identity so it stays stable across restarts.
    ///
    /// This one is allowed to live in cache/temp: everything under it is *recoverable* — a purged
    /// trail resyncs from the stash and from friends. Ratchet state is not, which is why it does
    /// not live here; see [`state_dir`](Self::state_dir).
    data_dir: PathBuf,
    /// On-disk root for state that **cannot be re-derived or re-fetched** — today, the ratchet
    /// session store (§4.2).
    ///
    /// Separate from `data_dir` because the two have opposite storage requirements, and getting
    /// either wrong is a break rather than an inconvenience:
    ///
    /// | | cache / temp | app data dir |
    /// |---|---|---|
    /// | backup rollback → counter rewind → key reuse | impossible | must be excluded |
    /// | OS purge → every session lost at once | likely | no |
    ///
    /// Sequential state has to survive an OS purge, so it belongs in the app data dir — and a
    /// restored backup would rewind counters into key reuse, so the host is responsible for
    /// excluding this path from backup *as well*. Both halves ship together: iOS stamps
    /// `NSURLIsExcludedFromBackupKey` in `IrohLocationModule.swift`, Android excludes `files/` in
    /// `plugins/withBackupExclusion.js`. Never point this at `data_dir` on a device.
    state_dir: PathBuf,
    inner: Mutex<Option<Started>>,
    /// Serializes the drain path (`ingest_fix`, `heartbeat_fix`, `publish_introduction`) over the
    /// gate and outbox. See [`publish::DrainLock`]. Never taken by anything else, so holding it
    /// across the publish awaits stalls only another drain, which would have duplicated the work.
    drain_lock: publish::DrainLock,
    /// Serializes `start`, so building the endpoint does not have to hold [`inner`].
    ///
    /// `start` awaits the BLE radio coming up and the endpoint binding, neither of which is fast
    /// and neither of which the OS promises to finish. Holding `inner` across them made every
    /// unrelated call — and therefore the whole UI — wait on the slowest thing in startup; on
    /// 2026-09-13 a wedged CoreBluetooth turned that into a 13 h outage ending in a locked splash
    /// screen. The two locks separate "is the node up?" (cheap, contended, answered constantly)
    /// from "is someone bringing it up?" (slow, rare, and only ever contended by a second caller
    /// who would have had to wait anyway).
    starting: Mutex<()>,
    /// Where friend-replica changes are announced (see [`ReplicaListener`]). Lives on the node,
    /// not on a started engine, so it survives a `start` after `shutdown`; a node the [`host`]
    /// REBUILDS is a new node and starts silent, so platform code attaches again per generation.
    replica_listener: ReplicaListenerCell,
    /// Bilateral pairing core (`streetcryptid/pair/1`). Created at construction so its ALPN
    /// handler can be registered on the router in `start`; its live handles are attached there.
    pair: Arc<PairCore>,
    /// Node-level queue of verified profile-update events (drained via `poll_profile_events`).
    profile_events: ProfileEventQueue,
    /// Per-friend Double Ratchet sessions (FORWARD-SECRECY §4.2). Created on `start`, because
    /// [`SessionStore`](session_store::SessionStore) claims the session directory for the
    /// process and that claim must be released on shutdown.
    sessions: Mutex<Option<Arc<sessions::SessionManager>>>,
    /// This device's monotonic publish counter (`seq_store.rs`). Created on `start` alongside the
    /// session store and for the same reason: it claims a directory for the process, and that
    /// claim has to be released on shutdown.
    seq: Mutex<Option<Arc<seq_store::SeqStore>>>,
    /// The three stores the native drain path needs to run with no JS context alive: what is
    /// waiting to be sealed, who to seal it for, and where we are on the slot grid. Opened with
    /// the node for the same reason as the counter — two of them claim directories.
    outbox: Mutex<Option<Arc<outbox::Outbox>>>,
    recipients: Mutex<Option<Arc<recipients::RecipientStore>>>,
    gate: Mutex<Option<Arc<gate::GateStore>>>,
    /// Every position this device put on the wire, until the app takes them into its own trail.
    /// See [`own_log`] for why the replica cannot answer that.
    own_log: Mutex<Option<Arc<own_log::OwnLog>>>,
    /// The settings a background bootstrap needs before it can call `start` — see
    /// [`crate::transport`]. Opened eagerly with the node rather than lazily, because the one
    /// caller that needs it is the one with no JS context to fall back on.
    transport: Mutex<Option<Arc<transport::TransportStore>>>,
    /// Where a drained envelope has to be sent to actually leave the phone — see
    /// [`crate::delivery`]. Opened with the others because the drain reads it on every wake, and a
    /// wake with no JS context has nowhere else to get it.
    delivery: Mutex<Option<Arc<delivery::DeliveryStore>>>,
    /// Ephemerals minted by `begin_session` and awaiting the peer's half. Keyed by peer endpoint
    /// id. Held in memory only: an unfinished bootstrap that does not survive a restart is a
    /// bootstrap the user simply repeats, whereas one persisted to disk is a private key sitting
    /// in storage for no reason.
    pending_bootstrap: Mutex<HashMap<Vec<u8>, x25519_dalek::StaticSecret>>,
    /// Digest of the control record (§4.6) this process last wrote to our `rsy` slot, so the
    /// recovery pass — which runs on every drain — rewrites it only when its content or its
    /// recipients change. Lost on restart, which costs one rewrite.
    last_control: Mutex<Option<[u8; 32]>>,
    /// Test-only offset applied to the session clock (see `advance_clock_for_tests`).
    clock_offset_ms: std::sync::atomic::AtomicI64,
}

/// Internals kept out of the `#[uniffi::export]` block above — UniFFI exports every method in an
/// exported impl, including private ones, and `SessionManager` is not an FFI type.
impl LocationNode {
    /// Push our own trail namespace to `peer_tickets` — the trail stash when it is configured and
    /// opted into, and **every pool member** — and wait for the exchange to finish. **This is what
    /// actually gets a published fix off the phone.**
    ///
    /// Sealing only writes the local replica; iroh-docs broadcasts a local insert solely for
    /// namespaces the live engine has marked as syncing, which happens on `start_sync` and nowhere
    /// else. A short-lived background process that never did that left its envelopes on the phone
    /// and an offline friend had nothing to reconcile from. The drain calls this after every batch
    /// (`NodeSink::flush`); it is not an FFI export, because nothing outside the drain should
    /// decide when a fix leaves.
    ///
    /// The peer list is the send-side counterpart of [`Self::sync_latest`], and it is what makes
    /// ARCHITECTURE.md §1.3/§6's pool relay the normal flow rather than luck. An earlier revision
    /// took a single `Option<String>` that only ever carried the stash, so an author's published
    /// fix was broadcast over docs to the stash and to nobody else: a pool member gained the
    /// author's entries only if it happened to dial the author itself during a reconciliation
    /// window, and with the stash off there was no durable copy anywhere. Pushing to the pool
    /// means a friend with the app open holds the author's entries **as they are published**, and
    /// can hand them on the moment the author goes dark.
    ///
    /// Repeating it is cheap: `start_sync` is a no-op once a namespace is syncing, so the
    /// steady-state cost is one connection per member for the process's lifetime.
    ///
    /// Unparseable tickets are skipped rather than failing the push — one malformed friend card
    /// must not stop delivery to everyone else — but they are counted on the span.
    ///
    /// One deadline, [`docs::PUSH_TIMEOUT_SECS`], bounds the exchange; it ends early once every
    /// dialled peer has reported. A peer that stays silent costs the full deadline, and is still
    /// handed the data: the namespace stays live, so it reconciles whenever it next wakes.
    ///
    /// Best-effort by design: a failure means offline delivery is degraded for those fixes, not
    /// that the live engine or a later [`Self::sync_latest`] is broken.
    pub async fn push_trail(&self, peer_tickets: Vec<String>) -> Result<(), LocationError> {
        use tracing::Instrument;
        let requested = peer_tickets.len();
        let peers: Vec<EndpointAddr> = peer_tickets
            .iter()
            .filter_map(|ticket| ticket.parse::<EndpointTicket>().ok())
            .map(|ticket| relay::scrub_addr(ticket.endpoint_addr().clone()))
            .collect();
        let span = tracing::info_span!(
            "trail.push",
            sc.author = %telemetry::short_hex(&self.author),
            sync.peers_requested = requested,
            sync.peers_dialed = peers.len(),
            entries_sent = tracing::field::Empty,
            peers_finished = tracing::field::Empty,
            peers_failed = tracing::field::Empty,
            peers_silent = tracing::field::Empty,
            finished = tracing::field::Empty,
        );
        async move {
            if peers.len() < requested {
                tracing::warn!(
                    skipped = requested - peers.len(),
                    "trail push: some peer tickets were unparseable and were skipped"
                );
            }
            // `live()` takes the node-wide `inner` lock, so a push queued behind another caller
            // holding it is visible here rather than as unexplained `trail.push` duration.
            let started = self
                .live()
                .instrument(tracing::info_span!("trail.push.live"))
                .await?;
            let trail = started.trail.clone();
            let ns = trail.own_namespace();

            let budget = std::time::Duration::from_secs(docs::PUSH_TIMEOUT_SECS);
            let sent = trail.push(ns, peers, budget).await.map_err(|e| {
                tracing::warn!(error = %e, "trail push failed");
                LocationError::Network(e.to_string())
            })?;
            let current = tracing::Span::current();
            current.record("finished", sent.is_some());
            let Some(report) = sent else {
                return Ok(());
            };
            // Summed across every peer that reported, not taken from whichever finished first.
            current.record("entries_sent", report.entries_sent);
            current.record("peers_finished", report.peers_finished);
            current.record("peers_failed", report.peers_failed);
            current.record(
                "peers_silent",
                report
                    .per_peer
                    .iter()
                    .filter(|p| p.outcome == docs::PeerOutcome::Silent)
                    .count(),
            );

            // One child span per dialled peer, because no aggregate can answer the question that
            // matters: `peers_finished = 2` tells you two peers answered, not WHICH two or how long
            // either took. Queryable directly —
            // `{ name = "trail.push.peer" && span.peer.outcome = "silent" }` — and see
            // `infra/otel/README.md` for the cookbook.
            //
            // The span's own duration is meaningless (it is opened and closed here, after the
            // fact); `peer.latency_ms` is the measurement. That is deliberate: a duration that
            // looked plausible but meant something else would be worse than an obvious zero.
            //
            // `peer.role` says whether the peer was the stash or a friend's phone, and a FINISHED
            // push is also a `peer.contact`: the two devices reconciled with each other.
            let roles = self
                .peer_roles()
                .instrument(tracing::info_span!("trail.push.roles"))
                .await;
            // Per-peer reporting awaits `remote_info` for every finished peer's path label, so it
            // is timed as a phase of its own (`trail.push.report`).
            let report_span =
                tracing::info_span!("trail.push.report", peers = report.per_peer.len() as u64);
            async {
                for peer in &report.per_peer {
                    let latency = peer.latency_ms;
                    let role = roles.role(&peer.peer);
                    tracing::info_span!(
                        "trail.push.peer",
                        sc.peer = %telemetry::short_hex(&peer.peer),
                        peer.outcome = peer.outcome.as_str(),
                        peer.role = role,
                        peer.latency_ms = latency.unwrap_or_default(),
                        peer.answered = latency.is_some(),
                        entries_sent = peer.entries_sent,
                    )
                    .in_scope(|| {});
                    if peer.outcome == docs::PeerOutcome::Finished {
                        let path = match EndpointId::from_bytes(&peer.peer) {
                            Ok(id) => delivery_label(&started.endpoint, id).await,
                            Err(_) => "unknown".to_string(),
                        };
                        contact::record(contact::Contact {
                            dir: contact::Dir::Send,
                            peer: &peer.peer,
                            role,
                            path: &path,
                            from_author: None,
                            entries: peer.entries_sent,
                        });
                    }
                }
            }
            .instrument(report_span)
            .await;

            let stash_dialed = roles
                .stash()
                .is_some_and(|stash| report.per_peer.iter().any(|p| &p.peer == stash));
            self.observe_reachability(
                report.per_peer.iter().any(|p| p.latency_ms.is_some()),
                stash_dialed,
                isolation::Source::Push,
                &started.endpoint,
            );

            Ok(())
        }
        .instrument(span)
        .await
    }

    /// Explicitly hand the current opaque trail slots to the stash and wait for HTTP receipts.
    ///
    /// Returns the number of slots the stash **accepted**; the other outcomes are on the
    /// `trail.content.upload` span, because `untracked` is a number you want to watch over time
    /// rather than branch on. Called by the drain after a push (`NodeSink::flush`).
    pub(crate) async fn upload_trail_content(
        &self,
        base_url: String,
        psk: Option<String>,
    ) -> Result<u64, LocationError> {
        use tracing::Instrument;
        let started = self.live().await?;
        let trail = started.trail.clone();
        let span = tracing::info_span!(
            "trail.content.upload",
            sc.author = %telemetry::short_hex(&self.author),
            uploaded = tracing::field::Empty,
            untracked = tracing::field::Empty,
            unreadable = tracing::field::Empty,
            transport_failed = tracing::field::Empty,
        );
        async move {
            let report = trail
                .upload_own_latest(&base_url, psk.as_deref())
                .await
                .map_err(|error| LocationError::Network(error.to_string()))?;
            let current = tracing::Span::current();
            current.record("uploaded", report.uploaded);
            current.record("untracked", report.untracked);
            current.record("unreadable", report.unreadable);
            current.record("transport_failed", report.transport_failed);
            // Worth a log line, not just a span field: a backlog that never drains is the
            // signature of entries that are not reconciling to the stash at all.
            if report.untracked > 0 {
                tracing::warn!(
                    untracked = report.untracked,
                    uploaded = report.uploaded,
                    "trail content upload: the stash is not tracking some slots; their bytes are \
                     not available for offline friends yet"
                );
                // A stash that has restarted answers exactly like this, and keeps doing so until
                // someone registers our namespaces again. Floored: it repeats on every upload.
                self.grant_stash(StashGrant::All { floored: true }, "untracked")
                    .await;
            }
            Ok(report.uploaded)
        }
        .instrument(span)
        .await
    }

    /// Drive §4.6 session restarts with every one of `peers` — recipients and watchers alike.
    ///
    /// Runs on every native drain, so a phone with no JS context alive still recovers; its common
    /// case (nothing wrong) costs one state load per friend and one local replica scan. Three
    /// steps, the policy for each living in [`restart`] so it can be tested without any of this:
    ///
    /// 1. **Follower: adopt.** A leader's restart header rides on the envelopes already in our
    ///    replica. [`SessionManager::prime`](sessions::SessionManager::prime) joins the restarted
    ///    session from it without consuming the fix inside — this process may be the native
    ///    runtime, which has nobody to hand a fix to, and opening the envelope would spend the only
    ///    key that decrypts it. On 2026-10-03 a Pixel whose app was not running sat on a broken
    ///    session for hours because only a JS read ever looked at what arrived.
    /// 2. **Decide.** A leader restarts on a request from the follower or on its own evidence; a
    ///    follower asks, repeats, or withdraws ([`restart::plan_leader`],
    ///    [`restart::plan_follower`]).
    /// 3. **Publish our control record** — our prekeys, for our leaders to restart against, and
    ///    our requests — when it has changed. A changed record holds the drain's push open
    ///    ([`publish::RecoveryOutcome::in_progress`]), because a request nobody can read is not a
    ///    request.
    ///
    /// `no_session` peers are never touched: there is no session to restart, and only pairing
    /// roots one.
    pub async fn recover_sessions(&self, peers: &[String]) -> publish::RecoveryOutcome {
        use tracing::Instrument;
        let span = tracing::info_span!(
            "session.recover",
            sc.author = %telemetry::short_hex(&self.author),
            peers = peers.len(),
            desynced = tracing::field::Empty,
            primed = tracing::field::Empty,
            restarted = tracing::field::Empty,
            requested = tracing::field::Empty,
            withdrawn = tracing::field::Empty,
            await_prekey = tracing::field::Empty,
            no_key = tracing::field::Empty,
            control_written = tracing::field::Empty,
            error = tracing::field::Empty,
        );
        async move {
            let Ok(manager) = self.session_manager().await else {
                return publish::RecoveryOutcome::default();
            };
            let now = self.now();
            let span = tracing::Span::current();
            let mut friends: Vec<[u8; 32]> = peers
                .iter()
                .filter_map(|hex| decode_endpoint(hex).ok())
                .collect();
            friends.sort();
            friends.dedup();
            let live = self.live().await.ok();

            // What the replica holds: our leaders' latest envelopes (a restart may ride on them),
            // and the control records of the friends we lead.
            let mut leader_envelopes = Vec::new();
            let mut peer_controls = HashMap::new();
            if let Some(live) = live.as_ref() {
                let leads_us = |peer: &[u8; 32]| manager.role(peer) == sessions::Role::Follower;
                if friends.iter().any(leads_us) {
                    match live.trail.read_latest_sealed().await {
                        Ok(sealed) => {
                            leader_envelopes = sealed
                                .iter()
                                .filter_map(|bytes| crypto::verify_v3(bytes).ok())
                                .filter(|verified| {
                                    friends.contains(&verified.author) && leads_us(&verified.author)
                                })
                                .collect();
                        }
                        Err(err) => {
                            span.record("error", tracing::field::display(&err));
                        }
                    }
                }
                for peer in friends.iter().filter(|peer| !leads_us(peer)) {
                    if let Some(control) = self.read_control_record(live, peer).await {
                        peer_controls.insert(*peer, control);
                    }
                }
            }

            let report =
                restart::run_pass(&manager, &friends, &leader_envelopes, &peer_controls, now);
            if let Some(err) = report.errors.first() {
                span.record("error", tracing::field::display(err));
            }

            // Our control record.
            let (control_written, no_key) =
                match self.publish_control(&manager, &friends, now).await {
                    Ok(outcome) => outcome,
                    Err(err) => {
                        span.record("error", tracing::field::display(&err));
                        (false, 0)
                    }
                };

            span.record("desynced", report.desynced);
            span.record("primed", report.primed);
            span.record("restarted", report.restarted);
            span.record("requested", report.requested);
            span.record("withdrawn", report.withdrawn);
            span.record("await_prekey", report.await_prekey);
            span.record("no_key", no_key);
            span.record("control_written", control_written);
            publish::RecoveryOutcome {
                in_progress: control_written,
                restored: report.primed + report.restarted,
            }
        }
        .instrument(span)
        .await
    }

    /// Wall-clock milliseconds as this node's session logic sees them. Production: `now_ms()`.
    fn now(&self) -> u64 {
        let offset = self.clock_offset_ms.load(Ordering::Relaxed);
        now_ms().saturating_add_signed(offset)
    }

    /// Move this node's session clock (recovery and health verdicts). Tests only — it is how an
    /// integration test reaches a state measured in hours, like a follower stuck without a
    /// sending chain, without waiting for it.
    #[doc(hidden)]
    pub fn advance_clock_for_tests(&self, by_ms: i64) {
        self.clock_offset_ms.fetch_add(by_ms, Ordering::Relaxed);
    }

    /// Where this node keeps state that cannot be re-fetched. Tests only — it is how an
    /// integration test damages a session record the way storage failure would.
    #[doc(hidden)]
    pub fn state_dir_for_tests(&self) -> PathBuf {
        self.state_dir.clone()
    }

    /// `peer`'s newest control record from our replica, if we can read one.
    async fn read_control_record(
        &self,
        live: &Live,
        peer: &[u8; 32],
    ) -> Option<restart::ControlRecord> {
        let payloads = live.trail.read_rsy(peer, &self.recv_secret).await.ok()?;
        payloads
            .iter()
            .filter_map(|payload| restart::ControlRecord::decode(payload))
            .max_by_key(|record| record.ts)
    }

    /// Seal our control record to every friend whose receiving key we know and write it to our
    /// `rsy` slot, unless what we would write is what we last wrote. Returns whether it was
    /// written, and how many friends had no key to seal to.
    async fn publish_control(
        &self,
        manager: &sessions::SessionManager,
        friends: &[[u8; 32]],
        now: u64,
    ) -> Result<(bool, u32), LocationError> {
        let store = self.recipient_store().await.ok();
        let mut keys = Vec::with_capacity(friends.len());
        let mut no_key = 0u32;
        for peer in friends {
            let hex = encode_hex(peer);
            let key = match store.as_ref().and_then(|s| s.key_for(&hex)) {
                Some(key) => Some(key),
                None => self.profile_recv_key(peer).await,
            };
            match key.as_deref().and_then(decode_hex) {
                Some(raw) if raw.len() == 32 => keys.push(raw),
                _ => no_key += 1,
            }
        }
        Ok((self.write_control(manager, keys, now, false).await?, no_key))
    }

    /// Write our control record sealed to `keys`. `force` rewrites even an unchanged record.
    async fn write_control(
        &self,
        manager: &sessions::SessionManager,
        mut keys: Vec<Vec<u8>>,
        now: u64,
        force: bool,
    ) -> Result<bool, LocationError> {
        keys.sort();
        keys.dedup();
        if keys.is_empty() {
            return Ok(false);
        }
        let record = restart::our_control_record(manager, now)
            .map_err(|e| LocationError::Network(e.to_string()))?;

        // What the record says and who can read it — not when it was written.
        let mut unstamped = record.clone();
        unstamped.ts = 0;
        let mut hasher = blake3::Hasher::new();
        hasher.update(&unstamped.encode().unwrap_or_default());
        for key in &keys {
            hasher.update(key);
        }
        let digest = *hasher.finalize().as_bytes();
        let mut last = self.last_control.lock().await;
        if !force && *last == Some(digest) {
            return Ok(false);
        }

        let payload = record
            .encode()
            .ok_or_else(|| LocationError::Decode("encode control record".into()))?;
        let envelope = crypto::seal(
            &self.identity_seed,
            &self.author,
            0,
            now,
            0,
            &payload,
            &keys,
        )?;
        let live = self.live().await?;
        let ns = live.trail.own_namespace();
        live.trail
            .write_rsy(ns, &self.author, envelope)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        *last = Some(digest);
        tracing::info!(
            sc.author = %telemetry::short_hex(&self.author),
            sc.restart = "control",
            recipients = keys.len(),
            prekeys = record.prekeys.len(),
            requests = record.requests.len(),
            "published our restart control record"
        );
        Ok(true)
    }

    /// Shorten or restore the §4.5 lapse bound on this node's live sessions. Tests only — it is
    /// how an integration test lapses a real pair without waiting a day.
    #[doc(hidden)]
    pub async fn set_t_lapse_ms_for_tests(&self, t_lapse_ms: u64) -> Result<(), LocationError> {
        self.session_manager().await?.set_t_lapse_ms(t_lapse_ms);
        Ok(())
    }

    /// Shrink or restore the ratchet acceptance window on this node's live sessions. Tests only —
    /// it is how an integration test gets past the window without publishing that many fixes.
    #[doc(hidden)]
    pub async fn set_accept_window_for_tests(&self, window: u32) -> Result<(), LocationError> {
        self.session_manager().await?.set_accept_window(window);
        Ok(())
    }

    /// A friend's receiving key from their verified profile — the fallback when JS has not
    /// mirrored one yet (a binary upgraded before its bundle, or a wake before the first launch).
    async fn profile_recv_key(&self, peer: &[u8]) -> Option<String> {
        let profile = self.live().await.ok()?.profile;
        let record = profile.read_for_endpoint(peer).await.ok()??;
        (!record.recv_pub.is_empty()).then(|| encode_hex(&record.recv_pub))
    }

    /// Record what the latest fix envelope was sealed for, for `device.health`.
    async fn note_seal(&self, total: usize, dropped: &[String]) {
        let Ok(store) = self.recipient_store().await else {
            return;
        };
        let mut report = recipients::SealReport {
            at: now_ms(),
            recipients: total as u32,
            dropped: dropped.len() as u32,
            dropped_peers: dropped.to_vec(),
            ..Default::default()
        };
        for entry in dropped {
            match entry.rsplit_once(':').map(|(_, reason)| reason) {
                Some("lapsed") => report.lapsed += 1,
                Some("no_session") => report.no_session += 1,
                _ => report.other += 1,
            }
        }
        store.record_seal(report);
    }

    async fn session_manager(&self) -> Result<Arc<sessions::SessionManager>, LocationError> {
        self.sessions
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)
    }

    async fn outbox(&self) -> Result<Arc<outbox::Outbox>, LocationError> {
        self.outbox
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)
    }

    async fn recipient_store(&self) -> Result<Arc<recipients::RecipientStore>, LocationError> {
        self.recipients
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)
    }

    async fn transport_store(&self) -> Result<Arc<transport::TransportStore>, LocationError> {
        self.transport
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)
    }

    async fn delivery_store(&self) -> Result<Arc<delivery::DeliveryStore>, LocationError> {
        self.delivery
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)
    }

    /// Who each peer is, for `peer.contact` (see [`contact::PeerRoles`]).
    ///
    /// A store that is not open yet yields an empty answer (every peer `other`) rather than an
    /// error: this only labels telemetry.
    async fn peer_roles(&self) -> contact::PeerRoles {
        peer_roles_from(
            self.recipient_store().await.ok().as_deref(),
            self.delivery_store().await.ok().as_deref(),
        )
    }

    /// The observer the trail replica reports to: every friend entry that lands, whoever brought
    /// it and whatever pass it rode in on (see [`docs::ReplicaObserver`]).
    ///
    /// Built in `start`, after the stores it labels contacts from are claimed, and holding clones
    /// rather than the node: the replica's watch tasks outlive no node, but they must not keep one
    /// alive either.
    async fn replica_watch(
        &self,
        endpoint: Endpoint,
    ) -> Result<Arc<dyn docs::ReplicaObserver>, LocationError> {
        Ok(Arc::new(ReplicaWatch {
            listener: self.replica_listener.clone(),
            endpoint,
            recipients: self.recipient_store().await?,
            delivery: self.delivery_store().await?,
        }))
    }

    async fn gate_store(&self) -> Result<Arc<gate::GateStore>, LocationError> {
        self.gate
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)
    }

    async fn seq_store(&self) -> Result<Arc<seq_store::SeqStore>, LocationError> {
        self.seq
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)
    }

    async fn read_latest_ratcheted_events_inner(&self) -> Result<Vec<RatchetEvent>, LocationError> {
        let (trail, sealed) = {
            let started = self.live().await?;
            let sealed = started
                .trail
                .read_latest_sealed()
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?;
            (started.trail.clone(), sealed)
        };
        let manager = self.session_manager().await?;
        let now = now_ms();

        let mut verified = sealed
            .into_iter()
            .filter_map(|bytes| crypto::verify_v3(&bytes).ok())
            .filter(|envelope| envelope.author != self.author)
            .collect::<Vec<_>>();
        // The fix and null lanes occupy separate LWW slots. If both current slots address us
        // (for example just after a sharing-direction change), open them in seq order so the
        // newer one does not advance the ratchet past the older activity record first.
        verified.sort_unstable_by_key(|envelope| (envelope.author, envelope.seq));

        let mut out = Vec::new();
        for verified in verified {
            let author = verified.author.to_vec();
            let payload = match manager.open(&author, &verified, now) {
                Ok(payload) => payload,
                Err(err) => {
                    tracing::debug!(
                        sc.author = %telemetry::short_hex(&author),
                        sc.seq = verified.seq,
                        sc.drop_reason = %err,
                        "ratcheted envelope not opened"
                    );
                    continue;
                }
            };
            let fix = match decode_fix_payload(&payload) {
                Ok(fix) => fix,
                Err(err) => {
                    tracing::debug!(
                        sc.author = %telemetry::short_hex(&author),
                        sc.seq = verified.seq,
                        error = %err,
                        "ratchet response payload could not be decoded"
                    );
                    continue;
                }
            };
            let kind = if fix.is_some() { "fix" } else { "null" };
            tracing::debug!(
                sc.author = %telemetry::short_hex(&author),
                sc.seq = verified.seq,
                sc.lane = kind,
                source = "durable",
                "ratchet response received"
            );
            // Who served this author's slot in the reconciliation that just ran. Absent for an
            // entry that was already in the replica — this reports delivery, never mere presence.
            let via_peer = trail.serving_peer(&author).await.map(|id| encode_hex(&id));
            out.push(RatchetEvent {
                author,
                seq: verified.seq,
                ts: verified.ts,
                kind: kind.to_string(),
                fix,
                via_peer,
            });
        }
        Ok(out)
    }
}

/// Session health and §4.6 restarts, as JS sees them. Recovery itself runs in the native drain
/// ([`LocationNode::recover_sessions`]); these exist for the per-friend health badges.
#[uniffi::export(async_runtime = "tokio")]
impl LocationNode {
    /// Whether this peer's session needs §4.6 recovery: a damaged record, `R` distinct envelopes
    /// we cannot open, a peer lapsed past `T_lapse` (§4.5), or — following — no sending chain for
    /// an hour.
    pub async fn is_desynced(&self, peer_endpoint_hex: String) -> Result<bool, LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        Ok(self.session_manager().await?.is_desynced(&peer, self.now()))
    }

    /// How many restarts have been installed with this peer in this process.
    ///
    /// §4.6 wants a restart *loop* to surface a "re-pair with this friend" prompt rather than
    /// retrying forever, so this is deliberately a count rather than a boolean: the UI decides
    /// where patience runs out, and the crypto layer does not pretend to know.
    pub async fn resync_count(&self, peer_endpoint_hex: String) -> Result<u32, LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        Ok(self.session_manager().await?.resync_count(&peer))
    }
}

/// How a caller wants the node's two on-disk roots resolved.
///
/// Both variants have to be resolved *after* the identity is known, because every path here is
/// scoped by the author hex and the author is only derivable once the key exists (it may have
/// just been generated).
enum NodeDirs {
    /// OS temp, scoped by author. Host tests and the desktop CLI, where nothing purges anything
    /// mid-run and there is no backup to be restored from.
    Default,
    /// Exact directories, used verbatim — the `cli` feature's `new_with_data_dir`, which keeps
    /// deliberately separate replica stores and must not have them renamed underneath it.
    #[cfg(feature = "cli")]
    Exact(PathBuf),
    /// Storage roots to scope per identity. The mobile path; see [`LocationNode::new_at_dirs`].
    Roots { data: PathBuf, state: PathBuf },
}

/// How many `LocationNode`s this PROCESS has built, ever.
///
/// The node is meant to be process-wide and singular — the host bridges refcount it so a mounted
/// app and a headless session adopt one node rather than clobbering each other. This counter is
/// what proves whether that actually held, and it is the only place that can: it sits below every
/// constructor and below every JS context, so it counts nodes in a process rather than nodes a
/// context believes it has.
///
/// **An ordinal above 1 with no intervening `shutdown` means two live nodes on one identity.** That
/// is not a degraded mode, it is two endpoints publishing the same endpoint id: a dial to that
/// identity lands on whichever one the relay or BLE picked, so a pairing handshake can reach
/// `verifying` on one node and have its `Accept` delivered to the other, which has never heard of
/// the session. It was reachable-but-unproven on 2026-09-13 — the evidence was three
/// `iroh endpoint bound` lines in a process that logged no shutdowns at all, which says a node was
/// built but not which context built it, and there was no way to tell a rebuild from a duplicate.
static NODE_ORDINAL: AtomicU64 = AtomicU64::new(0);

fn new_location_node_at(
    identity_secret: Option<Vec<u8>>,
    recv_secret: Option<Vec<u8>>,
    dirs: NodeDirs,
) -> Result<Arc<LocationNode>, LocationError> {
    telemetry::init_tracing();
    let ordinal = NODE_ORDINAL.fetch_add(1, Ordering::Relaxed) + 1;
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

    // Off-device, both live in one directory: temp is the right answer there, and collapsing them
    // keeps the CLI's on-disk layout exactly as it was. On a device they must diverge — see
    // `NodeDirs` and `LocationNode::state_dir`.
    let (data_dir, state_dir) = match dirs {
        NodeDirs::Default => {
            let dir = default_data_dir(&author);
            (dir.clone(), dir)
        }
        #[cfg(feature = "cli")]
        NodeDirs::Exact(dir) => (dir.clone(), dir),
        NodeDirs::Roots { data, state } => {
            let scope = encode_hex(&author);
            (data.join(&scope), state.join(&scope))
        }
    };

    let node = Arc::new(LocationNode {
        identity_seed,
        author,
        recv_secret,
        recv_public: recv_public.clone(),
        data_dir,
        state_dir,
        inner: Mutex::new(None),
        starting: Mutex::new(()),
        drain_lock: publish::DrainLock::default(),
        replica_listener: ReplicaListenerCell::default(),
        pair: PairCore::new(identity_seed, author, recv_public),
        profile_events: ProfileEventQueue::default(),
        sessions: Mutex::new(None),
        seq: Mutex::new(None),
        outbox: Mutex::new(None),
        recipients: Mutex::new(None),
        gate: Mutex::new(None),
        own_log: Mutex::new(None),
        transport: Mutex::new(None),
        delivery: Mutex::new(None),
        pending_bootstrap: Mutex::new(HashMap::new()),
        last_control: Mutex::new(None),
        clock_offset_ms: std::sync::atomic::AtomicI64::new(0),
        ordinal,
        stash_grant_at: AtomicU64::new(0),
    });
    tracing::info!(
        node.ordinal = ordinal,
        sc.author = %telemetry::short_hex(&author),
        "node.construct: built a LocationNode in this process"
    );
    if ordinal > 1 {
        // Loud on purpose. The bridges refcount precisely so this does not happen, and every way
        // it still can (a second host module instance, an identity mismatch adopting nothing, a
        // clobber) ends with two endpoints answering for one identity.
        tracing::warn!(
            node.ordinal = ordinal,
            sc.author = %telemetry::short_hex(&author),
            "node.construct: this process has now built more than one node for this identity"
        );
    }
    Ok(node)
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
        new_location_node_at(identity_secret, recv_secret, NodeDirs::Default)
    }

    /// Create a node under host-supplied storage roots. **This is the constructor mobile must
    /// use**; [`new`](Self::new) puts everything in the OS temp dir, which is right for host tests
    /// and wrong for a device.
    ///
    /// Both roots are scoped per identity internally (`<root>/<author hex>`), because the host
    /// cannot know the endpoint id before the node that derives it exists.
    ///
    /// - `data_root` — the recoverable trail replica and blobs. Cache is the correct home: it is
    ///   large, it is re-fetchable, and it must never be restored from a backup.
    /// - `state_root` — ratchet session state, which is **not** recoverable. This must be the
    ///   app's private data dir (Android `filesDir`, iOS Application Support) *and* excluded from
    ///   backup, since restoring an old copy rewinds send counters into key reuse. See
    ///   [`LocationNode::state_dir`].
    ///
    /// Passing the same root for both is a bug on device in one direction and a break in the
    /// other; the two have opposite requirements.
    /// Build a node from the platform keystore, for a background wake with no JS context alive.
    ///
    /// The counterpart to [`new_at_dirs`](Self::new_at_dirs), which takes the secrets as arguments
    /// because JS had already read them. Here nothing has: an OS location callback is the first
    /// code to run, so the node asks the platform for the identity itself through
    /// [`DeviceSecrets`].
    ///
    /// Fails with [`LocationError::NotStarted`] when the device has no identity yet. That is a
    /// fresh install whose app has never been opened, and the correct response is to do nothing —
    /// generating one here would mint an identity none of the user's friends have ever paired with,
    /// and silently orphan the one the app creates later.
    #[uniffi::constructor]
    pub fn from_device_secrets(
        secrets: Arc<dyn DeviceSecrets>,
        data_root: String,
        state_root: String,
    ) -> Result<Arc<Self>, LocationError> {
        let identity = secrets.identity_secret().ok_or(LocationError::NotStarted)?;
        let recv = secrets.recv_secret().ok_or(LocationError::NotStarted)?;
        new_location_node_at(
            Some(identity),
            Some(recv),
            NodeDirs::Roots {
                data: PathBuf::from(data_root),
                state: PathBuf::from(state_root),
            },
        )
    }

    #[uniffi::constructor]
    pub fn new_at_dirs(
        identity_secret: Option<Vec<u8>>,
        recv_secret: Option<Vec<u8>>,
        data_root: String,
        state_root: String,
    ) -> Result<Arc<Self>, LocationError> {
        new_location_node_at(
            identity_secret,
            recv_secret,
            NodeDirs::Roots {
                data: PathBuf::from(data_root),
                state: PathBuf::from(state_root),
            },
        )
    }

    /// Bind the iroh endpoint + spawn the docs/blobs router. Idempotent.
    #[tracing::instrument(
        name = "node.start",
        skip_all,
        fields(sc.author = %telemetry::short_hex(&self.author), relays = relay_urls.len())
    )]
    pub async fn start(
        &self,
        relay_urls: Vec<String>,
        relay_auth_token: String,
        relay_enabled: bool,
        ip_enabled: bool,
        ble_enabled: bool,
    ) -> Result<(), LocationError> {
        // Cheap check first, so a started node costs one uncontended lock and nothing else.
        if self.inner.lock().await.is_some() {
            return Ok(());
        }
        // Then serialize the slow path on its own lock. A second caller waits here rather than on
        // `inner`, so everything that only needs to ask whether the node is up stays responsive
        // while this one builds it.
        let _starting = self.starting.lock().await;
        // Re-check: whoever we queued behind may have finished the job while we waited.
        if self.inner.lock().await.is_some() {
            return Ok(());
        }
        // Claim every durable store BEFORE anything touches the network.
        //
        // The claims are process-wide, and while the app is mounted the native background runtime
        // asks for them and is refused. Taken after the endpoint bind, every refusal would first
        // have bound a second endpoint on our identity, spawned a router and opened the blob and
        // docs stores, then dropped them unannounced. Refused here, it costs a directory lock and
        // nothing else, which is what makes a refused claim safe to retry.
        //
        // Claim the ratchet session directory for this process (§4.2's structural single-writer
        // guard). A second live writer is refused rather than tolerated, because with sequential
        // state two writers is key reuse rather than a clobber.
        {
            let mut slot = self.sessions.lock().await;
            if slot.is_none() {
                std::fs::create_dir_all(&self.state_dir)
                    .map_err(|e| LocationError::Network(e.to_string()))?;
                let store = session_store::SessionStore::open(&self.state_dir, &self.identity_seed)
                    .map_err(|e| LocationError::Network(e.to_string()))?;
                *slot = Some(Arc::new(sessions::SessionManager::new(store, self.author)));
            }
        }
        // The publish counter, claimed in the same breath and under the same rule. It shares the
        // state dir because it shares the lifetime: both are per-identity, neither is recoverable
        // from the replica without a scan, and both must be released when the node shuts down.
        {
            let mut slot = self.seq.lock().await;
            if slot.is_none() {
                let store = seq_store::SeqStore::open(&self.state_dir)
                    .map_err(|e| LocationError::Network(e.to_string()))?;
                *slot = Some(Arc::new(store));
            }
        }
        // The drain path's own state. All three live beside the counter because they share its
        // lifetime and its reason for existing: an OS location callback has to be able to read
        // them before any JS module has loaded.
        {
            let mut slot = self.outbox.lock().await;
            if slot.is_none() {
                *slot = Some(Arc::new(
                    outbox::Outbox::open(&self.state_dir)
                        .map_err(|e| LocationError::Network(e.to_string()))?,
                ));
            }
        }
        {
            let mut slot = self.recipients.lock().await;
            if slot.is_none() {
                *slot = Some(Arc::new(
                    recipients::RecipientStore::open(&self.state_dir)
                        .map_err(|e| LocationError::Network(e.to_string()))?,
                ));
            }
        }
        {
            let mut slot = self.gate.lock().await;
            if slot.is_none() {
                *slot = Some(Arc::new(
                    gate::GateStore::open(&self.state_dir)
                        .map_err(|e| LocationError::Network(e.to_string()))?,
                ));
            }
        }
        {
            let mut slot = self.own_log.lock().await;
            if slot.is_none() {
                *slot = Some(Arc::new(
                    own_log::OwnLog::open(&self.state_dir)
                        .map_err(|e| LocationError::Network(e.to_string()))?,
                ));
            }
        }
        {
            let mut slot = self.transport.lock().await;
            if slot.is_none() {
                *slot = Some(Arc::new(
                    transport::TransportStore::open(&self.state_dir)
                        .map_err(|e| LocationError::Network(e.to_string()))?,
                ));
            }
        }
        {
            let mut slot = self.delivery.lock().await;
            if slot.is_none() {
                *slot = Some(Arc::new(
                    delivery::DeliveryStore::open(&self.state_dir)
                        .map_err(|e| LocationError::Network(e.to_string()))?,
                ));
            }
        }
        // The namespaces to reopen live in `state_dir`, not beside the replica: the replica is in
        // the cache directory on Android, and losing it must cost a re-sync, never a new identity.
        // Read here, with the other local state and before the endpoint binds, so a book that will
        // refuse the start does so without having touched the network.
        let open_book = |file: &str| {
            ns_book::NamespaceBook::open(&self.state_dir, file)
                .map(Arc::new)
                .map_err(|e| LocationError::Network(e.to_string()))
        };
        let trail_book = open_book(ns_book::TRAIL_BOOK_FILE)?;
        let profile_book = open_book(ns_book::PROFILE_BOOK_FILE)?;

        let relay_mode = if relay_enabled {
            relay::custom_relay_mode(&relay_urls, &relay_auth_token)
                .map_err(LocationError::Network)?
        } else {
            iroh::RelayMode::Disabled
        };
        // Peer addresses from stored tickets are filtered against this list (`relay::scrub_addr`).
        relay::set_known_relays(relay_enabled.then_some(relay_urls.as_slice()));
        let secret = SecretKey::from_bytes(&self.identity_seed);
        #[cfg(any(target_os = "android", target_vendor = "apple"))]
        let endpoint_id = secret.public();

        // Start from the N0 preset (IP transports + pkarr/DNS discovery) with our authenticated
        // relay map. On mobile we ADD a BLE custom transport alongside these — we never clear IP
        // transports or disable relay, so pairing/sync work both nearby (BLE) and over the
        // internet. Ticket-derived dials carry their own addresses, so nothing needs a separate
        // in-memory lookup.
        #[allow(unused_mut)]
        let mut builder = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret)
            .relay_mode(relay_mode);
        // iroh's default resolver sends its own queries to a nameserver list: Google's on Apple,
        // where it cannot read the system config, and on Android whatever list it read at build or
        // at the last network change, which can be the wrong network's. Some phones can never
        // reach either. Every relay dial, probe and address lookup goes through this one resolver,
        // so it goes through the OS instead; `system_dns` explains.
        #[cfg(any(target_vendor = "apple", target_os = "android"))]
        if let Some(resolver) = system_dns::resolver() {
            builder = builder.dns_resolver(resolver);
        }
        if !ip_enabled {
            builder = builder.clear_ip_transports();
        }

        #[cfg(any(target_os = "android", target_vendor = "apple"))]
        let ble = if ble_enabled {
            let pair = Arc::clone(&self.pair);
            let (b, handle) =
                ble::attach(builder, endpoint_id, move || pair.holds_ble_for_pairing()).await;
            builder = b;
            handle
        } else {
            ble::disabled()
        };
        #[cfg(not(any(target_os = "android", target_vendor = "apple")))]
        let ble = {
            let _ = ble_enabled;
            ble::disabled()
        };

        // Bounded for the same reason `ble::attach` is: this runs on the launch path, and an
        // endpoint that never finishes binding must surface as a failed `start` the caller can
        // retry, never as a `start` that hangs. Unlike BLE there is no degraded mode to fall back
        // to — without an endpoint there is no node — so this one is an error, not a warning.
        let endpoint = match tokio::time::timeout(ENDPOINT_BIND_TIMEOUT, builder.bind()).await {
            Ok(result) => result.map_err(|e| LocationError::Network(e.to_string()))?,
            Err(_) => {
                tracing::warn!(
                    timeout_ms = ENDPOINT_BIND_TIMEOUT.as_millis() as u64,
                    "endpoint bind timed out"
                );
                return Err(LocationError::Network("endpoint bind timed out".to_owned()));
            }
        };

        // Same-wifi/direct fast path: add mDNS (swarm-discovery) local-network address lookup
        // ALONGSIDE the N0 preset's relay + DNS discovery — never replacing it. Added
        // unconditionally on ALL targets: it's harmless on desktop and is the LAN fast path we
        // want on mobile too (BLE above only covers the no-wifi nearby case). Two phones on one
        // wifi can now discover + dial each other directly, with relay/DNS remaining as fallback.
        // (On iOS/Android the OS may require a multicast entitlement / MulticastLock at runtime,
        // but that's a manifest concern, not a build-time one; if mDNS can't start we log and
        // continue on the relay path.)
        if ip_enabled {
            match MdnsAddressLookup::builder().build(endpoint.id()) {
                Ok(mdns) => {
                    if let Ok(services) = endpoint.address_lookup() {
                        services.add(mdns);
                    }
                }
                Err(e) => {
                    tracing::warn!("mDNS local discovery unavailable, using relay/DNS only: {e}")
                }
            }
        }

        // iroh-docs' live engine announces and receives inserts over gossip, one topic per
        // namespace; nothing else in this crate speaks gossip. See `docs` for the model.
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
            TrailDocs::init(
                docs.clone(),
                (*blobs).clone(),
                self.data_dir.clone(),
                Some(trail_book),
                Some(self.replica_watch(endpoint.clone()).await?),
            )
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?,
        );
        let profile = Arc::new(
            ProfileDocs::init(
                docs,
                (*blobs).clone(),
                self.data_dir.clone(),
                Some(profile_book),
            )
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?,
        );
        // Arm the profile namespace as soon as the engine exists, not just on the next publish:
        // a friend who imported our read-ticket dials us to reconcile, and the live engine only
        // serves namespaces `start_sync` has marked as syncing. Best-effort — `publish_profile`
        // arms again, and a node that can't sync yet still holds the record locally.
        if let Err(err) = profile.arm_publishing().await {
            tracing::warn!(error = %err, "profile: could not arm the profile namespace at start");
        }

        // Wire the live handles into the pairing core so an Accept can mint our tickets, a
        // completed pair imports the peer's profile/trail namespaces, and — since §4.2 — the bump
        // installs the ratchet session it just rooted.
        let sink: Arc<dyn ProfileSink> = Arc::new(self.profile_events.clone());
        let session_manager = self
            .sessions
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)?;
        self.pair
            .attach_runtime(
                endpoint.clone(),
                trail.clone(),
                profile.clone(),
                sink,
                session_manager,
            )
            .await;

        // Publish the built node last, under a lock held only for the assignment itself.
        // Stamped with the node ordinal so an `iroh endpoint bound` in the log can be attributed
        // to a specific node rather than only to a moment. `ble_attached` is here for the same
        // reason: BLE attaches at CONSTRUCTION and can never be attached later, so whether this
        // node has it is fixed now and is what `ble_available()` will answer for its whole life.
        tracing::info!(
            node.ordinal = self.ordinal,
            ble_attached = ble.available(),
            ble_enabled,
            "node.start: endpoint is up"
        );
        *self.inner.lock().await = Some(Started {
            endpoint,
            trail,
            profile,
            ble,
            _router: router,
        });
        // Every start re-grants the stash, app or background: a stash restart forgets every
        // namespace, and this is the only path that runs in a process with no JS. Spawned.
        self.grant_stash(StashGrant::All { floored: false }, "start")
            .await;
        Ok(())
    }

    /// Shut down protocol handlers and close the endpoint before releasing this node.
    /// Tear the node down.
    ///
    /// Every step here is logged, and that is not incidental. This function awaits four things that
    /// can each block forever — the router shutdown and three async mutexes — and when one of them
    /// did (2026-08-18, an iPhone stuck with a relay connection still open) the JS caller was left
    /// with a promise that never settled, which wedged the process-wide session chain and left the
    /// phone dark for 19 hours. The callers now bound their wait, but a bounded wait only tells you
    /// *that* teardown hung. These markers tell you **where**: the last one logged is the await
    /// that did not return.
    pub async fn shutdown(&self) -> Result<(), LocationError> {
        // Exclude an in-flight `start` before touching anything. `start` publishes to `inner` only
        // at the very end, so without this a teardown landing mid-build takes `None`, tears down
        // nothing, and then watches the build install a live node it believed it had killed —
        // which is precisely the headless-vs-foreground clobber `native-runtime-owner.ts` exists
        // to prevent, reintroduced one layer down.
        //
        // This is not a new wait: holding `inner` across the build used to serialize these two for
        // free. Splitting the locks is what made it explicit, and the build is now bounded
        // (`ATTACH_TIMEOUT` + `ENDPOINT_BIND_TIMEOUT`), so the wait is finite where it was not.
        tracing::info!("shutdown: taking starting lock");
        let _starting = self.starting.lock().await;
        tracing::info!("shutdown: taking inner lock");
        let started = self.inner.lock().await.take();
        // A router that fails to close must not stop the rest of this function. It used to `?` out
        // here, which returned with every store below still claimed: the node was neither running
        // nor releasable, and every later `start` on this identity was refused with `AlreadyOpen`
        // until the process died. The error is still returned — after the claims are released.
        let mut router_error = None;
        if let Some(started) = started {
            // The replica watchers would end with the docs engine anyway; stopping them first
            // means none of them reports a delivery from an engine that is going away.
            started.trail.stop_watching();
            tracing::info!("shutdown: closing router");
            match started._router.shutdown().await {
                Ok(()) => tracing::info!("shutdown: router closed"),
                Err(e) => {
                    tracing::warn!(error = %e, "shutdown: router did not close cleanly");
                    router_error = Some(LocationError::Network(e.to_string()));
                }
            }
        }
        // Release the session-store writer claim, or `start` can never succeed again: the claim is
        // process-global (§4.2 requires that — a per-module flag cannot see across the fresh JS
        // context expo-task-manager hands each headless callback), so holding it past shutdown
        // turns every lifecycle stop/start into a permanent `AlreadyOpen`.
        //
        // The ratchet state itself is on disk and unaffected; this drops only the claim and the
        // in-memory miss counters. Nothing about a restart in flight lives in memory: the leader's
        // unanswered restart header and the follower's request are both on disk (§4.6).
        //
        // The pair runtime holds a handle too (it bootstraps sessions on a completed bump), and
        // the claim is released only when the *last* `Arc` drops — so clearing our slot alone
        // would leak it and make every restart `AlreadyOpen`. Detaching also matches what the
        // runtime is: live endpoint + docs handles that are about to become invalid anyway.
        tracing::info!("shutdown: detaching pair runtime");
        self.pair.detach_runtime().await;
        tracing::info!("shutdown: taking sessions lock");
        *self.sessions.lock().await = None;
        // Same rule for the publish counter: hold the slot past shutdown and the directory claim
        // outlives the node, so the next `start` is refused and the device stops publishing.
        tracing::info!("shutdown: taking seq lock");
        *self.seq.lock().await = None;
        // Two of these hold directory claims; releasing them is what lets the next `start` succeed.
        *self.outbox.lock().await = None;
        *self.recipients.lock().await = None;
        *self.gate.lock().await = None;
        *self.own_log.lock().await = None;
        *self.transport.lock().await = None;
        *self.delivery.lock().await = None;
        tracing::info!("shutdown: complete");
        match router_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    /// Notify iroh that the device's network may have changed (wifi↔cellular roam, interface
    /// up/down, IP reassignment).
    ///
    /// iroh's netmon auto-detects this on desktop, but Android's SELinux policy denies
    /// `untrusted_app` the netlink route socket + `/sys/class/net` reads it relies on (the recurring
    /// `avc: denied nlmsg_readpriv … netlink_route_socket` in logcat), so on Android iroh is blind to
    /// roaming: after the device leaves a network its sockets stay bound to the dead interface and the
    /// relay home is never re-derived, so cross-network sync silently dies. iroh exposes
    /// [`Endpoint::network_change`] precisely for this — the Android module observes
    /// `ConnectivityManager` and calls this on every default-network transition, prompting a socket
    /// rebind + relay re-check. No-op before `start()`; harmless to over-call.
    pub async fn network_changed(&self) {
        if let Some(started) = self.live_opt().await {
            // The rebind/relay re-check details show up as iroh's own magicsock/net_report
            // events; this marker is the join point telling us WHY they fired.
            tracing::info!("network_change: OS connectivity transition signaled");
            started.endpoint.network_change().await;
        }
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
        let started = self.live().await?;
        let addr = started.endpoint.addr();
        Ok(EndpointTicket::new(addr).to_string())
    }

    /// Announce friend-replica changes to `listener` from now on, replacing any listener before
    /// it. Per node: after the [`host`] rebuilds one (`restart`, `heal`, a replacement), attach to
    /// the new generation again. See [`ReplicaListener`].
    pub fn watch_replica(&self, listener: Arc<dyn ReplicaListener>) {
        self.replica_listener.set(Some(listener));
    }

    /// Stop announcing friend-replica changes. Replication carries on regardless.
    pub fn unwatch_replica(&self) {
        self.replica_listener.set(None);
    }

    /// Whether `start` has bound an endpoint that has not since been shut down.
    pub async fn is_started(&self) -> bool {
        self.live_opt().await.is_some()
    }

    // ── Durable trail (iroh-docs) — see docs/social/ARCHITECTURE.md §5–6 ──────────────────

    /// Reconcile our own + every imported friend namespace so each author's **current** fix is
    /// exchanged (FORWARD-SECRECY §4.4 — the durable path is last-write-wins; there is no missed
    /// history to recover). Read the results with [`Self::read_latest_ratcheted_events`].
    ///
    /// `peer_tickets` is every endpoint worth dialing for this pass: the trail stash when it is
    /// configured and opted into, and **every pool member**. That list is the whole mechanism
    /// behind ARCHITECTURE.md §1.3/§6 — "a rejoining B runs range-based reconciliation against
    /// C/D/A". An earlier revision took a single `Option<String>` that only ever carried the
    /// stash, so a device could recover an author's fix from the durable server or from the
    /// author, and from nobody else; with the author offline and the stash off there was no
    /// reachable source at all, even when a friend beside it demonstrably held the fix.
    ///
    /// The peers are handed to iroh-docs together rather than dialled one at a time, so a
    /// namespace reconciles with whoever answers instead of paying a separate timeout per peer.
    /// An empty list is meaningful and not an error: it reconciles with whatever the live engine
    /// is already connected to, which is the correct degenerate case (and what a device with no
    /// friends and no stash should do).
    ///
    /// Unparseable tickets are skipped rather than failing the pass — one malformed friend card
    /// must not stop reconciliation with everyone else — but they are counted on the span, since
    /// a silent skip is exactly the kind of thing that hides a real break.
    pub async fn sync_latest(
        &self,
        peer_tickets: Vec<String>,
        traceparent: Option<String>,
    ) -> Result<(), LocationError> {
        self.pull_inner(peer_tickets, None, traceparent).await?;
        Ok(())
    }

    /// [`Self::sync_latest`] with a wall-clock budget, reporting what the pass cost and found.
    ///
    /// For the native background runtimes, which pull inside a window the OS sizes and may end
    /// without warning. `budget_ms` bounds the whole pass (`None` keeps `sync_latest`'s natural
    /// timeouts, up to 25 s waiting for a first event plus 8 s per idle gap); a pass cut short
    /// keeps whatever had already landed, and the live engine goes on syncing behind it. The
    /// report is what the caller puts on its `friend.pull` span — see `infra/otel/README.md`.
    pub async fn pull_latest(
        &self,
        peer_tickets: Vec<String>,
        budget_ms: Option<u64>,
        traceparent: Option<String>,
    ) -> Result<PullReport, LocationError> {
        self.pull_inner(
            peer_tickets,
            budget_ms.map(std::time::Duration::from_millis),
            traceparent,
        )
        .await
    }

    /// Remember the transport settings, so a background bootstrap can `start` without JS.
    ///
    /// Push it whenever the app changes a transport toggle. The relay URLs and token are build-time
    /// constants inlined into the JS bundle, so a device only learns them by being told.
    pub async fn set_transport_config(
        &self,
        config: transport::TransportConfig,
    ) -> Result<(), LocationError> {
        self.transport_store()
            .await?
            .set(config)
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// `start`, using the settings stored by [`set_transport_config`](Self::set_transport_config).
    ///
    /// The bootstrap counterpart to `start`, for a wake with no JS context to supply them. Fails
    /// rather than defaulting when nothing is stored: a node started with an empty relay list runs,
    /// reports healthy, and can only reach peers on the same LAN — which looks exactly like the
    /// connectivity failures this path exists to eliminate.
    pub async fn start_stored(&self) -> Result<(), LocationError> {
        // Read from disk when the node is not started yet, which is the only time this is called
        // for real. The in-memory store is opened by `start` itself, so asking for it here used to
        // fail with `NotStarted` on every fresh node — the native background path on both platforms
        // could never build a node, and every capture that reached it was dropped. The store takes
        // no writer claim, so reading it beside a node that holds one is safe.
        let store = match self.transport_store().await {
            Ok(store) => store,
            Err(LocationError::NotStarted) => Arc::new(
                transport::TransportStore::open(&self.state_dir)
                    .map_err(|e| LocationError::Network(e.to_string()))?,
            ),
            Err(e) => return Err(e),
        };
        let config = store
            .get()
            .map_err(|e| LocationError::Network(e.to_string()))?;
        self.start(
            config.relay_urls,
            config.relay_auth_token,
            config.relay_enabled,
            config.ip_enabled,
            config.ble_enabled,
        )
        .await
    }

    /// Replace the set of friends this device seals location envelopes for.
    ///
    /// Both lists, one call: a friend belongs to exactly one of them and they change together, so
    /// two separate setters would leave a window where someone is in both or in neither. "Neither"
    /// is the dangerous one — it silently stops their ratchet contribution and lapses the edge
    /// (FORWARD-SECRECY.md §4.1).
    ///
    /// Persisted natively so an OS location callback can read them with no JS context alive. Push
    /// on every pool change; see [`crate::recipients`] for why a stale set is safe in the only
    /// direction it can be stale, and why revocation still rests on the ratchet session rather
    /// than on these lists.
    pub async fn set_sharing_recipients(
        &self,
        recipient_endpoints: Vec<String>,
        watcher_endpoints: Vec<String>,
    ) -> Result<(), LocationError> {
        self.recipient_store()
            .await?
            .set_all(&recipient_endpoints, &watcher_endpoints)
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Who the native drain path will seal for right now.
    pub async fn sharing_recipients(&self) -> Result<Vec<String>, LocationError> {
        Ok(self.recipient_store().await?.get())
    }

    /// Mirror each friend's X25519 receiving key, so the native drain can run §4.6 recovery.
    ///
    /// Push next to [`Self::set_sharing_recipients`], every friend (sharing and watch-only). The
    /// resync record is sealed to these keys, and a headless wake has no pool to read them from;
    /// a friend with no key here falls back to their verified profile.
    pub async fn set_recipient_keys(&self, keys: Vec<RecipientKey>) -> Result<(), LocationError> {
        let entries = keys
            .into_iter()
            .map(|k| (k.endpoint_id, k.recv_public))
            .collect::<Vec<_>>();
        self.recipient_store()
            .await?
            .set_keys(&entries)
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Who the latest fix envelope was sealed for and who it left out. `None` before the first.
    pub async fn last_seal_report(&self) -> Result<Option<recipients::SealReport>, LocationError> {
        Ok(self.recipient_store().await?.last_seal())
    }

    /// Record where a drained envelope must be sent to leave this device — see [`crate::delivery`].
    ///
    /// Push it on every pool change and every stash opt-in change, next to
    /// [`Self::set_sharing_recipients`]: that call says who to seal for, this one says who to hand
    /// the sealed bytes to, and a device that knows the first but not the second publishes into its
    /// own local replica and reports success.
    ///
    /// An empty ticket list is a valid configuration (stash off, no friends yet), not an unset one,
    /// so this never fails for being empty — the drain simply has no push to make.
    ///
    /// Opting into a stash (or moving to another one) grants it our namespaces at once; any other
    /// write re-grants at most once per [`stash::REGRANT_FLOOR_MS`], which covers the app's call
    /// on every launch without repeating the grant this node's start already made.
    pub async fn set_delivery_config(
        &self,
        config: delivery::DeliveryConfig,
    ) -> Result<(), LocationError> {
        let store = self.delivery_store().await?;
        let stash_changed = store.get().stash_base_url != config.stash_base_url;
        store
            .set(config)
            .map_err(|e| LocationError::Network(e.to_string()))?;
        self.grant_stash(
            StashGrant::All {
                floored: !stash_changed,
            },
            "delivery-config",
        )
        .await;
        Ok(())
    }

    /// Grant the stash our namespaces now — what `syncStashGrants` in `location-sharing.ts` did
    /// over HTTP from JS, which only ever ran on a foreground launch. Returns at once; the grant
    /// runs on its own task and reports as a `stash.grant` span.
    pub async fn grant_stash_now(&self) {
        self.grant_stash(StashGrant::All { floored: false }, "app")
            .await;
    }

    /// Where the native drain path will push right now. For diagnostics and `device.health`.
    pub async fn delivery_config(&self) -> Result<delivery::DeliveryConfig, LocationError> {
        Ok(self.delivery_store().await?.get())
    }

    /// When this device last accepted a fix, published, and pushed — as the native drain saw it.
    ///
    /// `device.health` used to derive all three from a JS-side watermark row, which only the JS
    /// publish path wrote. Once the native drain became the only publish path those stamps stopped
    /// moving, and the record began reporting a phone that was working as one that had been silent
    /// for eleven hours. These are the same moments observed from where they actually happen.
    pub async fn publish_watermarks(&self) -> Result<delivery::PublishWatermarks, LocationError> {
        let state = self.gate_store().await?.get();
        Ok(delivery::PublishWatermarks {
            last_accepted_at: state.last_accepted_at,
            last_published_at: state.last_published_at,
            last_pushed_at: state.last_pushed_at,
        })
    }

    /// Every position this device has published since the app last asked, oldest first, and forget
    /// them. The app appends them to its own trail; see [`own_log`] for why the replica cannot.
    pub async fn take_own_published(&self) -> Result<Vec<own_log::OwnPublished>, LocationError> {
        let log = self
            .own_log
            .lock()
            .await
            .clone()
            .ok_or(LocationError::NotStarted)?;
        log.take()
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Record a published position locally. Best-effort: a node without the log (not started) and
    /// a log that cannot write both lose only a trail point, never the publish.
    async fn record_own_published(&self, seq: u64, fix: &LocationFix) {
        if let Some(log) = self.own_log.lock().await.clone() {
            log.record(seq, fix);
        }
    }

    /// How many captured fixes are waiting to be sealed.
    pub async fn outbox_pending(&self) -> Result<u32, LocationError> {
        Ok(self.outbox().await?.pending())
    }

    /// Drop every queued fix (sign-out, or sharing turned off for good).
    pub async fn clear_outbox(&self) -> Result<(), LocationError> {
        self.outbox()
            .await?
            .clear()
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// The last sequence number handed out, without advancing. For display and diagnostics.
    pub async fn current_seq(&self) -> Result<u64, LocationError> {
        Ok(self.seq_store().await?.current())
    }

    /// Raise the counter to at least `floor`, returning whether it moved.
    ///
    /// Monotone: a floor at or below the current value is a no-op. Two callers, one shape — the
    /// one-time migration of the old `expo-secure-store` value, and recovery from a counter file
    /// that will not parse (seed from the highest `seq` in the local replica). Neither can
    /// re-issue a value, because raising a counter only ever skips.
    pub async fn seed_seq(&self, floor: u64) -> Result<bool, LocationError> {
        let store = self.seq_store().await?;
        tokio::task::spawn_blocking(move || store.seed(floor))
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    // ── ratcheted sessions (FORWARD-SECRECY.md §4.2, §4.7) ────────────────────────────────

    /// Begin a session bootstrap with `peer_endpoint_hex`: mint a fresh ephemeral X25519 keypair
    /// and return its **public** half as hex, to be carried to the peer.
    ///
    /// This is one half of the §4.6 primitive. In production both halves ride the pairing
    /// connection during the in-person SAS bump, identity-signed and transcript-bound; the
    /// signing and transport are step 7's, and until they land this is the seam a caller drives.
    ///
    /// Calling it again for the same peer replaces the pending ephemeral — an abandoned bootstrap
    /// leaves nothing behind but one unused secret, which drops with the process.
    pub async fn begin_session(&self, peer_endpoint_hex: String) -> Result<String, LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        let secret = x25519_dalek::StaticSecret::random_from_rng(rand::rngs::OsRng);
        let public = x25519_dalek::PublicKey::from(&secret).to_bytes();
        self.pending_bootstrap
            .lock()
            .await
            .insert(peer.to_vec(), secret);
        Ok(encode_hex(&public))
    }

    /// Complete the bootstrap with the peer's ephemeral public half, installing the session.
    ///
    /// `RK₀` is derived from the ephemeral-ephemeral DH and a transcript over both endpoint ids
    /// and both ephemerals — **never** from static-static DH, which a seized device could
    /// recompute from long-term keys it still holds (§3, §4.6 "no code path roots a session in
    /// static-static DH alone"). The transcript is canonically ordered, so both devices derive
    /// the same root and the same session id without negotiating either.
    ///
    /// The role is fixed by endpoint-id ordering, so the two sides take opposite halves of the
    /// standard asymmetric bootstrap with no extra round trip.
    pub async fn complete_session(
        &self,
        peer_endpoint_hex: String,
        peer_ephemeral_hex: String,
    ) -> Result<(), LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        let peer_eph: [u8; 32] = decode_hex(&peer_ephemeral_hex)
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| LocationError::Decode("bad ephemeral key hex".into()))?;

        let ours = self
            .pending_bootstrap
            .lock()
            .await
            .remove(peer.as_slice())
            .ok_or_else(|| LocationError::Decode("no pending bootstrap for this peer".into()))?;
        let our_eph = x25519_dalek::PublicKey::from(&ours).to_bytes();

        let shared = ours.diffie_hellman(&x25519_dalek::PublicKey::from(peer_eph));
        if !shared.was_contributory() {
            return Err(LocationError::Decode("degenerate ephemeral key".into()));
        }
        let transcript = boot_transcript(&self.author, &peer, &our_eph, &peer_eph);
        let (rk0, session_id) = derive_boot_root(shared.as_bytes(), &transcript);

        let manager = self.session_manager().await?;
        // Endpoint ordering, not who spoke first: simultaneous nearby bumps must not both think
        // they are the initiator (`ratchet::initiator_by_endpoint`).
        if ratchet::initiator_by_endpoint(&self.author, &peer) {
            manager
                .bootstrap(&peer, session_id, rk0, peer_eph, now_ms())
                .map_err(|e| LocationError::Network(e.to_string()))?;
        } else {
            // The responder's bump ephemeral doubles as its bootstrap ratchet key: it is exactly
            // the key the initiator just performed its root step against, and DR needs the
            // responder to hold a private the initiator can reach. It is replaced on the first
            // DH ratchet, which is the initiator's first envelope.
            manager
                .bootstrap_responder(&peer, session_id, rk0, ours, now_ms())
                .map_err(|e| LocationError::Network(e.to_string()))?;
        }
        Ok(())
    }

    /// Whether a ratchet session exists for this peer.
    pub async fn has_session(&self, peer_endpoint_hex: String) -> Result<bool, LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        Ok(self.session_manager().await?.has_session(&peer))
    }

    /// Forget the session with this peer (un-friending, or a §4.6 restart).
    pub async fn forget_session(&self, peer_endpoint_hex: String) -> Result<(), LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        self.session_manager()
            .await?
            .remove(&peer)
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Drop every FINISHED pairing session with this peer. Returns how many were removed.
    ///
    /// The companion to [`forget_session`](Self::forget_session): that one erases the ratchet
    /// state for a relationship that has ended, this one erases the pairing record of how it
    /// began. Needs no live node — the sessions live on `PairCore`, which is built at
    /// construction — so an unfriend still cleans up on a phone whose endpoint never came up.
    ///
    /// Live sessions are deliberately spared; see
    /// [`PairCore::forget_finished_sessions_with`](crate::pairing::PairCore::forget_finished_sessions_with).
    pub async fn forget_pair_sessions(
        &self,
        peer_endpoint_hex: String,
    ) -> Result<u32, LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        Ok(self.pair.forget_finished_sessions_with(&peer).await as u32)
    }

    /// Read the latest **ratcheted** fix per author from the local replica.
    ///
    /// Signature first, then session state — `verify_v3` returns a type that the session manager
    /// is the only consumer of, so no unauthenticated byte can reach the ratchet (§4.2).
    /// Envelopes we cannot open are skipped: addressed to someone else, replayed from the archive,
    /// or beyond the acceptance window are all "nothing to surface".
    pub async fn read_latest_ratcheted(&self) -> Result<Vec<IncomingFix>, LocationError> {
        Ok(self
            .read_latest_ratcheted_events_inner()
            .await?
            .into_iter()
            .filter_map(|event| {
                event.fix.map(|fix| IncomingFix {
                    author: event.author,
                    seq: event.seq,
                    fix,
                })
            })
            .collect())
    }

    /// Read the latest ratcheted envelope per durable lane, including null responses.
    pub async fn read_latest_ratcheted_events(&self) -> Result<Vec<RatchetEvent>, LocationError> {
        self.read_latest_ratcheted_events_inner().await
    }

    /// Explicitly drop durable entries older than `older_than_ts`.
    pub async fn prune_trail(&self, older_than_ts: u64) -> Result<(), LocationError> {
        let started = self.live().await?;
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
        let started = self.live().await?;
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
    ///
    /// The namespace is recorded so every later start reopens it, JS or not (see [`ns_book`]), and
    /// the stash is granted it at once.
    pub async fn import_doc_ticket(&self, ticket: String) -> Result<(), LocationError> {
        let started = self.live().await?;
        started
            .trail
            .import_ticket(&ticket)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        self.grant_stash(StashGrant::One(ticket), "import").await;
        Ok(())
    }

    /// Stop replicating a removed friend's trail namespace, and stop reopening it on every start.
    /// Returns whether we were replicating it. Call with the docs ticket the friend was added with.
    pub async fn forget_doc_ticket(&self, ticket: String) -> Result<bool, LocationError> {
        let started = self.live().await?;
        started
            .trail
            .forget_ticket(&ticket)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// [`Self::forget_doc_ticket`] for the friend's profile namespace.
    pub async fn forget_profile_ticket(&self, ticket: String) -> Result<bool, LocationError> {
        let profile = self.live().await?.profile;
        profile
            .forget_ticket(&ticket)
            .await
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
        let started = self.live().await?;
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
        let started = self.live().await?;
        started
            .profile
            .ticket()
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Import a friend's profile read-ticket and begin replicating + live-syncing their profile;
    /// accepted updates surface via [`poll_profile_events`](Self::poll_profile_events).
    pub async fn import_profile_ticket(&self, ticket: String) -> Result<(), LocationError> {
        // Take a handle, then DROP the guard before the import. `inner` is the node-wide lock that
        // `ble_capabilities`, `nearby_ble_peers`, `transport_diagnostics` and the publish path all
        // take, so holding it across a docs import made one unreachable friend stall every
        // unrelated native call — including the pairing poll that opens the SAS gate. Measured
        // 2026-09-10: `pairing.poll` spans of 47-131s on a phone whose docs engine was busy.
        let profile = self.live().await?.profile;
        let ns = profile
            .import_ticket(&ticket)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        let sink: Arc<dyn ProfileSink> = Arc::new(self.profile_events.clone());
        profile.watch(ns, sink);
        Ok(())
    }

    /// Read the newest verified profile for `endpoint_id` (self or a friend) from the local
    /// replica. `None` if absent or not yet replicated.
    pub async fn read_profile(
        &self,
        endpoint_id: Vec<u8>,
    ) -> Result<Option<ProfileView>, LocationError> {
        // Same reason as `import_profile_ticket`: the replica read reaches the docs engine, and
        // the node-wide `inner` lock must not be held while it waits its turn there.
        let profile = self.live().await?.profile;
        let rec = profile
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

    /// Withdraw an invite this node minted, given the opaque `scpair2:…` token it was shared as.
    ///
    /// Returns whether the invite was still outstanding, so a caller can tell "cancelled" from
    /// "there was nothing left to cancel". Takes the token rather than a decoded [`PairInvite`]
    /// because the token is the only form the app keeps once the link has been handed out.
    pub async fn revoke_pair_invite(&self, token: String) -> Result<bool, LocationError> {
        let inv =
            pairing::decode_invite(&token).map_err(|e| LocationError::Decode(e.to_string()))?;
        Ok(self.pair.revoke_invite(&inv.invite_id).await)
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

    /// Begin an invite-based pair from an opaque invite token (`scpair2:…`). Returns the session id.
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
    ///
    /// Returns once the decision is RECORDED, not once the peer has heard it. Telling the peer is a
    /// dial, bounded only by `PAIR_CONNECT_TIMEOUT`, and every caller is a human pressing REJECT or
    /// leaving the screen: on 2026-10-31 a Pixel's REJECT sat 15 s behind a Reject that could not
    /// reach an iPhone over a congested BLE link, and the app read as frozen. The decision itself
    /// (and any contradiction error) lands within the first lock, well inside
    /// [`CANCEL_PAIR_WAIT`]; delivery carries on in the background after that.
    pub async fn cancel_pair(&self, session_id: Vec<u8>) -> Result<(), LocationError> {
        let sid = session_id_arr(&session_id)?;
        let pair = self.pair.clone();
        let mut cancel = tokio::spawn(async move { pair.cancel_sas(&sid).await });
        match tokio::time::timeout(CANCEL_PAIR_WAIT, &mut cancel).await {
            Ok(Ok(result)) => result.map_err(|e| LocationError::Network(e.to_string())),
            Ok(Err(join)) => Err(LocationError::Network(join.to_string())),
            Err(_) => Ok(()),
        }
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
        // `live_opt` rather than the guard: this runs the instant a pair completes, and a profile
        // read that stalled here used to stall the whole node with it.
        let peer_profile = match self.live_opt().await {
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

    /// Snapshot the local endpoint's advertised addresses and iroh's retained path table for the
    /// requested peers. Remote path usage is point-in-time; callers should poll when displaying it.
    pub async fn transport_diagnostics(
        &self,
        peer_endpoint_ids: Vec<Vec<u8>>,
    ) -> Result<TransportDiagnostics, LocationError> {
        let endpoint = self.live().await?.endpoint;

        let local_addresses = endpoint
            .addr()
            .addrs
            .iter()
            .map(|address| transport_address_diagnostic(address, None))
            .collect();

        let mut peers = Vec::with_capacity(peer_endpoint_ids.len());
        for peer_endpoint_id in peer_endpoint_ids {
            let bytes: [u8; 32] = peer_endpoint_id
                .as_slice()
                .try_into()
                .map_err(|_| LocationError::Decode("peer endpoint id must be 32 bytes".into()))?;
            let endpoint_id = EndpointId::from_bytes(&bytes)
                .map_err(|e| LocationError::Decode(format!("bad peer endpoint id: {e}")))?;
            let info = endpoint.remote_info(endpoint_id).await;
            let (known, addresses) = match info {
                Some(info) => (
                    true,
                    info.addrs()
                        .map(|address| {
                            transport_address_diagnostic(
                                address.addr(),
                                Some(matches!(
                                    address.usage(),
                                    iroh::endpoint::TransportAddrUsage::Active
                                )),
                            )
                        })
                        .collect(),
                ),
                None => (false, Vec::new()),
            };
            peers.push(PeerTransportDiagnostic {
                endpoint_id: peer_endpoint_id,
                known,
                addresses,
            });
        }

        Ok(TransportDiagnostics {
            local_addresses,
            peers,
        })
    }

    /// What this device's durable replica can **serve**, one record per author present in it.
    ///
    /// The diagnostic that distinguishes "the relay had nothing to give" from "the transfer
    /// failed" — a distinction `friend_latest` cannot make, because it records what the app
    /// surfaced and keeps it after the replica moves on. Reconciliation serves out of the replica,
    /// so this is the only honest answer to "can this device relay author X".
    ///
    /// No decryption and no location data in the result — presence, not payload — so it is
    /// ungated, like [`Self::transport_diagnostics`]. `NamespaceId` is not an FFI type, so the
    /// exported shape reports by author endpoint id rather than by namespace.
    pub async fn trail_replica_status(&self) -> Result<Vec<TrailReplicaAuthor>, LocationError> {
        let started = self.live().await?;
        let trail = started.trail.clone();
        let slots = trail
            .replica_status()
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(slots
            .into_iter()
            .map(|slot| TrailReplicaAuthor {
                author: slot.author,
                seq: slot.seq,
                fix_ts: slot.fix_ts,
                has_content: slot.has_content,
            })
            .collect())
    }

    // ── BLE status (Android/Apple only; honest stub elsewhere) — ARCHITECTURE.md §2 ────────

    /// Whether a BLE transport is wired into this node's endpoint on this platform.
    pub async fn ble_available(&self) -> bool {
        self.live_opt()
            .await
            .map(|s| s.ble.available())
            .unwrap_or(false)
    }

    /// Honest BLE capability report combined with the app-level pairing-ready gate.
    pub async fn ble_capabilities(&self) -> BleCapabilities {
        let caps = self.live_opt().await.map(|s| s.ble.capabilities());
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
            match self.live_opt().await {
                Some(started) => started.ble,
                None => return Vec::new(),
            }
        };
        handle.nearby_peers().await.iter().map(ble_peer).collect()
    }

    /// Perform one foreground Bump rendezvous attempt using the same scanner/advertiser as the
    /// iroh BLE transport. The scan is refreshed, fresh peers are ranked by RSSI, ambiguous crowds
    /// fail closed, and the strongest peer's full identity is read + checked against its advertised
    /// prefix. No friendship is granted here; the returned endpoint still enters the authenticated
    /// nearby pairing + mandatory SAS flow.
    pub async fn resolve_bump_peer(&self, timeout_ms: u64) -> BumpResolution {
        use tracing::Instrument;
        let handle = {
            match self.live_opt().await {
                Some(started) => started.ble,
                None => {
                    return BumpResolution {
                        status: "unavailable".into(),
                        endpoint_id: None,
                        device_id: None,
                        rssi: None,
                        peer_count: 0,
                        detail: "BLE node is not started.".into(),
                    };
                }
            }
        };
        let timeout = std::time::Duration::from_millis(timeout_ms.clamp(2_000, 12_000));
        // `bump.resolve`: what one phone's search saw and how it ended. On 2026-10-30 an iPhone said
        // "No other streetCryptid phone answered" while a Pixel beside it had found it and was
        // dialling, and nothing recorded why its own search came back empty. `linked_peers` is the
        // transport's view at the end (a peer it already holds a link to can stop showing up as a
        // fresh advertisement), and `pairing_holds_ble` whether this phone's window was open.
        let span = tracing::info_span!(
            "bump.resolve",
            timeout_ms = timeout.as_millis() as u64,
            outcome = tracing::field::Empty,
            peer_count = tracing::field::Empty,
            rssi = tracing::field::Empty,
            detail = tracing::field::Empty,
            linked_peers = tracing::field::Empty,
            pairing_holds_ble = self.pair.holds_ble_for_pairing(),
            ms = tracing::field::Empty,
            // Filled by `BleHandle::resolve_bump_peer`: what the scan heard at all (`heard`), how
            // many of those advertised an iroh key, their RSSIs strongest first, and whether the
            // winner was named from what the transport already knew or by a GATT probe (each
            // probe is its own `ble.probe` span).
            scan_ms = tracing::field::Empty,
            scan_started = tracing::field::Empty,
            heard = tracing::field::Empty,
            iroh_devices = tracing::field::Empty,
            candidate_rssi = tracing::field::Empty,
            resolved_via = tracing::field::Empty,
            probes = tracing::field::Empty,
        );
        let started = std::time::Instant::now();
        let resolution = resolve_bump_with(&handle, timeout)
            .instrument(span.clone())
            .await;
        let linked = handle
            .nearby_peers()
            .await
            .iter()
            .filter(|peer| peer.phase == "connected")
            .count();
        span.record("ms", started.elapsed().as_millis() as u64);
        span.record("outcome", resolution.status.as_str());
        span.record("peer_count", resolution.peer_count);
        span.record("detail", resolution.detail.as_str());
        span.record("linked_peers", linked as u64);
        if let Some(rssi) = resolution.rssi {
            span.record("rssi", i64::from(rssi));
        }
        resolution
    }

    /// Passive proximity hint: has this peer's BLE advertisement been seen this session? This is
    /// the honest substitute for RSSI/active-scan the vendored crate does not expose; it triggers
    /// no active scan (the transport scans continuously). Always `false` on host / when unavailable.
    pub async fn ble_has_scan_hint(&self, endpoint_id: Vec<u8>) -> bool {
        self.live_opt()
            .await
            .map(|s| s.ble.has_scan_hint(&endpoint_id))
            .unwrap_or(false)
    }
}

/// Bounds the `network_change` an isolated node runs on itself.
const ISOLATION_NETWORK_CHANGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl LocationNode {
    /// Feed one delivery pass to the process's isolation tracker and act on what it says. See
    /// `isolation.rs`.
    ///
    /// Silence counts only when the stash was among the peers dialled: friends' phones are asleep
    /// most of the time, and a phone whose only peers are asleep is not isolated. An answer counts
    /// from anyone.
    ///
    /// The rebuild is taken here only when no app holds the node; the background runtimes re-read
    /// the host's node on every wake, so a replaced node is invisible to them. A mounted app heals
    /// through `rebindNode`, which re-wires what it built on the old node.
    fn observe_reachability(
        &self,
        answered: bool,
        stash_dialed: bool,
        source: isolation::Source,
        endpoint: &Endpoint,
    ) {
        let observation = if answered {
            isolation::Observation::Answered
        } else if stash_dialed {
            isolation::Observation::Silent
        } else {
            return;
        };
        let effects = isolation::observe(observation, source);
        if effects.contains(&isolation::Effect::NetworkChange) {
            let endpoint = endpoint.clone();
            tokio::spawn(async move {
                tracing::info!("network_change: this phone is reaching nobody");
                if tokio::time::timeout(ISOLATION_NETWORK_CHANGE_TIMEOUT, endpoint.network_change())
                    .await
                    .is_err()
                {
                    tracing::warn!("node.isolation: network_change did not finish");
                }
            });
        }
        let heal = observation == isolation::Observation::Silent
            && isolation::tracker().rebuild_due(isolation::now_ms())
            && host::node_host().snapshot().app_leases == 0;
        if heal {
            // The address only, compared against the host's own node: a test's node, or one
            // already replaced, is never healed in its place.
            let me = self as *const Self as usize;
            tokio::spawn(async move {
                host::node_host().heal_isolated(me).await;
            });
        }
    }

    /// The body of [`Self::sync_latest`] and [`Self::pull_latest`]. Kept out of the exported block
    /// so UniFFI does not see it.
    async fn pull_inner(
        &self,
        peer_tickets: Vec<String>,
        budget: Option<std::time::Duration>,
        traceparent: Option<String>,
    ) -> Result<PullReport, LocationError> {
        use tracing::Instrument;
        let started_at = n0_future::time::Instant::now();
        let deadline = budget.map(|b| started_at + b);
        let requested = peer_tickets.len();
        let peers: Vec<EndpointAddr> = peer_tickets
            .iter()
            .filter_map(|ticket| ticket.parse::<EndpointTicket>().ok())
            .map(|ticket| relay::scrub_addr(ticket.endpoint_addr().clone()))
            .collect();
        let dialed = peers.len();
        let dialed_ids: Vec<[u8; 32]> = peers.iter().map(|addr| *addr.id.as_bytes()).collect();
        let span = tracing::info_span!(
            "trail.sync",
            sc.author = %telemetry::short_hex(&self.author),
            sync.peers_requested = requested,
            sync.peers_dialed = dialed,
            // Peers that delivered at least one entry this pass — each is a `peer.contact`.
            sync.peers_delivered = tracing::field::Empty,
            // What the pass cost and why it ended — see `docs::SyncEnd`. `budget_ms` is absent
            // for the unbudgeted foreground/JS callers.
            sync.budget_ms = tracing::field::Empty,
            sync.entries = tracing::field::Empty,
            sync.namespaces = tracing::field::Empty,
            sync.namespaces_failed = tracing::field::Empty,
            sync.ns_content_ready = tracing::field::Empty,
            sync.ns_closed = tracing::field::Empty,
            sync.ns_idle = tracing::field::Empty,
            sync.ns_no_answer = tracing::field::Empty,
            sync.ns_deadline = tracing::field::Empty,
        );
        if let Some(budget) = budget {
            span.record("sync.budget_ms", budget.as_millis() as u64);
        }
        telemetry::set_parent(&span, traceparent.as_deref());
        async move {
            if dialed < requested {
                tracing::warn!(
                    skipped = requested - dialed,
                    "trail sync: some peer tickets were unparseable and were skipped"
                );
            }
            let started = self.live().await?;
            let trail = started.trail.clone();

            // No sink and no `recovered` count here any more: with one overwritten slot per author
            // there is no back-catalogue to stream, so a sync just reconciles and the app reads the
            // current fixes afterwards. The `recovered` span attribute is recorded app-side instead
            // (see `refreshTrailFromReplica`), which keeps the infra/otel `sc.*` join keys intact.
            let pass = trail.sync_all_until(peers, deadline).await.map_err(|e| {
                tracing::warn!(error = %e, "trail sync failed");
                LocationError::Network(e.to_string())
            })?;
            let current = tracing::Span::current();
            current.record("sync.entries", pass.delivered.len());
            current.record("sync.namespaces", pass.namespaces);
            current.record("sync.namespaces_failed", pass.failed);
            current.record("sync.ns_content_ready", pass.ends.content_ready);
            current.record("sync.ns_closed", pass.ends.closed);
            current.record("sync.ns_idle", pass.ends.idle);
            current.record("sync.ns_no_answer", pass.ends.no_answer);
            current.record("sync.ns_deadline", pass.ends.deadline);

            // Peers that delivered something. The `peer.contact` for each is NOT recorded here:
            // every entry a pull brings in also reaches the replica watch, which records one
            // contact per delivery whichever pass carried it (see `ReplicaWatch`). Counting here
            // too would count every pulled entry twice.
            let tallies = contact::tally_pull(&pass.delivered);
            let peers_delivered = tallies.len();
            current.record("sync.peers_delivered", peers_delivered);
            let roles = self.peer_roles().await;
            // A namespace that reached `ContentReady` or closed was answered by somebody even when
            // there was nothing new; one that only went idle was not (our own namespace emits
            // local events with nobody on the other end — 2026-10-22's silent passes all read
            // `ns_idle = 1`).
            self.observe_reachability(
                pass.ends.content_ready > 0 || pass.ends.closed > 0 || !pass.delivered.is_empty(),
                roles
                    .stash()
                    .is_some_and(|stash| dialed_ids.contains(stash)),
                isolation::Source::Pull,
                &started.endpoint,
            );
            Ok(PullReport {
                elapsed_ms: started_at.elapsed().as_millis() as u64,
                peers_requested: requested as u32,
                peers_dialed: dialed as u32,
                peers_delivered: peers_delivered as u32,
                entries: pass.delivered.len() as u32,
                namespaces: pass.namespaces as u32,
                namespaces_failed: pass.failed as u32,
                ns_content_ready: pass.ends.content_ready as u32,
                ns_closed: pass.ends.closed as u32,
                ns_idle: pass.ends.idle as u32,
                ns_no_answer: pass.ends.no_answer as u32,
                ns_deadline: pass.ends.deadline as u32,
            })
        }
        .instrument(span)
        .await
    }
}

#[cfg(feature = "cli")]
impl LocationNode {
    /// Construct a host-side node with an explicit replica directory. The trail-stash CLI uses
    /// separate pairing and watcher stores so direct pairing traffic can never contaminate a
    /// stash-only observation.
    pub fn new_with_data_dir(
        identity_secret: Option<Vec<u8>>,
        recv_secret: Option<Vec<u8>>,
        data_dir: PathBuf,
    ) -> Result<Arc<Self>, LocationError> {
        new_location_node_at(identity_secret, recv_secret, NodeDirs::Exact(data_dir))
    }

    /// Directly reconcile a trail capability with exactly `peer_ticket`, without importing it into
    /// the live docs engine. Returns the latest decryptable fix per
    /// author from that peer (LWW — there is no history to recover).
    pub async fn sync_latest_via_only(
        &self,
        read_ticket: String,
        peer_ticket: String,
        stash_url: String,
        stash_psk: Option<String>,
    ) -> Result<Vec<IncomingFix>, LocationError> {
        use tracing::Instrument;

        let doc_ticket = read_ticket
            .parse::<iroh_docs::DocTicket>()
            .map_err(|_| LocationError::Decode("bad trail docs read-ticket".into()))?;
        let endpoint_ticket = peer_ticket
            .parse::<EndpointTicket>()
            .map_err(|_| LocationError::Decode("bad strict sync endpoint ticket".into()))?;
        let peer = endpoint_ticket.endpoint_addr().clone();

        let span = tracing::info_span!(
            "trail.sync.stash_only",
            sc.author = %telemetry::short_hex(&self.author),
            stash.peer = %telemetry::short_hex(peer.id.as_bytes()),
            recovered = tracing::field::Empty,
        );
        async move {
            let (endpoint, trail) = {
                let started = self.live().await?;
                (started.endpoint.clone(), started.trail.clone())
            };
            let sealed = trail
                .sync_direct(
                    &endpoint,
                    doc_ticket,
                    peer,
                    &stash_url,
                    stash_psk.as_deref(),
                )
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?;
            let manager = self.session_manager().await?;
            let sealed_count = sealed.len();
            let mut verified = sealed
                .iter()
                .filter_map(|bytes| crypto::verify_v3(bytes).ok())
                .filter(|envelope| envelope.author != self.author)
                .collect::<Vec<_>>();
            verified.sort_unstable_by_key(|envelope| (envelope.author, envelope.seq));
            // Account for every blob, because EVERY reason to drop one is silent by design:
            // a non-v3 blob fails `verify_v3`, our own echo is filtered, and `NotForUs` is the
            // ordinary case in a pool (one wrap per recipient, only one of them ours). When a
            // fix legitimately never arrives, the difference between "the stash served nothing",
            // "it served something we could not verify" and "it served something not addressed
            // to us" is the whole diagnosis — and without this line all three look identical:
            // a watch that prints nothing at all.
            let verified_count = verified.len();
            let mut not_for_us = 0usize;
            let mut not_for_us_seqs: Vec<u64> = Vec::new();
            let mut open_failed = 0usize;
            let mut undecodable = 0usize;

            let mut fixes = Vec::new();
            for envelope in verified {
                let author = envelope.author.to_vec();
                let payload = match manager.open(&author, &envelope, now_ms()) {
                    Ok(payload) => payload,
                    Err(sessions::SessionError::NotForUs | sessions::SessionError::Replayed) => {
                        not_for_us += 1;
                        not_for_us_seqs.push(envelope.seq);
                        continue;
                    }
                    Err(error) => {
                        open_failed += 1;
                        eprintln!(
                            "[watch] ratcheted envelope {} could not be opened: {error}",
                            envelope.seq
                        );
                        continue;
                    }
                };
                let Ok(Some(fix)) = decode_fix_payload(&payload) else {
                    undecodable += 1;
                    continue;
                };
                fixes.push(IncomingFix {
                    author,
                    seq: envelope.seq,
                    fix,
                });
            }
            eprintln!(
                "[watch] blobs={sealed_count} verified={verified_count} opened={} not_for_us={not_for_us}{} open_failed={open_failed} undecodable={undecodable}",
                fixes.len(),
                if not_for_us_seqs.is_empty() {
                    String::new()
                } else {
                    format!(" (seq {not_for_us_seqs:?})")
                }
            );
            tracing::Span::current().record("recovered", fixes.len());
            Ok(fixes)
        }
        .instrument(span)
        .await
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

fn transport_address_diagnostic(
    address: &iroh::TransportAddr,
    active: Option<bool>,
) -> TransportAddressDiagnostic {
    let kind = if address.is_relay() {
        "relay"
    } else if address.is_ip() {
        "ip"
    } else {
        "custom"
    };
    TransportAddressDiagnostic {
        kind: kind.into(),
        address: address.to_string(),
        active,
    }
}

/// Whether an IP address is private / link-local — i.e. a LAN path rather than a routable one.
///
/// Mirrors `isLanIp` in `src/features/social/net/transports.ts`; keep the two in step so the
/// per-fix label and the transport debug panel never disagree about the same address.
fn is_lan_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            // Loopback, link-local (fe80::/10), unique-local (fc00::/7).
            v6.is_loopback() || (first & 0xffc0) == 0xfe80 || (first & 0xfe00) == 0xfc00
        }
    }
}

/// The label for one transport path, matching the transport rows the debug panel shows:
/// `relay` | `direct` | `lan` | `ble` (the only custom transport this app binds).
///
/// The `Custom` arm collapses to `ble` because BLE is the sole custom transport today. When Wi-Fi
/// Aware / Multipeer lands it will bind a SECOND custom transport, and this arm has to start
/// discriminating on the `CustomAddr` scheme — otherwise nearby high-bandwidth deliveries will
/// silently report as Bluetooth. [`transport_rank`] needs the new label at the same time.
fn transport_label(address: &iroh::TransportAddr) -> &'static str {
    match address {
        iroh::TransportAddr::Relay(_) => "relay",
        iroh::TransportAddr::Ip(socket) => {
            if is_lan_ip(socket.ip()) {
                "lan"
            } else {
                "direct"
            }
        }
        _ => "ble",
    }
}

/// Network distance of one transport label, closest first: nearby radio, then same network, then
/// hole-punched internet, then the relay of last resort. Lower sorts closer.
///
/// `stash` is deliberately absent: the stash is WHO handed an entry over (the serving peer,
/// matched against the configured stash by the reader), not a path, so it never competes here.
fn transport_rank(label: &str) -> u8 {
    match label {
        "ble" => 0,
        "lan" => 1,
        "direct" => 2,
        "relay" => 3,
        _ => u8::MAX,
    }
}

/// [`LocationNode::peer_roles`] over stores already in hand. Each store sits behind its own small
/// lock — NOT the node-wide `inner` lock — so this is safe from a replica watch task.
fn peer_roles_from(
    recipients: Option<&recipients::RecipientStore>,
    delivery: Option<&delivery::DeliveryStore>,
) -> contact::PeerRoles {
    let friends: Vec<[u8; 32]> = match recipients {
        Some(store) => store
            .get()
            .iter()
            .chain(store.watchers().iter())
            .filter_map(|hex| decode_endpoint(hex).ok())
            .collect(),
        None => Vec::new(),
    };
    // The stash goes FIRST in the delivery list when it is opted into (`DeliveryConfig`), and
    // only then; `PeerRoles::new` still lets a friend's recipient record win that position.
    let stash = delivery.and_then(|store| {
        let config = store.get();
        config
            .stash_base_url
            .as_ref()
            .and(config.peer_tickets.first())
            .and_then(|ticket| ticket.parse::<EndpointTicket>().ok())
            .map(|ticket| *ticket.endpoint_addr().id.as_bytes())
    });
    contact::PeerRoles::new(friends, stash)
}

/// What the node does when friend entries land in the replica: tell the app (if one is
/// listening) whose position just became readable, and record who handed them over.
///
/// This is the ONE receive-side `peer.contact`. A live broadcast from a friend's phone, a pull
/// from the stash, and a sync a friend opened to us all end in the same `InsertRemote`, so
/// counting here — and nowhere else — counts each delivery once whichever pass carried it.
struct ReplicaWatch {
    listener: ReplicaListenerCell,
    endpoint: Endpoint,
    recipients: Arc<recipients::RecipientStore>,
    delivery: Arc<delivery::DeliveryStore>,
}

impl docs::ReplicaObserver for ReplicaWatch {
    fn delivered(&self, deliveries: Vec<([u8; 32], [u8; 32])>) {
        let tallies = contact::tally_pull(&deliveries);
        if tallies.is_empty() {
            return;
        }
        let roles = peer_roles_from(Some(&self.recipients), Some(&self.delivery));
        let endpoint = self.endpoint.clone();
        tokio::spawn(async move {
            for (peer, tally) in tallies {
                let path = match EndpointId::from_bytes(&peer) {
                    Ok(id) => delivery_label(&endpoint, id).await,
                    Err(_) => "unknown".to_string(),
                };
                contact::record(contact::Contact {
                    dir: contact::Dir::Recv,
                    peer: &peer,
                    role: roles.role(&peer),
                    path: &path,
                    from_author: Some(tally.from_author),
                    entries: tally.entries,
                });
            }
        });
    }

    fn readable(&self, authors: Vec<[u8; 32]>) {
        if authors.is_empty() {
            return;
        }
        if let Some(listener) = self.listener.get() {
            listener.on_friend_entries(authors.into_iter().map(|a| a.to_vec()).collect());
        }
    }
}

/// The closest path we hold open to `delivered_from` right now — `ble` | `lan` | `direct` |
/// `relay`, or `unknown` when iroh has no active path to it (the connection that carried the data
/// already closed). It labels the path that WAS open, not the one the bytes provably took.
///
/// Closest, not "the one this exchange traversed": iroh keeps every usable path open at once — a
/// hole-punched direct path never demotes the relay path, which stays up as a fallback — and
/// [`iroh::endpoint::RemoteInfo`] exposes only the *set* of open paths. The real answer lives in
/// iroh's internal `selected_path`, reachable only through a `Connection`, which iroh-docs owns.
///
/// Ranking rather than taking the first active match is the point. `RemoteInfo::addrs()` iterates
/// an `FxHashMap`, so "first active" is arbitrary — and, with that hasher's fixed seed, *stably*
/// arbitrary per device: one phone labelled every delivery `relay` while its peer labelled the
/// same link `direct`.
async fn delivery_label(endpoint: &Endpoint, delivered_from: EndpointId) -> String {
    let info = match endpoint.remote_info(delivered_from).await {
        Some(info) => info,
        None => return "unknown".to_string(),
    };
    let closest = info
        .addrs()
        .filter(|address| matches!(address.usage(), iroh::endpoint::TransportAddrUsage::Active))
        .map(|address| transport_label(address.addr()))
        .min_by_key(|label| transport_rank(label));
    match closest {
        Some(label) => label.to_string(),
        None => "unknown".to_string(),
    }
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

/// The EndpointId (hex) inside an endpoint ticket, without dialling anything.
///
/// Pure decode, deliberately node-free: the app uses it to recognise the configured stash as the
/// device that handed over a fix, and that question comes up before (and independently of) any
/// node being started.
#[uniffi::export]
pub fn endpoint_id_from_ticket(ticket: String) -> Result<String, LocationError> {
    let parsed: EndpointTicket = ticket
        .parse()
        .map_err(|_| LocationError::Decode("bad endpoint ticket".into()))?;
    Ok(encode_hex(parsed.endpoint_addr().id.as_bytes()))
}

/// Encode a [`PairInvite`] into an opaque, dependency-free `scpair2:<base64url>` token for QR / links.
#[uniffi::export]
pub fn encode_pair_invite(invite: PairInvite) -> Result<String, LocationError> {
    let inv = invite_from_uniffi(&invite)?;
    pairing::encode_invite(&inv).map_err(|e| LocationError::Decode(e.to_string()))
}

/// Decode an opaque `scpair2:<base64url>` token back into a [`PairInvite`].
#[uniffi::export]
pub fn decode_pair_invite(token: String) -> Result<PairInvite, LocationError> {
    let inv = pairing::decode_invite(&token).map_err(|e| LocationError::Decode(e.to_string()))?;
    Ok(invite_to_uniffi(&inv))
}

/// Pad-and-encode a fix payload for sealing. `None` is the **null fix** (§4.1): an empty padded
/// frame, byte-identical in length to a real fix so the two lanes are indistinguishable by
/// ciphertext size. The inverse is [`decode_fix_payload`].
fn encode_fix_payload(fix: Option<&LocationFix>) -> Result<Vec<u8>, LocationError> {
    let encoded = match fix {
        Some(fix) => {
            postcard::to_allocvec(fix).map_err(|_| LocationError::Decode("encode fix".into()))?
        }
        None => Vec::new(),
    };
    pad::pad(&encoded).map_err(|e| LocationError::Decode(e.to_string()))
}

/// Unpad and decode a sealed fix payload. `Ok(None)` is a null fix (§4.1) — a watcher's cadence
/// keep-alive, which carries no position and is not an error.
fn decode_fix_payload(payload: &[u8]) -> Result<Option<LocationFix>, LocationError> {
    let inner = pad::unpad(payload).map_err(|e| LocationError::Decode(e.to_string()))?;
    if inner.is_empty() {
        return Ok(None);
    }
    // Decode across the zero fill, NOT across `inner`, and this is load-bearing rather than
    // incidental.
    //
    // `from_bytes` ignores trailing bytes, so an old peer reading a new payload simply drops the
    // appended fields — appending is safe in that direction for free. The other direction is not:
    // `unpad` trims to the declared length, so a new build reading a payload written before
    // `state` / `published_delta_s` existed would run out of input on the first `Option` tag,
    // return `Err`, and the replica reader would skip it as undecodable. A new build would go
    // silently blind to every friend still on an old one.
    //
    // postcard writes `Option::None` as a single `0x00`, and `unpad` has just PROVEN the fill is
    // zero (it rejects a dirty tail as a covert channel). So decoding the payload followed by its
    // own zero fill makes every appended `Option` field read as `None` on an old payload. That
    // makes appending compatible in both directions with no version byte and no two-shot decode —
    // a second dividend from a rule that was added for an unrelated security reason.
    //
    // The invariant this rests on: appended fields MUST be `Option` and MUST go at the end.
    postcard::from_bytes::<LocationFix>(&payload[2..])
        .map(Some)
        .map_err(|_| LocationError::Decode("decode fix".into()))
}

/// Milliseconds since the Unix epoch, saturating at 0 on a clock before it.
///
/// The ratchet uses this only for `T_lapse` (§4.5) and never for ordering or acceptance — those
/// are counter-based — so a wrong clock costs freshness, not correctness.
fn decode_endpoint(hex_str: &str) -> Result<[u8; 32], LocationError> {
    decode_hex(hex_str)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| LocationError::Decode("bad endpoint id hex".into()))
}

/// Lowercase hex, for the endpoint ids and ephemerals the session API speaks in.
fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// The bootstrap transcript: both identities and both ephemerals, canonically ordered.
///
/// Ordering by endpoint id rather than by role is what lets both devices compute the identical
/// transcript with no negotiation — the same trick `initiator_by_endpoint` uses for the role.
/// Binding all four values is what stops a peer's ephemeral from being replayed into a different
/// pairing (§4.6 "transcript-bound (both identities and both ephemerals under the signature)").
fn boot_transcript(
    ours: &[u8; 32],
    theirs: &[u8; 32],
    our_eph: &[u8; 32],
    their_eph: &[u8; 32],
) -> Vec<u8> {
    let mut t = Vec::with_capacity(128);
    let (first, first_eph, second, second_eph) = if ours < theirs {
        (ours, our_eph, theirs, their_eph)
    } else {
        (theirs, their_eph, ours, our_eph)
    };
    t.extend_from_slice(first);
    t.extend_from_slice(first_eph);
    t.extend_from_slice(second);
    t.extend_from_slice(second_eph);
    t
}

/// `RK₀` and the session id, both from the ephemeral-ephemeral shared secret and the transcript.
///
/// Two derivations from one secret under distinct blake3 contexts: the root must be secret, the
/// session id must not be (it goes in every wrap's AAD and both sides must agree on it offline).
fn derive_boot_root(shared: &[u8; 32], transcript: &[u8]) -> ([u8; 32], [u8; 16]) {
    let mut hasher = blake3::Hasher::new_derive_key(ratchet::BOOT_CONTEXT);
    hasher.update(shared);
    hasher.update(transcript);
    let rk0 = *hasher.finalize().as_bytes();

    // The session id is a public label, so it is derived from the transcript ALONE — deriving it
    // from the shared secret would leak nothing today but would make the id a secret-dependent
    // value travelling in clear AAD, which is a needless hostage to future analysis.
    let mut id_hasher = blake3::Hasher::new_derive_key("sc-dr/v1/session-id");
    id_hasher.update(transcript);
    let mut session_id = [0u8; 16];
    session_id.copy_from_slice(&id_hasher.finalize().as_bytes()[..16]);
    (rk0, session_id)
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

/// Writing our own namespace. Not exported: the app publishes through [`LocationNode::ingest_fix`]
/// and friends, which decide WHAT to seal; these only seal and write. Public for the integration
/// tests, which exercise the ratchet against a real replica.
impl LocationNode {
    /// Seal `fix` under **envelope v3** for each recipient's ratchet session and write it to our
    /// namespace's fix slot (FORWARD-SECRECY §4.7).
    ///
    /// Recipients are **endpoint ids**, not receiving keys: a v3 wrap is addressed by session,
    /// and sessions are keyed by who the peer is rather than by a long-term key of theirs. That
    /// difference is the point — the long-term receiving key is exactly what a seized device
    /// still holds.
    ///
    /// Returns the recipients that were left out, as `endpoint_hex:reason` — lapsed (§4.5),
    /// un-bootstrapped, or unpersistable. A short wrap list is never silent.
    pub async fn docs_write_ratcheted(
        &self,
        seq: u64,
        fix: LocationFix,
        recipient_endpoints: Vec<String>,
    ) -> Result<Vec<String>, LocationError> {
        let ts = fix.ts;
        self.write_ratcheted(seq, Some(fix), ts, recipient_endpoints)
            .await
    }

    /// Seal a **null fix** for `watcher_endpoints` and write it to the null slot (§4.1).
    ///
    /// A null fix is an ordinary envelope carrying an empty padded payload: same signature, same
    /// AAD binding, same `seq` monotonicity, same ciphertext length as a real fix. A watcher who
    /// only ever *reads* our position still receives our envelopes on cadence, and each one
    /// carries our ratchet contribution — which is what advances their `peer_advanced_ms` for us
    /// and stops `next_wraps` dropping us as `Lapsed` after 24 h.
    pub async fn docs_write_null_ratcheted(
        &self,
        seq: u64,
        ts: u64,
        watcher_endpoints: Vec<String>,
    ) -> Result<Vec<String>, LocationError> {
        self.write_ratcheted(seq, None, ts, watcher_endpoints).await
    }

    /// Both lanes. `fix.is_none()` is the null lane, which differs only in carrying an empty padded
    /// payload and landing in a separate LWW slot — the two envelopes a tick produces are wrapped
    /// for disjoint recipient sets, so sharing a slot would have them supersede each other.
    async fn write_ratcheted(
        &self,
        seq: u64,
        fix: Option<LocationFix>,
        ts: u64,
        recipient_endpoints: Vec<String>,
    ) -> Result<Vec<String>, LocationError> {
        use tracing::Instrument;
        let null = fix.is_none();
        let span = tracing::info_span!(
            "docs.write",
            sc.author = %telemetry::short_hex(&self.author),
            sc.seq = seq,
            sc.lane = if null { "null" } else { "fix" },
            // Recorded once sealed: v4 while a restart header rides along, v3 otherwise.
            sc.envelope = tracing::field::Empty,
            // blake3 of the sealed envelope, i.e. the content hash the stash and every reader see
            // — the cross-device join key.
            sc.entry_hash = tracing::field::Empty,
            recipients = recipient_endpoints.len(),
            dropped = tracing::field::Empty,
            sc.drop_reason = tracing::field::Empty,
            dropped_peers = tracing::field::Empty,
        );
        async move {
            let peers = recipient_endpoints
                .iter()
                .map(|hex| decode_endpoint(hex).map(|e| e.to_vec()))
                .collect::<Result<Vec<_>, _>>()?;
            let manager = self.session_manager().await?;

            let payload = encode_fix_payload(fix.as_ref())?;
            // Persist-before-publish: every counter these wraps represent is on disk before the
            // seal below, let alone the write (§4.2).
            let set = manager
                .next_wraps(&peers, now_ms())
                .map_err(|e| LocationError::Network(e.to_string()))?;
            let dropped: Vec<String> = set
                .dropped
                .iter()
                .map(|(peer, reason)| format!("{}:{}", encode_hex(peer), reason.as_str()))
                .collect();
            record_wrap_drops(&set.dropped);

            // Every recipient dropped means this envelope reaches nobody. Writing it anyway would
            // burn a `seq` and leave a wrap-less envelope in the replica for the stash to hold.
            if set.wraps.is_empty() {
                return Ok(dropped);
            }

            let envelope = crypto::seal_v3(
                &self.identity_seed,
                &self.author,
                seq,
                ts,
                DOCS_MESH_EPOCH,
                &payload,
                set.wraps,
            )?;
            if let Some(v) = crypto::envelope_version(&envelope) {
                tracing::Span::current().record("sc.envelope", v);
            }
            tracing::Span::current().record(
                "sc.entry_hash",
                tracing::field::display(telemetry::envelope_hash(&envelope)),
            );

            let started = self.live().await?;
            let ns = started.trail.own_namespace();
            let write = if null {
                started.trail.write_nul(ns, &self.author, envelope).await
            } else {
                started.trail.write(ns, &self.author, envelope).await
            };
            write.map_err(|e| LocationError::Network(e.to_string()))?;
            Ok(dropped)
        }
        .instrument(span)
        .await
    }
}

/// Turn a ratcheted write's dropped list into what the drain needs to know about it.
fn sealed_from(total: usize, dropped: &[String]) -> publish::Sealed {
    let dropped = dropped.len().min(total);
    publish::Sealed {
        wrapped: (total - dropped) as u32,
        dropped: dropped as u32,
    }
}

/// Put who a ratcheted publish left out, and why, on the current span.
///
/// The count alone said "one recipient dropped" on 785 consecutive publishes and nothing about
/// why; the reason is what separates "these two need to re-pair" (`no_session`) from "recovery is
/// not running" (`lapsed`), and the short peer ids join it to that friend's own span stream.
fn record_wrap_drops(dropped: &[(Vec<u8>, sessions::DropReason)]) {
    let span = tracing::Span::current();
    span.record("dropped", dropped.len());
    if dropped.is_empty() {
        return;
    }
    let mut reasons: Vec<&str> = dropped.iter().map(|(_, r)| r.as_str()).collect();
    reasons.sort_unstable();
    reasons.dedup();
    let who = dropped
        .iter()
        .map(|(peer, r)| format!("{}:{}", telemetry::short_hex(peer), r.as_str()))
        .collect::<Vec<_>>()
        .join(",");
    span.record("sc.drop_reason", reasons.join(","));
    span.record("dropped_peers", who);
}

/// Binds a node to [`publish::PublishSink`], so the engine can send without knowing what iroh-docs
/// is.
///
/// A publish is ONE write to our own namespace. The live engine broadcasts it to every peer
/// currently syncing that namespace, and [`Self::flush`] reconciles it with the stash and the pool
/// for everyone who is not — the same entry either way, so there is one sealed envelope per tick
/// and one ratchet position spent per recipient.
struct NodeSink<'a> {
    node: &'a LocationNode,
}

impl publish::PublishSink for NodeSink<'_> {
    /// One envelope, under one `publish.fix` span.
    ///
    /// # Why this span exists
    ///
    /// `publish.fix` was a JS span only, and `infra/otel/README.md` claimed native spans were its
    /// children on both platforms. They were not — the native drain reached the wire without ever
    /// opening one, so on 2026-09-05 two of three devices published hundreds of envelopes in 48
    /// hours and emitted no `publish.fix` at all. The span fired when a JS context happened to be
    /// alive, which on iOS means roughly "while the phone is moving and the app is up" — so the one
    /// dashboard that answers "is this device publishing" went blank in exactly the conditions
    /// worth watching.
    ///
    /// It is opened here, and only here: the native drain is the one publisher on every platform
    /// (the JS publish path is gone), so `{ name = "publish.fix" }` means "this device sealed an
    /// envelope into its replica", whoever drove the drain.
    async fn publish(
        &self,
        seq: u64,
        fix: LocationFix,
        recipients: Vec<String>,
    ) -> Result<publish::Sealed, publish::PublishError> {
        use tracing::Instrument;
        let span = tracing::info_span!(
            "publish.fix",
            sc.author = %telemetry::short_hex(&self.node.author),
            sc.seq = seq,
            recipients = recipients.len(),
            // The two clocks, on the span as well as on the wire, so a gap in a friend's trail can
            // be read back to whether the sender was parked or had stopped running.
            payload_ts = fix.ts,
            fix_state = fix.state.unwrap_or(0),
            published_delta_s = fix.published_delta_s.unwrap_or(0),
        );
        async move {
            let total = recipients.len();
            let own = fix.clone();
            let dropped = self
                .node
                .docs_write_ratcheted(seq, fix, recipients)
                .await
                .map_err(|e| publish::PublishError::Send(e.to_string()))?;
            self.node.note_seal(total, &dropped).await;
            // Whatever the recipients made of it: this is the device's own trail, which records
            // where it WAS, not who could read it.
            self.node.record_own_published(seq, &own).await;
            Ok(sealed_from(total, &dropped))
        }
        .instrument(span)
        .await
    }

    async fn publish_null(
        &self,
        seq: u64,
        ts: u64,
        watchers: Vec<String>,
    ) -> Result<publish::Sealed, publish::PublishError> {
        let total = watchers.len();
        let dropped = self
            .node
            .docs_write_null_ratcheted(seq, ts, watchers)
            .await
            .map_err(|e| publish::PublishError::Send(e.to_string()))?;
        Ok(sealed_from(total, &dropped))
    }

    async fn recover(&self, peers: Vec<String>) -> publish::RecoveryOutcome {
        self.node.recover_sessions(&peers).await
    }

    /// Reconcile the trail namespace with the stash and the pool, so the envelopes just written
    /// leave the device. See [`LocationNode::push_trail`].
    ///
    /// Reads the peer set from [`crate::delivery`] rather than taking it as an argument, because
    /// the caller that most needs this — an OS location callback with no JS context alive — has
    /// nowhere to get it from. `set_delivery_config` is what keeps it current.
    async fn flush(&self) -> Result<publish::FlushOutcome, publish::PublishError> {
        let node = self.node;
        let config = node
            .delivery_config()
            .await
            .map_err(|e| publish::PublishError::Send(e.to_string()))?;
        // Nothing to push to is a real state — stash opted out, no friends yet — and not worth a
        // span or a native round trip. Reported as
        // `NoTargets` rather than as success: nothing left the device, and saying otherwise is how
        // the watermark started lying.
        if config.is_empty() {
            return Ok(publish::FlushOutcome::NoTargets);
        }
        // This is the push. Its success or failure is the whole of whether the entries left.
        node.push_trail(config.peer_tickets.clone())
            .await
            .map_err(|e| publish::PublishError::Send(e.to_string()))?;
        // The blob upload is a SEPARATE fact and must not be able to discard the push above.
        //
        // It used to be chained with `?`, so an unreachable content API turned a completed
        // reconciliation into a failed flush and the drain skipped the watermark — a phone pushing
        // fine every few minutes reported `last_push_age_ms` in the tens of minutes, which is the
        // instrument you reach for when you suspect exactly this. Reconciliation moved the entries
        // regardless; a missing blob is a degradation the stash already reports itself, as
        // `content_missing` on `/healthz` and on the `trail.content.upload` span.
        //
        // Stash-only and gated on the OPT-IN, not on the stash merely being built into this
        // bundle. Uploading for a user who switched the stash off would PUT sealed envelopes into
        // a namespace nothing registered.
        if let Some((base_url, psk)) = config.stash() {
            if let Err(err) = node.upload_trail_content(base_url.to_string(), psk).await {
                tracing::warn!(
                    error = %err,
                    "trail content upload failed; entries reconciled but their blobs may be missing"
                );
            }
        }
        Ok(publish::FlushOutcome::Pushed)
    }
}

/// The four stores a drain runs over, taken from the node once per call.
struct DrainPorts {
    seq: Arc<seq_store::SeqStore>,
    queue: Arc<outbox::Outbox>,
    recipients: Arc<recipients::RecipientStore>,
    gate: Arc<gate::GateStore>,
}

impl DrainPorts {
    async fn of(node: &LocationNode) -> Result<Self, LocationError> {
        Ok(Self {
            seq: node.seq_store().await?,
            queue: node.outbox().await?,
            recipients: node.recipient_store().await?,
            gate: node.gate_store().await?,
        })
    }

    fn engine<'a>(
        &'a self,
        node: &'a LocationNode,
        sink: &'a NodeSink<'a>,
    ) -> publish::DrainEngine<'a, NodeSink<'a>> {
        publish::DrainEngine {
            seq: self.seq.as_ref(),
            queue: self.queue.as_ref(),
            recipients: self.recipients.as_ref(),
            gate: self.gate.as_ref(),
            sink,
            quality: gate::FixQualityConfig::default(),
            lock: &node.drain_lock,
            clock: &publish::SystemClock,
        }
    }
}

/// The publish path: everything that puts our position on the wire goes through one of these
/// three, whether the mounted app or a native background runtime is driving.
///
/// Thin by design: the decisions live in [`publish::DrainEngine`], which depends on ports rather
/// than on a node, so they can be tested against fakes that fail on demand. All this does is bind
/// those ports to the real stores and hand the engine somewhere to send.
#[uniffi::export(async_runtime = "tokio")]
impl LocationNode {
    /// Take one captured location all the way to the wire, with no JS involved.
    ///
    /// This is the whole point of the native drain path. `expo-task-manager` spools location events
    /// when it cannot start a headless JS context, and on 2026-08-29 a Pixel spooled eleven and a
    /// half hours of them — 446 real fixes, captured by a perfectly healthy foreground service,
    /// with nothing on the JS side alive to publish them. Everything below runs in the OS callback
    /// that delivered the fix.
    pub async fn ingest_fix(
        &self,
        fix: LocationFix,
        battery: gate::BatteryState,
        interval_ms: u64,
        now_ms: u64,
    ) -> Result<publish::IngestOutcome, LocationError> {
        let ports = DrainPorts::of(self).await?;
        let sink = NodeSink { node: self };
        ports
            .engine(self, &sink)
            .ingest(fix, battery, interval_ms, now_ms)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Publish the slots that have come due without a new fix, reusing the last known position.
    ///
    /// `ingest_fix` only runs when the OS delivers a location, and on a stationary phone that can
    /// be never; the cadence still has to be uniform, because it is the one property of a sealed
    /// envelope the stash can read.
    ///
    /// `parked` is what the caller can prove about motion: `Some(true)` a confirmed stop,
    /// `Some(false)` a stop just left, `None` a clock with no evidence either way (the JS timer).
    /// Only the first stamps `parked` — see [`publish::Motion`] for the day it was unconditional.
    pub async fn heartbeat_fix(
        &self,
        battery: gate::BatteryState,
        interval_ms: u64,
        now_ms: u64,
        parked: Option<bool>,
    ) -> Result<publish::IngestOutcome, LocationError> {
        let ports = DrainPorts::of(self).await?;
        let sink = NodeSink { node: self };
        ports
            .engine(self, &sink)
            .heartbeat(
                publish::Motion::from_parked(parked),
                battery,
                interval_ms,
                now_ms,
            )
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Seal the last known position once, for a recipient set that has just grown.
    ///
    /// Called when a pairing is accepted. A sealed envelope is readable only by the recipients it
    /// was sealed for, so a new friend cannot open anything published before they existed and
    /// their first sight of you is otherwise your next scheduled publish — p90 92 minutes on a
    /// parked iPhone. See [`publish::DrainEngine::publish_introduction`] for what it deliberately
    /// does NOT touch (the slot cursor, the parked/live stamp, the battery suspension).
    pub async fn publish_introduction(
        &self,
        now_ms: u64,
    ) -> Result<publish::IngestOutcome, LocationError> {
        let ports = DrainPorts::of(self).await?;
        let sink = NodeSink { node: self };
        ports
            .engine(self, &sink)
            .publish_introduction(now_ms)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }
}

/// One Bump search, as the app's [`BumpResolution`] (see [`LocationNode::resolve_bump_peer`]).
async fn resolve_bump_with(handle: &BleHandle, timeout: std::time::Duration) -> BumpResolution {
    match handle.resolve_bump_peer(timeout).await {
        Ok(peer) => BumpResolution {
            status: "resolved".into(),
            endpoint_id: Some(peer.endpoint_id),
            device_id: Some(peer.device_id),
            rssi: peer.rssi,
            peer_count: peer.peer_count,
            detail: "Nearby phone resolved.".into(),
        },
        Err(ble::BumpResolveError::Unavailable) => BumpResolution {
            status: "unavailable".into(),
            endpoint_id: None,
            device_id: None,
            rssi: None,
            peer_count: 0,
            detail: "BLE is unavailable in this build or on this device.".into(),
        },
        Err(ble::BumpResolveError::NoPeers) => BumpResolution {
            status: "noPeers".into(),
            endpoint_id: None,
            device_id: None,
            rssi: None,
            peer_count: 0,
            detail: "No fresh streetCryptid signal was found.".into(),
        },
        Err(ble::BumpResolveError::Ambiguous { peer_count }) => BumpResolution {
            status: "ambiguous".into(),
            endpoint_id: None,
            device_id: None,
            rssi: None,
            peer_count,
            detail: "More than one equally close signal was found.".into(),
        },
        Err(ble::BumpResolveError::ProbeFailed { peer_count, detail }) => BumpResolution {
            status: "probeFailed".into(),
            endpoint_id: None,
            device_id: None,
            rssi: None,
            peer_count,
            detail,
        },
    }
}

#[cfg(test)]
mod null_fix_tests {
    use super::{
        decode_fix_payload, encode_fix_payload, pad, LocationFix, FIX_STATE_LIVE, FIX_STATE_NO_FIX,
        FIX_STATE_PARKED,
    };
    use crate::crypto;
    use crate::docs::{encode_key, encode_nul_key, encode_rsy_key};

    fn fix() -> LocationFix {
        LocationFix {
            lat: -122.419416,
            lon: 37.774929,
            accuracy_m: 12.5,
            heading_deg: 91.0,
            ts: 1_786_000_000_000,
            state: None,
            published_delta_s: None,
        }
    }

    /// A `LocationFix` as it was encoded before the envelope stamps existed.
    ///
    /// Field-for-field the first five of the real one, so postcard produces exactly the bytes an
    /// older build puts on the wire. Both compatibility tests below are written against this
    /// rather than against a hand-typed byte array, so they keep testing the real thing if the
    /// position fields ever change.
    #[derive(serde::Serialize, serde::Deserialize)]
    struct LegacyFix {
        lat: f64,
        lon: f64,
        accuracy_m: f64,
        heading_deg: f64,
        ts: u64,
    }

    /// New build, old sender: the direction that silently breaks.
    ///
    /// `unpad` trims to the declared length, so decoding the trimmed slice would hit end-of-input
    /// on the first appended `Option` tag and return `Err` — and `latest_fix_to_incoming` turns a
    /// decode error into `None`, i.e. the friend's fix vanishes with no error anywhere. A build
    /// that shipped this would go blind to every peer still running the previous one, and nothing
    /// would say so.
    #[test]
    fn a_fix_from_a_sender_that_predates_the_envelope_stamps_still_decodes() {
        let legacy = LegacyFix {
            lat: -122.419416,
            lon: 37.774929,
            accuracy_m: 12.5,
            heading_deg: 91.0,
            ts: 1_786_000_000_000,
        };
        let frame = pad::pad(&postcard::to_allocvec(&legacy).unwrap()).unwrap();

        let decoded = decode_fix_payload(&frame)
            .expect("an older peer's fix must decode, not error")
            .expect("and must carry a position");

        assert_eq!(decoded.ts, 1_786_000_000_000);
        assert_eq!(decoded.lat, -122.419416);
        // Absent, not guessed. "This sender does not tell us" and "this sender says live" are
        // different claims and the UI has to keep them apart.
        assert_eq!(decoded.state, None);
        assert_eq!(decoded.published_delta_s, None);
    }

    /// Old build, new sender: the direction that is free.
    ///
    /// `postcard::from_bytes` drops whatever it does not consume, so appended fields are invisible
    /// to a peer that does not know about them and the fix still lands.
    #[test]
    fn an_older_peer_reads_a_stamped_fix_and_ignores_the_stamps() {
        let stamped = LocationFix {
            state: Some(FIX_STATE_PARKED),
            published_delta_s: Some(3_600),
            ..fix()
        };
        let frame = encode_fix_payload(Some(&stamped)).unwrap();

        let seen_by_old_build: LegacyFix =
            postcard::from_bytes(pad::unpad(&frame).unwrap()).expect("must still decode");
        assert_eq!(seen_by_old_build.ts, stamped.ts);
        assert_eq!(seen_by_old_build.lat, stamped.lat);
    }

    /// The stamps survive a real seal/open round trip, not just an encode.
    #[test]
    fn the_envelope_stamps_survive_the_padded_round_trip() {
        for (state, delta) in [
            (Some(FIX_STATE_LIVE), Some(0u32)),
            (Some(FIX_STATE_PARKED), Some(62_400)),
            (Some(FIX_STATE_NO_FIX), Some(300)),
            (None, None),
        ] {
            let sent = LocationFix {
                state,
                published_delta_s: delta,
                ..fix()
            };
            let frame = encode_fix_payload(Some(&sent)).unwrap();
            let back = decode_fix_payload(&frame).unwrap().unwrap();
            assert_eq!(back.state, state);
            assert_eq!(back.published_delta_s, delta);
        }
    }

    /// The property symmetric lanes rest on (§4.1): sealed, a watcher's null envelope must be
    /// byte-for-byte the same size as a sharer's real one, or the stash can classify every edge
    /// by counting bytes and the padding was decorative.
    #[test]
    fn a_sealed_null_fix_is_the_same_size_as_a_sealed_real_fix() {
        let (seed, author) = crypto::test_identity();
        let (_, recv_pub) = crypto::generate_recv_keypair();
        let recipients = vec![recv_pub];

        let real = crypto::seal(
            &seed,
            &author,
            7,
            fix().ts,
            crate::DOCS_MESH_EPOCH,
            &encode_fix_payload(Some(&fix())).unwrap(),
            &recipients,
        )
        .unwrap();
        let null = crypto::seal(
            &seed,
            &author,
            8,
            fix().ts,
            crate::DOCS_MESH_EPOCH,
            &encode_fix_payload(None).unwrap(),
            &recipients,
        )
        .unwrap();

        assert_eq!(null.len(), real.len());
    }

    /// A null fix is a healthy envelope that carries no position — not a decode failure. The
    /// replica read path leans on exactly this three-way outcome.
    #[test]
    fn a_null_fix_opens_and_decodes_to_no_position() {
        let (seed, author) = crypto::test_identity();
        let (recv_secret, recv_pub) = crypto::generate_recv_keypair();

        let envelope = crypto::seal(
            &seed,
            &author,
            1,
            fix().ts,
            crate::DOCS_MESH_EPOCH,
            &encode_fix_payload(None).unwrap(),
            &[recv_pub],
        )
        .unwrap();

        let opened = crypto::open(&recv_secret, &envelope).unwrap();
        assert!(decode_fix_payload(&opened.payload).unwrap().is_none());
    }

    /// Round-trip the real lane through the same encoder, so the `Option` split cannot silently
    /// start dropping positions.
    #[test]
    fn a_real_fix_still_round_trips_through_the_shared_encoder() {
        let payload = encode_fix_payload(Some(&fix())).unwrap();
        let back = decode_fix_payload(&payload).unwrap().expect("a position");
        assert_eq!(back.ts, fix().ts);
        assert_eq!(back.accuracy_m, 12.5);
    }

    /// The two envelopes one tick produces are wrapped for disjoint recipient sets, so they must
    /// land in different last-write-wins slots or each silently supersedes the other.
    #[test]
    fn the_null_lane_does_not_collide_with_the_fix_lane() {
        let author = [0x42u8; 32];
        assert_ne!(encode_nul_key(&author), encode_key(&author));
        assert_ne!(encode_nul_key(&author), encode_rsy_key(&author));
    }
}

#[cfg(test)]
mod transport_label_tests {
    use super::{is_lan_ip, transport_label, transport_rank};
    use iroh::TransportAddr;

    fn ip(addr: &str) -> TransportAddr {
        TransportAddr::Ip(addr.parse().expect("socket addr"))
    }

    /// The selection `delivery_label` performs over the active paths, minus the async endpoint
    /// lookup: rank the labels and keep the closest. Kept in step with `delivery_label` by hand —
    /// `RemoteInfo`/`TransportAddrInfo` cannot be constructed outside iroh, so the real function
    /// is only reachable with two live endpoints.
    fn closest(labels: &[&'static str]) -> Option<&'static str> {
        labels
            .iter()
            .copied()
            .min_by_key(|label| transport_rank(label))
    }

    #[test]
    fn relay_paths_are_labelled_relay() {
        let relay = TransportAddr::Relay("https://relay.example.com".parse().expect("relay url"));
        assert_eq!(transport_label(&relay), "relay");
    }

    #[test]
    fn private_and_link_local_ips_are_lan() {
        for addr in [
            "192.168.1.10:4433",
            "10.1.10.82:4433",
            "172.16.0.1:4433",
            "172.31.255.255:4433",
            "127.0.0.1:4433",
            "169.254.1.1:4433",
            "[::1]:4433",
            "[fe80::1]:4433",
            "[fd00::1]:4433",
        ] {
            assert_eq!(transport_label(&ip(addr)), "lan", "{addr}");
        }
    }

    #[test]
    fn routable_ips_are_direct() {
        for addr in [
            "203.0.113.7:4433",
            "172.32.0.1:4433",
            "172.15.0.1:4433",
            "[2001:db8::1]:4433",
        ] {
            assert_eq!(transport_label(&ip(addr)), "direct", "{addr}");
        }
    }

    #[test]
    fn lan_check_matches_the_transport_panel_ranges() {
        assert!(is_lan_ip("192.168.0.1".parse().expect("ip")));
        assert!(!is_lan_ip("8.8.8.8".parse().expect("ip")));
    }

    #[test]
    fn rank_orders_labels_closest_to_furthest() {
        let mut labels = ["relay", "direct", "lan", "ble"];
        labels.sort_by_key(|label| transport_rank(label));
        assert_eq!(labels, ["ble", "lan", "direct", "relay"]);
    }

    /// The regression this whole ranking exists for: iroh keeps the relay path open alongside a
    /// hole-punched one, so a delivery with both active must NOT be labelled `relay`.
    #[test]
    fn relay_never_wins_while_a_closer_path_is_open() {
        assert_eq!(closest(&["relay", "direct"]), Some("direct"));
        assert_eq!(closest(&["relay", "lan"]), Some("lan"));
        assert_eq!(closest(&["relay", "ble"]), Some("ble"));
        assert_eq!(closest(&["relay", "direct", "lan", "ble"]), Some("ble"));
    }

    /// Hash order must not decide the label: the same open paths in any order label identically.
    /// Before ranking, `RemoteInfo::addrs()` iteration order picked the winner, which is why two
    /// phones reported different transports for one link.
    #[test]
    fn label_is_independent_of_path_order() {
        assert_eq!(closest(&["relay", "lan", "direct"]), Some("lan"));
        assert_eq!(closest(&["direct", "relay", "lan"]), Some("lan"));
        assert_eq!(closest(&["lan", "direct", "relay"]), Some("lan"));
    }

    #[test]
    fn relay_still_wins_when_it_is_the_only_open_path() {
        assert_eq!(closest(&["relay"]), Some("relay"));
    }

    /// No active path at all is `delivery_label`'s `unknown` fallback, not a guessed transport.
    #[test]
    fn no_active_path_selects_nothing() {
        assert_eq!(closest(&[]), None);
    }

    /// An unranked label (a future custom transport added to `transport_label` but not to
    /// `transport_rank`) must lose to every known one rather than silently outranking BLE.
    #[test]
    fn unknown_labels_sort_furthest() {
        assert_eq!(transport_rank("multipeer"), u8::MAX);
        assert_eq!(closest(&["multipeer", "relay"]), Some("relay"));
    }
}
