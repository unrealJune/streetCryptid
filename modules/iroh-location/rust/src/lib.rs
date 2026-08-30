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
mod durable;
pub mod gate;
mod h3;
/// Festival-mesh radio capsules: the outer wrapper that carries an envelope over open
/// radio without a linkable identity (pure; see `mesh.rs` and `docs/mesh/DESIGN.md`).
pub mod mesh;
/// Native MVT tile/bundle decoder for the map pipeline (pure; see `mvt.rs`).
pub mod mvt;
pub mod outbox;
pub mod pad;
mod pairing;
mod profile;
pub mod publish;
pub mod ratchet;
pub mod recipients;
pub mod seq_store;
pub mod session_store;
pub mod sessions;
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
mod relay;
mod telemetry;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
#[cfg(target_os = "android")]
use std::sync::OnceLock;

use iroh::{
    address_lookup::MemoryLookup, protocol::Router, Endpoint, EndpointAddr, EndpointId, SecretKey,
};
use iroh_blobs::{store::fs::FsStore, BlobsProtocol};
use iroh_gossip::{api::Event, net::Gossip, proto::TopicId};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use iroh_tickets::endpoint::EndpointTicket;
use n0_future::StreamExt;
use tokio::sync::Mutex;

use ble::BleHandle;
use docs::{LatestFix, TrailDocs};
use pairing::{
    InviteData, PairCore, PairNotice, PairPhase, PairProtocol, PairResultData, PairSignal,
    PairStateData, SasChallengeData, SasRole,
};
use profile::{ProfileDocs, ProfileFields, ProfileRecord, ProfileSink};
pub use telemetry::{configure_telemetry, flush_telemetry};

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
#[derive(Debug, Clone, uniffi::Record, serde::Serialize, serde::Deserialize)]
pub struct LocationFix {
    pub lat: f64,
    pub lon: f64,
    pub accuracy_m: f64,
    pub heading_deg: f64,
    pub ts: u64,
}

/// Control message kind. Not a uniffi enum: the wire carries a plain `u8` so an unknown future
/// kind decodes cleanly and is ignored by an older peer rather than failing the whole payload.
pub const CTL_KIND_LIVE_REQUEST: u8 = 1;
/// Withdraw an outstanding live request (see [`CTL_KIND_LIVE_REQUEST`]).
pub const CTL_KIND_LIVE_CANCEL: u8 = 2;

/// A **control** message — the live-mode request channel (ARCHITECTURE §9c).
///
/// Sealed with the exact same envelope machinery as a [`LocationFix`] and written to the sender's
/// own trail namespace under a `ctl/` key, so it is opaque to the stash and to every pool member
/// it is not wrapped for. Deliberately carries no location.
///
/// `ts` + `nonce` are the replay defence, and they matter: the control key is overwritten in
/// place, so a malicious replica could withhold an update and keep serving a stale request. The
/// receiver MUST reject messages outside a freshness window and MUST dedupe by `nonce`.
#[derive(Debug, Clone, uniffi::Record, serde::Serialize, serde::Deserialize)]
pub struct ControlMsg {
    /// Wire version of this payload (currently 1).
    pub v: u8,
    /// One of `CTL_KIND_*`.
    pub kind: u8,
    /// When the sender created it (ms since epoch) — the freshness anchor.
    pub ts: u64,
    /// Requested live window in ms; the receiver clamps it and is always free to refuse.
    pub ttl_ms: u32,
    /// 16 random bytes giving this message a stable identity for dedup.
    pub nonce: Vec<u8>,
}

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

/// Foreign (Swift/Kotlin/JS) callback for inbound events on a subscription.
#[uniffi::export(with_foreign)]
pub trait FixListener: Send + Sync + 'static {
    /// A fix we could decrypt (someone shared with us). `backfill` is `true` when the fix arrived
    /// via durable range-reconciliation (iroh-docs catch-up) rather than the live gossip path.
    ///
    /// `via` names the LAST HOP into this device — see [`transport_label`]. Gossip is epidemic and
    /// the stash is a mirror, so it never claims a direct link to the fix's author.
    ///
    /// On the live path it is the CLOSEST open path to the delivering neighbour rather than the
    /// carrier of this particular datagram, which iroh does not expose — see [`delivery_label`].
    fn on_fix(&self, author: Vec<u8>, seq: u64, fix: LocationFix, backfill: bool, via: String);
    /// A fix we received but could NOT decrypt (not addressed to us / revoked). Useful
    /// for presence metrics without leaking content.
    fn on_opaque(&self, author: Vec<u8>, seq: u64);
    /// Membership / connectivity status strings for the harness UI.
    fn on_status(&self, status: String);
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
/// as "have we seen this author's fix" — app storage is written by the live gossip lane too, and
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

// The process-global `tracing` subscriber (Android logcat pipe + the optional OTLP developer
// telemetry reload slot) lives in `telemetry.rs` — see the module docs there for the layering
// and the `sc.*` correlation model.

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
    /// The most recently attached listener, reused to surface durable-trail (backfill / sync)
    /// events from the node-level `sync_trail` call.
    listener: Mutex<Option<Arc<dyn FixListener>>>,
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
    /// The settings a background bootstrap needs before it can call `start` — see
    /// [`crate::transport`]. Opened eagerly with the node rather than lazily, because the one
    /// caller that needs it is the one with no JS context to fall back on.
    transport: Mutex<Option<Arc<transport::TransportStore>>>,
    /// Ephemerals minted by `begin_session` and awaiting the peer's half. Keyed by peer endpoint
    /// id. Held in memory only: an unfinished bootstrap that does not survive a restart is a
    /// bootstrap the user simply repeats, whereas one persisted to disk is a private key sitting
    /// in storage for no reason.
    pending_bootstrap: Mutex<HashMap<Vec<u8>, x25519_dalek::StaticSecret>>,
    /// The ephemeral behind our currently published resync record (§4.6), if any.
    ///
    /// One, not one per peer: a single fresh ephemeral serves every peer we are restarting with,
    /// because the transcript separates the roots. Dropped once every peer has been resynced, and
    /// on restart — a resync whose ephemeral is gone is simply re-offered.
    pending_resync: Mutex<Option<PendingResync>>,
}

/// Our half of an in-flight resync exchange.
struct PendingResync {
    secret: x25519_dalek::StaticSecret,
    public: [u8; 32],
    nonce: [u8; 16],
    ts: u64,
}

/// Internals kept out of the `#[uniffi::export]` block above — UniFFI exports every method in an
/// exported impl, including private ones, and `SessionManager` is not an FFI type.
impl LocationNode {
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

