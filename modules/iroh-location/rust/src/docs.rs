//! Durable **last-write-wins** fix path — the iroh-docs half of the location core.
//!
//! See `docs/social/ARCHITECTURE.md` §2, §5–6 and `docs/social/FORWARD-SECRECY.md` §4.4.
//! Alongside the live iroh-gossip broadcast (in [`crate`]'s
//! [`Subscription`](crate::Subscription)), the current fix is *also* written to a replicated
//! iroh-docs namespace under a **single key per author** (`hex(author)/fix`), each write
//! superseding the last. There is deliberately no durable history: the replica answers
//! "where is this friend now", never "where have they been" — offline recovery of missed
//! fixes was removed with the forward-secrecy work. Because docs stores the **exact same
//! sealed envelope bytes** as gossip (see [`crate::crypto`]), per-recipient revocation
//! carries over unchanged: a dropped recipient may keep replicating the ciphertext but has
//! no wrap, so the bytes are opaque to it.
//!
//! ## What lives here
//! * [`TrailDocs`] — wraps the persistent `Docs` replica store (own namespace + imported
//!   friend namespaces) and the iroh-blobs content store the entries point at.
//! * **Pure** helpers ([`encode_key`], [`decode_key`], [`encode_ctl_key`],
//!   [`keys_to_prune`]) holding the key-encoding and explicit-pruning logic, covered by
//!   `#[cfg(test)]` without a live iroh node.
//!
//! Superseded versions of an overwritten key still exist in the replica (same reason
//! `single_latest_per_key` is load-bearing for control messages) — reclaiming them is the
//! retention work of FORWARD-SECRECY.md §5.1/§7 step 2, not this module's keying.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use iroh::EndpointAddr;
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
use n0_future::time::{timeout, Duration, Instant};
use n0_future::StreamExt;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::crypto;

#[cfg(feature = "cli")]
use iroh_docs::{
    actor::{OpenOpts, SyncHandle},
    net::connect_and_sync,
    store::{DownloadPolicy, Store as DocsStore},
    DocTicket,
};

/// Stop a reconciliation after this many seconds without a new event (peer likely unreachable),
/// so `sync_all` always returns instead of hanging on a stalled connection.
const SYNC_IDLE_TIMEOUT_SECS: u64 = 8;

/// How long to wait for the *first* event of a reconciliation. Deliberately much longer than
/// [`SYNC_IDLE_TIMEOUT_SECS`]: a cold headless node has to bring up its endpoint, run net_report,
/// and either hole-punch or fall back to a relay before it can talk to the stash at all — on
/// cellular that routinely exceeds 8s, and bailing there meant the periodic backfill gave up
/// before the connection existed. Once events are flowing, the shorter idle gap applies.
const SYNC_FIRST_EVENT_TIMEOUT_SECS: u64 = 25;

/// Upper bound on a single namespace's push. `push` only needs `SyncFinished`, not a full drain,
/// but a peer that connects and then stalls would otherwise hold a headless context open.
const PUSH_TIMEOUT_SECS: u64 = 30;

/// Key separator between the hex author and the zero-padded sequence number.
pub const KEY_SEP: u8 = b'/';

/// Filename (under `data_dir`) holding the persisted trail `NamespaceId`, so our own trail
/// namespace is stable across [`crate::LocationNode`] restarts even though iroh-docs mints a
/// fresh namespace on `create()`. Mirrors [`crate::profile::PROFILE_NS_FILE`]; without it a
/// restart would orphan every friend's stored trail read-ticket (durable/stash backfill would
/// silently break while the live gossip path kept working).
pub const TRAIL_NS_FILE: &str = "trail-namespace.bin";

/// Read a persisted 32-byte namespace id from `path`, or `None` if absent / malformed. Lives
/// here (shared by both the native and wasm crates via `#[path]`) rather than in `profile`,
/// which is native-only. On wasm there is no real filesystem, so the read simply yields `None`
/// and a fresh namespace is minted each time — correct for the ephemeral in-memory store there.
pub fn read_ns_file(path: &Path) -> Option<[u8; 32]> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut id = [0u8; 32];
    id.copy_from_slice(&bytes);
    Some(id)
}

/// Persist a 32-byte namespace id to `path` (best-effort; creates parent dirs). Failures are
/// swallowed by callers, so an unwritable/absent filesystem (e.g. wasm) is a no-op.
pub fn write_ns_file(path: &Path, id: &[u8; 32]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, id)
}

// ── Pure, unit-testable helpers ─────────────────────────────────────────────────────────

/// Lowercase-hex encode bytes (no external dep, so it round-trips with [`hex_decode`]).
fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Decode a lowercase/uppercase hex string back into bytes. Returns `None` on odd length or
/// a non-hex digit.
fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Some(out)
}

/// Literal trailing segment of the single per-author fix key.
pub const FIX_TAG: &str = "fix";

/// Encode the **single last-write-wins** docs key holding `author`'s current fix:
/// `hex(author)/fix`.
///
/// The envelope `seq` deliberately left the key (FORWARD-SECRECY.md §4.4): it stays inside the
/// signed envelope for replay rejection, but the replica holds one overwritten slot per author —
/// structurally identical to the control-message path — so there is no durable history to key.
pub fn encode_key(author: &[u8]) -> Vec<u8> {
    let mut key = hex_encode(author).into_bytes();
    key.push(KEY_SEP);
    key.extend_from_slice(FIX_TAG.as_bytes());
    key
}

/// Decode a key produced by [`encode_key`] back into the author bytes.
///
/// Returns `None` for a control key (see [`encode_ctl_key`]: the literal `ctl` lead is not valid
/// hex) and for pre-LWW `hex(author)/{seq:020}` keys left in a replica by older builds — their
/// history is deliberately invisible to current readers.
pub fn decode_key(key: &[u8]) -> Option<Vec<u8>> {
    let pos = key.iter().position(|&b| b == KEY_SEP)?;
    if &key[pos + 1..] != FIX_TAG.as_bytes() {
        return None;
    }
    let author_hex = std::str::from_utf8(&key[..pos]).ok()?;
    hex_decode(author_hex)
}

/// Literal leading segment marking a **control** entry rather than a location fix.
///
/// Control entries (live-mode requests — ARCHITECTURE §9c) are written to the author's OWN
/// namespace next to their fix slot, but must never be mistaken for one. The `ctl` lead gives
/// that for free: [`decode_key`] rejects `"ctl"` as a hex author, so every fix reader skips
/// control entries without change. Chosen deliberately over a `hex(author)/ctl` layout, which
/// would share the fix key's author prefix and force every reader to filter.
pub const CTL_TAG: &str = "ctl";

/// Encode a control entry key as `ctl/hex(author)` — deliberately **one slot per author**.
///
/// Unlike fixes, control entries carry no history: re-writing the key supersedes the previous
/// message, so the replica holds exactly one per author forever rather than accumulating a row
/// per live-mode request that every poll would then re-read and the stash would replicate for
/// good. Latest-wins is also the right semantics — "I want to watch you now" and "cancel" both
/// describe the current intent, so a superseded request is never one we wanted to act on.
/// Replay/dedup identity lives in the payload's nonce + ts, not in the key.
pub fn encode_ctl_key(author: &[u8]) -> Vec<u8> {
    let mut key = CTL_TAG.as_bytes().to_vec();
    key.push(KEY_SEP);
    key.extend_from_slice(hex_encode(author).as_bytes());
    key
}

// No `decode_ctl_key`: control entries are fetched by exact key (see `TrailDocs::read_ctl`), so
// nothing needs the inverse. The invariant that matters — that fix readers cannot see these keys
// — is asserted in `fix_readers_ignore_control_keys` below.

