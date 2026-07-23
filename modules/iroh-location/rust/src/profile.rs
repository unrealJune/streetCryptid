//! Signed, versioned cryptid **profile** — the mutable identity a friend sees.
//!
//! See `docs/social/ARCHITECTURE.md` §3. A profile is the mutable half of a device's
//! identity (handle / sigil / cryptid name / color / current receiving key). Unlike the
//! immutable [`crate::LocationNode`] identity keys, it changes over time, so it lives in its
//! **own single-writer iroh-docs namespace** (separate from the trail namespace) and is
//! replicated to friends who imported its read-ticket.
//!
//! ## Trust model
//! Docs replication is *not* the trust boundary — a [`ProfileRecord`] carries its own
//! **ed25519 signature** over canonical bytes, made with the node's identity seed (the same
//! key behind the `EndpointId`). Readers verify: (1) the signature, (2) that the record's
//! `endpoint_id` matches the expected peer, and (3) that `epoch` strictly increases
//! (rollback / replay protection). This makes the binding of `recv_pub`→`endpoint_id`
//! durable and verifiable regardless of how the bytes travelled.
//!
//! ## What is pure vs live
//! Everything up to and including [`build_signed`] / [`verify`] / [`validate_fields`] /
//! [`is_newer_epoch`] / the namespace-metadata file helpers is pure and unit-tested here.
//! [`ProfileDocs`] wraps the live iroh-docs replica.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use iroh_blobs::api::Store as BlobsStore;
use iroh_docs::{
    api::{
        protocol::{AddrInfoOptions, ShareMode},
        Doc,
    },
    engine::LiveEvent,
    protocol::Docs,
    store::Query,
    AuthorId, NamespaceId,
};
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Current profile schema version.
pub const PROFILE_V: u8 = 1;

/// The single docs key every profile record is written under (one record per namespace).
pub const PROFILE_KEY: &[u8] = b"profile";

/// Domain separation for the ed25519 profile signature.
const PROFILE_SIG_CTX: &[u8] = b"streetcryptid/profile/v1";

/// App limits (mirror `src/features/account/core/profile.ts`).
pub const MAX_HANDLE_CHARS: usize = 20;
pub const MAX_CRYPTID_NAME_CHARS: usize = 24;
pub const MAX_SIGIL_LINES: usize = 12;
pub const MAX_SIGIL_COLUMNS: usize = 32;
pub const MAX_SIGIL_BYTES: usize = 512;
/// Tab width used when measuring sigil columns (matches the TS `expandedLineLength`).
const TAB_WIDTH: usize = 4;
/// Hard cap on the encoded [`ProfileRecord`] so a namespace entry stays small.
pub const MAX_PROFILE_BYTES: usize = 2048;

const ENDPOINT_LEN: usize = 32;
const RECV_PUB_LEN: usize = 32;
const SIG_LEN: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("profile field invalid: {0}")]
    Field(String),
    #[error("profile wire decode failed")]
    Decode,
    #[error("profile wire encode failed")]
    Encode,
    #[error("profile signature invalid")]
    BadSignature,
    #[error("profile endpoint id does not match the authenticated peer")]
    WrongEndpoint,
    #[error("bad key length")]
    KeyLength,
}

/// The signed, versioned profile as it travels on the wire / in a docs entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileRecord {
    pub v: u8,
    /// ed25519 EndpointId this profile belongs to (32B).
    pub endpoint_id: Vec<u8>,
    /// Monotonic version counter; a newer profile MUST use a strictly greater epoch.
    pub epoch: u64,
    pub handle: String,
    pub cryptid_name: String,
    /// Multiline ASCII sigil (printable ASCII + tab + newline).
    pub sigil: String,
    /// `#RRGGBB`.
    pub color: String,
    /// The device's current X25519 receiving public key (32B).
    pub recv_pub: Vec<u8>,
    /// ms since epoch when authored.
    pub ts: u64,
    /// ed25519 signature over the canonical (sig-less) encoding (64B).
    pub sig: Vec<u8>,
}

impl ProfileRecord {
    /// The 32-byte endpoint id as a fixed array, or `None` if malformed.
    pub fn endpoint_arr(&self) -> Option<[u8; ENDPOINT_LEN]> {
        self.endpoint_id.clone().try_into().ok()
    }
}

/// Plain (unsigned) profile fields the app hands us to publish.
#[derive(Debug, Clone)]
pub struct ProfileFields {
    pub handle: String,
    pub cryptid_name: String,
    pub sigil: String,
    pub color: String,
}