    /// Verify and open one inbound **ratcheted** envelope from the live gossip lane.
    ///
    /// The live lane is v3 for the same reason the durable one is: §4.3 asks for a ratchet header
    /// on every envelope, and a hot-mode fix sealed to a long-term receiving key is a fix the
    /// archive can decrypt forever once the device is seized. Hot and cold now share one schedule,
    /// so a live session also advances the counters the cold cadence will use next.
    ///
    /// Three outcomes rather than a `Result`, because "not addressed to us" is the common case in
    /// a pool — every envelope carries a wrap per recipient and only one is ever ours — and must
    /// not be logged as a failure.
    async fn open_ratcheted_envelope(&self, bytes: &[u8]) -> GossipOpen {
        let Ok(verified) = crypto::verify_v3(bytes) else {
            return GossipOpen::Failed;
        };
        if verified.author == self.author {
            return GossipOpen::NotForUs; // our own broadcast, echoed back
        }
        let Ok(manager) = self.session_manager().await else {
            return GossipOpen::Failed;
        };
        match manager.open(&verified.author, &verified, now_ms()) {
            Ok(payload) => GossipOpen::Delivered {
                author: verified.author,
                seq: verified.seq,
                payload,
            },
            Err(sessions::SessionError::NotForUs) | Err(sessions::SessionError::NoSession) => {
                GossipOpen::NotForUs
            }
            Err(_) => GossipOpen::Failed,
        }
    }

    async fn read_latest_ratcheted_events_inner(&self) -> Result<Vec<RatchetEvent>, LocationError> {
        let sealed = {
            let guard = self.inner.lock().await;
            let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
            started
                .trail
                .read_latest_sealed()
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?
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
            out.push(RatchetEvent {
                author,
                seq: verified.seq,
                ts: verified.ts,
                kind: kind.to_string(),
                fix,
            });
        }
        Ok(out)
    }
}

/// What happened to an inbound gossip envelope. See [`LocationNode::open_ratcheted_envelope`].
enum GossipOpen {
    Delivered {
        author: [u8; 32],
        seq: u64,
        payload: zeroize::Zeroizing<Vec<u8>>,
    },
    /// Addressed to someone else, or from a peer we hold no session with. Ordinary.
    NotForUs,
    /// Not a v3 envelope, signature invalid, or the schedule refused the position.
    Failed,
}

/// Desync detection and the §4.6 resync primitive.
#[uniffi::export(async_runtime = "tokio")]
impl LocationNode {
    /// Whether this peer's session needs §4.6 recovery: `R` consecutive missed envelopes, an
    /// unreadable state file, or a peer lapsed past `T_lapse` (§4.5).
    pub async fn is_desynced(&self, peer_endpoint_hex: String) -> Result<bool, LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        Ok(self.session_manager().await?.is_desynced(&peer, now_ms()))
    }

    /// How many resyncs we have driven with this peer.
    ///
    /// §4.6 wants a resync *loop* to surface a "re-pair with this friend" prompt rather than
    /// retrying forever, so this is deliberately a count rather than a boolean: the UI decides
    /// where patience runs out, and the crypto layer does not pretend to know.
    pub async fn resync_count(&self, peer_endpoint_hex: String) -> Result<u32, LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;
        Ok(self.session_manager().await?.resync_count(&peer))
    }

    /// Publish our half of a §4.6 resync: a fresh ephemeral, wrapped for `recipient_recv_pubs`.
    ///
    /// Rides the HPKE lane rather than the ratchet, necessarily — this is the message that
    /// re-establishes a ratchet, so it cannot require one. That is also why it is the one place
    /// the design has to be most careful: **recovery must never become the bypass**. The record
    /// carries only an ephemeral public key. It cannot downgrade anything, because a root is
    /// only ever derived when *both* ephemerals are in hand.
    ///
    /// Idempotent within an exchange: calling it again re-publishes the same ephemeral rather
    /// than minting a new one, so a peer that already saw our half does not have to see a second.
    pub async fn publish_resync(
        &self,
        recipient_recv_pubs: Vec<String>,
    ) -> Result<String, LocationError> {
        let recipients = recipient_recv_pubs
            .iter()
            .map(|h| decode_hex(h).ok_or_else(|| LocationError::Decode("bad recv key hex".into())))
            .collect::<Result<Vec<_>, _>>()?;

        let (public, nonce, ts, reminted) = {
            let mut pending = self.pending_resync.lock().await;
            let now = now_ms();
            // Idempotent while the record is still usable, re-minted once it is not.
            //
            // Without the age check this is idempotent *forever*: it would re-publish the original
            // `ts` on every call, and once that passed `RESYNC_FRESHNESS_MS` the peer would refuse
            // our record permanently while we kept republishing the same stale bytes. The session
            // would sit desynced, refusing to heal, reporting no error — and the normal reason you
            // are resyncing at all is a peer who is offline, i.e. exactly the case that takes
            // longer than an hour.
            //
            // Re-minting at half the window leaves the fresh record a full half-window of validity
            // before it too needs replacing, so there is no gap where our published record is
            // unusable.
            let stale = pending
                .as_ref()
                .is_some_and(|p| now.saturating_sub(p.ts) >= sessions::RESYNC_REMINT_MS);
            match pending.as_ref() {
                Some(p) if !stale => (p.public, p.nonce, p.ts, false),
                _ => {
                    let secret = x25519_dalek::StaticSecret::random_from_rng(rand::rngs::OsRng);
                    let public = x25519_dalek::PublicKey::from(&secret).to_bytes();
                    let mut nonce = [0u8; 16];
                    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
                    let was_pending = pending.is_some();
                    *pending = Some(PendingResync {
                        secret,
                        public,
                        nonce,
                        ts: now,
                    });
                    (public, nonce, now, was_pending)
                }
            }
        };

        // Re-minting discards the ephemeral behind every conclusion we have already drawn, so
        // those conclusions have to go with it. Concretely: we may have already applied the peer's
        // record against the *old* ephemeral and installed a session from it. The peer will see
        // our new record and re-apply against the new one, landing on a different root — while we,
        // having already marked their nonce as seen, would never re-apply and would sit on the old
        // session forever. Forgetting the applied nonces lets us re-apply their current record
        // against the new ephemeral, so both sides converge on the same root again.
        if reminted {
            if let Ok(manager) = self.session_manager().await {
                manager.forget_applied_resyncs();
            }
        }

        let record = ResyncRecord {
            v: RESYNC_V,
            ephemeral: public.to_vec(),
            ts,
            nonce: nonce.to_vec(),
        };
        let payload =
            postcard::to_allocvec(&record).map_err(|_| LocationError::Decode("encode".into()))?;
        let envelope = crypto::seal(
            &self.identity_seed,
            &self.author,
            0,
            ts,
            0,
            &payload,
            &recipients,
        )?;
        tracing::info!(
            sc.author = %telemetry::short_hex(&self.author),
            sc.resync = "published",
            recipients = recipients.len(),
            "published a resync record"
        );

        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let ns = started.trail.own_namespace();
        started
            .trail
            .write_rsy(ns, &self.author, envelope)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(encode_hex(&public))
    }

    /// Look for `peer`'s resync record and, if one is there, restart the session from it.
    ///
    /// Publishes our own half first when we have not already, so a single call from each side
    /// completes the exchange without either having to go first — which matters because the
    /// side that noticed the desync and the side that caused it are usually not the same one.
    ///
    /// Returns whether a session was installed. `false` covers "no record yet", "stale record",
    /// and "already applied" — all ordinary, none an error.
    pub async fn poll_resync(
        &self,
        peer_endpoint_hex: String,
        peer_recv_pub_hex: String,
    ) -> Result<bool, LocationError> {
        let peer = decode_endpoint(&peer_endpoint_hex)?;

        let payloads = {
            let guard = self.inner.lock().await;
            let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
            started
                .trail
                .read_rsy(&peer, &self.recv_secret)
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?
        };
        let Some(record) = payloads
            .iter()
            .filter_map(|p| postcard::from_bytes::<ResyncRecord>(p).ok())
            .find(|r| r.v == RESYNC_V && r.ephemeral.len() == 32 && r.nonce.len() == 16)
        else {
            return Ok(false);
        };

        // Offer our half if we have not. Without this the exchange needs the two sides to
        // independently decide to start one, and only one of them can see the failure.
        if self.pending_resync.lock().await.is_none() {
            self.publish_resync(vec![peer_recv_pub_hex]).await?;
        }
        let (our_secret, our_public) = {
            let pending = self.pending_resync.lock().await;
            let p = pending.as_ref().ok_or(LocationError::NotStarted)?;
            (p.secret.clone(), p.public)
        };

        let peer_eph: [u8; 32] = record.ephemeral[..]
            .try_into()
            .map_err(|_| LocationError::Decode("bad ephemeral".into()))?;
        let nonce: [u8; 16] = record.nonce[..]
            .try_into()
            .map_err(|_| LocationError::Decode("bad nonce".into()))?;

        let shared = our_secret.diffie_hellman(&x25519_dalek::PublicKey::from(peer_eph));
        if !shared.was_contributory() {
            return Err(LocationError::Decode("degenerate ephemeral key".into()));
        }
        let transcript = boot_transcript(&self.author, &peer, &our_public, &peer_eph);
        let (rk0, session_id) = derive_boot_root(shared.as_bytes(), &transcript);

        let manager = self.session_manager().await?;
        let initiator = ratchet::initiator_by_endpoint(&self.author, &peer);
        let applied = manager
            .apply_resync(
                &peer,
                nonce,
                record.ts,
                session_id,
                rk0,
                peer_eph,
                if initiator { None } else { Some(our_secret) },
                now_ms(),
            )
            .map_err(|e| LocationError::Network(e.to_string()))?;

        if applied {
            tracing::info!(
                sc.author = %telemetry::short_hex(&self.author),
                sc.peer = %telemetry::short_hex(&peer),
                sc.resync = "applied",
                sc.resync_count = manager.resync_count(&peer),
                "restarted the session from a resync record"
            );
        }
        Ok(applied)
    }

    /// Drop our in-flight resync ephemeral once every peer has been restarted.
    pub async fn clear_resync(&self) {
        *self.pending_resync.lock().await = None;
    }
}