/// Literal leading segment marking a **null fix** — a watcher's cadence keep-alive
/// (FORWARD-SECRECY.md §4.1) rather than a position.
///
/// Null fixes need their own slot because the durable path is last-write-wins with exactly one
/// fix key per author (§4.4), and the two lanes are wrapped for *disjoint* recipient sets: the
/// fix lane for the friends we share position with, the null lane for the friends we do not.
/// Sharing one slot would mean each tick's second envelope silently supersedes the first, so a
/// device that both shares and watches could never keep both lanes durable.
///
/// Like [`CTL_TAG`], the `nul` lead is not valid hex, so [`decode_key`] rejects it and every fix
/// reader skips null entries without change.
pub const NUL_TAG: &str = "nul";

/// Encode the null-fix key as `nul/hex(author)` — one overwritten slot per author.
///
/// Latest-wins is the right semantics here for the same reason as the fix lane: a null fix
/// carries no position and no history, only the sender's current ratchet contribution (§4.1), and
/// only the most recent one is ever of use.
pub fn encode_nul_key(author: &[u8]) -> Vec<u8> {
    let mut key = NUL_TAG.as_bytes().to_vec();
    key.push(KEY_SEP);
    key.extend_from_slice(hex_encode(author).as_bytes());
    key
}

/// Decode a key produced by [`encode_nul_key`] back into the author bytes.
///
/// The mirror of [`decode_key`] for the null lane. Both are needed by
/// [`TrailDocs::read_latest_sealed`], which must return the two lanes and no others: the control
/// and resync lanes are not fix envelopes and would fail `verify_v3` anyway, but skipping them by
/// key is cheaper and states the intent.
pub fn decode_nul_key(key: &[u8]) -> Option<Vec<u8>> {
    let pos = key.iter().position(|&b| b == KEY_SEP)?;
    if &key[..pos] != NUL_TAG.as_bytes() {
        return None;
    }
    let author_hex = std::str::from_utf8(&key[pos + 1..]).ok()?;
    hex_decode(author_hex)
}

/// Note one delivered entry against the author it belongs to. Pure, so the newest-wins rule is
/// testable without a live reconciliation.
///
/// Non-fix keys (control, resync, pre-LWW) are ignored: those lanes are not what "delivered a
/// friend's location" means, and attributing a fix to the peer that happened to hand over a live
/// mode request would be a plausible-looking lie.
fn record_serving_peer(
    peers: &mut HashMap<[u8; 32], ServingPeer>,
    key: &[u8],
    peer: [u8; 32],
    entry_ts: u64,
) {
    let Some(author) = decode_key(key).or_else(|| decode_nul_key(key)) else {
        return;
    };
    let Ok(author): Result<[u8; 32], _> = author.as_slice().try_into() else {
        return;
    };
    let entry = peers
        .entry(author)
        .or_insert(ServingPeer { peer, entry_ts });
    if entry_ts >= entry.entry_ts {
        *entry = ServingPeer { peer, entry_ts };
    }
}

/// Literal leading segment marking a **resync record** (FORWARD-SECRECY.md §4.6).
///
/// Its own lane rather than the control lane, for the same reason the null fix needed one: both
/// are one overwritten slot per author, and a resync record sharing a slot with a live-mode
/// request would mean asking to watch someone cancels your attempt to re-establish a session
/// with them. Not valid hex, so fix readers skip it.
pub const RSY_TAG: &str = "rsy";

/// Encode the resync key as `rsy/hex(author)` — **one slot per author, not per pair**.
///
/// Deliberately not keyed by peer. A per-pair key would put the peer's endpoint id in a doc key
/// the stash replicates in clear, handing it the author's entire friend list — the §1.1 leak
/// that §4.7's rotating kids exist to close, reintroduced through the back door. One slot works
/// because a single fresh ephemeral serves every peer at once: each peer's root is
/// `KDF(DH(eph_ours, eph_theirs), transcript)`, so the transcript separates them even though our
/// half is shared. The record is wrapped per recipient, so only intended peers can read it.
pub fn encode_rsy_key(author: &[u8]) -> Vec<u8> {
    let mut key = RSY_TAG.as_bytes().to_vec();
    key.push(KEY_SEP);
    key.extend_from_slice(hex_encode(author).as_bytes());
    key
}

/// Explicit-pruning selection: given `(key, entry_ts)` pairs, return the keys whose entry is
/// **strictly older** than `older_than_ts` and should be pruned.
pub fn keys_to_prune(entries: &[(Vec<u8>, u64)], older_than_ts: u64) -> Vec<Vec<u8>> {
    entries
        .iter()
        .filter(|(_, ts)| *ts < older_than_ts)
        .map(|(key, _)| key.clone())
        .collect()
}

// ── Live-node wrapper ───────────────────────────────────────────────────────────────────

/// The latest decrypted fix for one author, read from the durable replica. `payload` is the
/// still-encoded [`crate::LocationFix`] bytes — the caller (lib.rs) owns the postcard decode so
/// this module stays decoupled from the UniFFI record type. `author`/`seq` come from the opened
/// envelope (signed), not from the docs key.
#[derive(Debug, Clone)]
pub struct LatestFix {
    pub author: Vec<u8>,
    pub seq: u64,
    /// Decrypted fix bytes. Zeroizing so a friend's coordinates are scrubbed when this drops
    /// rather than left in freed heap; see [`crypto::Opened::payload`].
    pub payload: Zeroizing<Vec<u8>>,
}

/// One author's fix slot as it exists in the LOCAL durable replica — presence, never payload.
///
/// The answer to "can this device serve author X", which is a different question from "has this
/// device seen author X's fix" (see [`TrailDocs::replica_status`]). Deliberately carries no
/// location data, so it needs no decrypt and no gate: `seq`/`fix_ts` are lifted from the
/// envelope's signed plaintext header, and are `0` when `has_content` is false because there was
/// no envelope to read them from.
#[derive(Debug, Clone)]
pub struct ReplicaSlot {
    pub author: Vec<u8>,
    pub seq: u64,
    pub fix_ts: u64,
    pub has_content: bool,
}

/// What one pass of [`TrailDocs::upload_own_latest`] actually managed to hand the stash.
///
/// Four outcomes rather than a count, because "nothing uploaded" has four causes that call for
/// opposite responses and used to be indistinguishable — the loop reported the first failure and
/// abandoned the rest, so the numbers never existed to tell them apart. `untracked` is the
/// expected steady state for a slot the stash has not reconciled yet; `transport_failed` is the
/// only one that says anything about the stash being reachable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContentUploadReport {
    /// Slots the stash accepted and can now serve.
    pub uploaded: u64,
    /// Slots the stash is not tracking yet (`404`/`409`) — its entry has not reconciled in.
    pub untracked: u64,
    /// Slots whose bytes are no longer in the local blob store, so there was nothing to offer.
    pub unreadable: u64,
    /// Slots that failed for a reason that is about the stash, not the slot.
    pub transport_failed: u64,
}

/// What one [`TrailDocs::push`] actually reconciled, across every peer it was given.
///
/// Previously this was a bare `entries_sent` taken from the **first** `SyncFinished` to arrive,
/// which made the number close to meaningless with more than one peer: whichever peer happened to
/// finish first decided the answer, and the stash — usually already up to date — reported `0`
/// while entries were moving to the others. The documented cookbook query
/// `{ name = "trail.push" && span.entries_sent > 0 }` therefore matched almost nothing on a
/// healthy fleet, which is worse than no signal.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PushReport {
    /// Entries handed to peers, summed over every peer that finished.
    pub entries_sent: u64,
    /// Peers that completed a reconciliation.
    pub peers_finished: usize,
    /// Peers that reported an error instead — unreachable, or refused.
    pub peers_failed: usize,
}