/// Expanded (tabs→spaces) length of a single sigil line, matching the TS measurement.
fn expanded_line_len(line: &str) -> usize {
    line.chars()
        .map(|c| if c == '\t' { TAB_WIDTH } else { 1 })
        .sum()
}

/// Validate the mutable profile fields against the app limits. Pure + unit-tested.
pub fn validate_fields(fields: &ProfileFields) -> Result<(), ProfileError> {
    let handle = fields.handle.trim_start_matches('@');
    let handle_len = handle.chars().count();
    if handle_len == 0 || handle_len > MAX_HANDLE_CHARS {
        return Err(ProfileError::Field(format!(
            "handle must be 1..={MAX_HANDLE_CHARS} chars"
        )));
    }
    if !handle.chars().all(|c| c.is_ascii_graphic()) {
        return Err(ProfileError::Field("handle must be printable ASCII".into()));
    }

    let name = fields.cryptid_name.trim();
    let name_len = name.chars().count();
    if name_len == 0 || name_len > MAX_CRYPTID_NAME_CHARS {
        return Err(ProfileError::Field(format!(
            "cryptid name must be 1..={MAX_CRYPTID_NAME_CHARS} chars"
        )));
    }

    let sigil = &fields.sigil;
    if sigil.trim().is_empty() {
        return Err(ProfileError::Field("sigil must not be empty".into()));
    }
    if sigil.len() > MAX_SIGIL_BYTES {
        return Err(ProfileError::Field(format!(
            "sigil must be <= {MAX_SIGIL_BYTES} bytes"
        )));
    }
    // Printable ASCII plus tab and newline only.
    if !sigil
        .bytes()
        .all(|b| b == b'\t' || b == b'\n' || (0x20..=0x7e).contains(&b))
    {
        return Err(ProfileError::Field(
            "sigil must be printable ASCII, tab, and newline only".into(),
        ));
    }
    let lines: Vec<&str> = sigil.split('\n').collect();
    if lines.len() > MAX_SIGIL_LINES {
        return Err(ProfileError::Field(format!(
            "sigil must be <= {MAX_SIGIL_LINES} lines"
        )));
    }
    if lines
        .iter()
        .any(|l| expanded_line_len(l) > MAX_SIGIL_COLUMNS)
    {
        return Err(ProfileError::Field(format!(
            "sigil lines must be <= {MAX_SIGIL_COLUMNS} columns"
        )));
    }

    let color = fields.color.trim();
    if !is_hex_color(color) {
        return Err(ProfileError::Field("color must be #RRGGBB".into()));
    }
    Ok(())
}

fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// Canonical, signature-independent encoding used for signing + verification.
fn signing_bytes(rec: &ProfileRecord) -> Result<Vec<u8>, ProfileError> {
    let mut unsigned = rec.clone();
    unsigned.sig = Vec::new();
    let mut out = PROFILE_SIG_CTX.to_vec();
    out.extend_from_slice(&postcard::to_allocvec(&unsigned).map_err(|_| ProfileError::Encode)?);
    Ok(out)
}

/// Build a signed [`ProfileRecord`] and return its postcard-encoded bytes.
///
/// * `identity_seed` — the 32-byte ed25519 seed (node identity / iroh `SecretKey` bytes).
/// * `endpoint_id`   — the 32-byte ed25519 public key (== EndpointId).
/// * `recv_pub`      — the current X25519 receiving public key (32B).
/// * `epoch`         — monotonic; the caller guarantees it is strictly greater than the last.
pub fn build_signed(
    identity_seed: &[u8],
    endpoint_id: &[u8],
    recv_pub: &[u8],
    epoch: u64,
    ts: u64,
    fields: &ProfileFields,
) -> Result<Vec<u8>, ProfileError> {
    if identity_seed.len() != 32
        || endpoint_id.len() != ENDPOINT_LEN
        || recv_pub.len() != RECV_PUB_LEN
    {
        return Err(ProfileError::KeyLength);
    }
    validate_fields(fields)?;
    let seed: [u8; 32] = identity_seed
        .try_into()
        .map_err(|_| ProfileError::KeyLength)?;
    let signing = SigningKey::from_bytes(&seed);
    // The endpoint id MUST be the public half of the signing seed — otherwise the record
    // would be signed by a key unrelated to the claimed endpoint.
    if signing.verifying_key().to_bytes() != endpoint_id {
        return Err(ProfileError::WrongEndpoint);
    }

    let mut rec = ProfileRecord {
        v: PROFILE_V,
        endpoint_id: endpoint_id.to_vec(),
        epoch,
        handle: fields.handle.clone(),
        cryptid_name: fields.cryptid_name.clone(),
        sigil: fields.sigil.clone(),
        color: fields.color.clone(),
        recv_pub: recv_pub.to_vec(),
        ts,
        sig: Vec::new(),
    };
    let sig = signing.sign(&signing_bytes(&rec)?);
    rec.sig = sig.to_bytes().to_vec();

    let bytes = postcard::to_allocvec(&rec).map_err(|_| ProfileError::Encode)?;
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(ProfileError::Field(format!(
            "encoded profile is {} bytes (> {MAX_PROFILE_BYTES})",
            bytes.len()
        )));
    }
    Ok(bytes)
}