/// The §4.6 resync record: one fresh ephemeral, offered to every peer we need to restart with.
///
/// Two deliberate departures from §4.6's field list, both of which remove a way to disagree:
///
/// * **no session id.** §4.6 lists one, but both sides can derive it from the transcript, and a
///   transmitted id is an id the two sides can differ on. Derived, they cannot.
/// * **no peer id.** The wrap set already addresses the record, and the transcript binds both
///   identities into the root, so a record replayed at a third party derives a root its supposed
///   author never computes. Naming the peer in the payload would add nothing except a second
///   place for the answer to live.
///
/// Authentication is inherited, not added: the record rides inside a v2 envelope, which is
/// ed25519-signed over the whole thing by the author's identity key. That is the same argument
/// §4.1 makes for the ratchet header — one signed lane rather than a second one to get wrong.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ResyncRecord {
    v: u8,
    /// Our fresh ephemeral X25519 public key. One serves every peer: each peer's root is
    /// `KDF(DH(eph_ours, eph_theirs), transcript)`, so the transcript separates them.
    ephemeral: Vec<u8>,
    ts: u64,
    /// 16 random bytes, so a record replayed out of the overwritten slot is a recognisable
    /// no-op rather than a second session restart.
    nonce: Vec<u8>,
}

const RESYNC_V: u8 = 1;

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

