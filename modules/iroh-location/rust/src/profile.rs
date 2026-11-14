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

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use iroh::EndpointAddr;
use iroh_blobs::api::Store as BlobsStore;
use iroh_blobs::Hash;
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
use n0_future::time::Instant;
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::ns_book::{self, NamespaceBook};
use crate::profile_seal::{self, KeyId, KeyState};

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

/// What sealing needs (see [`crate::profile_seal`]): the identity seed our profile keys derive
/// from, the receiving secret that opens friends' keyrings, and where the key state lives.
pub struct Sealer {
    identity_seed: [u8; 32],
    recv_secret: Vec<u8>,
    state_dir: PathBuf,
    state: std::sync::Mutex<KeyState>,
    /// Friends' profile keys as their keyrings opened, by namespace and key id.
    friend_keys: std::sync::Mutex<HashMap<([u8; 32], KeyId), [u8; 32]>>,
}

impl Sealer {
    pub fn new(identity_seed: [u8; 32], recv_secret: Vec<u8>, state_dir: PathBuf) -> Self {
        let state = KeyState::load(&state_dir);
        Self {
            identity_seed,
            recv_secret,
            state_dir,
            state: std::sync::Mutex::new(state),
            friend_keys: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn state(&self) -> KeyState {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn current_key(&self) -> [u8; 32] {
        profile_seal::derive_key(&self.identity_seed, self.state().generation)
    }

    /// Our own key named `kid`: the current generation's, or the one before it, which an entry
    /// can still be sealed under for the moment a rotation is being written.
    fn own_key(&self, kid: &KeyId) -> Option<[u8; 32]> {
        let generation = self.state().generation;
        [generation, generation.saturating_sub(1)]
            .into_iter()
            .map(|g| profile_seal::derive_key(&self.identity_seed, g))
            .find(|key| profile_seal::key_id(key) == *kid)
    }
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
    /// What to reopen on the next start. See [`crate::ns_book`]; same reasons as the trail's.
    book: Option<Arc<NamespaceBook>>,
    /// Highest profile epoch accepted per endpoint id (rollback protection).
    epochs: Mutex<HashMap<[u8; 32], u64>>,
    /// Namespaces that already have a live watcher task, so re-importing a friend's ticket (the
    /// retry path for a profile that never arrived) doesn't pile up duplicate subscribers.
    watched: Mutex<HashSet<[u8; 32]>>,
    /// Verified records handed to us OUT OF BAND — today, on a pairing `Accept`.
    ///
    /// These belong to no replica we hold: the peer's namespace may not be imported yet, and even
    /// once it is we cannot write their single-writer doc. They are nonetheless first-class, for
    /// the reason the module header gives — a record carries its own signature and endpoint
    /// binding, so docs replication was never what made it trustworthy. Keyed by endpoint id and
    /// read by [`read_for_endpoint`](Self::read_for_endpoint) alongside the replicas, so the
    /// namespace winning later with a newer epoch simply outranks the handed copy.
    handed: Mutex<HashMap<[u8; 32], ProfileRecord>>,
    /// Sealing ([`crate::profile_seal`]). `None` stores and reads every record in the clear, as
    /// before sealing existed: the docs fixtures, and tests that look at the stored bytes.
    seal: Option<Arc<Sealer>>,
    /// One writer to our own namespace at a time, so a reseal and a publish never interleave.
    write: Mutex<()>,
    /// The peer that last handed us an entry in each friend namespace (`InsertRemote.from`), so
    /// a [settle](Self::settle_stranded) can ask it again for bytes it did not deliver.
    served_by: Mutex<HashMap<[u8; 32], [u8; 32]>>,
}

/// A friend profile entry whose newest record is in the replica while the bytes it names are not.
///
/// The same state as the trail's [`crate::docs::StrandedSlot`], for the same reason: iroh-docs
/// gives a record's content one download attempt, against the peer that delivered the record,
/// and never retries. A profile namespace is held by more than its owner (every friend who
/// imported it serves it, and so does anything else it is granted to), so a record can arrive
/// from a peer that has not got its bytes yet. Until they land [`ProfileDocs::read_latest`] reads
/// the namespace as having no profile, and the friend keeps whatever name and sigil we last had.
///
/// Every key counts, not only [`PROFILE_KEY`]: anything a friend publishes in this namespace is
/// read by someone, and a key-agnostic scan cannot fall behind the keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrandedEntry {
    pub namespace: [u8; 32],
    pub key: Vec<u8>,
    pub hash: Hash,
    /// The entry's record timestamp (iroh-docs microseconds), for the age on the telemetry.
    pub written_us: u64,
}

/// What one [`ProfileDocs::settle_stranded`] pass found and fixed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProfileSettleReport {
    /// Friend profile entries whose newest record had no local bytes when the pass began.
    pub stranded: usize,
    /// Of those, the ones whose bytes this pass fetched.
    pub fetched: usize,
    /// Profiles that became readable and were newer than what we had, each handed to the sink.
    pub updated: usize,
}

impl ProfileDocs {
    /// Initialise from an already-spawned [`Docs`] protocol + blobs store.
    ///
    /// With a `book`, our own namespace comes back from the secret it holds — never minted over
    /// one that merely failed to open — and friend namespaces it lists are reopened. Rotating this
    /// namespace silently stops every friend receiving our profile edits, exactly as rotating the
    /// trail one stops them receiving fixes. See [`crate::ns_book`]. Without a book, the id file
    /// under `data_dir` is the only memory.
    pub async fn init(
        docs: Docs,
        blobs: BlobsStore,
        data_dir: PathBuf,
        book: Option<Arc<NamespaceBook>>,
    ) -> Result<Self> {
        let author = docs.author_default().await?;
        let ns_path = data_dir.join(PROFILE_NS_FILE);
        let legacy = read_ns_file(&ns_path);

        let mut handles = HashMap::new();
        let doc = match book.as_deref() {
            Some(book) => {
                let own = ns_book::open_own_namespace(&docs, book, legacy).await?;
                for doc in ns_book::reopen_friends(&docs, book).await {
                    handles.insert(doc.id().to_bytes(), doc);
                }
                own
            }
            None => match legacy {
                Some(id) => match docs.open(NamespaceId::from(id)).await {
                    Ok(Some(doc)) => doc,
                    _ => docs.create().await?,
                },
                None => docs.create().await?,
            },
        };
        // Kept for a downgrade to a binary that reads only this file. Best-effort.
        let _ = write_ns_file(&ns_path, &doc.id().to_bytes());
        let own_ns = doc.id();
        handles.insert(own_ns.to_bytes(), doc);
        Ok(Self {
            docs,
            blobs,
            author,
            own_ns,
            handles: Mutex::new(handles),
            book,
            epochs: Mutex::new(HashMap::new()),
            watched: Mutex::new(HashSet::new()),
            handed: Mutex::new(HashMap::new()),
            seal: None,
            write: Mutex::new(()),
            served_by: Mutex::new(HashMap::new()),
        })
    }