/// Verify a profile record's structure, size, signature, endpoint binding, and fields.
///
/// If `expected_endpoint` is `Some`, the record's `endpoint_id` MUST equal it (binding a
/// friend's profile to the endpoint id we authenticated over iroh / pinned in pairing).
pub fn verify(
    bytes: &[u8],
    expected_endpoint: Option<&[u8]>,
) -> Result<ProfileRecord, ProfileError> {
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(ProfileError::Decode);
    }
    let rec: ProfileRecord = postcard::from_bytes(bytes).map_err(|_| ProfileError::Decode)?;
    if rec.v != PROFILE_V {
        return Err(ProfileError::Decode);
    }
    if rec.endpoint_id.len() != ENDPOINT_LEN
        || rec.recv_pub.len() != RECV_PUB_LEN
        || rec.sig.len() != SIG_LEN
    {
        return Err(ProfileError::Decode);
    }
    if let Some(expected) = expected_endpoint {
        if expected != rec.endpoint_id.as_slice() {
            return Err(ProfileError::WrongEndpoint);
        }
    }

    validate_fields(&ProfileFields {
        handle: rec.handle.clone(),
        cryptid_name: rec.cryptid_name.clone(),
        sigil: rec.sigil.clone(),
        color: rec.color.clone(),
    })?;

    let endpoint_arr: [u8; ENDPOINT_LEN] = rec
        .endpoint_id
        .clone()
        .try_into()
        .map_err(|_| ProfileError::Decode)?;
    let vk = VerifyingKey::from_bytes(&endpoint_arr).map_err(|_| ProfileError::BadSignature)?;
    let sig = Signature::from_slice(&rec.sig).map_err(|_| ProfileError::BadSignature)?;
    vk.verify_strict(&signing_bytes(&rec)?, &sig)
        .map_err(|_| ProfileError::BadSignature)?;
    Ok(rec)
}

/// Rollback guard: a candidate profile is accepted only if strictly newer than the last seen.
pub fn is_newer_epoch(candidate: u64, last_seen: Option<u64>) -> bool {
    match last_seen {
        Some(last) => candidate > last,
        None => true,
    }
}

// ── Durable namespace-id metadata (stability across restarts) ────────────────────────────

/// Filename (under `data_dir`) holding the persisted profile `NamespaceId`, so the profile
/// namespace is stable across [`crate::LocationNode`] restarts even though iroh-docs mints a
/// fresh namespace on `create()`.
pub const PROFILE_NS_FILE: &str = "profile-namespace.bin";

// The `read_ns_file`/`write_ns_file` helpers now live in `docs` (shared by the native + wasm
// crates); re-exported here so the profile init/tests keep referring to them unqualified.
pub use crate::docs::{read_ns_file, write_ns_file};

// ── Live-node wrapper ───────────────────────────────────────────────────────────────────

/// Sink for verified profile updates surfaced by the docs live-sync loop. Implemented in
/// lib.rs to push onto the node's pollable profile-event queue.
pub trait ProfileSink: Send + Sync + 'static {
    fn on_profile_update(&self, record: ProfileRecord);
}

/// Wraps the profile iroh-docs replica: our own single-writer namespace plus any friend
/// namespaces imported from a pairing Accept.
pub struct ProfileDocs {
    docs: Docs,
    blobs: BlobsStore,
    author: AuthorId,
    own_ns: NamespaceId,
    /// Docs we can read (own + imported friends), keyed by namespace bytes.
    handles: Mutex<HashMap<[u8; 32], Doc>>,
    /// Highest profile epoch accepted per endpoint id (rollback protection).
    epochs: Mutex<HashMap<[u8; 32], u64>>,
}