fn new_location_node_at(
    identity_secret: Option<Vec<u8>>,
    recv_secret: Option<Vec<u8>>,
    dirs: NodeDirs,
) -> Result<Arc<LocationNode>, LocationError> {
    telemetry::init_tracing();
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

    Ok(Arc::new(LocationNode {
        identity_seed,
        author,
        recv_secret,
        recv_public: recv_public.clone(),
        data_dir,
        state_dir,
        inner: Mutex::new(None),
        listener: Mutex::new(None),
        pair: PairCore::new(identity_seed, author, recv_public),
        profile_events: ProfileEventQueue::default(),
        sessions: Mutex::new(None),
        seq: Mutex::new(None),
        outbox: Mutex::new(None),
        recipients: Mutex::new(None),
        gate: Mutex::new(None),
        transport: Mutex::new(None),
        pending_bootstrap: Mutex::new(HashMap::new()),
        pending_resync: Mutex::new(None),
    }))
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

    /// Bind the iroh endpoint + spawn the gossip router. Idempotent.
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
        let mut guard = self.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let relay_mode = if relay_enabled {
            relay::custom_relay_mode(&relay_urls, &relay_auth_token)
                .map_err(LocationError::Network)?
        } else {
            iroh::RelayMode::Disabled
        };
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
        if !ip_enabled {
            builder = builder.clear_ip_transports();
        }

        #[cfg(any(target_os = "android", target_vendor = "apple"))]
        let ble = if ble_enabled {
            let (b, handle) = ble::attach(builder, endpoint_id).await;
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
            TrailDocs::init(docs.clone(), (*blobs).clone(), self.data_dir.clone())
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?,
        );
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
                *slot = Some(Arc::new(sessions::SessionManager::new(store)));
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
            let mut slot = self.transport.lock().await;
            if slot.is_none() {
                *slot = Some(Arc::new(
                    transport::TransportStore::open(&self.state_dir)
                        .map_err(|e| LocationError::Network(e.to_string()))?,
                ));
            }
        }
        let profile = Arc::new(
            ProfileDocs::init(docs, (*blobs).clone(), self.data_dir.clone())
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
        tracing::info!("shutdown: taking inner lock");
        let started = self.inner.lock().await.take();
        if let Some(started) = started {
            tracing::info!("shutdown: closing router");
            started
                ._router
                .shutdown()
                .await
                .map_err(|e| LocationError::Network(e.to_string()))?;
            tracing::info!("shutdown: router closed");
        }
        tracing::info!("shutdown: taking listener lock");
        *self.listener.lock().await = None;
        // Release the session-store writer claim, or `start` can never succeed again: the claim is
        // process-global (§4.2 requires that — a per-module flag cannot see across the fresh JS
        // context expo-task-manager hands each headless callback), so holding it past shutdown
        // turns every lifecycle stop/start into a permanent `AlreadyOpen`.
        //
        // The ratchet state itself is on disk and unaffected; this drops only the claim and the
        // in-memory desync counters. `pending_resync` deliberately survives — a stop/start in the
        // same process should not abandon an in-flight resync exchange and force a second one.
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
        *self.transport.lock().await = None;
        tracing::info!("shutdown: complete");
        Ok(())
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
        let guard = self.inner.lock().await;
        if let Some(started) = guard.as_ref() {
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
        // Kept for the receive loop: classifying the path an envelope arrived over needs the
        // endpoint's remote-address table, and the loop must not take the node lock per message.
        let delivery_endpoint = started.endpoint.clone();
        drop(guard);

        // The node itself, not a snapshot of its session manager: `shutdown` replaces that handle,
        // and a task holding the old one would keep opening envelopes against a store whose writer
        // claim has been released.
        let node = self.clone();
        let cb = listener.clone();

        // Remember the listener so node-level `sync_trail` can surface backfill / sync events.
        *self.listener.lock().await = Some(listener.clone());

        // Pump inbound gossip events -> decrypt -> callback.
        let receive_task = tokio::spawn(async move {
            cb.on_status("subscribed".to_string());
            while let Some(event) = receiver.next().await {
                match event {
                    Ok(Event::Received(msg)) => {
                        // Short sync span per inbound envelope: `sc.entry_hash` (blake3 of the
                        // sealed bytes) is what joins this receive to the sender's publish and
                        // the stash's entry — `outcome` says why a ping stopped here (decrypt
                        // failure / not addressed to us / decode failure).
                        let span = tracing::info_span!(
                            "gossip.receive",
                            sc.entry_hash = %telemetry::envelope_hash(&msg.content),
                            sc.author = tracing::field::Empty,
                            sc.seq = tracing::field::Empty,
                            sc.via = tracing::field::Empty,
                            outcome = tracing::field::Empty,
                        );
                        // Signature first, then session state (§4.2): `verify_v3` hands back a
                        // type the session manager is the only consumer of, so no unauthenticated
                        // byte can reach the ratchet.
                        let opened = node.open_ratcheted_envelope(&msg.content).await;
                        // The path lookup is awaited OUTSIDE the span guard: holding a
                        // `tracing` span entered across an await would leak it into whatever
                        // task the executor polls next.
                        let via = match &opened {
                            GossipOpen::Delivered { .. } => {
                                delivery_label(&delivery_endpoint, msg.delivered_from).await
                            }
                            _ => "live".to_string(),
                        };
                        let _guard = span.enter();
                        match opened {
                            GossipOpen::Delivered {
                                author,
                                seq,
                                payload,
                            } => {
                                let opened = crypto::Opened {
                                    author,
                                    seq,
                                    payload,
                                };
                                span.record(
                                    "sc.author",
                                    tracing::field::display(telemetry::short_hex(&opened.author)),
                                );
                                span.record("sc.seq", opened.seq);
                                span.record("sc.via", via.as_str());
                                match decode_fix_payload(&opened.payload) {
                                    Ok(Some(fix)) => {
                                        span.record("outcome", "delivered");
                                        tracing::debug!(
                                            sc.author = %telemetry::short_hex(&opened.author),
                                            sc.seq = opened.seq,
                                            sc.lane = "fix",
                                            source = %via,
                                            "ratchet response received"
                                        );
                                        cb.on_fix(
                                            opened.author.to_vec(),
                                            opened.seq,
                                            fix,
                                            false,
                                            via,
                                        );
                                    }
                                    // A null fix is a watcher publishing on cadence so the
                                    // ratchet has a return contribution (§4.1). It carries no
                                    // position, so nothing is delivered — but it is a healthy
                                    // envelope, not a failure.
                                    Ok(None) => {
                                        span.record("outcome", "null-fix");
                                        tracing::debug!(
                                            sc.author = %telemetry::short_hex(&opened.author),
                                            sc.seq = opened.seq,
                                            sc.lane = "null",
                                            source = %via,
                                            "ratchet response received"
                                        );
                                        cb.on_opaque(opened.author.to_vec(), opened.seq);
                                    }
                                    Err(_) => {
                                        span.record("outcome", "payload-decode-failed");
                                    }
                                }
                            }
                            GossipOpen::NotForUs => {
                                span.record("outcome", "opaque");
                                // best-effort presence signal without content
                                cb.on_opaque(Vec::new(), 0);
                            }
                            GossipOpen::Failed => {
                                span.record("outcome", "open-failed");
                            }
                        }
                    }
                    Ok(Event::NeighborUp(id)) => {
                        tracing::info!(peer = %telemetry::short_hex(id.as_bytes()), "gossip neighbor up");
                        cb.on_status("peer-up".to_string());
                    }
                    Ok(Event::NeighborDown(id)) => {
                        tracing::info!(peer = %telemetry::short_hex(id.as_bytes()), "gossip neighbor down");
                        cb.on_status("peer-down".to_string());
                    }
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
        subscription_id: String,
        seq: u64,
        fix: LocationFix,
        recipients: Vec<Vec<u8>>,
    ) -> Result<(), LocationError> {
        let ts = fix.ts;
        self.docs_write_inner(subscription_id, seq, Some(fix), ts, recipients, None)
            .await
    }

    pub async fn docs_write_traced(
        &self,
        subscription_id: String,
        seq: u64,
        fix: LocationFix,
        recipients: Vec<Vec<u8>>,
        traceparent: String,
    ) -> Result<(), LocationError> {
        let ts = fix.ts;
        self.docs_write_inner(
            subscription_id,
            seq,
            Some(fix),
            ts,
            recipients,
            Some(traceparent),
        )
        .await
    }

    /// Seal a **null fix** for `recipients` and write it to our namespace's null slot
    /// (FORWARD-SECRECY §4.1) — the watcher half of the symmetric lanes.
    ///
    /// A null fix is an ordinary envelope carrying an empty padded payload: same signature, same
    /// AAD binding, same `seq` monotonicity, same ciphertext length as a real fix. It exists so a
    /// friend we do not share position with still receives our envelopes on cadence, which is
    /// what carries our ratchet contribution once envelope v3 lands (§4.2). `ts` is the tick's
    /// timestamp — it rides in the signed header exactly as a real fix's does.
    ///
    /// Written to a separate LWW key from the fix lane so the two envelopes a tick produces,
    /// wrapped for disjoint recipient sets, do not supersede each other (see `docs::encode_nul_key`).
    pub async fn docs_write_null(
        &self,
        subscription_id: String,
        seq: u64,
        ts: u64,
        recipients: Vec<Vec<u8>>,
    ) -> Result<(), LocationError> {
        self.docs_write_inner(subscription_id, seq, None, ts, recipients, None)
            .await
    }

    pub async fn docs_write_null_traced(
        &self,
        subscription_id: String,
        seq: u64,
        ts: u64,
        recipients: Vec<Vec<u8>>,
        traceparent: String,
    ) -> Result<(), LocationError> {
        self.docs_write_inner(
            subscription_id,
            seq,
            None,
            ts,
            recipients,
            Some(traceparent),
        )
        .await
    }

    async fn docs_write_inner(
        &self,
        _subscription_id: String,
        seq: u64,
        fix: Option<LocationFix>,
        ts: u64,
        recipients: Vec<Vec<u8>>,
        traceparent: Option<String>,
    ) -> Result<(), LocationError> {
        use tracing::Instrument;
        let null = fix.is_none();
        let span = tracing::info_span!(
            "docs.write",
            sc.author = %telemetry::short_hex(&self.author),
            sc.seq = seq,
            sc.lane = if null { "null" } else { "fix" },
            sc.entry_hash = tracing::field::Empty,
        );
        telemetry::set_parent(&span, traceparent.as_deref());
        async move {
            let guard = self.inner.lock().await;
            let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
            let payload = encode_fix_payload(fix.as_ref())?;
            let envelope = crypto::seal(
                &self.identity_seed,
                &self.author,
                seq,
                ts,
                DOCS_MESH_EPOCH,
                &payload,
                &recipients,
            )?;
            tracing::Span::current().record(
                "sc.entry_hash",
                tracing::field::display(telemetry::envelope_hash(&envelope)),
            );
            let ns = started.trail.own_namespace();
            let write = if null {
                started.trail.write_nul(ns, &self.author, envelope).await
            } else {
                started.trail.write(ns, &self.author, envelope).await
            };
            write.map_err(|e| {
                tracing::warn!(error = %e, "durable docs write failed");
                LocationError::Network(e.to_string())
            })?;
            Ok(())
        }
        .instrument(span)
        .await
    }

    /// Seal `msg` for `recipients` and write it to our own namespace's control slot
    /// (ARCHITECTURE §9c). Overwrites any previous control message from us — one slot per author,
    /// latest-wins — so a cancel genuinely supersedes the request it withdraws.
    ///
    /// `recipients` is normally a single friend's receiving key: a live request addressed to one
    /// person should be readable by exactly that person. Passing an empty list writes an envelope
    /// nobody can open, which is a no-op in practice but not an error here.
    ///
    /// The envelope's `seq` is fixed at 0 — control entries have no history for it to order, and
    /// replay identity lives in the payload's `nonce`/`ts` instead.
    pub async fn docs_write_control(
        &self,
        msg: ControlMsg,
        recipients: Vec<Vec<u8>>,
    ) -> Result<(), LocationError> {
        use tracing::Instrument;
        let span = tracing::info_span!(
            "ctl.write",
            sc.author = %telemetry::short_hex(&self.author),
            ctl.kind = msg.kind,
            recipients = recipients.len(),
            sc.entry_hash = tracing::field::Empty,
        );
        async move {
            let guard = self.inner.lock().await;
            let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
            let payload = postcard::to_allocvec(&msg)
                .map_err(|_| LocationError::Decode("encode control".into()))?;
            let envelope = crypto::seal(
                &self.identity_seed,
                &self.author,
                0,
                msg.ts,
                0,
                &payload,
                &recipients,
            )?;
            tracing::Span::current().record(
                "sc.entry_hash",
                tracing::field::display(telemetry::envelope_hash(&envelope)),
            );
            let ns = started.trail.own_namespace();
            started
                .trail
                .write_ctl(ns, &self.author, envelope)
                .await
                .map_err(|e| {
                    tracing::warn!(error = %e, "control write failed");
                    LocationError::Network(e.to_string())
                })?;
            Ok(())
        }
        .instrument(span)
        .await
    }

    /// Read `author`'s current control message, if we can open it. Returns an empty vec when
    /// there is none, when it is addressed to someone else, or when the content has not
    /// replicated locally yet — all indistinguishable and all "nothing to act on".
    ///
    /// Callers MUST still check freshness and dedupe by `nonce`; see [`ControlMsg`].
    pub async fn read_control(&self, author: Vec<u8>) -> Result<Vec<ControlMsg>, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let payloads = started
            .trail
            .read_ctl(&author, &self.recv_secret)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(payloads
            .iter()
            .filter_map(|p| postcard::from_bytes::<ControlMsg>(p).ok())
            .collect())
    }

    /// Reconcile our own + every imported friend namespace so each author's **current** fix is
    /// exchanged (FORWARD-SECRECY §4.4 — the durable path is last-write-wins; there is no missed
    /// history to recover). Read the results with [`Self::read_latest`].
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
        use tracing::Instrument;
        let requested = peer_tickets.len();
        let peers: Vec<EndpointAddr> = peer_tickets
            .iter()
            .filter_map(|ticket| ticket.parse::<EndpointTicket>().ok())
            .map(|ticket| ticket.endpoint_addr().clone())
            .collect();
        let span = tracing::info_span!(
            "trail.sync",
            sc.author = %telemetry::short_hex(&self.author),
            sync.peers_requested = requested,
            sync.peers_dialed = peers.len(),
        );
        telemetry::set_parent(&span, traceparent.as_deref());
        async move {
            if peers.len() < requested {
                tracing::warn!(
                    skipped = requested - peers.len(),
                    "trail sync: some peer tickets were unparseable and were skipped"
                );
            }
            let guard = self.inner.lock().await;
            let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
            let trail = started.trail.clone();
            drop(guard);

            // No sink and no `recovered` count here any more: with one overwritten slot per author
            // there is no back-catalogue to stream, so a sync just reconciles and the app reads the
            // current fixes afterwards. The `recovered` span attribute is recorded app-side instead
            // (see `refreshTrailFromReplica`), which keeps the infra/otel `sc.*` join keys intact.
            trail.sync_all(peers).await.map_err(|e| {
                tracing::warn!(error = %e, "trail sync failed");
                LocationError::Network(e.to_string())
            })?;
            Ok(())
        }
        .instrument(span)
        .await
    }

    /// Push our own trail namespace to `peer_tickets` — the trail stash when it is configured and
    /// opted into, and **every pool member** — and wait for the exchange to finish. **This is what
    /// actually gets a published fix off the phone.**
    ///
    /// [`Self::docs_write`] only writes the local replica; iroh-docs broadcasts a local insert
    /// solely for namespaces the live engine has marked as syncing, which happens on `start_sync`
    /// and nowhere else. A short-lived headless publish context never called anything that did
    /// that, so its envelopes never reached the stash and an offline friend had nothing to
    /// reconcile from. Call this after draining a batch.
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
    /// Best-effort by design: a failure means offline delivery is degraded for those fixes, not
    /// that the live gossip path or a later [`Self::sync_latest`] is broken.
    pub async fn push_trail(
        &self,
        peer_tickets: Vec<String>,
        traceparent: Option<String>,
    ) -> Result<(), LocationError> {
        use tracing::Instrument;
        let requested = peer_tickets.len();
        let peers: Vec<EndpointAddr> = peer_tickets
            .iter()
            .filter_map(|ticket| ticket.parse::<EndpointTicket>().ok())
            .map(|ticket| ticket.endpoint_addr().clone())
            .collect();
        let span = tracing::info_span!(
            "trail.push",
            sc.author = %telemetry::short_hex(&self.author),
            sync.peers_requested = requested,
            sync.peers_dialed = peers.len(),
            entries_sent = tracing::field::Empty,
            peers_finished = tracing::field::Empty,
            peers_failed = tracing::field::Empty,
            finished = tracing::field::Empty,
        );
        telemetry::set_parent(&span, traceparent.as_deref());
        async move {
            if peers.len() < requested {
                tracing::warn!(
                    skipped = requested - peers.len(),
                    "trail push: some peer tickets were unparseable and were skipped"
                );
            }
            let guard = self.inner.lock().await;
            let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
            let trail = started.trail.clone();
            let ns = trail.own_namespace();
            drop(guard);

            let sent = trail.push(ns, peers).await.map_err(|e| {
                tracing::warn!(error = %e, "trail push failed");
                LocationError::Network(e.to_string())
            })?;
            let current = tracing::Span::current();
            current.record("finished", sent.is_some());
            if let Some(report) = sent {
                // Summed across every peer that reported, not taken from whichever finished first.
                current.record("entries_sent", report.entries_sent);
                current.record("peers_finished", report.peers_finished);
                current.record("peers_failed", report.peers_failed);
            }
            Ok(())
        }
        .instrument(span)
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
        let config = self
            .transport_store()
            .await?
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
    /// Persisted natively so an OS location callback can read it with no JS context alive. Push it
    /// on every pool change; see [`crate::recipients`] for why a stale set is safe in the only
    /// direction it can be stale, and why revocation still rests on the ratchet session rather
    /// than on this list.
    pub async fn set_sharing_recipients(
        &self,
        recipient_endpoints: Vec<String>,
    ) -> Result<(), LocationError> {
        self.recipient_store()
            .await?
            .set(&recipient_endpoints)
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Who the native drain path will seal for right now.
    pub async fn sharing_recipients(&self) -> Result<Vec<String>, LocationError> {
        Ok(self.recipient_store().await?.get())
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

    /// Advance and return this device's next publish sequence number.
    ///
    /// Durable before it returns: the caller puts the value straight onto the wire as half of an
    /// `author/seq` docs key, and two envelopes under one key is a payload silently lost to
    /// last-write-wins. See `seq_store.rs` for why the counter had to leave JS to be safe — in
    /// short, every headless callback gets a fresh JS context and so got its own copy of it.
    pub async fn next_seq(&self) -> Result<u64, LocationError> {
        let store = self.seq_store().await?;
        // The save is a couple of fsyncs, so it does not belong on the async executor's thread.
        tokio::task::spawn_blocking(move || store.next())
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?
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

    /// Explicitly hand the current opaque trail slots to the stash and wait for HTTP receipts.
    ///
    /// Returns the number of slots the stash **accepted**. The other outcomes are on the
    /// `trail.content.upload` span rather than in the return value, deliberately: the UniFFI
    /// signature stays `u64` so a phone running an older binary than the JS bundle keeps working,
    /// and `untracked` is a number you want to watch over time rather than branch on.
    pub async fn upload_trail_content(
        &self,
        base_url: String,
        psk: Option<String>,
    ) -> Result<u64, LocationError> {
        use tracing::Instrument;
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let trail = started.trail.clone();
        drop(guard);
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
            }
            Ok(report.uploaded)
        }
        .instrument(span)
        .await
    }

    /// Read the latest decryptable fix per author (friends who share with us) from the local
    /// replica. One entry per author — the durable path holds no history (FORWARD-SECRECY §4.4).
    pub async fn read_latest(&self) -> Result<Vec<IncomingFix>, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let fixes = started
            .trail
            .read_latest(&self.recv_secret)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))?;
        Ok(fixes
            .into_iter()
            .filter_map(latest_fix_to_incoming)
            .collect())
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

    /// Seal `fix` under **envelope v3** for each recipient's ratchet session and write it to our
    /// durable namespace (FORWARD-SECRECY §4.7).
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
        subscription_id: String,
        seq: u64,
        fix: LocationFix,
        recipient_endpoints: Vec<String>,
    ) -> Result<Vec<String>, LocationError> {
        self.docs_write_ratcheted_inner(
            subscription_id,
            seq,
            Some(fix),
            0,
            recipient_endpoints,
            None,
        )
        .await
    }

    /// Seal a **ratcheted null fix** for `watcher_endpoints` and write it to the null slot.
    ///
    /// The v3 counterpart of [`Self::docs_write_null`], and the half of §4.1 that makes the
    /// symmetric-lane argument true rather than aspirational. A watcher who only ever *reads* our
    /// position still publishes on cadence, and once that envelope is ratcheted it carries their
    /// ratchet contribution — which is what advances our `peer_advanced_ms` for them and stops
    /// `next_wraps` dropping them as `Lapsed` after 24 h. On the v2 null lane the contribution did
    /// not exist, so every one-directional watch edge expired after a day.
    pub async fn docs_write_null_ratcheted(
        &self,
        subscription_id: String,
        seq: u64,
        ts: u64,
        watcher_endpoints: Vec<String>,
    ) -> Result<Vec<String>, LocationError> {
        self.docs_write_ratcheted_inner(subscription_id, seq, None, ts, watcher_endpoints, None)
            .await
    }

    pub async fn docs_write_null_ratcheted_traced(
        &self,
        subscription_id: String,
        seq: u64,
        ts: u64,
        watcher_endpoints: Vec<String>,
        traceparent: String,
    ) -> Result<Vec<String>, LocationError> {
        self.docs_write_ratcheted_inner(
            subscription_id,
            seq,
            None,
            ts,
            watcher_endpoints,
            Some(traceparent),
        )
        .await
    }

    pub async fn docs_write_ratcheted_traced(
        &self,
        subscription_id: String,
        seq: u64,
        fix: LocationFix,
        recipient_endpoints: Vec<String>,
        traceparent: String,
    ) -> Result<Vec<String>, LocationError> {
        self.docs_write_ratcheted_inner(
            subscription_id,
            seq,
            Some(fix),
            0,
            recipient_endpoints,
            Some(traceparent),
        )
        .await
    }

    /// Both ratcheted durable lanes. `fix.is_none()` is the null lane, which differs only in
    /// carrying an empty padded payload and landing in a separate LWW slot — the two envelopes a
    /// tick produces are wrapped for disjoint recipient sets, so sharing a slot would have them
    /// supersede each other.
    async fn docs_write_ratcheted_inner(
        &self,
        _subscription_id: String,
        seq: u64,
        fix: Option<LocationFix>,
        null_ts: u64,
        recipient_endpoints: Vec<String>,
        traceparent: Option<String>,
    ) -> Result<Vec<String>, LocationError> {
        use tracing::Instrument;
        let null = fix.is_none();
        let ts = fix.as_ref().map(|f| f.ts).unwrap_or(null_ts);
        let span = tracing::info_span!(
            "docs.write",
            sc.author = %telemetry::short_hex(&self.author),
            sc.seq = seq,
            sc.lane = if null { "null" } else { "fix" },
            sc.envelope = 3,
            recipients = recipient_endpoints.len(),
            dropped = tracing::field::Empty,
        );
        telemetry::set_parent(&span, traceparent.as_deref());
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
            tracing::Span::current().record("dropped", dropped.len());

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

            let guard = self.inner.lock().await;
            let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
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

    /// Read the latest **ratcheted** fix per author from the local replica.
    ///
    /// Signature first, then session state — `verify_v3` returns a type that the session manager
    /// is the only consumer of, so no unauthenticated byte can reach the ratchet (§4.2).
    /// Envelopes we cannot open are skipped exactly as v2's are: addressed to someone else,
    /// replayed from the archive, or beyond the acceptance window are all "nothing to surface".
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

    /// Snapshot the local endpoint's advertised addresses and iroh's retained path table for the
    /// requested peers. Remote path usage is point-in-time; callers should poll when displaying it.
    pub async fn transport_diagnostics(
        &self,
        peer_endpoint_ids: Vec<Vec<u8>>,
    ) -> Result<TransportDiagnostics, LocationError> {
        let endpoint = {
            let guard = self.inner.lock().await;
            guard
                .as_ref()
                .ok_or(LocationError::NotStarted)?
                .endpoint
                .clone()
        };

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
    /// failed" — a distinction `friend_latest` structurally cannot make, because the live gossip
    /// lane writes it too and a fix that arrived over gossip never enters the author's namespace
    /// (a pool member holds a READ ticket). Reconciliation serves out of the replica, so this is
    /// the only honest answer to "can this device relay author X".
    ///
    /// No decryption and no location data in the result — presence, not payload — so it is
    /// ungated, like [`Self::transport_diagnostics`]. `NamespaceId` is not an FFI type, so the
    /// exported shape reports by author endpoint id rather than by namespace.
    pub async fn trail_replica_status(&self) -> Result<Vec<TrailReplicaAuthor>, LocationError> {
        let guard = self.inner.lock().await;
        let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
        let trail = started.trail.clone();
        drop(guard);
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
        let guard = self.inner.lock().await;
        guard.as_ref().map(|s| s.ble.available()).unwrap_or(false)
    }

    /// Honest BLE capability report combined with the app-level pairing-ready gate.
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

    /// Perform one foreground Bump rendezvous attempt using the same scanner/advertiser as the
    /// iroh BLE transport. The scan is refreshed, fresh peers are ranked by RSSI, ambiguous crowds
    /// fail closed, and the strongest peer's full identity is read + checked against its advertised
    /// prefix. No friendship is granted here; the returned endpoint still enters the authenticated
    /// nearby pairing + mandatory SAS flow.
    pub async fn resolve_bump_peer(&self, timeout_ms: u64) -> BumpResolution {
        let handle = {
            let guard = self.inner.lock().await;
            match guard.as_ref() {
                Some(started) => started.ble.clone(),
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
    /// the live docs engine or joining its gossip swarm. Returns the latest decryptable fix per
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
            let (endpoint, trail, memory) = {
                let guard = self.inner.lock().await;
                let started = guard.as_ref().ok_or(LocationError::NotStarted)?;
                (
                    started.endpoint.clone(),
                    started.trail.clone(),
                    started.memory.clone(),
                )
            };
            memory.add_endpoint_info(peer.clone());
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
                    Err(sessions::SessionError::NotForUs) => {
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
            for bytes in sealed {
                let Ok(opened) = crypto::open(&self.recv_secret, &bytes) else {
                    continue;
                };
                if let Some(fix) = latest_fix_to_incoming(docs::LatestFix {
                    author: opened.author.to_vec(),
                    seq: opened.seq,
                    payload: opened.payload,
                }) {
                    fixes.push(fix);
                }
            }
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
/// `stash` is deliberately absent: offline delivery is not an iroh path at all and is labelled on
/// the backfill side (see the `from_stash` branch in `sync_trail`), so it never competes here.
fn transport_rank(label: &str) -> u8 {
    match label {
        "ble" => 0,
        "lan" => 1,
        "direct" => 2,
        "relay" => 3,
        _ => u8::MAX,
    }
}

/// Classify the path a gossip message came in over, by asking the endpoint which of the delivering
/// neighbour's addresses are active and naming the CLOSEST one.
///
/// Closest, not "the one this datagram traversed": iroh keeps every usable path `Open`
/// simultaneously — a hole-punched direct path never demotes the relay path, which stays up as a
/// standing fallback — and [`iroh::endpoint::RemoteInfo`] exposes only the *set* of open paths. The
/// real answer lives in iroh's internal `selected_path`, reachable only through a `Connection`,
/// which iroh-gossip owns rather than us.
///
/// Ranking rather than taking the first active match is the whole point. `RemoteInfo::addrs()`
/// iterates an `FxHashMap`, so "first active" is arbitrary — and, because that hasher has a fixed
/// seed, *stably* arbitrary per device. That is what made one phone label every fix `relay` while
/// its peer labelled the very same link `direct`.
///
/// Falls back to `live` (arrived, path unknown) rather than guessing: `remote_info` is a
/// point-in-time snapshot and may have nothing active to report.
async fn delivery_label(endpoint: &Endpoint, delivered_from: EndpointId) -> String {
    let info = match endpoint.remote_info(delivered_from).await {
        Some(info) => info,
        None => return "live".to_string(),
    };
    let closest = info
        .addrs()
        .filter(|address| matches!(address.usage(), iroh::endpoint::TransportAddrUsage::Active))
        .map(|address| transport_label(address.addr()))
        .min_by_key(|label| transport_rank(label));
    match closest {
        Some(label) => label.to_string(),
        None => "live".to_string(),
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

/// Convert a decrypted [`LatestFix`] into the UniFFI [`IncomingFix`], decoding the payload.
fn latest_fix_to_incoming(lf: LatestFix) -> Option<IncomingFix> {
    // `None` covers both a null fix and an undecodable payload. They are not the same thing, but
    // they have the same consequence here — there is no position to surface — and this function
    // has no channel to report the difference on. The gossip path, which does, separates them.
    let fix = decode_fix_payload(&lf.payload).ok().flatten()?;
    Some(IncomingFix {
        author: lf.author,
        seq: lf.seq,
        fix,
    })
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
    postcard::from_bytes::<LocationFix>(inner)
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

/// A live topic subscription; publish fixes through it.
#[derive(uniffi::Object)]
pub struct Subscription {
    node: Arc<LocationNode>,
    sender: Mutex<iroh_gossip::api::GossipSender>,
    receive_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Binds a live [`Subscription`] to [`publish::PublishSink`], so the engine can send without
/// knowing what gossip or iroh-docs are.
///
/// Both lanes here, not one each: they carry the **same sealed bytes**, which is what makes
/// per-recipient revocation carry over from the live path to the durable mirror. Splitting them
/// across two sink calls would invite an implementation that sealed twice and let the two diverge.
struct SubscriptionSink<'a> {
    subscription: &'a Subscription,
    /// Accepted for API parity with the TS contract and otherwise unused: a node owns a single
    /// trail namespace, so `docs_write_ratcheted` ignores it (`_subscription_id`). Threaded through
    /// rather than dropped so this sink keeps the same shape as the mounted path's call.
    subscription_id: String,
}

impl publish::PublishSink for SubscriptionSink<'_> {
    async fn publish(
        &self,
        seq: u64,
        fix: LocationFix,
        recipients: Vec<String>,
    ) -> Result<(), publish::PublishError> {
        // Live lane first, durable mirror second — the order `location-sharing.ts` uses.
        self.subscription
            .publish(seq, fix.clone(), recipients.clone())
            .await
            .map_err(|e| publish::PublishError::Send(e.to_string()))?;
        self.subscription
            .node
            .docs_write_ratcheted(self.subscription_id.clone(), seq, fix, recipients)
            .await
            .map_err(|e| publish::PublishError::Send(e.to_string()))?;
        Ok(())
    }
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
    /// Take one captured location all the way to the wire, with no JS involved.
    ///
    /// This is the whole point of the native drain path. `expo-task-manager` spools location events
    /// when it cannot start a headless JS context, and on 2026-08-29 a Pixel spooled eleven and a
    /// half hours of them — 446 real fixes, captured by a perfectly healthy foreground service,
    /// with nothing on the JS side alive to publish them. Everything below runs in the OS callback
    /// that delivered the fix.
    ///
    /// Thin by design: the decisions live in [`publish::DrainEngine`], which depends on ports
    /// rather than on a node, so they can be tested against fakes that fail on demand. All this
    /// does is bind those ports to the real stores and hand the engine somewhere to send.
    pub async fn ingest_fix(
        &self,
        subscription_id: String,
        fix: LocationFix,
        battery: gate::BatteryState,
        interval_ms: u64,
        now_ms: u64,
    ) -> Result<publish::IngestOutcome, LocationError> {
        let sink = SubscriptionSink {
            subscription: self,
            subscription_id,
        };
        let seq = self.node.seq_store().await?;
        let queue = self.node.outbox().await?;
        let recipients = self.node.recipient_store().await?;
        let gate_store = self.node.gate_store().await?;
        let engine = publish::DrainEngine {
            seq: seq.as_ref(),
            queue: queue.as_ref(),
            recipients: recipients.as_ref(),
            gate: gate_store.as_ref(),
            sink: &sink,
            quality: gate::FixQualityConfig::default(),
        };
        engine
            .ingest(fix, battery, interval_ms, now_ms)
            .await
            .map_err(|e| LocationError::Network(e.to_string()))
    }

    /// Seal `fix` for `recipients` (each = a friend's 32-byte receiving public key) and
    /// broadcast it on the topic. Recipients NOT in this list cannot decrypt it —
    /// that's how revocation works.
    pub async fn publish(
        &self,
        seq: u64,
        fix: LocationFix,
        recipient_endpoints: Vec<String>,
    ) -> Result<Vec<String>, LocationError> {
        let ts = fix.ts;
        self.publish_inner(seq, Some(fix), ts, recipient_endpoints, None)
            .await
    }

    pub async fn publish_traced(
        &self,
        seq: u64,
        fix: LocationFix,
        recipient_endpoints: Vec<String>,
        traceparent: String,
    ) -> Result<Vec<String>, LocationError> {
        let ts = fix.ts;
        self.publish_inner(seq, Some(fix), ts, recipient_endpoints, Some(traceparent))
            .await
    }

    /// Broadcast a **null fix** — an envelope with an empty padded payload (FORWARD-SECRECY §4.1).
    ///
    /// The live half of the watcher lane: identical in shape, length, and signing discipline to
    /// [`Self::publish`], carrying no position. Recipients decode it as a healthy envelope with
    /// nothing to deliver.
    pub async fn publish_null(
        &self,
        seq: u64,
        ts: u64,
        recipient_endpoints: Vec<String>,
    ) -> Result<Vec<String>, LocationError> {
        self.publish_inner(seq, None, ts, recipient_endpoints, None)
            .await
    }

    pub async fn publish_null_traced(
        &self,
        seq: u64,
        ts: u64,
        recipient_endpoints: Vec<String>,
        traceparent: String,
    ) -> Result<Vec<String>, LocationError> {
        self.publish_inner(seq, None, ts, recipient_endpoints, Some(traceparent))
            .await
    }

    async fn publish_inner(
        &self,
        seq: u64,
        fix: Option<LocationFix>,
        ts: u64,
        recipient_endpoints: Vec<String>,
        traceparent: Option<String>,
    ) -> Result<Vec<String>, LocationError> {
        use tracing::Instrument;
        // `sc.entry_hash` is recorded post-seal: it is the blake3 of the sealed envelope, i.e.
        // the same content hash the stash and receivers see — the cross-device join key.
        let span = tracing::info_span!(
            "gossip.publish",
            sc.author = %telemetry::short_hex(&self.node.author),
            sc.seq = seq,
            sc.lane = if fix.is_none() { "null" } else { "fix" },
            sc.envelope = 3,
            sc.entry_hash = tracing::field::Empty,
            recipients = recipient_endpoints.len(),
            dropped = tracing::field::Empty,
        );
        telemetry::set_parent(&span, traceparent.as_deref());
        async move {
            let peers = recipient_endpoints
                .iter()
                .map(|hex| decode_endpoint(hex).map(|e| e.to_vec()))
                .collect::<Result<Vec<_>, _>>()?;
            let manager = self.node.session_manager().await?;
            let payload = encode_fix_payload(fix.as_ref())?;

            // Persist-before-publish holds on the live lane exactly as on the durable one — and
            // matters more here, because at the hot cadence the counters move ~75× faster.
            let set = manager
                .next_wraps(&peers, now_ms())
                .map_err(|e| LocationError::Network(e.to_string()))?;
            let dropped: Vec<String> = set
                .dropped
                .iter()
                .map(|(peer, reason)| format!("{}:{}", encode_hex(peer), reason.as_str()))
                .collect();
            tracing::Span::current().record("dropped", dropped.len());
            if set.wraps.is_empty() {
                return Ok(dropped);
            }

            let envelope = crypto::seal_v3(
                &self.node.identity_seed,
                &self.node.author,
                seq,
                ts,
                DOCS_MESH_EPOCH,
                &payload,
                set.wraps,
            )?;
            tracing::Span::current().record(
                "sc.entry_hash",
                tracing::field::display(telemetry::envelope_hash(&envelope)),
            );
            let sender = self.sender.lock().await;
            sender.broadcast(envelope.into()).await.map_err(|e| {
                tracing::warn!(error = %e, "gossip broadcast failed");
                LocationError::Network(e.to_string())
            })?;
            Ok(dropped)
        }
        .instrument(span)
        .await
    }
}

#[cfg(test)]
mod null_fix_tests {
    use super::{decode_fix_payload, encode_fix_payload, LocationFix};
    use crate::crypto;
    use crate::docs::{encode_ctl_key, encode_key, encode_nul_key};

    fn fix() -> LocationFix {
        LocationFix {
            lat: -122.419416,
            lon: 37.774929,
            accuracy_m: 12.5,
            heading_deg: 91.0,
            ts: 1_786_000_000_000,
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
    /// gossip receive path leans on exactly this three-way outcome.
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
        assert_ne!(encode_nul_key(&author), encode_ctl_key(&author));
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

    /// No active path at all is `delivery_label`'s `live` fallback, not a guessed transport.
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