/// Who served an author's slot in the most recent reconciliation that carried it.
///
/// `entry_ts` is the docs record timestamp, kept so a burst of `InsertRemote`s for the same author
/// (one lane after the other, or two peers finishing at once) settles on the newest entry rather
/// than the last event polled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ServingPeer {
    peer: [u8; 32],
    entry_ts: u64,
}

/// Wraps an iroh-docs replica: our own namespace (we are its sole writer) plus any friend
/// namespaces we've imported for replication + reads.
pub struct TrailDocs {
    docs: Docs,
    blobs: BlobsStore,
    /// The node-wide docs author we sign entries with (distinct from the envelope `author`,
    /// which is the ed25519 EndpointId encoded into the key).
    author: AuthorId,
    /// Our own trail namespace — the one we write to.
    own_ns: NamespaceId,
    /// All docs we can read (own + imported friends), keyed by namespace bytes.
    handles: Mutex<HashMap<[u8; 32], Doc>>,
    /// Per envelope-author, the peer that last handed us their entry during a reconciliation.
    ///
    /// Keyed by author rather than by namespace because that is the question the UI asks — "who
    /// delivered Maya's fix" — and because a namespace has exactly one writer but any number of
    /// peers willing to serve it. Bounded by the pool size: one slot per author we replicate.
    ///
    /// Deliberately in-memory and delivery-scoped. An entry already in the replica produces no
    /// `InsertRemote`, so a read after a quiet sync reports no peer — which is the truth: nobody
    /// delivered it this time.
    serving_peers: Mutex<HashMap<[u8; 32], ServingPeer>>,
}

impl TrailDocs {
    /// Initialise from an already-spawned [`Docs`] protocol + its backing blobs store.
    ///
    /// Reuses the persisted trail namespace under `data_dir` when possible (stable across
    /// restarts), otherwise creating a new one and persisting its id. iroh-docs mints a fresh
    /// namespace on every `create()`, so without this a restart would rotate our trail namespace
    /// and orphan every friend's stored read-ticket (see [`TRAIL_NS_FILE`]). Mirrors
    /// [`crate::profile::ProfileDocs::init`]. The caller is responsible for having registered the
    /// `Docs`/`Blobs`/`Gossip` protocols on the iroh [`Router`](iroh::protocol::Router).
    pub async fn init(docs: Docs, blobs: BlobsStore, data_dir: PathBuf) -> Result<Self> {
        let author = docs.author_default().await?;
        let ns_path = data_dir.join(TRAIL_NS_FILE);

        // Reopen the persisted namespace if we have one and it's still in the local store;
        // otherwise fall through to minting + persisting a fresh one.
        let doc = match read_ns_file(&ns_path) {
            Some(id) => match docs.open(NamespaceId::from(id)).await {
                Ok(Some(doc)) => Some(doc),
                _ => None,
            },
            None => None,
        };
        let own = match doc {
            Some(doc) => doc,
            None => {
                let doc = docs.create().await?;
                // Best-effort persist; a failure just means we mint a fresh ns next boot.
                let _ = write_ns_file(&ns_path, &doc.id().to_bytes());
                doc
            }
        };
        let own_ns = own.id();
        let mut handles = HashMap::new();
        handles.insert(own_ns.to_bytes(), own);
        Ok(Self {
            docs,
            blobs,
            author,
            own_ns,
            handles: Mutex::new(handles),
            serving_peers: Mutex::new(HashMap::new()),
        })
    }

    /// Our own trail namespace id.
    pub fn own_namespace(&self) -> NamespaceId {
        self.own_ns
    }