impl ProfileDocs {
    /// Initialise from an already-spawned [`Docs`] protocol + blobs store, reusing the
    /// persisted profile namespace under `data_dir` when possible (stable across restarts),
    /// otherwise creating a new one and persisting its id.
    pub async fn init(docs: Docs, blobs: BlobsStore, data_dir: PathBuf) -> Result<Self> {
        let author = docs.author_default().await?;
        let ns_path = data_dir.join(PROFILE_NS_FILE);

        let doc = match read_ns_file(&ns_path) {
            Some(id) => {
                let ns = NamespaceId::from(id);
                match docs.open(ns).await {
                    Ok(Some(doc)) => Some(doc),
                    _ => None,
                }
            }
            None => None,
        };
        let doc = match doc {
            Some(doc) => doc,
            None => {
                let doc = docs.create().await?;
                // Best-effort persist; a failure just means we mint a fresh ns next boot.
                let _ = write_ns_file(&ns_path, &doc.id().to_bytes());
                doc
            }
        };
        let own_ns = doc.id();
        let mut handles = HashMap::new();
        handles.insert(own_ns.to_bytes(), doc);
        Ok(Self {
            docs,
            blobs,
            author,
            own_ns,
            handles: Mutex::new(handles),
            epochs: Mutex::new(HashMap::new()),
        })
    }

    async fn doc_for(&self, ns: NamespaceId) -> Result<Doc> {
        if let Some(doc) = self.handles.lock().await.get(&ns.to_bytes()).cloned() {
            return Ok(doc);
        }
        let doc = self
            .docs
            .open(ns)
            .await?
            .ok_or_else(|| anyhow!("profile namespace not found in local replica"))?;
        self.handles.lock().await.insert(ns.to_bytes(), doc.clone());
        Ok(doc)
    }

    /// Publish (or update) our own profile record bytes under [`PROFILE_KEY`].
    pub async fn publish(
        &self,
        endpoint_id: &[u8],
        epoch: u64,
        record_bytes: Vec<u8>,
    ) -> Result<()> {
        let doc = self.doc_for(self.own_ns).await?;
        doc.set_bytes(self.author, PROFILE_KEY.to_vec(), record_bytes)
            .await?;
        if let Ok(arr) = <[u8; 32]>::try_from(endpoint_id) {
            let mut epochs = self.epochs.lock().await;
            let e = epochs.entry(arr).or_insert(0);
            if epoch > *e {
                *e = epoch;
            }
        }
        Ok(())
    }

    /// Our current published epoch for `endpoint_id` (0 if none), used to pick the next epoch.
    pub async fn last_epoch(&self, endpoint_id: &[u8]) -> u64 {
        match <[u8; 32]>::try_from(endpoint_id) {
            Ok(arr) => self.epochs.lock().await.get(&arr).copied().unwrap_or(0),
            Err(_) => 0,
        }
    }

    /// A shareable **read**-ticket for our profile namespace (goes into the pairing Accept).
    pub async fn ticket(&self) -> Result<String> {
        let doc = self.doc_for(self.own_ns).await?;
        let ticket = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await?;
        Ok(ticket.to_string())
    }

    /// Import a friend's profile read-ticket, begin replicating, and return the namespace id.
    pub async fn import_ticket(&self, ticket: &str) -> Result<NamespaceId> {
        let ticket: iroh_docs::DocTicket = ticket.parse().map_err(|e| anyhow!("{e}"))?;
        let doc = self.docs.import(ticket).await?;
        let ns = doc.id();
        self.handles.lock().await.insert(ns.to_bytes(), doc);
        Ok(ns)
    }

    /// Read + verify the newest profile in `ns`. `expected_endpoint` binds it to a known peer.
    /// Returns `Ok(None)` if no (content-available) record is present yet.
    pub async fn read_latest(
        &self,
        ns: NamespaceId,
        expected_endpoint: Option<&[u8]>,
    ) -> Result<Option<ProfileRecord>> {
        let doc = self.doc_for(ns).await?;
        let query = Query::single_latest_per_key()
            .key_exact(PROFILE_KEY)
            .build();
        let entry = match doc.get_one(query).await? {
            Some(e) => e,
            None => return Ok(None),
        };
        let bytes = match self.blobs.blobs().get_bytes(entry.content_hash()).await {
            Ok(b) => b,
            Err(_) => return Ok(None), // content not replicated locally yet
        };
        match verify(&bytes, expected_endpoint) {
            Ok(rec) => Ok(Some(rec)),
            Err(_) => Ok(None),
        }
    }