    /// Seal what this node writes and open what friends sealed ([`crate::profile_seal`]).
    pub fn with_seal(mut self, sealer: Sealer) -> Self {
        self.seal = Some(Arc::new(sealer));
        self
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

    /// Mark our own profile namespace as syncing in the iroh-docs live engine.
    ///
    /// This is the SEND half of the profile path and it is not optional, for exactly the reason
    /// [`crate::docs::TrailDocs::push`] documents: `publish` only touches the local replica, and
    /// the live engine broadcasts a `LocalInsert` — and serves inbound range reconciliation —
    /// **only** for namespaces `start_sync` has marked as syncing
    /// (`engine::live::on_replica_event`). Without this a friend who imported our read-ticket has
    /// nothing to reconcile from, so they keep the placeholder identity from the pairing result
    /// forever while we see theirs just fine.
    ///
    /// Unlike the trail push this does not wait for a `SyncFinished`: a profile has no stash peer
    /// to confirm against, so blocking would only stall the caller for the timeout. Idempotent and
    /// cheap — `start_sync` is a no-op once the namespace is already syncing.
    pub async fn arm_publishing(&self) -> Result<()> {
        let doc = self.doc_for(self.own_ns).await?;
        doc.start_sync(Vec::<EndpointAddr>::new()).await?;
        Ok(())
    }

    /// Publish (or update) our own profile record bytes under [`PROFILE_KEY`].
    pub async fn publish(
        &self,
        endpoint_id: &[u8],
        epoch: u64,
        record_bytes: Vec<u8>,
    ) -> Result<()> {
        let doc = self.doc_for(self.own_ns).await?;
        // Arm the engine BEFORE the write: a `LocalInsert` is broadcast only for an
        // already-syncing namespace, so arming afterwards would leave this record waiting for
        // someone else's reconciliation instead of going out now. Best-effort — a friend who
        // imported our ticket can still dial us, and failing here would mean not even storing
        // the record locally.
        if let Err(err) = self.arm_publishing().await {
            tracing::warn!(error = %err, "profile: start_sync failed; publish is local-only");
        }
        let _write = self.write.lock().await;
        self.write_own(&doc, PROFILE_KEY, record_bytes).await?;
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

    /// Our profile namespace's write key, for a repeater grant proof (see the trail's
    /// `own_namespace_secret`). It never leaves the phone.
    pub async fn own_namespace_secret(&self) -> Result<[u8; 32]> {
        let doc = self.doc_for(self.own_ns).await?;
        match doc
            .share(ShareMode::Write, AddrInfoOptions::Id)
            .await?
            .capability
        {
            iroh_docs::Capability::Write(secret) => Ok(secret.to_bytes()),
            iroh_docs::Capability::Read(_) => Err(anyhow!("our own profile is open read-only")),
        }
    }

    /// Every friend profile ticket in the book: what the stash is granted beside our own.
    pub fn friend_tickets(&self) -> Vec<String> {
        self.book
            .as_ref()
            .map(|book| {
                book.friends()
                    .into_iter()
                    .map(|entry| entry.ticket)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Import a friend's profile read-ticket, begin replicating, and return the namespace id.
    ///
    /// Recorded in the book, so every later start reopens it whether or not JS runs.
    pub async fn import_ticket(&self, ticket: &str) -> Result<NamespaceId> {
        let mut parsed: iroh_docs::DocTicket = ticket.parse().map_err(|e| anyhow!("{e}"))?;
        // A ticket names the relays its owner had when it was minted; see `relay::scrub_addr`.
        parsed.nodes = parsed
            .nodes
            .into_iter()
            .map(crate::relay::scrub_addr)
            .collect();
        let doc = self.docs.import(parsed).await?;
        let ns = doc.id();
        if ns != self.own_ns {
            if let Some(book) = &self.book {
                book.add_friend(ns.to_bytes(), ticket)?;
            }
        }
        self.handles.lock().await.insert(ns.to_bytes(), doc);
        Ok(ns)
    }

    /// Re-arm saved profiles after a native-only node restart and wait for their content.
    /// The caller bounds this wait and runs it alongside the trail pull.
    ///
    /// A friend's profile is taken from their own phone and from `relays[friend]`: the stash and
    /// the repeaters that carry them hold it too, sealed (`crate::profile_seal`), so it arrives
    /// while their phone sleeps the same way their trail does. Done once any of them has synced
    /// and the content is in; given up once every one of them has failed.
    pub async fn sync_known_friends(
        &self,
        friends: &BTreeSet<[u8; 32]>,
        relays: &HashMap<[u8; 32], Vec<EndpointAddr>>,
    ) {
        let Some(book) = &self.book else {
            return;
        };
        let saved = book.friends();
        let tickets: Vec<_> = saved.iter().map(|entry| entry.ticket.clone()).collect();
        let owners: HashMap<_, _> = crate::repeater::friend_namespaces(&tickets, friends)
            .into_iter()
            .map(|(owner, namespace)| (namespace, owner))
            .collect();
        n0_future::join_all(saved.into_iter().filter_map(|entry| {
            let owner = *owners.get(&entry.namespace)?;
            let ticket: iroh_docs::DocTicket = entry.ticket.parse().ok()?;
            if ticket.capability.id().to_bytes() != entry.namespace {
                return None;
            }
            let mut peers: Vec<EndpointAddr> = ticket
                .nodes
                .into_iter()
                .filter(|addr| addr.id.as_bytes() == &owner)
                .map(crate::relay::scrub_addr)
                .collect();
            for relay in relays.get(&owner).into_iter().flatten() {
                if !peers.iter().any(|p| p.id == relay.id) {
                    peers.push(relay.clone());
                }
            }
            if peers.is_empty() {
                return None;
            }
            let mut waiting: HashSet<[u8; 32]> =
                peers.iter().map(|addr| *addr.id.as_bytes()).collect();
            Some(async move {
                let Ok(doc) = self.doc_for(NamespaceId::from(entry.namespace)).await else {
                    return;
                };
                let Ok(mut events) = doc.subscribe().await else {
                    return;
                };
                if let Err(error) = doc.start_sync(peers).await {
                    tracing::warn!(%error, "profile: could not schedule friend sync");
                    return;
                }
                let mut synced = false;
                while let Some(Ok(event)) = events.next().await {
                    match event {
                        LiveEvent::SyncFinished(result)
                            if waiting.contains(result.peer.as_bytes()) =>
                        {
                            match result.result {
                                Ok(_) => synced = true,
                                Err(error) if error.contains("AlreadySyncing") => {}
                                Err(_) => {
                                    waiting.remove(result.peer.as_bytes());
                                    if waiting.is_empty() && !synced {
                                        return;
                                    }
                                }
                            }
                        }
                        LiveEvent::PendingContentReady if synced => return,
                        _ => {}
                    }
                }
            })
        }))
        .await;
    }

    /// Stop replicating a removed friend's profile namespace and drop it from the book. Returns
    /// whether we were replicating it.
    pub async fn forget_ticket(&self, ticket: &str) -> Result<bool> {
        let ns = NamespaceId::from(ns_book::ticket_namespace(ticket)?);
        if ns == self.own_ns {
            return Ok(false);
        }
        let in_book = match &self.book {
            Some(book) => book.remove_friend(ns.to_bytes())?,
            None => false,
        };
        let handle = self.handles.lock().await.remove(&ns.to_bytes());
        if let Some(doc) = &handle {
            let _ = doc.leave().await;
        }
        Ok(in_book || handle.is_some())
    }

    /// Put `bytes` under `key` in our own profile namespace, unless that is already what it holds.
    /// Returns whether anything was written.
    ///
    /// For records that live beside the profile under their own key and signing context (today the
    /// repeater card, `crate::repeater`), so that older readers, which look up [`PROFILE_KEY`]
    /// only, never see them. Same arming rule as [`publish`](Self::publish).
    pub async fn publish_key(&self, key: &[u8], bytes: Vec<u8>) -> Result<bool> {
        let _write = self.write.lock().await;
        if self.latest_key_bytes(self.own_ns, key).await?.as_deref() == Some(bytes.as_slice()) {
            return Ok(false);
        }
        let doc = self.doc_for(self.own_ns).await?;
        if let Err(err) = self.arm_publishing().await {
            tracing::warn!(error = %err, "profile: start_sync failed; publish is local-only");
        }
        self.write_own(&doc, key, bytes).await?;
        Ok(true)
    }

    /// Store `plaintext` under `key` in our own namespace: sealed under the current profile key
    /// when sealing is on, else in the clear. Callers hold `write`.
    async fn write_own(&self, doc: &Doc, key: &[u8], plaintext: Vec<u8>) -> Result<()> {
        let Some(sealer) = &self.seal else {
            doc.set_bytes(self.author, key.to_vec(), plaintext).await?;
            return Ok(());
        };
        self.write_sealed(doc, &sealer.current_key(), key, &plaintext)
            .await
    }

    async fn write_sealed(
        &self,
        doc: &Doc,
        profile_key: &[u8; 32],
        key: &[u8],
        plaintext: &[u8],
    ) -> Result<()> {
        let sealed =
            profile_seal::seal_entry(profile_key, &self.own_ns.to_bytes(), key, plaintext)?;
        doc.set_bytes(self.author, profile_seal::sealed_key(key), sealed)
            .await?;
        // The copy an earlier build kept in the clear: every holder could read it, so it goes as
        // soon as a sealed one stands beside it. Friends on a build that cannot open sealed
        // records keep the last one they read.
        if self.raw_bytes(self.own_ns, key).await?.is_some() {
            doc.del(self.author, key.to_vec()).await?;
        }
        Ok(())
    }

    /// Wrap the profile key for `friends` (endpoint id, X25519 receiving key) and seal everything
    /// again, when [`KeyState::plan`] says so: someone joined or left, or it is time to refresh
    /// the copies the stash holds. A friend who left moves us to the next key. Returns whether
    /// anything was written; `false` too when sealing is off.
    pub async fn reseal(&self, friends: &[([u8; 32], Vec<u8>)], now_ms: u64) -> Result<bool> {
        let Some(sealer) = &self.seal else {
            return Ok(false);
        };
        let _write = self.write.lock().await;
        let state = sealer.state();
        let plan = state.plan(friends, now_ms);
        if !plan.reseal {
            return Ok(false);
        }
        // What we hold now, opened with the key it was sealed under, before the key moves on.
        let mut records = Vec::new();
        for key in [PROFILE_KEY, crate::repeater::CARD_KEY] {
            if let Some(bytes) = self.latest_key_bytes(self.own_ns, key).await? {
                records.push((key, bytes));
            }
        }
        let next = state.after(&plan, friends, now_ms);
        let profile_key = profile_seal::derive_key(&sealer.identity_seed, next.generation);
        let doc = self.doc_for(self.own_ns).await?;
        if let Err(err) = self.arm_publishing().await {
            tracing::warn!(error = %err, "profile: start_sync failed; reseal is local-only");
        }
        // The keyring first, so a friend who sees the new entries can already open them.
        let keyring =
            profile_seal::build_keyring(&profile_key, &self.own_ns.to_bytes(), &next.keys)?;
        doc.set_bytes(self.author, profile_seal::KEYRING_KEY.to_vec(), keyring)
            .await?;
        for (key, plaintext) in records {
            self.write_sealed(&doc, &profile_key, key, &plaintext)
                .await?;
        }
        // Last: a crash before here plans the same generation again next time.
        next.save(&sealer.state_dir)?;
        *sealer.state.lock().unwrap_or_else(|p| p.into_inner()) = next;
        Ok(true)
    }

    /// The newest bytes under `key` in every profile namespace we hold whose content has arrived,
    /// our own included. Unverified: the caller checks whatever signature the record carries.
    /// Tests only: the app reads cards with [`Self::read_key_from_friends`], which knows whose
    /// namespace each came from.
    #[cfg(test)]
    pub async fn read_key_everywhere(&self, key: &[u8]) -> Vec<Vec<u8>> {
        let namespaces: Vec<NamespaceId> = self
            .handles
            .lock()
            .await
            .keys()
            .map(|b| NamespaceId::from(*b))
            .collect();
        let mut out = Vec::new();
        for ns in namespaces {
            if let Ok(Some(bytes)) = self.latest_key_bytes(ns, key).await {
                out.push(bytes);
            }
        }
        out
    }

    /// The newest bytes under `key` in each friend's profile namespace, paired with the friend it
    /// belongs to. The owner comes from the ticket handed over at pairing (the same unambiguous
    /// match [`Self::sync_known_friends`] uses), never from the record, so a reader can check
    /// that whatever signed the bytes is the friend whose namespace they were read from
    /// (REPEATERS.md §4.2: a card counts as a vouch only from the friend it claims to be).
    /// Unverified otherwise. Empty without a book.
    pub async fn read_key_from_friends(
        &self,
        key: &[u8],
        friends: &BTreeSet<[u8; 32]>,
    ) -> Vec<([u8; 32], Vec<u8>)> {
        let Some(book) = &self.book else {
            return Vec::new();
        };
        let tickets: Vec<_> = book
            .friends()
            .into_iter()
            .map(|entry| entry.ticket)
            .collect();
        let mut out = Vec::new();
        for (owner, namespace) in crate::repeater::friend_namespaces(&tickets, friends) {
            if let Ok(Some(bytes)) = self
                .latest_key_bytes(NamespaceId::from(namespace), key)
                .await
            {
                out.push((owner, bytes));
            }
        }
        out
    }

    /// The newest record under `key` in `ns`, opened when it is sealed. A namespace with no sealed
    /// copy is read in the clear: a friend on an older build, or ours before its first seal. A
    /// sealed copy we cannot open is `None`, never the clear one beside it.
    async fn latest_key_bytes(&self, ns: NamespaceId, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let Some(sealer) = &self.seal else {
            return self.raw_bytes(ns, key).await;
        };
        match self.raw_bytes(ns, &profile_seal::sealed_key(key)).await? {
            Some(sealed) => Ok(self.open_sealed(sealer, ns, key, &sealed).await),
            None => self.raw_bytes(ns, key).await,
        }
    }

    async fn open_sealed(
        &self,
        sealer: &Sealer,
        ns: NamespaceId,
        key: &[u8],
        sealed: &[u8],
    ) -> Option<Vec<u8>> {
        let kid = profile_seal::entry_kid(sealed)?;
        let profile_key = if ns == self.own_ns {
            sealer.own_key(&kid)?
        } else {
            self.friend_key(sealer, ns, kid).await?
        };
        profile_seal::open_entry(&profile_key, &ns.to_bytes(), key, sealed)
    }

    /// A friend's profile key `kid`, from the cache or from their keyring.
    async fn friend_key(&self, sealer: &Sealer, ns: NamespaceId, kid: KeyId) -> Option<[u8; 32]> {
        let slot = (ns.to_bytes(), kid);
        let cached = sealer
            .friend_keys
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&slot)
            .copied();
        if cached.is_some() {
            return cached;
        }
        let keyring = self
            .raw_bytes(ns, profile_seal::KEYRING_KEY)
            .await
            .ok()
            .flatten()?;
        let (ring_kid, key) =
            profile_seal::open_keyring(&keyring, &ns.to_bytes(), &sealer.recv_secret)?;
        sealer
            .friend_keys
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert((ns.to_bytes(), ring_kid), key);
        (ring_kid == kid).then_some(key)
    }

    /// The newest bytes stored under exactly `key` in `ns`, as stored.
    async fn raw_bytes(&self, ns: NamespaceId, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let doc = self.doc_for(ns).await?;
        let query = Query::single_latest_per_key().key_exact(key).build();
        let entry = match doc.get_one(query).await? {
            Some(e) => e,
            None => return Ok(None),
        };
        match self.blobs.blobs().get_bytes(entry.content_hash()).await {
            Ok(b) => Ok(Some(b.to_vec())),
            Err(_) => Ok(None),
        }
    }

    /// The raw signed bytes of the newest record in `ns`, or `None` if there is no entry yet or
    /// its content has not replicated locally. These bytes are exactly what was signed, which is
    /// what makes them forwardable verbatim — see [`own_record_bytes`](Self::own_record_bytes).
    async fn latest_bytes(&self, ns: NamespaceId) -> Result<Option<Vec<u8>>> {
        self.latest_key_bytes(ns, PROFILE_KEY).await
    }

    /// Read + verify the newest profile in `ns`. `expected_endpoint` binds it to a known peer.
    /// Returns `Ok(None)` if no (content-available) record is present yet.
    pub async fn read_latest(
        &self,
        ns: NamespaceId,
        expected_endpoint: Option<&[u8]>,
    ) -> Result<Option<ProfileRecord>> {
        let bytes = match self.latest_bytes(ns).await? {
            Some(b) => b,
            None => return Ok(None),
        };
        match verify(&bytes, expected_endpoint) {
            Ok(rec) => Ok(Some(rec)),
            Err(_) => Ok(None),
        }
    }

    /// Our own newest published record, as the signed bytes to put on a pairing `Accept`.
    ///
    /// `None` before this device has published a profile at all — a state the caller must treat
    /// as "send nothing and let replication catch up", never as a reason to fail the pair.
    pub async fn own_record_bytes(&self) -> Option<Vec<u8>> {
        self.latest_bytes(self.own_ns).await.ok().flatten()
    }

    /// Verify a record handed to us out of band and, if it is strictly newer than anything we
    /// have accepted for `expected_endpoint`, remember it and hand it back for the sink.
    ///
    /// `Ok(None)` means "valid but not new" — the ordinary outcome when the namespace already
    /// replicated this epoch — and is deliberately not an error. An `Err` means the bytes failed
    /// verification against the endpoint we authenticated, which is a peer lying about who they
    /// are and must not be silently absorbed.
    pub async fn ingest_handed_record(
        &self,
        bytes: &[u8],
        expected_endpoint: &[u8],
    ) -> Result<Option<ProfileRecord>, ProfileError> {
        let rec = verify(bytes, Some(expected_endpoint))?;
        let arr = rec.endpoint_arr().ok_or(ProfileError::Decode)?;
        if !self.accept_if_newer(&rec).await {
            return Ok(None);
        }
        self.handed.lock().await.insert(arr, rec.clone());
        Ok(Some(rec))
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
        // The handed copy seeds `best` rather than being checked last, so a namespace only
        // displaces it by being strictly newer — the same rule that orders the namespaces
        // against each other.
        let mut best: Option<ProfileRecord> = match <[u8; ENDPOINT_LEN]>::try_from(endpoint_id) {
            Ok(arr) => self.handed.lock().await.get(&arr).cloned(),
            Err(_) => None,
        };
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

    /// Every friend profile entry whose newest record is here without its bytes.
    ///
    /// Friend namespaces only: we write our own, so its bytes are always local. Presence is asked
    /// of the blob store directly (`has`), which reads no content.
    pub async fn stranded_entries(&self) -> Result<Vec<StrandedEntry>> {
        let namespaces: Vec<NamespaceId> = self
            .handles
            .lock()
            .await
            .keys()
            .map(|b| NamespaceId::from(*b))
            .filter(|ns| *ns != self.own_ns)
            .collect();
        let mut out = Vec::new();
        for ns in namespaces {
            let doc = self.doc_for(ns).await?;
            let stream = doc.get_many(Query::single_latest_per_key().build()).await?;
            tokio::pin!(stream);
            while let Some(entry) = stream.next().await {
                let entry = entry?;
                if entry.content_len() == 0 {
                    continue; // a tombstone names no bytes
                }
                if self.blobs.blobs().has(entry.content_hash()).await? {
                    continue;
                }
                out.push(StrandedEntry {
                    namespace: ns.to_bytes(),
                    key: entry.key().to_vec(),
                    hash: entry.content_hash(),
                    written_us: entry.timestamp(),
                });
            }
        }
        Ok(out)
    }

    /// The owner of each friend namespace we can name: the peers its read ticket lists, which is
    /// the friend's own phone. Empty without a book.
    fn owner_sources(&self) -> HashMap<[u8; 32], Vec<iroh::EndpointId>> {
        let Some(book) = &self.book else {
            return HashMap::new();
        };
        book.friends()
            .into_iter()
            .map(|friend| {
                let ids = crate::docs::ticket_peers(&friend.ticket)
                    .into_iter()
                    .map(|addr| addr.id)
                    .collect();
                (friend.namespace, ids)
            })
            .collect()
    }

    /// Fetch the bytes of every [stranded](StrandedEntry) friend profile entry, and hand each
    /// profile that became readable, and is newer than what we accepted, to `sink`.
    ///
    /// The profile twin of [`crate::docs::TrailDocs::settle_stranded`], run by the same pull.
    /// The docs engine raises no `ContentReady` for bytes fetched here, so the watch loop never
    /// re-reads them: the re-read happens here.
    ///
    /// Sources per entry, most likely first: `sources` (the peers the pull dialled, the stash
    /// among them), `namespace_sources` for the entry's namespace (whoever else holds that
    /// friend's profile: the repeaters carrying them), the friend's own phone (from the read
    /// ticket we imported), and whoever last served that namespace to us. Bounded by `deadline`
    /// and by the trail's per-fetch cap; anything still stranded is tried on the next pull, and
    /// failures are reported, not raised.
    pub async fn settle_stranded(
        &self,
        endpoint: &iroh::Endpoint,
        sources: &[iroh::EndpointId],
        namespace_sources: &HashMap<[u8; 32], Vec<iroh::EndpointId>>,
        deadline: Option<Instant>,
        sink: Option<&dyn ProfileSink>,
    ) -> Result<ProfileSettleReport> {
        let stranded = self.stranded_entries().await?;
        let mut report = ProfileSettleReport {
            stranded: stranded.len(),
            ..ProfileSettleReport::default()
        };
        if stranded.is_empty() {
            return Ok(report);
        }
        let wait = crate::docs::stranded_wait(deadline);
        if wait.is_zero() {
            tracing::debug!(
                stranded = stranded.len(),
                "stranded friend profile entries left for the next pull: no time left in this one"
            );
            return Ok(report);
        }
        let now_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as u64)
            .unwrap_or(0);

        let owners = self.owner_sources();
        let served_by = self.served_by.lock().await.clone();
        let own = endpoint.id();
        let jobs = stranded
            .iter()
            .map(|entry| {
                let extra: Vec<iroh::EndpointId> = namespace_sources
                    .get(&entry.namespace)
                    .into_iter()
                    .chain(owners.get(&entry.namespace))
                    .flatten()
                    .copied()
                    .collect();
                let providers = crate::docs::stranded_sources(
                    sources,
                    &extra,
                    None,
                    served_by.get(&entry.namespace).copied(),
                    own,
                );
                (entry.hash, providers)
            })
            .collect();
        let outcomes = crate::docs::fetch_stranded(&self.blobs, endpoint, jobs, wait).await;

        let mut readable: Vec<[u8; 32]> = Vec::new();
        for (entry, outcome) in stranded.iter().zip(outcomes) {
            let key = String::from_utf8_lossy(&entry.key);
            let age_ms = now_us.saturating_sub(entry.written_us) / 1000;
            match outcome {
                Ok(()) => {
                    report.fetched += 1;
                    if !readable.contains(&entry.namespace) {
                        readable.push(entry.namespace);
                    }
                    tracing::info!(
                        sc.namespace = %crate::telemetry::short_hex(&entry.namespace),
                        sc.entry_hash = %crate::telemetry::short_hex(entry.hash.as_bytes()),
                        profile.key = %key,
                        age_ms,
                        "fetched a stranded friend profile entry's bytes"
                    );
                }
                Err(error) => {
                    tracing::debug!(
                        sc.namespace = %crate::telemetry::short_hex(&entry.namespace),
                        sc.entry_hash = %crate::telemetry::short_hex(entry.hash.as_bytes()),
                        profile.key = %key,
                        age_ms,
                        %error,
                        "stranded friend profile entry still without bytes; will retry next pull"
                    );
                }
            }
        }
        for ns in readable {
            if let Ok(Some(rec)) = self.read_latest(NamespaceId::from(ns), None).await {
                if self.accept_if_newer(&rec).await {
                    report.updated += 1;
                    if let Some(sink) = sink {
                        sink.on_profile_update(rec);
                    }
                }
            }
        }
        Ok(report)
    }

    /// Spawn a live-sync watcher for `ns` that verifies inbound profile records, enforces the
    /// monotonic-epoch rule, and forwards accepted updates to `sink`. Runs until the doc closes.
    ///
    /// At most one watcher runs per namespace: re-importing a friend's ticket is how we retry a
    /// profile that never replicated, and that path would otherwise spawn a fresh subscriber every
    /// attempt. The claim is released when the watcher exits, so a later re-import can restart it.
    pub fn watch(self: &Arc<Self>, ns: NamespaceId, sink: Arc<dyn ProfileSink>) {
        let this = self.clone();
        tokio::spawn(async move {
            if !this.watched.lock().await.insert(ns.to_bytes()) {
                return;
            }
            this.clone().watch_loop(ns, sink).await;
            this.watched.lock().await.remove(&ns.to_bytes());
        });
    }

    async fn watch_loop(self: Arc<Self>, ns: NamespaceId, sink: Arc<dyn ProfileSink>) {
        let this = self;
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
                Ok(LiveEvent::InsertRemote { from, entry, .. }) => {
                    this.served_by
                        .lock()
                        .await
                        .insert(ns.to_bytes(), *from.as_bytes());
                    entry
                }
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
            // The record itself, its sealed copy, or a keyring that may open a sealed copy we
            // could not read before. Read back through `read_latest`, which opens what is sealed;
            // content that has not arrived yet comes round again as `ContentReady`.
            let key = entry.key();
            if key != PROFILE_KEY
                && key != profile_seal::sealed_key(PROFILE_KEY).as_slice()
                && key != profile_seal::KEYRING_KEY
            {
                continue;
            }
            if let Ok(Some(rec)) = this.read_latest(ns, None).await {
                if this.accept_if_newer(&rec).await {
                    sink.on_profile_update(rec);
                }
            }
        }
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

    // ── Records handed over on a pairing Accept ──────────────────────────────────────────────
    //
    // The persona used to arrive only by replication: one iroh-docs dial made when the pair
    // completed, with nothing behind it but a retry sweep minutes later. These cover the path
    // that carries the record on the handshake itself, and in particular that doing so gives up
    // NONE of what replication was checking — the signature, the endpoint binding to the peer the
    // connection authenticated, and the monotonic epoch.

    async fn live_profile(tag: &str) -> (ProfileDocs, PathBuf) {
        let dir = crate::docs::tests::scratch_dir(tag);
        let fx = crate::docs::tests::spawn_docs(&dir).await;
        let docs = ProfileDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone(), None)
            .await
            .unwrap();
        // The fixture's endpoint/gossip must outlive the replica; leaking is the cheapest way to
        // say so in a test and the process is about to exit anyway.
        std::mem::forget(fx);
        (docs, dir)
    }

    fn signed_record(seed: &[u8; 32], endpoint: &[u8; 32], epoch: u64) -> Vec<u8> {
        let (_sk, recv_pub) = crate::crypto::generate_recv_keypair();
        build_signed(
            seed,
            endpoint,
            &recv_pub,
            epoch,
            1_000 + epoch,
            &good_fields(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn own_profile_namespace_survives_a_wiped_replica() {
        // Rotating the profile namespace stops every friend receiving our profile edits, the same
        // way rotating the trail one stops them receiving fixes. See `crate::ns_book`.
        let state = crate::docs::tests::scratch_dir("profile-book-state");
        let open_book = || {
            Some(Arc::new(
                NamespaceBook::open(&state, ns_book::PROFILE_BOOK_FILE).unwrap(),
            ))
        };
        let first = crate::docs::tests::scratch_dir("profile-book-a");
        let fx = crate::docs::tests::spawn_docs(&first).await;
        let ns = ProfileDocs::init(
            fx.docs.clone(),
            fx.blobs.clone(),
            first.clone(),
            open_book(),
        )
        .await
        .unwrap()
        .own_ns;
        let wiped = crate::docs::tests::scratch_dir("profile-book-b");
        let fx2 = crate::docs::tests::spawn_docs(&wiped).await;
        let again = ProfileDocs::init(
            fx2.docs.clone(),
            fx2.blobs.clone(),
            wiped.clone(),
            open_book(),
        )
        .await
        .unwrap();
        assert_eq!(again.own_ns, ns);
        for dir in [state, first, wiped] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn handed_record_is_readable_without_ever_replicating() {
        let (docs, dir) = live_profile("handed").await;
        let (seed, endpoint) = identity();

        assert!(docs.read_for_endpoint(&endpoint).await.unwrap().is_none());
        let rec = docs
            .ingest_handed_record(&signed_record(&seed, &endpoint, 4), &endpoint)
            .await
            .unwrap()
            .expect("a first record is new");
        assert_eq!(rec.epoch, 4);
        assert_eq!(
            docs.read_for_endpoint(&endpoint)
                .await
                .unwrap()
                .map(|r| r.epoch),
            Some(4),
            "the pair result reads through read_for_endpoint; the handed copy must satisfy it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn handed_record_must_belong_to_the_authenticated_peer() {
        let (docs, dir) = live_profile("handed-wrong-peer").await;
        let (seed, endpoint) = identity();
        let (_other_seed, other_endpoint) = identity();

        // A peer we authenticated as `other_endpoint` handing us a valid record belonging to
        // someone else: the signature is genuine, the binding is not.
        let err = docs
            .ingest_handed_record(&signed_record(&seed, &endpoint, 1), &other_endpoint)
            .await
            .unwrap_err();
        assert!(matches!(err, ProfileError::WrongEndpoint));
        assert!(docs
            .read_for_endpoint(&other_endpoint)
            .await
            .unwrap()
            .is_none());
        assert!(
            docs.read_for_endpoint(&endpoint).await.unwrap().is_none(),
            "a rejected record must not be cached under its own endpoint either"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn handed_record_obeys_the_monotonic_epoch_rule() {
        let (docs, dir) = live_profile("handed-epoch").await;
        let (seed, endpoint) = identity();

        docs.ingest_handed_record(&signed_record(&seed, &endpoint, 7), &endpoint)
            .await
            .unwrap()
            .expect("first accepted");
        // Replay of an older epoch: valid bytes, refused as an update, and — the part that
        // matters — it must not displace the newer persona already on screen.
        assert!(docs
            .ingest_handed_record(&signed_record(&seed, &endpoint, 3), &endpoint)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            docs.read_for_endpoint(&endpoint)
                .await
                .unwrap()
                .map(|r| r.epoch),
            Some(7)
        );
        // A genuine edit still lands.
        assert!(docs
            .ingest_handed_record(&signed_record(&seed, &endpoint, 8), &endpoint)
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            docs.read_for_endpoint(&endpoint)
                .await
                .unwrap()
                .map(|r| r.epoch),
            Some(8)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn tampered_handed_record_is_refused() {
        let (docs, dir) = live_profile("handed-tamper").await;
        let (seed, endpoint) = identity();
        let mut bytes = signed_record(&seed, &endpoint, 1);
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        assert!(docs.ingest_handed_record(&bytes, &endpoint).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn own_record_bytes_round_trips_what_we_published() {
        let (docs, dir) = live_profile("own-bytes").await;
        let (seed, endpoint) = identity();

        assert!(
            docs.own_record_bytes().await.is_none(),
            "a device that has never published sends no record"
        );
        let bytes = signed_record(&seed, &endpoint, 2);
        docs.publish(&endpoint, 2, bytes.clone()).await.unwrap();
        // Byte-identical, because what goes on the Accept has to be exactly what was signed.
        assert_eq!(docs.own_record_bytes().await.as_deref(), Some(&bytes[..]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── A profile record whose bytes never arrived ───────────────────────────────────────────

    /// A profile replica that serves what it holds: blobs and docs behind a router, as on a node.
    struct ServedProfile {
        docs: ProfileDocs,
        endpoint: iroh::Endpoint,
        _router: iroh::protocol::Router,
    }

    async fn served_profile(
        dir: &std::path::Path,
        book: Option<Arc<NamespaceBook>>,
    ) -> ServedProfile {
        use iroh::{Endpoint, RelayMode, SecretKey};
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(SecretKey::generate())
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .expect("bind test endpoint");
        let gossip = iroh_gossip::net::Gossip::builder().spawn(endpoint.clone());
        let blobs = iroh_blobs::store::fs::FsStore::load(dir.join("blobs"))
            .await
            .expect("load test blobs");
        let docs = iroh_docs::protocol::Docs::persistent(dir.to_path_buf())
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await
            .expect("spawn test docs");
        let router = iroh::protocol::Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip)
            .accept(
                iroh_blobs::ALPN,
                iroh_blobs::BlobsProtocol::new(&blobs, None),
            )
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();
        let profile = ProfileDocs::init(docs, (*blobs).clone(), dir.to_path_buf(), book)
            .await
            .expect("init profile");
        // A read ticket carries only the direct addresses with no relay, which take a moment.
        for _ in 0..200 {
            if !endpoint.addr().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        ServedProfile {
            docs: profile,
            endpoint,
            _router: router,
        }
    }

    #[derive(Default)]
    struct Collected(std::sync::Mutex<Vec<ProfileRecord>>);

    impl ProfileSink for Collected {
        fn on_profile_update(&self, record: ProfileRecord) {
            self.0.lock().unwrap().push(record);
        }
    }

    /// The trail's 2026-11-10 incident, on a profile. The reader reconciles a friend's profile
    /// record from a peer that does not hold the bytes yet, so the docs engine's one download
    /// attempt fails; the bytes then land on that peer without a `ContentReady`. Before the settle
    /// pass the friend's name and sigil never updated. Here the only source offered is the
    /// friend's own phone, taken from the read ticket in the reader's book.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_profile_reconciled_before_its_bytes_is_fetched_once_they_land() {
        let w_dir = crate::docs::tests::scratch_dir("stranded-profile-writer");
        let r_dir = crate::docs::tests::scratch_dir("stranded-profile-reader");
        let r_state = crate::docs::tests::scratch_dir("stranded-profile-reader-state");
        let writer = served_profile(&w_dir, None).await;
        let book = Arc::new(NamespaceBook::open(&r_state, ns_book::PROFILE_BOOK_FILE).unwrap());
        let reader = served_profile(&r_dir, Some(book)).await;

        let (seed, endpoint) = identity();
        let bytes = signed_record(&seed, &endpoint, 5);
        let hash = Hash::new(&bytes);
        let doc = writer.docs.doc_for(writer.docs.own_ns).await.unwrap();
        doc.set_hash(
            writer.docs.author,
            PROFILE_KEY.to_vec(),
            hash,
            bytes.len() as u64,
        )
        .await
        .unwrap();
        writer.docs.arm_publishing().await.unwrap();

        let ticket = writer.docs.ticket().await.unwrap();
        let ns = reader.docs.import_ticket(&ticket).await.unwrap();
        for _ in 0..600 {
            if !reader.docs.stranded_entries().await.unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let stranded = reader.docs.stranded_entries().await.unwrap();
        assert_eq!(stranded.len(), 1, "the record arrives without its bytes");
        assert_eq!(stranded[0].namespace, ns.to_bytes());
        assert_eq!(stranded[0].key, PROFILE_KEY.to_vec());
        assert_eq!(stranded[0].hash, hash);

        // The bytes land on the serving peer out-of-band; nothing in iroh-docs asks again.
        writer.docs.blobs.add_bytes(bytes.clone()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(reader.docs.read_latest(ns, None).await.unwrap().is_none());

        let sink = Collected::default();
        let report = reader
            .docs
            .settle_stranded(
                &reader.endpoint,
                &[],
                &HashMap::new(),
                None,
                Some(&sink as &dyn ProfileSink),
            )
            .await
            .unwrap();
        assert_eq!(
            report,
            ProfileSettleReport {
                stranded: 1,
                fetched: 1,
                updated: 1,
            }
        );
        let delivered = sink.0.lock().unwrap().clone();
        assert_eq!(delivered.len(), 1, "the app is told");
        assert_eq!(delivered[0].epoch, 5);
        assert_eq!(
            reader
                .docs
                .read_for_endpoint(&endpoint)
                .await
                .unwrap()
                .map(|r| r.epoch),
            Some(5)
        );

        // Nothing stranded is a cheap no-op.
        let again = reader
            .docs
            .settle_stranded(
                &reader.endpoint,
                &[],
                &HashMap::new(),
                None,
                Some(&sink as &dyn ProfileSink),
            )
            .await
            .unwrap();
        assert_eq!(again, ProfileSettleReport::default());
        assert_eq!(sink.0.lock().unwrap().len(), 1);

        for dir in [w_dir, r_dir, r_state] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