    /// Upload every current slot in our namespace to the stash's authenticated opaque-content API.
    ///
    /// **Per-slot outcomes, never a batch abort.** The stash only accepts content for a
    /// `(namespace, hash)` pair it already holds the *entry* for — the record arrives by
    /// reconciliation, the bytes by this call, and the two are separate transfers. A slot whose
    /// entry has not reached the stash yet is therefore answered `404`, and that is an ordinary,
    /// self-correcting state rather than a failure of this upload.
    ///
    /// It stopped being ordinary when one such slot aborted the whole loop: `single_latest_per_key`
    /// yields the fix lane and the null lane together, so a single permanently-unreconciled slot
    /// sat at the front of the iteration and every *newer* slot behind it was never offered. The
    /// phone reported `trail push failed` on every tick, always naming the same hash, while the
    /// fixes an offline friend actually needed sat locally with their bytes never pushed. Skipping
    /// is the whole fix: the entry either reconciles later and the next tick uploads it, or it
    /// never does and it was never deliverable anyway.
    ///
    /// Transport failures are different in kind — an unreachable or refusing stash is not a
    /// property of one slot — so they are counted and the last one is returned once the loop has
    /// still given every slot a chance. That keeps `trail.push.app` reporting a genuine stash
    /// outage while no longer reporting a backlog of untracked slots as one.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn upload_own_latest(
        &self,
        base_url: &str,
        psk: Option<&str>,
    ) -> Result<ContentUploadReport> {
        let doc = self.doc_for(self.own_ns).await?;
        let stream = doc.get_many(Query::single_latest_per_key().build()).await?;
        tokio::pin!(stream);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        let namespace = hex_encode(self.own_ns.as_bytes());
        let mut report = ContentUploadReport::default();
        let mut last_transport_error: Option<anyhow::Error> = None;
        while let Some(entry) = stream.next().await {
            let entry = entry?;
            if entry.content_len() == 0 {
                continue;
            }
            let hash = entry.content_hash();
            // A slot whose bytes we no longer hold cannot be offered, and cannot be fixed by
            // retrying it: skip it rather than failing the slots that follow.
            let bytes = match self.blobs.blobs().get_bytes(hash).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    tracing::warn!(
                        hash = %crate::telemetry::short_hex(hash.as_bytes()),
                        error = %error,
                        "trail content upload: local bytes are gone for this slot; skipping"
                    );
                    report.unreadable += 1;
                    continue;
                }
            };
            let request = client
                .put(format!(
                    "{}/v1/namespaces/{namespace}/content/{hash}",
                    base_url.trim_end_matches('/')
                ))
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(bytes);
            let request = match psk {
                Some(psk) => request.bearer_auth(psk),
                None => request,
            };
            let send = || async {
                request
                    .try_clone()
                    .expect("byte-backed request is cloneable")
                    .send()
                    .await
            };
            let mut response = match send().await {
                Ok(response) => response,
                Err(error) => {
                    report.transport_failed += 1;
                    last_transport_error = Some(error.into());
                    continue;
                }
            };
            // The entry may still be in flight to the stash; a short retry covers that race
            // without turning a genuinely untracked slot into a stall.
            for _ in 0..4 {
                if response.status() != reqwest::StatusCode::NOT_FOUND {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                match send().await {
                    Ok(next) => response = next,
                    Err(error) => {
                        report.transport_failed += 1;
                        last_transport_error = Some(error.into());
                        break;
                    }
                }
            }
            let status = response.status();
            if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::CONFLICT {
                // 404: this stash has no entry for the pair (or does not know the namespace).
                // 409: newer stashes say "known namespace, untracked hash" specifically. Both mean
                // the record has not landed yet, which the next reconciliation may fix.
                tracing::debug!(
                    hash = %crate::telemetry::short_hex(hash.as_bytes()),
                    status = status.as_u16(),
                    "trail content upload: stash is not tracking this slot yet; skipping"
                );
                report.untracked += 1;
                continue;
            }
            match response.error_for_status() {
                Ok(_) => report.uploaded += 1,
                Err(error) => {
                    report.transport_failed += 1;
                    last_transport_error = Some(error.into());
                }
            }
        }
        // Only a transport problem is worth failing the push over, and only when it stopped us
        // getting anything at all through — a partial upload still moved fixes off the phone.
        if report.uploaded == 0 {
            if let Some(error) = last_transport_error {
                return Err(error);
            }
        }
        Ok(report)
    }

    /// Fetch a cached [`Doc`] handle for `ns`, or open it from the local replica store.
    async fn doc_for(&self, ns: NamespaceId) -> Result<Doc> {
        if let Some(doc) = self.handles.lock().await.get(&ns.to_bytes()).cloned() {
            return Ok(doc);
        }
        let doc = self
            .docs
            .open(ns)
            .await?
            .ok_or_else(|| anyhow!("namespace not found in local replica"))?;
        self.handles.lock().await.insert(ns.to_bytes(), doc.clone());
        Ok(doc)
    }

    /// The peer that last served `author`'s slot in a reconciliation, if one did.
    ///
    /// `None` is an ordinary answer, not a failure: it means no entry for that author was
    /// *delivered* into this replica (nothing new to reconcile, or the process was restarted since
    /// it was). A caller may only ever say "this peer handed it over", never "no-one did".
    pub async fn serving_peer(&self, author: &[u8]) -> Option<[u8; 32]> {
        let key: [u8; 32] = author.try_into().ok()?;
        self.serving_peers.lock().await.get(&key).map(|s| s.peer)
    }

    /// Import a friend's trail from their docs read-ticket and begin replicating it. Returns the
    /// imported namespace id. Wired to `LocationNode::import_doc_ticket`, called on friend add
    /// (the read side of a grant, ARCHITECTURE §6).
    pub async fn import_ticket(&self, ticket: &str) -> Result<NamespaceId> {
        let ticket: iroh_docs::DocTicket = ticket.parse().map_err(|e| anyhow!("{e}"))?;
        let doc = self.docs.import(ticket).await?;
        let ns = doc.id();
        self.handles.lock().await.insert(ns.to_bytes(), doc);
        Ok(ns)
    }

    /// Write a sealed envelope to `ns` under the author's single LWW key (FORWARD-SECRECY §4.4),
    /// superseding the previous fix. `envelope` must be the identical bytes broadcast on gossip
    /// so revocation carries over.
    pub async fn write(&self, ns: NamespaceId, author: &[u8], envelope: Vec<u8>) -> Result<()> {
        let doc = self.doc_for(ns).await?;
        doc.set_bytes(self.author, encode_key(author), envelope)
            .await?;
        Ok(())
    }

    /// Write a sealed **control** envelope to `ns` under `ctl/hex(author)` (ARCHITECTURE §9c).
    ///
    /// Same sealing as a fix — the payload is a `ControlMsg`, not a `LocationFix`, and is wrapped
    /// only for the recipient it addresses, so the stash and every other pool member see opaque
    /// bytes. Writers use their OWN namespace: a user is the sole writer of their trail, and the
    /// recipient already replicates it, so this needs no new grant or transport.
    pub async fn write_ctl(&self, ns: NamespaceId, author: &[u8], envelope: Vec<u8>) -> Result<()> {
        let doc = self.doc_for(ns).await?;
        doc.set_bytes(self.author, encode_ctl_key(author), envelope)
            .await?;
        Ok(())
    }

    /// Write a sealed **null fix** to `ns` under `nul/hex(author)` (FORWARD-SECRECY §4.1).
    ///
    /// Identical sealing to a fix — the plaintext is an empty padded frame, so the envelope is
    /// byte-for-byte the same length as a real one and the stash cannot tell the lanes apart by
    /// ciphertext size. The separate key is what keeps this from superseding the fix lane; see
    /// [`encode_nul_key`].
    pub async fn write_nul(&self, ns: NamespaceId, author: &[u8], envelope: Vec<u8>) -> Result<()> {
        let doc = self.doc_for(ns).await?;
        doc.set_bytes(self.author, encode_nul_key(author), envelope)
            .await?;
        Ok(())
    }

    /// Read + decrypt `author`'s current control entry across **every** known namespace.
    ///
    /// Returns at most one payload per namespace holding one (normally exactly one, in the
    /// author's own namespace). Entries we cannot open are skipped — a control message addressed
    /// to someone else is indistinguishable from noise, by design. No `since_ts` filtering here:
    /// the payload is a `ControlMsg`, so freshness is the caller's to judge after decoding.
    pub async fn read_ctl(
        &self,
        author: &[u8],
        recv_secret: &[u8],
    ) -> Result<Vec<Zeroizing<Vec<u8>>>> {
        let namespaces: Vec<NamespaceId> = {
            let handles = self.handles.lock().await;
            handles.keys().map(|b| NamespaceId::from(*b)).collect()
        };
        let key = encode_ctl_key(author);
        let mut out = Vec::new();
        for ns in namespaces {
            let doc = self.doc_for(ns).await?;
            // `single_latest_per_key` is load-bearing: the control key is overwritten in place, so
            // superseded versions still exist in the replica and a plain query would resurrect a
            // cancelled request. Same shape as `profile::read_latest`.
            let query = Query::single_latest_per_key()
                .key_exact(key.clone())
                .build();
            let entry = match doc.get_one(query).await? {
                Some(e) => e,
                None => continue,
            };
            let bytes = match self.blobs.blobs().get_bytes(entry.content_hash()).await {
                Ok(b) => b,
                Err(_) => continue, // content not yet available locally
            };
            if let Ok(opened) = crypto::open(recv_secret, &bytes) {
                out.push(opened.payload);
            }
        }
        Ok(out)
    }

    /// Read the **still-sealed** current envelope per author from both fix lanes, across every
    /// known namespace.
    ///
    /// The v3 counterpart of [`Self::read_latest`]. Opening a ratcheted envelope needs the
    /// per-friend session state (FORWARD-SECRECY §4.7), which lives above this module — so this
    /// hands back bytes and lets the caller decide. Skipping the decrypt here also keeps the
    /// §4.2 ordering intact: the caller verifies the signature before any session state moves.
    ///
    /// **Both** the `hex(author)/fix` and `nul/hex(author)` lanes are returned, and that is
    /// load-bearing rather than convenient. §4.1's symmetric lanes only manufacture the
    /// bidirectionality forward secrecy needs if a watcher's null fix actually reaches the
    /// sharer's ratchet — a reader that skipped the null lane would never call `accept` for a
    /// watch-only friend, never move their `peer_advanced_ms`, and drop them as `Lapsed` at
    /// `T_lapse`. Every one-directional watch edge would die after a day.
    ///
    /// Our own outbound envelopes are included; the caller filters them by author, since it is
    /// the one that knows who we are.
    pub async fn read_latest_sealed(&self) -> Result<Vec<Vec<u8>>> {
        let mut out = Vec::new();
        for ns in self.namespaces().await {
            let doc = self.doc_for(ns).await?;
            let query = Query::single_latest_per_key().build();
            let stream = doc.get_many(query).await?;
            tokio::pin!(stream);
            while let Some(entry) = stream.next().await {
                let entry = entry?;
                let is_fix = decode_key(entry.key()).is_some();
                let is_null = decode_nul_key(entry.key()).is_some();
                if !is_fix && !is_null {
                    continue; // control entry, resync record, or pre-LWW key
                }
                match self.blobs.blobs().get_bytes(entry.content_hash()).await {
                    Ok(bytes) => out.push(bytes.to_vec()),
                    Err(_) => continue, // content not yet available locally
                }
            }
        }
        Ok(out)
    }

    /// Write a sealed **resync record** to `ns` under `rsy/hex(author)` (FORWARD-SECRECY §4.6).
    ///
    /// HPKE-sealed like a control message rather than ratcheted, necessarily: this is the message
    /// that re-establishes a ratchet, so it cannot depend on one existing.
    pub async fn write_rsy(&self, ns: NamespaceId, author: &[u8], envelope: Vec<u8>) -> Result<()> {
        let doc = self.doc_for(ns).await?;
        doc.set_bytes(self.author, encode_rsy_key(author), envelope)
            .await?;
        Ok(())
    }

    /// Read + decrypt `author`'s current resync record across every known namespace.
    ///
    /// Same shape as [`Self::read_ctl`], including the load-bearing `single_latest_per_key`: the
    /// slot is overwritten in place, so a plain query would resurrect a superseded record and
    /// walk the session backwards into a root the peer has already moved off.
    pub async fn read_rsy(
        &self,
        author: &[u8],
        recv_secret: &[u8],
    ) -> Result<Vec<Zeroizing<Vec<u8>>>> {
        let namespaces: Vec<NamespaceId> = {
            let handles = self.handles.lock().await;
            handles.keys().map(|b| NamespaceId::from(*b)).collect()
        };
        let key = encode_rsy_key(author);
        let mut out = Vec::new();
        for ns in namespaces {
            let doc = self.doc_for(ns).await?;
            let query = Query::single_latest_per_key()
                .key_exact(key.clone())
                .build();
            let entry = match doc.get_one(query).await? {
                Some(e) => e,
                None => continue,
            };
            let bytes = match self.blobs.blobs().get_bytes(entry.content_hash()).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            if let Ok(opened) = crypto::open(recv_secret, &bytes) {
                out.push(opened.payload);
            }
        }
        Ok(out)
    }

    /// Read + decrypt the **latest** fix per author across every known namespace (own + imported
    /// friends). Entries we cannot open (not addressed to us / revoked / our own outbound
    /// envelopes) and non-fix keys (control entries, pre-LWW keys) are silently skipped.
    ///
    /// `single_latest_per_key` is load-bearing here for the same reason as on the control path:
    /// the fix key is overwritten in place, so superseded versions still exist in the replica and
    /// a plain query would resurrect them.
    pub async fn read_latest(&self, recv_secret: &[u8]) -> Result<Vec<LatestFix>> {
        let mut out = Vec::new();
        for ns in self.namespaces().await {
            let doc = self.doc_for(ns).await?;
            let query = Query::single_latest_per_key().build();
            let stream = doc.get_many(query).await?;
            tokio::pin!(stream);
            while let Some(entry) = stream.next().await {
                let entry = entry?;
                if decode_key(entry.key()).is_none() {
                    continue; // control entry or pre-LWW key
                }
                let bytes = match self.blobs.blobs().get_bytes(entry.content_hash()).await {
                    Ok(b) => b,
                    Err(_) => continue, // content not yet available locally
                };
                if let Ok(opened) = crypto::open(recv_secret, &bytes) {
                    out.push(LatestFix {
                        author: opened.author.to_vec(),
                        seq: opened.seq,
                        payload: opened.payload,
                    });
                }
            }
        }
        Ok(out)
    }

    /// What this replica can **serve**, per author, across every known namespace — metadata only.
    ///
    /// `friend_latest` and the trail cache are APP storage: they are written by the live gossip
    /// lane too, so a fix that arrived over gossip is in them while the docs replica holds nothing
    /// (a pool member has a READ ticket and cannot write to the author's namespace). Reconciliation
    /// serves out of the replica, so "we have seen this author's fix" and "we can hand this
    /// author's fix to someone else" are genuinely different questions and only this one answers
    /// the second.
    ///
    /// **No decryption.** `seq` and `fix_ts` come from the envelope's signed-but-plaintext header
    /// via [`crypto::envelope_header`] — a signature check, not an unwrap — so this reports
    /// presence for every author in the replica including the ones whose payloads are not
    /// addressed to us. The fix lane only (`hex(author)/fix`); control, null and resync slots are
    /// not the thing a relay is asked to serve.
    ///
    /// `has_content` separates the ways a slot can be useless: `content_len() == 0`, a docs record
    /// whose blob never landed locally, and a blob that is not a readable signed envelope. In
    /// every one of them there is nothing to hand on, and reporting the slot as present would say
    /// "the transfer failed" when the truth is "the relay had nothing to give".
    pub async fn replica_status(&self) -> Result<Vec<ReplicaSlot>> {
        let mut out = Vec::new();
        for ns in self.namespaces().await {
            let doc = self.doc_for(ns).await?;
            // `single_latest_per_key`, as everywhere else: the fix slot is overwritten in place,
            // so a plain query would also report superseded versions.
            let query = Query::single_latest_per_key().build();
            let stream = doc.get_many(query).await?;
            tokio::pin!(stream);
            while let Some(entry) = stream.next().await {
                let entry = entry?;
                let author = match decode_key(entry.key()) {
                    Some(author) => author,
                    None => continue, // control, null, resync, or pre-LWW key
                };
                let bytes = if entry.content_len() == 0 {
                    None
                } else {
                    self.blobs
                        .blobs()
                        .get_bytes(entry.content_hash())
                        .await
                        .ok()
                };
                // Servable means "we hold an envelope we could hand over", so the header has to
                // parse and its signature has to check out. A blob that is present but not a
                // readable signed envelope is not something to relay, and reporting it as one
                // would turn a corrupt slot into a mysterious downstream failure.
                let header = bytes
                    .as_ref()
                    .and_then(|bytes| crypto::envelope_header(bytes).ok());
                out.push(ReplicaSlot {
                    // The SIGNED author, not the docs key. The key only records where the writer
                    // filed the entry; the header is what the author's signature covers. Falls
                    // back to the key only when there is no envelope to read, in which case the
                    // slot is reported as unservable anyway.
                    author: header.map(|h| h.author.to_vec()).unwrap_or(author),
                    seq: header.map(|h| h.seq).unwrap_or(0),
                    fix_ts: header.map(|h| h.ts).unwrap_or(0),
                    has_content: header.is_some(),
                });
            }
        }
        Ok(out)
    }

    /// Reconcile `ns` with `peers` and wait (bounded) for the exchange + content transfer to
    /// settle. Pull-only plumbing: decrypt/read happens afterwards via [`Self::read_latest`],
    /// so there is no per-entry surfacing and no sink.
    async fn sync_ns(&self, ns: NamespaceId, peers: Vec<EndpointAddr>) -> Result<()> {
        let doc = self.doc_for(ns).await?;
        let mut events = doc.subscribe().await?;
        doc.start_sync(peers).await?;

        // Bound the reconciliation: with no reachable peer `SyncFinished` may never arrive, which
        // would hang this call forever. The first event gets a longer grace period — a cold node's
        // dial (net_report + hole-punch or relay fallback) routinely outlasts the idle gap.
        let mut saw_event = false;
        loop {
            let wait = if saw_event {
                SYNC_IDLE_TIMEOUT_SECS
            } else {
                SYNC_FIRST_EVENT_TIMEOUT_SECS
            };
            match timeout(Duration::from_secs(wait), events.next()).await {
                // All reconciled entries have their content locally — the clean finish.
                Ok(Some(Ok(LiveEvent::PendingContentReady))) => break,
                // The one place a peer is named per entry. `read_latest_sealed` reads the replica
                // afterwards and cannot tell a freshly delivered slot from one that was already
                // there, so provenance has to be captured here, as it arrives.
                Ok(Some(Ok(LiveEvent::InsertRemote { from, entry, .. }))) => {
                    saw_event = true;
                    let mut peers = self.serving_peers.lock().await;
                    record_serving_peer(
                        &mut peers,
                        entry.key(),
                        *from.as_bytes(),
                        entry.timestamp(),
                    );
                }
                Ok(Some(Ok(_))) => saw_event = true,
                Ok(Some(Err(_))) | Ok(None) => break,
                Err(_) => break, // idle timeout — settle for what transferred
            }
        }
        Ok(())
    }

    /// Put `ns` into the iroh-docs live engine with `peers` and wait for one reconciliation to
    /// finish. Returns the number of entries we sent, or `None` when no `SyncFinished` landed
    /// before the deadline.
    ///
    /// This is the SEND half of the durable path and it is not optional: `write` only touches the
    /// local replica, and the live engine broadcasts a `LocalInsert` **only** for namespaces that
    /// `start_sync` has marked as syncing (`engine::live::on_replica_event`). A process that
    /// publishes without ever calling this — every headless background wake — leaves its envelopes
    /// on the phone forever, so an offline friend has nothing to reconcile from. Unlike [`Self::sync`]
    /// this does not decrypt anything: our own envelopes are sealed for our recipients, not for us.
    ///
    /// Calling it repeatedly is cheap: `start_sync` is a no-op once the namespace is already
    /// syncing, and the engine keeps broadcasting subsequent writes for the process's lifetime.
    pub async fn push(
        &self,
        ns: NamespaceId,
        peers: Vec<EndpointAddr>,
    ) -> Result<Option<PushReport>> {
        let doc = self.doc_for(ns).await?;
        let mut events = doc.subscribe().await?;
        let expected_peers = peers.len();
        doc.start_sync(peers).await?;

        // One overall budget rather than one per event. The old per-event timeout was harmless
        // while this returned at the first `SyncFinished`; now that it waits for the others, a
        // per-event bound would multiply by the peer count and blow a headless wake's budget.
        let deadline = Instant::now() + Duration::from_secs(PUSH_TIMEOUT_SECS);
        let mut report = PushReport::default();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match timeout(remaining, events.next()).await {
                Ok(Some(Ok(LiveEvent::SyncFinished(ev)))) => {
                    match &ev.result {
                        Ok(details) => {
                            report.entries_sent += details.entries_sent as u64;
                            report.peers_finished += 1;
                        }
                        Err(err) => {
                            // One unreachable peer isn't the end of the exchange — keep waiting
                            // for the others rather than reporting the whole push as done.
                            tracing::warn!(
                                peer = %ev.peer.fmt_short(),
                                error = %err,
                                "trail.push: reconciliation with peer failed"
                            );
                            report.peers_failed += 1;
                        }
                    }
                    // Every peer we dialled has now reported one way or the other.
                    if report.peers_finished + report.peers_failed >= expected_peers {
                        break;
                    }
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(err))) => return Err(err),
                // Stream ended or nothing more arrived in time. The namespace is still marked
                // syncing, so later writes in this process broadcast — we just cannot confirm the
                // peers that stayed silent.
                Ok(None) | Err(_) => break,
            }
        }
        if report.peers_finished == 0 && report.peers_failed == 0 {
            return Ok(None);
        }
        Ok(Some(report))
    }

    /// Perform one direct range-reconciliation exchange with `peer` without opening the namespace
    /// in the iroh-docs live engine. This deliberately avoids gossip membership and remembered
    /// useful peers, so the desktop observer has exactly one metadata and blob source: trail-stash.
    #[cfg(feature = "cli")]
    pub async fn sync_direct(
        &self,
        endpoint: &iroh::Endpoint,
        ticket: DocTicket,
        peer: EndpointAddr,
        stash_url: &str,
        stash_psk: Option<&str>,
    ) -> Result<Vec<Zeroizing<Vec<u8>>>> {
        eprintln!("[watch] creating metadata-only sync actor");
        let sync = SyncHandle::spawn(
            DocsStore::memory(),
            None,
            format!("stash-cli-{}", endpoint.id().fmt_short()),
        );
        eprintln!("[watch] importing trail capability");
        let namespace = sync.import_namespace(ticket.capability).await?;
        // The stash intentionally releases ciphertext for superseded entries while retaining their
        // signed docs records. Automatic download would request every historical hash and abort on
        // the first released blob. Reconcile metadata only, then fetch the latest retained slot for
        // each key explicitly below.
        sync.set_download_policy(namespace, DownloadPolicy::NothingExcept(Vec::new()))
            .await?;
        sync.open(namespace, OpenOpts::default().sync()).await?;
        eprintln!("[watch] reconciling metadata with stash");

        let result = async {
            let finished = connect_and_sync(endpoint, &sync, namespace, peer.clone(), None).await?;
            eprintln!("[watch] metadata reconciliation finished");
            if finished.peer != peer.id {
                return Err(anyhow!(
                    "direct trail sync expected {}, got {}",
                    peer.id.fmt_short(),
                    finished.peer.fmt_short()
                ));
            }

            let (tx, mut rx) = irpc::channel::mpsc::channel(256);
            sync.get_many(namespace, Query::single_latest_per_key().build(), tx)
                .await?;
            let mut out = Vec::new();
            while let Some(entry) = rx.recv().await? {
                let entry = entry?;
                if entry.content_len() == 0 || decode_key(entry.key()).is_none() {
                    continue;
                }
                let hash = entry.content_hash();
                let bytes = match self.blobs.blobs().get_bytes(hash).await {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        eprintln!(
                        "[watch] fetching latest retained blob {} through the stash receipt API",
                        crate::telemetry::short_hex(hash.as_bytes())
                    );
                        let namespace_hex = hex_encode(namespace.as_bytes());
                        let request = reqwest::Client::builder()
                            .timeout(std::time::Duration::from_secs(10))
                            .build()?
                            .get(format!(
                                "{}/v1/namespaces/{namespace_hex}/content/{hash}",
                                stash_url.trim_end_matches('/')
                            ));
                        let request = match stash_psk {
                            Some(psk) => request.bearer_auth(psk),
                            None => request,
                        };
                        let response = request.send().await?.error_for_status()?;
                        let bytes = response.bytes().await?;
                        if iroh_blobs::Hash::new(&bytes) != hash {
                            return Err(anyhow!("stash receipt returned bytes for the wrong hash"));
                        }
                        bytes
                    }
                };
                out.push(Zeroizing::new(bytes.to_vec()));
            }
            Ok(out)
        }
        .await;

        let shutdown = sync.shutdown().await.map(|_| ());
        let fixes = result?;
        shutdown?;
        Ok(fixes)
    }

    /// Explicitly prune entries in `ns` older than `older_than_ts`. Only
    /// entries we authored can be deleted; returns the number removed.
    ///
    /// TODO(units): iroh-docs `Entry::timestamp()` is the record write time; callers pass a
    /// threshold in the same clock. If the app wants to prune on the fix's own `ts`, decrypt-then-
    /// filter (only possible for our own trail) once the durable path is live-tested.
    pub async fn prune(&self, ns: NamespaceId, older_than_ts: u64) -> Result<u64> {
        let doc = self.doc_for(ns).await?;
        let query = Query::all().build();
        let stream = doc.get_many(query).await?;
        tokio::pin!(stream);
        let mut pairs: Vec<(Vec<u8>, u64)> = Vec::new();
        while let Some(entry) = stream.next().await {
            let entry = entry?;
            pairs.push((entry.key().to_vec(), entry.timestamp()));
        }
        let mut removed = 0u64;
        for key in keys_to_prune(&pairs, older_than_ts) {
            removed += doc.del(self.author, key).await? as u64;
        }
        Ok(removed)
    }

    /// A shareable docs **read**-ticket granting replication of `ns` (the swarm-join half of a
    /// grant — the decrypt half is registering the friend's recvPub). Goes in the contact card.
    pub async fn read_ticket(&self, ns: NamespaceId) -> Result<String> {
        let doc = self.doc_for(ns).await?;
        let ticket = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await?;
        Ok(ticket.to_string())
    }

    /// All namespaces we can read (own + imported friends).
    pub async fn namespaces(&self) -> Vec<NamespaceId> {
        self.handles
            .lock()
            .await
            .keys()
            .map(|b| NamespaceId::from(*b))
            .collect()
    }

    /// Reconcile **every** known namespace (own + friends) with `peers`, so each friend's latest
    /// fix (and our own outbound slot) is exchanged. Read the results afterwards with
    /// [`Self::read_latest`].
    ///
    /// A namespace that fails is logged and skipped rather than aborting the run: these are
    /// independent replicas, and short-circuiting on the first error meant one friend whose doc
    /// couldn't be opened silently blocked the refresh for everyone after them in the map.
    pub async fn sync_all(&self, peers: Vec<EndpointAddr>) -> Result<()> {
        let namespaces = self.namespaces().await;
        let mut failed = 0usize;
        for ns in &namespaces {
            if let Err(err) = self.sync_ns(*ns, peers.clone()).await {
                failed += 1;
                tracing::warn!(
                    sc.namespace = %crate::telemetry::short_hex(&ns.to_bytes()),
                    error = %err,
                    "trail.sync: namespace failed; continuing with the rest"
                );
            }
        }
        // Only a total wipeout is an error worth failing the call for — otherwise the caller gets
        // whatever was reachable, which is the point of a best-effort refresh.
        if failed > 0 && failed == namespaces.len() {
            return Err(anyhow!("all {failed} trail namespaces failed to sync"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── key encoding round-trip ──────────────────────────────────────────────────────────
    #[test]
    fn key_round_trip() {
        let author = [0xabu8; 32];
        let key = encode_key(&author);
        assert_eq!(decode_key(&key), Some(author.to_vec()));
    }

    #[test]
    fn fix_key_is_one_slot_per_author() {
        // LWW hinges on the key being independent of anything per-publish.
        let a = [1u8; 32];
        let b = [2u8; 32];
        assert_eq!(encode_key(&a), encode_key(&a));
        assert_ne!(encode_key(&a), encode_key(&b));
    }

    #[test]
    fn decode_key_rejects_garbage_and_legacy_keys() {
        assert!(decode_key(b"no-separator-here").is_none());
        assert!(decode_key(b"zz/fix").is_none()); // non-hex author
                                                  // Pre-LWW `hex(author)/{seq:020}` keys left by older builds stay invisible.
        assert!(decode_key(b"abab/00000000000000000001").is_none());
    }

    // ── serving-peer attribution ─────────────────────────────────────────────────────────

    #[test]
    fn serving_peer_records_both_fix_lanes() {
        let author = [0x22u8; 32];
        let peer = [0x33u8; 32];
        let mut peers = HashMap::new();
        record_serving_peer(&mut peers, &encode_key(&author), peer, 10);
        assert_eq!(peers.get(&author).map(|s| s.peer), Some(peer));

        let mut nul = HashMap::new();
        record_serving_peer(&mut nul, &encode_nul_key(&author), peer, 10);
        assert_eq!(nul.get(&author).map(|s| s.peer), Some(peer));
    }

    /// Two peers can finish reconciling the same author within one sync. The newest entry is the
    /// one that actually moved the friend's dot, so it is the one whose deliverer we name.
    #[test]
    fn serving_peer_keeps_the_newest_entry() {
        let author = [0x22u8; 32];
        let old_peer = [0x01u8; 32];
        let new_peer = [0x02u8; 32];
        let key = encode_key(&author);
        let mut peers = HashMap::new();

        record_serving_peer(&mut peers, &key, new_peer, 20);
        record_serving_peer(&mut peers, &key, old_peer, 10);
        assert_eq!(peers.get(&author).map(|s| s.peer), Some(new_peer));

        // …and a genuinely newer delivery replaces it.
        record_serving_peer(&mut peers, &key, old_peer, 30);
        assert_eq!(peers.get(&author).map(|s| s.peer), Some(old_peer));
    }

    /// A control or resync entry says nothing about who delivered a location.
    #[test]
    fn serving_peer_ignores_non_fix_lanes() {
        let author = [0x22u8; 32];
        let peer = [0x33u8; 32];
        let mut peers = HashMap::new();
        record_serving_peer(&mut peers, &encode_ctl_key(&author), peer, 10);
        record_serving_peer(&mut peers, &encode_rsy_key(&author), peer, 10);
        record_serving_peer(&mut peers, b"abab/00000000000000000001", peer, 10);
        assert!(peers.is_empty());
    }

    // ── control-entry keys (ARCHITECTURE §9c) ────────────────────────────────────────────

    /// The whole point of the `ctl/` lead: fix readers must skip control entries untouched.
    /// If this ever fails, control payloads start reaching `read_latest` and the presence UI,
    /// which would try to decode a `ControlMsg` as a `LocationFix`.
    #[test]
    fn fix_readers_ignore_control_keys() {
        let author = [0x11u8; 32];
        let ctl = encode_ctl_key(&author);
        // `decode_key` refuses it, so `read_latest` / `sync_direct` drop it on the floor.
        assert!(decode_key(&ctl).is_none());
        assert_ne!(ctl, encode_key(&author));
    }

    /// One slot per author: the key must not vary, or superseding would not work.
    #[test]
    fn ctl_key_is_stable_per_author() {
        let a = [3u8; 32];
        let b = [4u8; 32];
        assert_eq!(encode_ctl_key(&a), encode_ctl_key(&a));
        assert_ne!(encode_ctl_key(&a), encode_ctl_key(&b));
    }

    /// The null lane must be invisible to fix readers and must not collide with either other
    /// lane — the whole point of giving it its own key is that a tick's two envelopes, wrapped
    /// for disjoint recipient sets, both survive.
    #[test]
    fn null_keys_are_their_own_lane() {
        let author = [0x11u8; 32];
        let nul = encode_nul_key(&author);
        assert!(decode_key(&nul).is_none());
        assert_ne!(nul, encode_key(&author));
        assert_ne!(nul, encode_ctl_key(&author));
    }

    /// One overwritten slot per author, same as the fix and control lanes.
    #[test]
    fn nul_key_is_stable_per_author() {
        let a = [5u8; 32];
        let b = [6u8; 32];
        assert_eq!(encode_nul_key(&a), encode_nul_key(&a));
        assert_ne!(encode_nul_key(&a), encode_nul_key(&b));
    }

    // ── prune-threshold selection ────────────────────────────────────────────────────────
    #[test]
    fn prune_selects_strictly_older() {
        let entries = vec![
            (b"a".to_vec(), 100u64),
            (b"b".to_vec(), 200),
            (b"c".to_vec(), 300),
        ];
        let pruned = keys_to_prune(&entries, 200);
        assert_eq!(pruned, vec![b"a".to_vec()]); // 200 is NOT older than 200
    }

    #[test]
    fn prune_empty_when_all_fresh() {
        let entries = vec![(b"a".to_vec(), 500u64), (b"b".to_vec(), 600)];
        assert!(keys_to_prune(&entries, 100).is_empty());
    }

    // ── revocation carries over to the durable path (reuses crypto.rs) ───────────────────
    // The durable path stores the SAME sealed bytes as gossip, so an envelope written to docs
    // still decrypts for a recipient and is opaque to a non-recipient / revoked peer.
    #[test]
    fn docs_envelope_decrypts_for_recipient_opaque_to_revoked() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;

        let signing = SigningKey::generate(&mut OsRng);
        let seed = signing.to_bytes();
        let author = signing.verifying_key().to_bytes();

        let (b_sk, b_pk) = crypto::generate_recv_keypair(); // active recipient
        let (c_sk, c_pk) = crypto::generate_recv_keypair(); // will be revoked

        // fix #1 shared with B and C, written to docs under the author's LWW slot.
        let payload = b"durable trail point";
        let envelope =
            crypto::seal(&seed, &author, 1, 1000, 0, payload, &[b_pk.clone(), c_pk]).unwrap();
        let _key = encode_key(&author); // exercises the docs key path

        // Both recipients can open the SAME stored bytes.
        assert_eq!(
            crypto::open(&b_sk, &envelope).unwrap().payload.as_slice(),
            payload
        );
        assert_eq!(
            crypto::open(&c_sk, &envelope).unwrap().payload.as_slice(),
            payload
        );

        // fix #2: C revoked (dropped from wraps). The durable bytes are opaque to C, still
        // readable by B — no docs node required to prove it.
        let e2 = crypto::seal(&seed, &author, 2, 2000, 0, b"after revoke", &[b_pk]).unwrap();
        assert!(crypto::open(&b_sk, &e2).is_ok());
        assert!(matches!(
            crypto::open(&c_sk, &e2),
            Err(crypto::CryptoError::NotARecipient)
        ));
    }

    // ── own trail namespace is stable across restarts (regression) ───────────────────────────
    //
    // iroh-docs mints a fresh namespace on every `create()`. Before the persistence fix,
    // `TrailDocs::init` called `create()` unconditionally, so each restart rotated our trail
    // namespace and orphaned every friend's stored read-ticket (durable/stash backfill silently
    // broke while the live gossip path kept working). These tests pin the reuse behaviour.

    use iroh::{Endpoint, RelayMode, SecretKey};
    use iroh_blobs::store::fs::FsStore;
    use iroh_gossip::net::Gossip;

    /// A live docs node over `data_dir`. Holds the endpoint/gossip alive so the persistent docs
    /// store stays open for the duration of a test (init is local-only — no network sync).
    struct DocsFixture {
        docs: Docs,
        blobs: BlobsStore,
        _endpoint: Endpoint,
        _gossip: Gossip,
    }

    async fn spawn_docs(data_dir: &std::path::Path) -> DocsFixture {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(SecretKey::generate())
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .expect("bind test endpoint");
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let blobs = FsStore::load(data_dir.join("blobs"))
            .await
            .expect("load test blobs");
        let docs = iroh_docs::protocol::Docs::persistent(data_dir.to_path_buf())
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await
            .expect("spawn test docs");
        DocsFixture {
            docs,
            blobs: (*blobs).clone(),
            _endpoint: endpoint,
            _gossip: gossip,
        }
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sc-trail-ns-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── LWW: a second publish leaves exactly one readable entry per author ───────────────────
    // The FORWARD-SECRECY.md §7 step 1 acceptance test: the replica answers "current fix",
    // never history. `read_latest` must yield one entry per author, carrying the newest seq.
    #[tokio::test]
    async fn second_publish_leaves_one_readable_entry_per_author() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;

        let dir = scratch_dir("lww");
        let fx = spawn_docs(&dir).await;
        let td = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone())
            .await
            .unwrap();
        let ns = td.own_namespace();

        let signing = SigningKey::generate(&mut OsRng);
        let seed = signing.to_bytes();
        let author = signing.verifying_key().to_bytes();
        let (b_sk, b_pk) = crypto::generate_recv_keypair();

        let e1 = crypto::seal(&seed, &author, 1, 1000, 0, b"first", &[b_pk.clone()]).unwrap();
        let e2 = crypto::seal(&seed, &author, 2, 2000, 0, b"second", &[b_pk.clone()]).unwrap();
        td.write(ns, &author, e1).await.unwrap();
        td.write(ns, &author, e2).await.unwrap();

        let latest = td.read_latest(&b_sk).await.unwrap();
        assert_eq!(
            latest.len(),
            1,
            "one readable entry per author, not history"
        );
        assert_eq!(latest[0].author, author.to_vec());
        assert_eq!(latest[0].seq, 2, "the second publish supersedes the first");
        assert_eq!(latest[0].payload.as_slice(), b"second");

        // A control entry in the same namespace stays invisible to fix readers.
        let ctl = crypto::seal(&seed, &author, 0, 3000, 0, b"ctl-msg", &[b_pk]).unwrap();
        td.write_ctl(ns, &author, ctl).await.unwrap();
        let latest = td.read_latest(&b_sk).await.unwrap();
        assert_eq!(latest.len(), 1, "control entries must not read as fixes");
        assert_eq!(latest[0].payload.as_slice(), b"second");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn trail_namespace_is_stable_across_reinit() {
        let dir = scratch_dir("stable");
        let fx = spawn_docs(&dir).await;

        let first = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone())
            .await
            .unwrap();
        let ns1 = first.own_namespace();
        // The id was persisted so the next boot can reopen it.
        assert_eq!(
            read_ns_file(&dir.join(TRAIL_NS_FILE)),
            Some(ns1.to_bytes()),
            "init must persist the trail namespace id"
        );

        // A second init over the same data_dir (a restart) must REUSE the namespace, not mint one.
        let second = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone())
            .await
            .unwrap();
        assert_eq!(
            second.own_namespace(),
            ns1,
            "trail namespace must be stable across restarts"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn trail_namespace_differs_per_data_dir() {
        let d1 = scratch_dir("distinct-a");
        let d2 = scratch_dir("distinct-b");

        let fx1 = spawn_docs(&d1).await;
        let ns_a = TrailDocs::init(fx1.docs.clone(), fx1.blobs.clone(), d1.clone())
            .await
            .unwrap()
            .own_namespace();
        let fx2 = spawn_docs(&d2).await;
        let ns_b = TrailDocs::init(fx2.docs.clone(), fx2.blobs.clone(), d2.clone())
            .await
            .unwrap()
            .own_namespace();

        assert_ne!(
            ns_a, ns_b,
            "separate installs must not share a trail namespace"
        );

        let _ = std::fs::remove_dir_all(&d1);
        let _ = std::fs::remove_dir_all(&d2);
    }

    #[tokio::test]
    async fn trail_namespace_recreated_when_persisted_id_absent_from_store() {
        let dir = scratch_dir("fallback");
        // A persisted id that was never created in this store (e.g. the store was wiped but the
        // metadata file survived). init must fall back to minting + persisting a fresh one.
        let stale = [0x11u8; 32];
        write_ns_file(&dir.join(TRAIL_NS_FILE), &stale).unwrap();

        let fx = spawn_docs(&dir).await;
        let td = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone())
            .await
            .unwrap();
        let ns = td.own_namespace();

        assert_ne!(
            ns.to_bytes(),
            stale,
            "must not adopt a persisted id that isn't in the store"
        );
        assert_eq!(
            read_ns_file(&dir.join(TRAIL_NS_FILE)),
            Some(ns.to_bytes()),
            "the freshly minted id must replace the stale one on disk"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