    /// Read the newest verified profile for `endpoint_id` across every known namespace.
    pub async fn read_for_endpoint(&self, endpoint_id: &[u8]) -> Result<Option<ProfileRecord>> {
        let namespaces: Vec<NamespaceId> = self
            .handles
            .lock()
            .await
            .keys()
            .map(|b| NamespaceId::from(*b))
            .collect();
        let mut best: Option<ProfileRecord> = None;
        for ns in namespaces {
            if let Ok(Some(rec)) = self.read_latest(ns, Some(endpoint_id)).await {
                if best.as_ref().map(|b| rec.epoch > b.epoch).unwrap_or(true) {
                    best = Some(rec);
                }
            }
        }
        Ok(best)
    }

    /// Accept a candidate profile iff its epoch is strictly newer than the last we accepted for
    /// that endpoint, then record the new high-water epoch. Returns `true` if accepted.
    pub async fn accept_if_newer(&self, rec: &ProfileRecord) -> bool {
        let arr = match rec.endpoint_arr() {
            Some(a) => a,
            None => return false,
        };
        let mut epochs = self.epochs.lock().await;
        let last = epochs.get(&arr).copied();
        if is_newer_epoch(rec.epoch, last) {
            epochs.insert(arr, rec.epoch);
            true
        } else {
            false
        }
    }

    /// Spawn a live-sync watcher for `ns` that verifies inbound profile records, enforces the
    /// monotonic-epoch rule, and forwards accepted updates to `sink`. Runs until the doc closes.
    pub fn watch(self: &Arc<Self>, ns: NamespaceId, sink: Arc<dyn ProfileSink>) {
        let this = self.clone();
        tokio::spawn(async move {
            let doc = match this.doc_for(ns).await {
                Ok(d) => d,
                Err(_) => return,
            };
            let mut events = match doc.subscribe().await {
                Ok(e) => e,
                Err(_) => return,
            };
            while let Some(event) = events.next().await {
                let entry = match event {
                    Ok(LiveEvent::InsertRemote { entry, .. }) => entry,
                    Ok(LiveEvent::InsertLocal { entry }) => entry,
                    Ok(LiveEvent::ContentReady { .. }) => {
                        // Content for a previously-seen entry may now be available; re-read.
                        if let Ok(Some(rec)) = this.read_latest(ns, None).await {
                            if this.accept_if_newer(&rec).await {
                                sink.on_profile_update(rec);
                            }
                        }
                        continue;
                    }
                    Ok(_) => continue,
                    Err(_) => break,
                };
                if entry.key() != PROFILE_KEY {
                    continue;
                }
                let bytes = match this.blobs.blobs().get_bytes(entry.content_hash()).await {
                    Ok(b) => b,
                    Err(_) => continue, // await ContentReady
                };
                if let Ok(rec) = verify(&bytes, None) {
                    if this.accept_if_newer(&rec).await {
                        sink.on_profile_update(rec);
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    fn identity() -> ([u8; 32], [u8; 32]) {
        let sk = SigningKey::generate(&mut OsRng);
        (sk.to_bytes(), sk.verifying_key().to_bytes())
    }

    fn good_fields() -> ProfileFields {
        ProfileFields {
            handle: "@mothman".into(),
            cryptid_name: "Mothman".into(),
            sigil: "  \\.    ./\n   \\(oo)/\n    )~~(\n   /_||_\\".into(),
            color: "#2F9E6A".into(),
        }
    }

    #[test]
    fn validate_accepts_good_fields() {
        assert!(validate_fields(&good_fields()).is_ok());
    }

    #[test]
    fn validate_rejects_overlong_handle() {
        let mut f = good_fields();
        f.handle = "@".to_string() + &"x".repeat(MAX_HANDLE_CHARS + 1);
        assert!(validate_fields(&f).is_err());
    }

    #[test]
    fn validate_rejects_overlong_name() {
        let mut f = good_fields();
        f.cryptid_name = "y".repeat(MAX_CRYPTID_NAME_CHARS + 1);
        assert!(validate_fields(&f).is_err());
    }

    #[test]
    fn validate_rejects_too_many_sigil_lines() {
        let mut f = good_fields();
        f.sigil = "x\n".repeat(MAX_SIGIL_LINES + 1);
        assert!(validate_fields(&f).is_err());
    }

    #[test]
    fn validate_rejects_wide_sigil_columns() {
        let mut f = good_fields();
        f.sigil = "x".repeat(MAX_SIGIL_COLUMNS + 1);
        assert!(validate_fields(&f).is_err());
    }

    #[test]
    fn validate_counts_tabs_as_four_columns() {
        // A tab expands to four columns. Include a visible glyph so the sigil isn't rejected as
        // empty (a pure-whitespace sigil trims away). 7 tabs + 4 glyphs == 28 + 4 == 32 columns
        // (exactly the limit); one more glyph tips it over.
        let mut f = good_fields();
        f.sigil = format!("{}{}", "\t".repeat(7), "x".repeat(4));
        assert!(validate_fields(&f).is_ok());
        f.sigil = format!("{}{}", "\t".repeat(7), "x".repeat(5));
        assert!(validate_fields(&f).is_err());
    }

    #[test]
    fn validate_rejects_non_ascii_sigil() {
        let mut f = good_fields();
        f.sigil = "mothman✨".into();
        assert!(validate_fields(&f).is_err());
    }

    #[test]
    fn validate_rejects_bad_color() {
        let mut f = good_fields();
        f.color = "2F9E6A".into(); // missing '#'
        assert!(validate_fields(&f).is_err());
        f.color = "#2F9E6".into(); // too short
        assert!(validate_fields(&f).is_err());
        f.color = "#GGGGGG".into(); // non-hex
        assert!(validate_fields(&f).is_err());
    }

    #[test]
    fn sign_then_verify_round_trips() {
        let (seed, endpoint) = identity();
        let (_sk, recv_pub) = crate::crypto::generate_recv_keypair();
        let bytes = build_signed(&seed, &endpoint, &recv_pub, 1, 1000, &good_fields()).unwrap();
        let rec = verify(&bytes, Some(&endpoint)).unwrap();
        assert_eq!(rec.epoch, 1);
        assert_eq!(rec.endpoint_id, endpoint.to_vec());
        assert_eq!(rec.recv_pub, recv_pub);
        assert_eq!(rec.handle, "@mothman");
    }

    #[test]
    fn verify_rejects_wrong_endpoint_binding() {
        let (seed, endpoint) = identity();
        let (_other_seed, other_endpoint) = identity();
        let (_sk, recv_pub) = crate::crypto::generate_recv_keypair();
        let bytes = build_signed(&seed, &endpoint, &recv_pub, 1, 1000, &good_fields()).unwrap();
        assert!(matches!(
            verify(&bytes, Some(&other_endpoint)),
            Err(ProfileError::WrongEndpoint)
        ));
    }

    #[test]
    fn verify_rejects_tampered_field() {
        let (seed, endpoint) = identity();
        let (_sk, recv_pub) = crate::crypto::generate_recv_keypair();
        let bytes = build_signed(&seed, &endpoint, &recv_pub, 1, 1000, &good_fields()).unwrap();
        let mut rec: ProfileRecord = postcard::from_bytes(&bytes).unwrap();
        rec.handle = "@impostor".into();
        let tampered = postcard::to_allocvec(&rec).unwrap();
        assert!(matches!(
            verify(&tampered, None),
            Err(ProfileError::BadSignature)
        ));
    }

    #[test]
    fn build_rejects_endpoint_not_matching_seed() {
        let (seed, _endpoint) = identity();
        let (_other_seed, other_endpoint) = identity();
        let (_sk, recv_pub) = crate::crypto::generate_recv_keypair();
        assert!(matches!(
            build_signed(&seed, &other_endpoint, &recv_pub, 1, 1000, &good_fields()),
            Err(ProfileError::WrongEndpoint)
        ));
    }

    #[test]
    fn epoch_monotonicity() {
        assert!(is_newer_epoch(1, None));
        assert!(is_newer_epoch(2, Some(1)));
        assert!(!is_newer_epoch(1, Some(1)));
        assert!(!is_newer_epoch(1, Some(2)));
    }

    #[test]
    fn ns_file_round_trip() {
        let dir = std::env::temp_dir().join(format!("sc-profile-ns-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PROFILE_NS_FILE);
        assert_eq!(read_ns_file(&path), None);
        let id = [7u8; 32];
        write_ns_file(&path, &id).unwrap();
        assert_eq!(read_ns_file(&path), Some(id));
        // A wrong-length file is treated as absent.
        std::fs::write(&path, [1u8; 8]).unwrap();
        assert_eq!(read_ns_file(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
