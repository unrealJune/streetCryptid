//! The location transport: one **last-write-wins** iroh-docs slot per author, replicated live.
//!
//! See `docs/social/ARCHITECTURE.md` §2, §5–6 and `docs/social/FORWARD-SECRECY.md` §4.4.
//! Every fix is ratchet-sealed once and written to the author's OWN namespace under a **single
//! key per author** (`hex(author)/fix`), each write superseding the last. There is deliberately
//! no durable history: the replica answers "where is this friend now", never "where have they
//! been". Per-recipient revocation is a property of the envelope, not of the transport: a dropped
//! recipient may keep replicating the ciphertext but has no wrap, so the bytes are opaque to it.
//!
//! ## How an entry moves
//! Every namespace — ours and each friend's — is put into the iroh-docs live engine when the
//! node starts ([`TrailDocs::init`]), and stays there for the life of the process. That one call
//! is what makes a replica both *serve* (inbound reconciliation is refused for a namespace that
//! is not syncing) and *broadcast* (a local write goes out as a gossip `Op::Put` on the
//! namespace's topic only while it is syncing). Three things then land a friend's entry here,
//! and all three end in the same `InsertRemote`:
//! * the friend's own push — a reconciliation it opens with us after a write;
//! * the live engine's broadcast of that write to the namespace's swarm, while we are in it;
//! * our pull — a reconciliation we open with the stash or a friend ([`TrailDocs::sync_all`]).
//!
//! A per-namespace watch task ([`ReplicaObserver`]) reports each one exactly once, whichever of
//! the three carried it. iroh-gossip is still in the process, but only as the live engine's
//! transport for those broadcasts; nothing in this crate opens a gossip topic of its own.
//!
//! ## What lives here
//! * [`TrailDocs`] — wraps the persistent `Docs` replica store (own namespace + imported
//!   friend namespaces) and the iroh-blobs content store the entries point at.
//! * **Pure** helpers ([`encode_key`], [`decode_key`], [`encode_nul_key`], [`encode_rsy_key`],
//!   [`keys_to_prune`]) holding the key-encoding and explicit-pruning logic, covered by
//!   `#[cfg(test)]` without a live iroh node.
//!
//! Superseded versions of an overwritten key still exist in the replica (which is why
//! `single_latest_per_key` is load-bearing on every read) — reclaiming them is the retention work
//! of FORWARD-SECRECY.md §5.1/§7 step 2, not this module's keying.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use iroh::EndpointAddr;
use iroh_blobs::api::Store as BlobsStore;
use iroh_blobs::Hash;
use iroh_docs::ContentStatus;
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
use n0_future::join_all;
use n0_future::task::AbortOnDropHandle;
use n0_future::time::{timeout, Duration, Instant};
use n0_future::{Stream, StreamExt};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::crypto;
use crate::ns_book::{self, NamespaceBook};

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
pub const PUSH_TIMEOUT_SECS: u64 = 30;

/// Key separator between the hex author and the zero-padded sequence number.
pub const KEY_SEP: u8 = b'/';

/// Filename (under `data_dir`) holding the persisted trail `NamespaceId`, so our own trail
/// namespace is stable across [`crate::LocationNode`] restarts even though iroh-docs mints a
/// fresh namespace on `create()`. Mirrors [`crate::profile::PROFILE_NS_FILE`]; without it a
/// restart would orphan every friend's stored trail read-ticket. Superseded by the namespace
/// book's secret and kept only so a downgrade finds the same namespace.
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
/// signed envelope for replay rejection, but the replica holds one overwritten slot per author,
/// so there is no durable history to key.
pub fn encode_key(author: &[u8]) -> Vec<u8> {
    let mut key = hex_encode(author).into_bytes();
    key.push(KEY_SEP);
    key.extend_from_slice(FIX_TAG.as_bytes());
    key
}

/// Decode a key produced by [`encode_key`] back into the author bytes.
///
/// Returns `None` for the null and resync lanes (their `nul`/`rsy` leads are not valid hex) and
/// for keys older builds left in a replica — pre-LWW `hex(author)/{seq:020}` fixes and the retired
/// `ctl/hex(author)` live-mode requests. Those are deliberately invisible to current readers.
pub fn decode_key(key: &[u8]) -> Option<Vec<u8>> {
    let pos = key.iter().position(|&b| b == KEY_SEP)?;
    if &key[pos + 1..] != FIX_TAG.as_bytes() {
        return None;
    }
    let author_hex = std::str::from_utf8(&key[..pos]).ok()?;
    hex_decode(author_hex)
}

/// Literal leading segment marking a **null fix** — a watcher's cadence keep-alive
/// (FORWARD-SECRECY.md §4.1) rather than a position.
///
/// Null fixes need their own slot because the durable path is last-write-wins with exactly one
/// fix key per author (§4.4), and the two lanes are wrapped for *disjoint* recipient sets: the
/// fix lane for the friends we share position with, the null lane for the friends we do not.
/// Sharing one slot would mean each tick's second envelope silently supersedes the first, so a
/// device that both shares and watches could never keep both lanes durable.
///
/// The `nul` lead is not valid hex, so [`decode_key`] rejects it and every fix reader skips null
/// entries without change.
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
/// [`TrailDocs::read_latest_sealed`], which must return the two lanes and no others: the resync
/// lane is not a fix envelope and would fail `verify_v3` anyway, but skipping it by key is
/// cheaper and states the intent.
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
/// Only the two fix lanes (`fix` and `nul`) count. A resync record or a key an older build left
/// behind is not what "delivered a friend's location" means, and attributing a fix to the peer
/// that happened to hand one over would be a plausible-looking lie. Returns the author the key
/// named when it was a fix-lane slot, `None` (and nothing recorded) otherwise.
fn record_serving_peer(
    peers: &mut HashMap<[u8; 32], ServingPeer>,
    key: &[u8],
    peer: [u8; 32],
    entry_ts: u64,
) -> Option<[u8; 32]> {
    let author = decode_key(key).or_else(|| decode_nul_key(key))?;
    let author: [u8; 32] = author.as_slice().try_into().ok()?;
    let entry = peers
        .entry(author)
        .or_insert(ServingPeer { peer, entry_ts });
    if entry_ts >= entry.entry_ts {
        *entry = ServingPeer { peer, entry_ts };
    }
    Some(author)
}

/// Literal leading segment marking a **resync record** (FORWARD-SECRECY.md §4.6).
///
/// Its own lane for the same reason the null fix needed one: every lane is one overwritten slot
/// per author, so a record sharing a slot with a fix would supersede it. Not valid hex, so fix
/// readers skip it.
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

/// Decode a key produced by [`encode_rsy_key`] back into the author bytes.
///
/// Only [`TrailDocs::stranded_slots`] needs it: a control record whose bytes never landed is a
/// restart request (or prekey) the leader cannot read, which strands recovery exactly as a missing
/// fix strands a dot.
fn decode_rsy_key(key: &[u8]) -> Option<Vec<u8>> {
    let pos = key.iter().position(|&b| b == KEY_SEP)?;
    if &key[..pos] != RSY_TAG.as_bytes() {
        return None;
    }
    let author_hex = std::str::from_utf8(&key[pos + 1..]).ok()?;
    hex_decode(author_hex)
}

/// The envelope author a friend-lane slot key names (`fix`, `nul` or `rsy`), or `None` for any
/// other key. The three lanes whose bytes a reader needs; see [`TrailDocs::stranded_slots`].
fn decode_lane_author(key: &[u8]) -> Option<[u8; 32]> {
    let author = decode_key(key)
        .or_else(|| decode_nul_key(key))
        .or_else(|| decode_rsy_key(key))?;
    <[u8; 32]>::try_from(author.as_slice()).ok()
}

/// How long one attempt to fetch a stranded slot's bytes may take when the caller sets no tighter
/// deadline. The stash's own settle loop uses the same figure (`FETCH_TIMEOUT_SECS`).
#[cfg(not(target_arch = "wasm32"))]
const STRANDED_FETCH_TIMEOUT_SECS: u64 = 20;

/// A friend's slot whose newest entry is in the replica while the bytes it names are not.
///
/// The state a reader is left in when it reconciles an entry from a peer that does not hold the
/// content yet — in practice the stash, which receives the record by reconciliation and the bytes
/// moments later (the writer's HTTP upload, or its own settle loop). iroh-docs gives the reader's
/// downloader one attempt, against the peer that delivered the record, and then waits for a gossip
/// `ContentReady` that content landing on the stash out-of-band never produces. Until 2026-11-12
/// nothing else asked again, and [`TrailDocs::read_latest_sealed`] skips such a slot without a
/// word, so the friend simply stopped updating: see [`TrailDocs::settle_stranded`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrandedSlot {
    pub namespace: [u8; 32],
    /// The envelope author the slot key names — an `EndpointId`, so also a place to ask.
    pub author: [u8; 32],
    pub hash: Hash,
    /// The entry's record timestamp (iroh-docs microseconds), for the age on the telemetry.
    pub written_us: u64,
}

/// What one [`TrailDocs::settle_stranded`] pass found and fixed.
#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SettleReport {
    /// Friend slots whose newest entry had no local bytes when the pass began.
    pub stranded: usize,
    /// Of those, the ones whose bytes this pass fetched.
    pub fetched: usize,
    /// Authors that became readable, each once — what the replica observer was told.
    pub readable: Vec<[u8; 32]>,
}

/// Who to ask for one stranded slot's bytes, most likely first, each once, never ourselves.
///
/// The pass's dialled peers come first because the stash is among them and it is the one peer
/// that holds every friend's bytes and is always up. The author is next (the key is its
/// `EndpointId`, so no address book is needed), then whoever last served that author's entry to
/// us. Asking only the author would strand exactly the friend whose phone is asleep — the case
/// the stash exists for. Pure, so the order and the self-exclusion are testable.
#[cfg(not(target_arch = "wasm32"))]
fn stranded_sources(
    dialled: &[iroh::EndpointId],
    author: [u8; 32],
    served_by: Option<[u8; 32]>,
    own: iroh::EndpointId,
) -> Vec<iroh::EndpointId> {
    let mut out: Vec<iroh::EndpointId> = Vec::new();
    let candidates = dialled.iter().copied().chain(
        [Some(author), served_by]
            .into_iter()
            .flatten()
            .filter_map(|bytes| iroh::EndpointId::from_bytes(&bytes).ok()),
    );
    for id in candidates {
        if id != own && !out.contains(&id) {
            out.push(id);
        }
    }
    out
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushReport {
    /// Entries handed to peers, summed over every peer that finished.
    pub entries_sent: u64,
    /// Peers that completed a reconciliation.
    pub peers_finished: usize,
    /// Peers that reported an error instead — unreachable, or refused.
    pub peers_failed: usize,
    /// What each dialled peer did, individually. See [`PeerPushOutcome`].
    pub per_peer: Vec<PeerPushOutcome>,
}

/// Which of the three things a dialled peer did.
///
/// The distinction between [`Failed`](PeerOutcome::Failed) and [`Silent`](PeerOutcome::Silent) is
/// the entire diagnostic point. Measured over 7 days, 74% of pushes burned the full 30s deadline
/// with `peers_failed = 0` — the missing peers had not refused, they had said **nothing**, so the
/// "everyone has reported" break condition could never be satisfied. Counting them together would
/// hide the asleep phones that cost a push its whole deadline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerOutcome {
    /// Reconciled. `entries_sent` is meaningful.
    Finished,
    /// Reported an error — refused, or a reachable peer that could not complete.
    Failed,
    /// Never reported at all before the deadline. An asleep phone looks like this.
    Silent,
}

impl PeerOutcome {
    /// Stable lowercase name, used as a span attribute and as the JS-facing discriminant.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Silent => "silent",
        }
    }
}

/// Complete a push's per-peer record: every dialled peer that never reported is folded in as
/// [`PeerOutcome::Silent`] alongside the peers that did.
///
/// Pure, and separated out for that reason, so it is tested without standing up an iroh node. It
/// must never drop the record when nobody answered: a push where every peer stayed quiet is the
/// most informative row there is.
fn finish_outcomes(
    mut reported: Vec<PeerPushOutcome>,
    outstanding: &[[u8; 32]],
) -> Vec<PeerPushOutcome> {
    for peer in outstanding {
        reported.push(PeerPushOutcome {
            peer: *peer,
            outcome: PeerOutcome::Silent,
            latency_ms: None,
            entries_sent: 0,
        });
    }
    reported.sort_by_key(|outcome| outcome.peer);
    reported
}

/// One peer's contribution to a push, the row behind each `trail.push.peer` span.
///
/// Per-peer-per-push rather than aggregated, because an aggregate `peers_finished` count cannot
/// say WHICH peer answered or how long it took.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerPushOutcome {
    /// The peer's endpoint id.
    pub peer: [u8; 32],
    /// What it did.
    pub outcome: PeerOutcome,
    /// Time from `start_sync` to this peer reporting. `None` when it never did.
    pub latency_ms: Option<u64>,
    /// Entries handed to THIS peer. Zero unless [`PeerOutcome::Finished`].
    pub entries_sent: u64,
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

/// The peers a docs read ticket names, with each address's relays scrubbed to ones this node
/// knows (a ticket's relay is history, not an address; see `relay::scrub_addr`). Empty for a
/// ticket that does not parse.
fn ticket_peers(ticket: &str) -> Vec<EndpointAddr> {
    match ticket.parse::<iroh_docs::DocTicket>() {
        Ok(parsed) => parsed
            .nodes
            .into_iter()
            .map(crate::relay::scrub_addr)
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Who is told when friend entries land in the replica. Implemented by the node
/// (`ReplicaWatch` in [`crate`]); the web build passes none.
///
/// Both calls are made from a namespace's watch task, which iroh-docs' live actor waits on: its
/// subscriber channels are bounded and it `send().await`s into them, so a watcher that blocks
/// stalls every namespace's sync. Implementations must return promptly and push real work onto a
/// task of their own.
pub trait ReplicaObserver: Send + Sync + 'static {
    /// `(serving peer, author)` for every fix-lane entry delivered since the last call — the
    /// receive-side `peer.contact` evidence. One pair per entry, unsorted and not deduplicated.
    fn delivered(&self, deliveries: Vec<([u8; 32], [u8; 32])>);
    /// Authors whose newest entry (either fix lane) is now readable locally — the entry AND its
    /// content. Each author at most once per call.
    fn readable(&self, authors: Vec<[u8; 32]>);
}

/// How long a watch task holds a report open for more entries before handing it over. One sync
/// can land a dozen authors within milliseconds; the app re-reads the whole replica per report.
const REPLICA_COALESCE: Duration = Duration::from_millis(250);

/// A report is handed over at this size without waiting for the burst to end.
const REPLICA_FLUSH_AT: usize = 256;

/// The state one namespace's watch task carries between events. Pure, so the "report each
/// delivery once, and an author only once its content is local" rules are testable without a
/// live engine.
#[derive(Default)]
struct WatchBatch {
    delivered: Vec<([u8; 32], [u8; 32])>,
    readable: Vec<[u8; 32]>,
    /// Authors whose newest entry landed before its content did, by the hash that will complete
    /// it. Keyed by author, so a newer entry replaces the wait rather than adding one, and a hash
    /// that never arrives costs one slot per author rather than growing for ever.
    awaiting: HashMap<[u8; 32], Hash>,
}

impl WatchBatch {
    fn mark_readable(&mut self, author: [u8; 32]) {
        if !self.readable.contains(&author) {
            self.readable.push(author);
        }
    }

    /// A fix-lane entry from `from` for `author` arrived; `status` is the LOCAL content status.
    fn insert(&mut self, from: [u8; 32], author: [u8; 32], hash: Hash, status: ContentStatus) {
        self.delivered.push((from, author));
        match status {
            ContentStatus::Complete => {
                self.awaiting.remove(&author);
                self.mark_readable(author);
            }
            ContentStatus::Incomplete | ContentStatus::Missing => {
                self.awaiting.insert(author, hash);
            }
        }
    }

    /// The content behind `hash` is now local.
    fn content_ready(&mut self, hash: Hash) {
        let ready: Vec<[u8; 32]> = self
            .awaiting
            .iter()
            .filter(|(_, waiting)| **waiting == hash)
            .map(|(author, _)| *author)
            .collect();
        for author in ready {
            self.awaiting.remove(&author);
            self.mark_readable(author);
        }
    }

    fn pending(&self) -> bool {
        !self.delivered.is_empty() || !self.readable.is_empty()
    }

    fn full(&self) -> bool {
        self.delivered.len() + self.readable.len() >= REPLICA_FLUSH_AT
    }

    fn flush(&mut self, observer: &dyn ReplicaObserver) {
        if !self.delivered.is_empty() {
            observer.delivered(std::mem::take(&mut self.delivered));
        }
        if !self.readable.is_empty() {
            observer.readable(std::mem::take(&mut self.readable));
        }
    }
}

/// One namespace's watch: every entry a peer hands this replica, however it arrived.
///
/// Runs until the subscription ends (the namespace left the engine, or the node shut down) or
/// its handle is dropped. Holds only clones — never the [`TrailDocs`] — so it cannot keep a
/// stopped node's replica alive.
async fn watch_namespace(
    ns: NamespaceId,
    mut events: impl Stream<Item = Result<LiveEvent>> + Unpin,
    serving_peers: Arc<Mutex<HashMap<[u8; 32], ServingPeer>>>,
    observer: Arc<dyn ReplicaObserver>,
) {
    let mut batch = WatchBatch::default();
    loop {
        let next = if batch.pending() {
            match timeout(REPLICA_COALESCE, events.next()).await {
                Ok(next) => next,
                Err(_) => {
                    batch.flush(observer.as_ref());
                    continue;
                }
            }
        } else {
            events.next().await
        };
        match next {
            Some(Ok(LiveEvent::InsertRemote {
                from,
                entry,
                content_status,
            })) => {
                let from = *from.as_bytes();
                let author = {
                    let mut peers = serving_peers.lock().await;
                    record_serving_peer(&mut peers, entry.key(), from, entry.timestamp())
                };
                if let Some(author) = author {
                    batch.insert(from, author, entry.content_hash(), content_status);
                }
            }
            Some(Ok(LiveEvent::ContentReady { hash })) => batch.content_ready(hash),
            Some(Ok(_)) => {}
            Some(Err(error)) => {
                tracing::warn!(
                    sc.namespace = %crate::telemetry::short_hex(&ns.to_bytes()),
                    error = %error,
                    "trail.watch: replica subscription failed; this namespace is no longer watched"
                );
                break;
            }
            None => break,
        }
        if batch.full() {
            batch.flush(observer.as_ref());
        }
    }
    batch.flush(observer.as_ref());
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
    /// What to reopen on the next start: our secret and every imported friend namespace. `None`
    /// on the web, whose store is in memory. See [`crate::ns_book`].
    book: Option<Arc<NamespaceBook>>,
    /// Per envelope-author, the peer that last handed us their entry during a reconciliation.
    ///
    /// Keyed by author rather than by namespace because that is the question the UI asks — "who
    /// delivered Maya's fix" — and because a namespace has exactly one writer but any number of
    /// peers willing to serve it. Bounded by the pool size: one slot per author we replicate.
    ///
    /// Deliberately in-memory and delivery-scoped. An entry already in the replica produces no
    /// `InsertRemote`, so a read after a quiet sync reports no peer — which is the truth: nobody
    /// delivered it this time. Shared with the watch tasks, which record every delivery.
    serving_peers: Arc<Mutex<HashMap<[u8; 32], ServingPeer>>>,
    /// Told about every friend entry that lands; `None` on the web.
    observer: Option<Arc<dyn ReplicaObserver>>,
    /// One watch task per namespace, aborted when its entry is dropped. A std lock: it is only
    /// ever held to insert or remove, never across an await.
    watchers: std::sync::Mutex<HashMap<[u8; 32], AbortOnDropHandle<()>>>,
}

impl TrailDocs {
    /// Initialise from an already-spawned [`Docs`] protocol + its backing blobs store.
    ///
    /// With a `book` (every device build), our own namespace comes back from the secret it holds
    /// and every friend namespace it lists is reopened — so a node started with no JS reconciles
    /// friends too, and a wiped replica comes back as the SAME namespaces rather than orphaning
    /// every friend's read ticket. See [`crate::ns_book`] for the 2026-10-05 incident.
    ///
    /// Without one (the web build's in-memory store) the namespace id file under `data_dir` is
    /// the only memory, as before. The caller is responsible for having registered the
    /// `Docs`/`Blobs`/`Gossip` protocols on the iroh [`Router`](iroh::protocol::Router).
    ///
    /// Every namespace is then put into the live engine (see [`Self::go_live`]) — the one step
    /// that makes this replica serve, broadcast and receive. Until 2026-11 a reopened friend
    /// namespace was not, so a restarted node refused every friend's push until its own first
    /// pull happened to name that namespace.
    pub async fn init(
        docs: Docs,
        blobs: BlobsStore,
        data_dir: PathBuf,
        book: Option<Arc<NamespaceBook>>,
        observer: Option<Arc<dyn ReplicaObserver>>,
    ) -> Result<Self> {
        let author = docs.author_default().await?;
        let ns_path = data_dir.join(TRAIL_NS_FILE);
        let legacy = read_ns_file(&ns_path);

        let mut handles = HashMap::new();
        // Where each reopened friend namespace was last known to live: its read ticket's
        // addresses, scrubbed like any other ticket-derived dial.
        let mut bootstrap: HashMap<[u8; 32], Vec<EndpointAddr>> = HashMap::new();
        let own = match book.as_deref() {
            Some(book) => {
                for friend in book.friends() {
                    bootstrap.insert(friend.namespace, ticket_peers(&friend.ticket));
                }
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
        let _ = write_ns_file(&ns_path, &own.id().to_bytes());
        let own_ns = own.id();
        handles.insert(own_ns.to_bytes(), own);
        let docs = Self {
            docs,
            blobs,
            author,
            own_ns,
            handles: Mutex::new(handles),
            book,
            serving_peers: Arc::new(Mutex::new(HashMap::new())),
            observer,
            watchers: std::sync::Mutex::new(HashMap::new()),
        };
        let live: Vec<Doc> = docs.handles.lock().await.values().cloned().collect();
        for doc in live {
            let peers = bootstrap.remove(&doc.id().to_bytes()).unwrap_or_default();
            if let Err(error) = docs.go_live(&doc, peers).await {
                // Not fatal: the namespace still reads and writes locally, and the next push or
                // pull that names it calls `start_sync` again.
                tracing::warn!(
                    sc.namespace = %crate::telemetry::short_hex(&doc.id().to_bytes()),
                    error = %error,
                    "trail: could not put a namespace into the live engine"
                );
            }
        }
        Ok(docs)
    }

    /// Watch `doc` (when there is an observer) and put it into the live engine, joining `peers`.
    ///
    /// Subscribes FIRST: `start_sync` opens reconciliations with `peers` and with every peer the
    /// namespace has usefully synced with before (the engine remembers those itself, by id), and an
    /// entry handed over before the watch exists would never be reported. `peers` carries the
    /// addresses a friend's ticket recorded, so a node with no working address lookup can still
    /// reach the friend; remembered peers are dialled through the endpoint's lookup alone.
    ///
    /// Only friend namespaces are watched: we are our own namespace's only writer, so nothing a
    /// peer hands over there is news to the app.
    async fn go_live(&self, doc: &Doc, peers: Vec<EndpointAddr>) -> Result<()> {
        if let (Some(observer), true) = (&self.observer, doc.id() != self.own_ns) {
            let events = doc.subscribe().await?;
            self.watch(doc.id(), events, observer.clone());
        }
        doc.start_sync(peers).await
    }

    /// Start (or replace) the watch task for `ns`.
    fn watch(
        &self,
        ns: NamespaceId,
        events: impl Stream<Item = Result<LiveEvent>> + Unpin + Send + 'static,
        observer: Arc<dyn ReplicaObserver>,
    ) {
        let task = n0_future::task::spawn(watch_namespace(
            ns,
            events,
            self.serving_peers.clone(),
            observer,
        ));
        self.watchers
            .lock()
            .expect("watchers lock")
            .insert(ns.to_bytes(), AbortOnDropHandle::new(task));
    }

    /// Stop every watch task. Called on shutdown, before the router closes, so no task reports a
    /// delivery to an app that is going away.
    pub fn stop_watching(&self) {
        self.watchers.lock().expect("watchers lock").clear();
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
    /// still given every slot a chance. That keeps `trail.content.upload` reporting a genuine stash
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
    ///
    /// Recorded in the book, so every later start reopens it whether or not JS runs.
    pub async fn import_ticket(&self, ticket: &str) -> Result<NamespaceId> {
        let mut parsed: iroh_docs::DocTicket = ticket.parse().map_err(|e| anyhow!("{e}"))?;
        parsed.nodes = ticket_peers(ticket);
        // Subscribed before the ticket's peers are dialled, so the first reconciliation — the
        // one that brings a new friend's current position — is reported like any other.
        let (doc, events) = self.docs.import_and_subscribe(parsed).await?;
        let ns = doc.id();
        if ns != self.own_ns {
            if let Some(book) = &self.book {
                book.add_friend(ns.to_bytes(), ticket)?;
            }
            if let Some(observer) = &self.observer {
                self.watch(ns, Box::pin(events), observer.clone());
            }
        }
        self.handles.lock().await.insert(ns.to_bytes(), doc);
        Ok(ns)
    }

    /// Stop replicating a removed friend's namespace and drop it from the book, so no later start
    /// reopens it. The local entries are left for iroh-docs to keep or collect; nothing reads them.
    /// Returns whether we were replicating it.
    pub async fn forget_ticket(&self, ticket: &str) -> Result<bool> {
        let ns = NamespaceId::from(ns_book::ticket_namespace(ticket)?);
        if ns == self.own_ns {
            return Ok(false);
        }
        let in_book = match &self.book {
            Some(book) => book.remove_friend(ns.to_bytes())?,
            None => false,
        };
        self.watchers
            .lock()
            .expect("watchers lock")
            .remove(&ns.to_bytes());
        let handle = self.handles.lock().await.remove(&ns.to_bytes());
        if let Some(doc) = &handle {
            let _ = doc.leave().await;
        }
        Ok(in_book || handle.is_some())
    }

    /// The read tickets of every friend namespace in the book — what the stash grant registers.
    pub fn friend_tickets(&self) -> Vec<String> {
        self.book
            .as_deref()
            .map(|book| book.friends().into_iter().map(|f| f.ticket).collect())
            .unwrap_or_default()
    }

    /// Write a sealed envelope to `ns` under the author's single LWW key (FORWARD-SECRECY §4.4),
    /// superseding the previous fix. Local only: the live engine broadcasts it if the namespace is
    /// syncing, and [`Self::push`] reconciles it with the peers that should have it.
    pub async fn write(&self, ns: NamespaceId, author: &[u8], envelope: Vec<u8>) -> Result<()> {
        let doc = self.doc_for(ns).await?;
        doc.set_bytes(self.author, encode_key(author), envelope)
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

    /// Read the **still-sealed** current envelope per author from both fix lanes, across every
    /// known namespace.
    ///
    /// Opening a ratcheted envelope needs the per-friend session state (FORWARD-SECRECY §4.7),
    /// which lives above this module — so this hands back bytes and lets the caller decide. Skipping the decrypt here also keeps the
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
                    continue; // resync record, or a key an older build left behind
                }
                match self.blobs.blobs().get_bytes(entry.content_hash()).await {
                    Ok(bytes) => out.push(bytes.to_vec()),
                    // Content not local. Not counted here — this runs on every read, and a read
                    // never dials — but it is not left to chance either: every pull settles
                    // these (`settle_stranded`) and reports them on `trail.sync`.
                    Err(_) => continue,
                }
            }
        }
        Ok(out)
    }

    /// Every friend slot (`fix`, `nul`, `rsy`) whose newest entry is here without its bytes.
    ///
    /// Friend namespaces only: we write our own, so its bytes are always local. Presence is asked
    /// of the blob store directly (`has`), which reads no content.
    pub async fn stranded_slots(&self) -> Result<Vec<StrandedSlot>> {
        let mut out = Vec::new();
        for ns in self.namespaces().await {
            if ns == self.own_ns {
                continue;
            }
            let doc = self.doc_for(ns).await?;
            let stream = doc.get_many(Query::single_latest_per_key().build()).await?;
            tokio::pin!(stream);
            while let Some(entry) = stream.next().await {
                let entry = entry?;
                if entry.content_len() == 0 {
                    continue; // a tombstone names no bytes
                }
                let Some(author) = decode_lane_author(entry.key()) else {
                    continue;
                };
                if self.blobs.blobs().has(entry.content_hash()).await? {
                    continue;
                }
                out.push(StrandedSlot {
                    namespace: ns.to_bytes(),
                    author,
                    hash: entry.content_hash(),
                    written_us: entry.timestamp(),
                });
            }
        }
        Ok(out)
    }

    /// Fetch the bytes of every [stranded](StrandedSlot) friend slot, and announce the authors
    /// that became readable.
    ///
    /// The reader-side twin of the stash's settle loop (`repeater/server` `settle_once`), for the
    /// same reason: the docs engine's downloader gets one attempt, against whichever peer handed
    /// the record over, and never retries. On 2026-11-10 an iPhone that kept every friend
    /// namespace live received a friend's entries from the stash in the moment between the record
    /// arriving there and its bytes being uploaded. The attempt failed, and the bytes then landed
    /// on the stash by HTTP, which emits no `ContentReady`. Every later entry raced the same way,
    /// so for 31 hours that friend's dot froze on one phone while another opened all of it, and
    /// nothing anywhere recorded a failure: `read_latest_sealed` skips a slot with no bytes, and
    /// a skipped slot is never offered to the ratchet, so not even a miss was counted.
    ///
    /// Sources per slot: `sources` (the peers this pass dialled — the stash among them), the
    /// slot's author (its `EndpointId` is the key), and whoever last served that author to us.
    /// Each fetch is bounded by `deadline` when there is one and by
    /// [`STRANDED_FETCH_TIMEOUT_SECS`] regardless; a slot still stranded is simply tried again on
    /// the next pull. Failures are expected (a sleeping author, a stash that has not received the
    /// bytes either) and are reported, not raised.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn settle_stranded(
        &self,
        endpoint: &iroh::Endpoint,
        sources: &[iroh::EndpointId],
        deadline: Option<Instant>,
    ) -> Result<SettleReport> {
        let stranded = self.stranded_slots().await?;
        let mut report = SettleReport {
            stranded: stranded.len(),
            ..SettleReport::default()
        };
        if stranded.is_empty() {
            return Ok(report);
        }
        let wait = {
            let cap = Duration::from_secs(STRANDED_FETCH_TIMEOUT_SECS);
            match deadline {
                Some(deadline) => deadline.saturating_duration_since(Instant::now()).min(cap),
                None => cap,
            }
        };
        let now_us = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as u64)
            .unwrap_or(0);
        if wait.is_zero() {
            for slot in &stranded {
                tracing::debug!(
                    sc.author = %crate::telemetry::short_hex(&slot.author),
                    sc.entry_hash = %crate::telemetry::short_hex(slot.hash.as_bytes()),
                    age_ms = now_us.saturating_sub(slot.written_us) / 1000,
                    "stranded friend slot left for the next pull: no time left in this one"
                );
            }
            return Ok(report);
        }

        let mut served_by: HashMap<[u8; 32], [u8; 32]> = HashMap::new();
        {
            let peers = self.serving_peers.lock().await;
            for slot in &stranded {
                if let Some(peer) = peers.get(&slot.author) {
                    served_by.insert(slot.author, peer.peer);
                }
            }
        }
        let own = endpoint.id();
        let downloader = self.blobs.downloader(endpoint);
        let attempts = stranded.iter().map(|slot| {
            let providers = stranded_sources(
                sources,
                slot.author,
                served_by.get(&slot.author).copied(),
                own,
            );
            let downloader = downloader.clone();
            async move {
                if providers.is_empty() {
                    return (slot, Err(anyhow!("no peer to ask")));
                }
                let fetch = timeout(
                    wait,
                    downloader.download(iroh_blobs::HashAndFormat::raw(slot.hash), providers),
                )
                .await;
                let outcome = match fetch {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) => Err(anyhow!("{error}")),
                    Err(_) => Err(anyhow!("timed out after {} ms", wait.as_millis())),
                };
                (slot, outcome)
            }
        });
        for (slot, outcome) in join_all(attempts).await {
            match outcome {
                Ok(()) if self.blobs.blobs().has(slot.hash).await.unwrap_or(false) => {
                    report.fetched += 1;
                    if !report.readable.contains(&slot.author) {
                        report.readable.push(slot.author);
                    }
                    tracing::info!(
                        sc.author = %crate::telemetry::short_hex(&slot.author),
                        sc.entry_hash = %crate::telemetry::short_hex(slot.hash.as_bytes()),
                        age_ms = now_us.saturating_sub(slot.written_us) / 1000,
                        "fetched a stranded friend slot's bytes"
                    );
                }
                Ok(()) => {
                    tracing::debug!(
                        sc.author = %crate::telemetry::short_hex(&slot.author),
                        sc.entry_hash = %crate::telemetry::short_hex(slot.hash.as_bytes()),
                        "stranded slot: download reported done but the bytes are not complete"
                    );
                }
                Err(error) => {
                    tracing::debug!(
                        sc.author = %crate::telemetry::short_hex(&slot.author),
                        sc.entry_hash = %crate::telemetry::short_hex(slot.hash.as_bytes()),
                        age_ms = now_us.saturating_sub(slot.written_us) / 1000,
                        %error,
                        "stranded friend slot still without bytes; will retry next pull"
                    );
                }
            }
        }
        if let (Some(observer), false) = (&self.observer, report.readable.is_empty()) {
            observer.readable(report.readable.clone());
        }
        Ok(report)
    }

    /// Write a sealed **resync record** to `ns` under `rsy/hex(author)` (FORWARD-SECRECY §4.6).
    ///
    /// HPKE-sealed ([`crypto::seal`]) rather than ratcheted, necessarily: this is the message that
    /// re-establishes a ratchet, so it cannot depend on one existing.
    pub async fn write_rsy(&self, ns: NamespaceId, author: &[u8], envelope: Vec<u8>) -> Result<()> {
        let doc = self.doc_for(ns).await?;
        doc.set_bytes(self.author, encode_rsy_key(author), envelope)
            .await?;
        Ok(())
    }

    /// Read + decrypt `author`'s current control record across every known namespace.
    ///
    /// **Only a record `author` signed is returned.** The slot key names an author but proves
    /// nothing — every friend writes its own namespace, and every friend's namespace is scanned
    /// here — so a record is accepted only when the envelope's verified signer is the author the
    /// caller asked for. Without that check any friend C could write `rsy/hex(B)` sealed to us,
    /// carrying C's own prekey, and we would restart our session with B against it: every later
    /// envelope for B would then be readable by C. The prekeys inside a record are not signed
    /// individually; this signature is their only authentication.
    ///
    /// `single_latest_per_key` is load-bearing: the slot is overwritten in place, so a plain
    /// query would resurrect a superseded record and walk the session backwards into a root the
    /// peer has already moved off.
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
            match crypto::open(recv_secret, &bytes) {
                Ok(opened) if opened.author.as_slice() == author => out.push(opened.payload),
                _ => continue,
            }
        }
        Ok(out)
    }

    /// What this replica can **serve**, per author, across every known namespace — metadata only.
    ///
    /// `friend_latest` and the trail cache are APP storage: they keep a fix after its slot was
    /// superseded, pruned or never had its content land, so "we have seen this author's fix" and
    /// "we can hand this author's fix to someone else" are genuinely different questions.
    /// Reconciliation serves out of the replica, and only this answers the second.
    ///
    /// **No decryption.** `seq` and `fix_ts` come from the envelope's signed-but-plaintext header
    /// via [`crypto::envelope_header`] — a signature check, not an unwrap — so this reports
    /// presence for every author in the replica including the ones whose payloads are not
    /// addressed to us. The fix lane only (`hex(author)/fix`); null and resync slots are not the
    /// thing a relay is asked to serve.
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
                    None => continue, // null, resync, or a key an older build left behind
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
    /// settle. Pull-only plumbing: decrypt/read happens afterwards via
    /// [`Self::read_latest_sealed`], and the namespace's watch task reports what landed.
    ///
    /// Returns every `(serving peer, author)` delivered into the replica during the pass, for
    /// `peer.contact` (see [`crate::contact::tally_pull`]), and how the wait ended.
    ///
    /// `deadline` caps the whole wait. Stopping early is safe: dropping the subscription only stops
    /// us WATCHING — the live engine keeps the namespace syncing and lands whatever arrives later.
    async fn sync_ns(
        &self,
        ns: NamespaceId,
        peers: Vec<EndpointAddr>,
        deadline: Option<Instant>,
    ) -> Result<(Vec<([u8; 32], [u8; 32])>, SyncEnd)> {
        let doc = self.doc_for(ns).await?;
        let mut events = doc.subscribe().await?;
        let asked: std::collections::HashSet<_> = peers.iter().map(|peer| peer.id).collect();
        doc.start_sync(peers).await?;

        // Bound the reconciliation: with no reachable peer `SyncFinished` may never arrive, which
        // would hang this call forever. The first event gets a longer grace period — a cold node's
        // dial (net_report + hole-punch or relay fallback) routinely outlasts the idle gap.
        let mut saw_event = false;
        // `PendingContentReady` follows EVERY `SyncFinished`, including one for an exchange that
        // was aborted or failed: iroh-docs emits it at once when nothing is queued. A namespace in
        // the live engine is reconciled with gossip neighbours as well as the peers asked for, and
        // two of those exchanges racing make one abort (`AlreadySyncing`), so the first
        // `PendingContentReady` could arrive before the asked-for exchange had delivered anything.
        // It is believed once an asked-for peer has finished an exchange cleanly, or once every
        // asked-for peer has failed for a reason other than that race (so a pass that reached no
        // one still ends as promptly as it used to). On the iroh 1.4 bump (2026-11-02) this race
        // decided loopback tests a few milliseconds apart.
        let mut asked_peer_synced = asked.is_empty();
        let mut asked_failed = std::collections::HashSet::new();
        let mut delivered: Vec<([u8; 32], [u8; 32])> = Vec::new();
        loop {
            let remaining = deadline.map(|d| d.saturating_duration_since(Instant::now()));
            let (wait, deadline_bound) = next_wait(saw_event, remaining);
            if deadline_bound && wait.is_zero() {
                return Ok((delivered, SyncEnd::Deadline));
            }
            match timeout(wait, events.next()).await {
                // All reconciled entries have their content locally — the clean finish.
                Ok(Some(Ok(LiveEvent::PendingContentReady)))
                    if asked_peer_synced || asked_failed.len() == asked.len() =>
                {
                    return Ok((delivered, SyncEnd::ContentReady))
                }
                Ok(Some(Ok(LiveEvent::SyncFinished(ev)))) => {
                    saw_event = true;
                    if asked.contains(&ev.peer) {
                        match &ev.result {
                            Ok(_) => asked_peer_synced = true,
                            // The loser of two exchanges with the same peer; the winner reports
                            // for it. (iroh-docs flattens the reason into the message.)
                            Err(error) if error.contains("AlreadySyncing") => {}
                            Err(_) => {
                                asked_failed.insert(ev.peer);
                            }
                        }
                    }
                }
                // The one place a peer is named per entry. `read_latest_sealed` reads the replica
                // afterwards and cannot tell a freshly delivered slot from one that was already
                // there, so provenance has to be captured here, as it arrives.
                Ok(Some(Ok(LiveEvent::InsertRemote { from, entry, .. }))) => {
                    saw_event = true;
                    let mut peers = self.serving_peers.lock().await;
                    if let Some(author) = record_serving_peer(
                        &mut peers,
                        entry.key(),
                        *from.as_bytes(),
                        entry.timestamp(),
                    ) {
                        delivered.push((*from.as_bytes(), author));
                    }
                }
                Ok(Some(Ok(_))) => saw_event = true,
                Ok(Some(Err(_))) | Ok(None) => return Ok((delivered, SyncEnd::Closed)),
                // Timed out — settle for what transferred, and say which clock ran out.
                Err(_) => return Ok((delivered, timeout_end(saw_event, deadline_bound))),
            }
        }
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
    ///
    /// `budget` is a deadline, not a wait: the exchange ends as soon as every dialled peer has
    /// reported. With no peers the namespace is still handed to the live engine, and nothing is
    /// waited for.
    pub async fn push(
        &self,
        ns: NamespaceId,
        peers: Vec<EndpointAddr>,
        budget: Duration,
    ) -> Result<Option<PushReport>> {
        use tracing::Instrument;
        // The phases of a push are spans of their own (`trail.push.open`, `.start_sync`, `.wait`)
        // because the deadline below bounds only the wait: on 2026-11-08 `trail.push` spans ran
        // 35-82 s (one 447 s) against a 30 s budget with every peer's `latency_ms` under 30 s, and
        // nothing could say where the rest went.
        let (doc, mut events) = async {
            let doc = self.doc_for(ns).await?;
            let events = doc.subscribe().await?;
            anyhow::Ok((doc, events))
        }
        .instrument(tracing::info_span!("trail.push.open"))
        .await?;

        let mut pending: std::collections::HashSet<[u8; 32]> =
            peers.iter().map(|addr| *addr.id.as_bytes()).collect();

        let mut report = PushReport::default();
        let dialled = peers.len();
        doc.start_sync(peers)
            .instrument(tracing::info_span!(
                "trail.push.start_sync",
                peers = dialled
            ))
            .await?;
        if dialled == 0 {
            return Ok(Some(report));
        }

        // The budget starts once the exchange is under way, as it always has; `latency_ms` is
        // measured from here too.
        let started_at = Instant::now();
        let deadline = started_at + budget;
        let wait = tracing::info_span!(
            "trail.push.wait",
            budget_ms = budget.as_millis() as u64,
            ended = tracing::field::Empty,
            events = tracing::field::Empty,
            pending = tracing::field::Empty,
        );
        let mut events_seen: u64 = 0;
        let mut ended = "all-reported";
        let waited = async {
            while !pending.is_empty() {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    ended = "deadline";
                    break;
                }
                let next = timeout(remaining, events.next()).await;
                events_seen += 1;
                match next {
                    Ok(Some(Ok(LiveEvent::SyncFinished(ev)))) => {
                        let peer = *ev.peer.as_bytes();
                        let latency_ms = started_at.elapsed().as_millis() as u64;
                        // A peer this push did not dial can still report — the live engine may be
                        // reconciling with it from an earlier `start_sync`. Record it all the same.
                        pending.remove(&peer);
                        match &ev.result {
                            Ok(details) => {
                                let sent = details.entries_sent as u64;
                                report.entries_sent += sent;
                                report.peers_finished += 1;
                                report.per_peer.push(PeerPushOutcome {
                                    peer,
                                    outcome: PeerOutcome::Finished,
                                    latency_ms: Some(latency_ms),
                                    entries_sent: sent,
                                });
                            }
                            Err(err) => {
                                // One unreachable peer isn't the end of the exchange — keep waiting
                                // for the others rather than reporting the whole push as done.
                                tracing::warn!(
                                    peer = %ev.peer.fmt_short(),
                                    error = %err,
                                    latency_ms,
                                    "trail.push: reconciliation with peer failed"
                                );
                                report.peers_failed += 1;
                                report.per_peer.push(PeerPushOutcome {
                                    peer,
                                    outcome: PeerOutcome::Failed,
                                    latency_ms: Some(latency_ms),
                                    entries_sent: 0,
                                });
                            }
                        }
                    }
                    Ok(Some(Ok(_))) => continue,
                    Ok(Some(Err(err))) => {
                        ended = "stream-error";
                        return Err(err);
                    }
                    // Stream ended, or the deadline passed. Either way the peers still
                    // in `pending` never spoke. The namespace stays marked syncing, so later writes in
                    // this process broadcast — we just cannot confirm them here.
                    Ok(None) => {
                        ended = "stream-ended";
                        break;
                    }
                    Err(_) => {
                        ended = "deadline";
                        break;
                    }
                }
            }
            anyhow::Ok(())
        }
        .instrument(wait.clone())
        .await;
        wait.record("ended", ended);
        wait.record("events", events_seen);
        wait.record("pending", pending.len() as u64);
        waited?;

        let outstanding: Vec<[u8; 32]> = pending.into_iter().collect();
        report.per_peer = finish_outcomes(report.per_peer, &outstanding);
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
    /// [`Self::read_latest_sealed`].
    ///
    /// A namespace that fails is logged and skipped rather than aborting the run: these are
    /// independent replicas, and short-circuiting on the first error meant one friend whose doc
    /// couldn't be opened silently blocked the refresh for everyone after them in the map.
    ///
    /// Returns every `(serving peer, author)` delivered across all namespaces, for `peer.contact`.
    /// The web replica's refresh; the mobile node goes through [`Self::sync_all_until`].
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    pub async fn sync_all(&self, peers: Vec<EndpointAddr>) -> Result<Vec<([u8; 32], [u8; 32])>> {
        Ok(self.sync_all_until(peers, None).await?.delivered)
    }

    /// [`Self::sync_all`], stopped at `deadline` when one is given, reporting how each namespace's
    /// wait ended.
    ///
    /// The deadline exists for the background callers: one pass can wait 25 s for a first event
    /// and then 8 s per idle gap, which is the whole of an iOS background window. A pass cut short
    /// keeps everything that had already arrived.
    pub async fn sync_all_until(
        &self,
        peers: Vec<EndpointAddr>,
        deadline: Option<Instant>,
    ) -> Result<SyncPass> {
        let namespaces = self.namespaces().await;
        // CONCURRENTLY, not one after another. Every namespace that nobody answers for costs the
        // full `SYNC_FIRST_EVENT_TIMEOUT_SECS`, and a serial loop multiplied that by the friend
        // count: measured 2026-09-10, a phone with six namespaces spent 150s inside a single
        // `sync_latest` and one with five spent 217s, all of it waiting on peers asleep in a
        // pocket. The namespaces are independent replicas reconciled against the same peer set —
        // there is no ordering between them — so the pass now costs ONE timeout, not N.
        let results = join_all(namespaces.iter().map(|ns| {
            let peers = peers.clone();
            async move { (*ns, self.sync_ns(*ns, peers, deadline).await) }
        }))
        .await;

        let mut pass = SyncPass {
            namespaces: namespaces.len(),
            ..SyncPass::default()
        };
        for (ns, result) in &results {
            if let Ok((from_ns, end)) = result {
                pass.delivered.extend_from_slice(from_ns);
                pass.ends.tally(*end);
            }
            if let Err(err) = result {
                pass.failed += 1;
                tracing::warn!(
                    sc.namespace = %crate::telemetry::short_hex(&ns.to_bytes()),
                    error = %err,
                    "trail.sync: namespace failed; continuing with the rest"
                );
            }
        }
        // Only a total wipeout is an error worth failing the call for — otherwise the caller gets
        // whatever was reachable, which is the point of a best-effort refresh.
        if pass.failed > 0 && pass.failed == namespaces.len() {
            return Err(anyhow!(
                "all {} trail namespaces failed to sync",
                pass.failed
            ));
        }
        Ok(pass)
    }
}

/// How one namespace's reconciliation wait ended.
///
/// The cost of a pull is almost all waiting, and these say what was waited on: `NoAnswer` is a
/// namespace nobody answered for at all (the full first-event timeout, spent on peers asleep in a
/// pocket), `Idle` is one that transferred and then went quiet, `Deadline` is the caller's budget
/// running out first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncEnd {
    /// `PendingContentReady`: every reconciled entry has its content locally. The clean finish.
    ContentReady,
    /// The event stream closed or errored.
    Closed,
    /// Events flowed, then none for [`SYNC_IDLE_TIMEOUT_SECS`].
    Idle,
    /// No event at all within [`SYNC_FIRST_EVENT_TIMEOUT_SECS`].
    NoAnswer,
    /// The caller's deadline arrived before either timeout.
    Deadline,
}

/// Namespaces per [`SyncEnd`], for one pass.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SyncEnds {
    pub content_ready: usize,
    pub closed: usize,
    pub idle: usize,
    pub no_answer: usize,
    pub deadline: usize,
}

impl SyncEnds {
    pub fn tally(&mut self, end: SyncEnd) {
        match end {
            SyncEnd::ContentReady => self.content_ready += 1,
            SyncEnd::Closed => self.closed += 1,
            SyncEnd::Idle => self.idle += 1,
            SyncEnd::NoAnswer => self.no_answer += 1,
            SyncEnd::Deadline => self.deadline += 1,
        }
    }
}

/// One [`TrailDocs::sync_all_until`] pass.
#[derive(Debug, Default, Clone)]
pub struct SyncPass {
    /// Every `(serving peer, author)` delivered into the replica.
    pub delivered: Vec<([u8; 32], [u8; 32])>,
    /// Namespaces attempted.
    pub namespaces: usize,
    /// Namespaces that errored before they could wait at all.
    pub failed: usize,
    /// How the rest ended.
    pub ends: SyncEnds,
}

/// How long to wait for the next event, and whether the caller's deadline is what bounds it.
fn next_wait(saw_event: bool, remaining: Option<Duration>) -> (Duration, bool) {
    let natural = Duration::from_secs(if saw_event {
        SYNC_IDLE_TIMEOUT_SECS
    } else {
        SYNC_FIRST_EVENT_TIMEOUT_SECS
    });
    match remaining {
        Some(left) if left <= natural => (left, true),
        _ => (natural, false),
    }
}

/// Which clock ran out when a wait timed out.
fn timeout_end(saw_event: bool, deadline_bound: bool) -> SyncEnd {
    if deadline_bound {
        SyncEnd::Deadline
    } else if saw_event {
        SyncEnd::Idle
    } else {
        SyncEnd::NoAnswer
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // ── pull deadline ────────────────────────────────────────────────────────────────────

    #[test]
    fn no_deadline_keeps_the_natural_timeouts() {
        assert_eq!(
            next_wait(false, None),
            (Duration::from_secs(SYNC_FIRST_EVENT_TIMEOUT_SECS), false)
        );
        assert_eq!(
            next_wait(true, None),
            (Duration::from_secs(SYNC_IDLE_TIMEOUT_SECS), false)
        );
    }

    #[test]
    fn a_generous_deadline_does_not_shorten_the_wait() {
        let far = Duration::from_secs(SYNC_FIRST_EVENT_TIMEOUT_SECS + 60);
        assert_eq!(
            next_wait(false, Some(far)),
            (Duration::from_secs(SYNC_FIRST_EVENT_TIMEOUT_SECS), false)
        );
    }

    #[test]
    fn a_near_deadline_bounds_the_wait_and_says_so() {
        let near = Duration::from_millis(1_500);
        assert_eq!(next_wait(false, Some(near)), (near, true));
        assert_eq!(next_wait(true, Some(near)), (near, true));
        // Exhausted: a zero wait the caller turns into `Deadline` without polling at all.
        assert_eq!(
            next_wait(true, Some(Duration::ZERO)),
            (Duration::ZERO, true)
        );
    }

    #[test]
    fn a_timeout_names_the_clock_that_ran_out() {
        // The deadline wins even after events flowed: it is what stopped us.
        assert_eq!(timeout_end(true, true), SyncEnd::Deadline);
        assert_eq!(timeout_end(false, true), SyncEnd::Deadline);
        assert_eq!(timeout_end(true, false), SyncEnd::Idle);
        assert_eq!(timeout_end(false, false), SyncEnd::NoAnswer);
    }

    #[test]
    fn sync_ends_tally_each_kind_separately() {
        let mut ends = SyncEnds::default();
        for end in [
            SyncEnd::ContentReady,
            SyncEnd::ContentReady,
            SyncEnd::Closed,
            SyncEnd::Idle,
            SyncEnd::NoAnswer,
            SyncEnd::Deadline,
        ] {
            ends.tally(end);
        }
        assert_eq!(
            ends,
            SyncEnds {
                content_ready: 2,
                closed: 1,
                idle: 1,
                no_answer: 1,
                deadline: 1,
            }
        );
    }

    // ── key encoding round-trip ──────────────────────────────────────────────────────────
    // ── per-peer push accounting ─────────────────────────────────────────────────────────

    fn finished(peer: [u8; 32], latency_ms: u64, entries: u64) -> PeerPushOutcome {
        PeerPushOutcome {
            peer,
            outcome: PeerOutcome::Finished,
            latency_ms: Some(latency_ms),
            entries_sent: entries,
        }
    }

    #[test]
    fn silent_peers_are_recorded_even_when_nobody_answered() {
        // The most informative row there is: every peer stayed quiet. An earlier draft returned
        // `None` here and threw the whole push away.
        let a = [0xaau8; 32];
        let b = [0xbbu8; 32];
        let out = finish_outcomes(Vec::new(), &[a, b]);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|p| p.outcome == PeerOutcome::Silent));
        assert!(out.iter().all(|p| p.latency_ms.is_none()));
    }

    #[test]
    fn answered_peers_keep_their_latency_and_entries() {
        let peer = [0x07u8; 32];
        let out = finish_outcomes(vec![finished(peer, 913, 3)], &[]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].latency_ms, Some(913));
        assert_eq!(out[0].entries_sent, 3);
        assert_eq!(out[0].outcome, PeerOutcome::Finished);
    }

    #[test]
    fn every_dialled_peer_appears_exactly_once() {
        // The measured shape: stash and one friend answer, one parked phone never does.
        let stash = [0x10u8; 32];
        let awake = [0x20u8; 32];
        let asleep = [0x30u8; 32];
        let out = finish_outcomes(
            vec![finished(stash, 800, 1), finished(awake, 1_100, 1)],
            &[asleep],
        );
        assert_eq!(out.len(), 3);
        let mut peers: Vec<[u8; 32]> = out.iter().map(|p| p.peer).collect();
        let sorted = {
            let mut copy = peers.clone();
            copy.sort_unstable();
            copy
        };
        assert_eq!(peers, sorted, "outcomes must be in a stable order");
        peers.dedup();
        assert_eq!(peers.len(), 3, "no peer may be double-counted");
        assert_eq!(
            out.iter()
                .filter(|p| p.outcome == PeerOutcome::Silent)
                .count(),
            1
        );
    }

    #[test]
    fn outcome_names_are_stable() {
        // Dashboards and the TraceQL cookbook match on these `peer.outcome` strings.
        assert_eq!(PeerOutcome::Finished.as_str(), "finished");
        assert_eq!(PeerOutcome::Failed.as_str(), "failed");
        assert_eq!(PeerOutcome::Silent.as_str(), "silent");
    }

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

    /// A resync entry, or a retired control entry an older build left behind, says nothing about
    /// who delivered a location.
    #[test]
    fn serving_peer_ignores_non_fix_lanes() {
        let author = [0x22u8; 32];
        let peer = [0x33u8; 32];
        let mut peers = HashMap::new();
        let retired_ctl = format!("ctl/{}", hex_encode(&author)).into_bytes();
        record_serving_peer(&mut peers, &retired_ctl, peer, 10);
        record_serving_peer(&mut peers, &encode_rsy_key(&author), peer, 10);
        record_serving_peer(&mut peers, b"abab/00000000000000000001", peer, 10);
        assert!(peers.is_empty());
    }

    /// A retired `ctl/hex(author)` entry is still in replicas written by older builds, and fix
    /// readers must keep skipping it untouched.
    #[test]
    fn fix_readers_ignore_retired_control_keys() {
        let author = [0x11u8; 32];
        let ctl = format!("ctl/{}", hex_encode(&author)).into_bytes();
        assert!(decode_key(&ctl).is_none());
        assert!(decode_nul_key(&ctl).is_none());
    }

    /// The null lane must be invisible to fix readers and must not collide with the fix lane —
    /// the whole point of giving it its own key is that a tick's two envelopes, wrapped for
    /// disjoint recipient sets, both survive.
    #[test]
    fn null_keys_are_their_own_lane() {
        let author = [0x11u8; 32];
        let nul = encode_nul_key(&author);
        assert!(decode_key(&nul).is_none());
        assert_ne!(nul, encode_key(&author));
        assert_ne!(nul, encode_rsy_key(&author));
    }

    /// One overwritten slot per author, same as the fix lane.
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

    // ── revocation carries over to the replica (reuses crypto.rs) ─────────────────────────────
    // The replica stores sealed bytes, so an envelope written to docs still decrypts for a
    // recipient and is opaque to a non-recipient / revoked peer.
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
    // namespace and orphaned every friend's stored read-ticket, so every friend read a namespace
    // nobody wrote again. These tests pin the reuse behaviour.

    use iroh::{Endpoint, RelayMode, SecretKey};
    use iroh_blobs::store::fs::FsStore;
    use iroh_gossip::net::Gossip;

    /// A live docs node over `data_dir`. Holds the endpoint/gossip alive so the persistent docs
    /// store stays open for the duration of a test (init is local-only — no network sync).
    ///
    /// `pub(crate)` so `profile`'s tests can stand a replica up the same way rather than keeping
    /// a second copy of this in step with it.
    pub(crate) struct DocsFixture {
        pub(crate) docs: Docs,
        pub(crate) blobs: BlobsStore,
        _endpoint: Endpoint,
        _gossip: Gossip,
    }

    pub(crate) async fn spawn_docs(data_dir: &std::path::Path) -> DocsFixture {
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

    pub(crate) fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sc-trail-ns-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── LWW: a second publish leaves exactly one readable entry per author ───────────────────
    // The FORWARD-SECRECY.md §7 step 1 acceptance test: the replica answers "current fix",
    // never history. `read_latest_sealed` must yield one entry per author, carrying the newest
    // seq, and the null and resync lanes beside it must not read as fixes.
    #[tokio::test]
    async fn second_publish_leaves_one_readable_entry_per_author() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;

        let dir = scratch_dir("lww");
        let fx = spawn_docs(&dir).await;
        let td = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone(), None, None)
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

        let latest = td.read_latest_sealed().await.unwrap();
        assert_eq!(
            latest.len(),
            1,
            "one readable entry per author, not history"
        );
        let bytes = &latest[0];
        assert_eq!(crypto::envelope_header(bytes).unwrap().author, author);
        let opened = crypto::open(&b_sk, bytes).unwrap();
        assert_eq!(opened.seq, 2, "the second publish supersedes the first");
        assert_eq!(opened.payload.as_slice(), b"second");

        // A resync record in the same namespace is not a fix.
        let rsy = crypto::seal(&seed, &author, 0, 3000, 0, b"rsy-record", &[b_pk]).unwrap();
        td.write_rsy(ns, &author, rsy).await.unwrap();
        assert_eq!(
            td.read_latest_sealed().await.unwrap().len(),
            1,
            "resync records must not read as fixes"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── a control record is authenticated by its signer, never by its slot ──────────────────
    //
    // Three parties: we (A) are friends with B and C. C writes a record into a slot named for B,
    // sealed to us and carrying C's prekey. Accepting it would make us restart our session with
    // B against a key C holds, and C — who replicates our namespace as a friend — could then
    // open every envelope we seal for B. The slot key is chosen by the writer; only the
    // signature says who wrote it.
    #[tokio::test]
    async fn a_control_record_is_read_only_from_the_author_it_names() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;

        let dir = scratch_dir("rsy-binding");
        let fx = spawn_docs(&dir).await;
        let td = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone(), None, None)
            .await
            .unwrap();
        let ns = td.own_namespace();
        let (a_sk, a_pk) = crypto::generate_recv_keypair();

        let b = SigningKey::generate(&mut OsRng);
        let b_author = b.verifying_key().to_bytes();
        let c = SigningKey::generate(&mut OsRng);
        let c_author = c.verifying_key().to_bytes();

        // C's forgery: a valid envelope (C signed it, as C) in B's slot, sealed to A.
        let forged = crypto::seal(
            &c.to_bytes(),
            &c_author,
            0,
            1_000,
            0,
            b"c's prekey, claiming to be b's",
            &[a_pk.clone()],
        )
        .unwrap();
        td.write_rsy(ns, &b_author, forged).await.unwrap();
        assert!(
            td.read_rsy(&b_author, &a_sk).await.unwrap().is_empty(),
            "a record C signed must never be read as B's control record"
        );

        // B's own record in the same slot is read.
        let genuine = crypto::seal(
            &b.to_bytes(),
            &b_author,
            0,
            2_000,
            0,
            b"b's prekey",
            &[a_pk.clone()],
        )
        .unwrap();
        td.write_rsy(ns, &b_author, genuine).await.unwrap();
        let read = td.read_rsy(&b_author, &a_sk).await.unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].as_slice(), b"b's prekey");

        // And C's record is still C's: asking for C does not return B's.
        let c_own = crypto::seal(
            &c.to_bytes(),
            &c_author,
            0,
            3_000,
            0,
            b"c's prekey",
            &[a_pk],
        )
        .unwrap();
        td.write_rsy(ns, &c_author, c_own).await.unwrap();
        let read = td.read_rsy(&c_author, &a_sk).await.unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].as_slice(), b"c's prekey");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn trail_namespace_is_stable_across_reinit() {
        let dir = scratch_dir("stable");
        let fx = spawn_docs(&dir).await;

        let first = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone(), None, None)
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
        let second = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone(), None, None)
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
        let ns_a = TrailDocs::init(fx1.docs.clone(), fx1.blobs.clone(), d1.clone(), None, None)
            .await
            .unwrap()
            .own_namespace();
        let fx2 = spawn_docs(&d2).await;
        let ns_b = TrailDocs::init(fx2.docs.clone(), fx2.blobs.clone(), d2.clone(), None, None)
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
        let td = TrailDocs::init(fx.docs.clone(), fx.blobs.clone(), dir.clone(), None, None)
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

    // ── the namespace book: what a start reopens, kept out of the replica's directory ────────
    //
    // 2026-10-05: a Pixel's node, started by the native runtime with no JS, reconciled only its
    // own namespace, and that same start rotated its own namespace — so neither side could reach
    // the other until a re-pair. These pin the book that replaces both behaviours.

    fn book(state_dir: &std::path::Path) -> Arc<NamespaceBook> {
        Arc::new(NamespaceBook::open(state_dir, ns_book::TRAIL_BOOK_FILE).unwrap())
    }

    #[tokio::test]
    async fn own_namespace_survives_a_wiped_replica() {
        let state = scratch_dir("book-wipe-state");
        let first_replica = scratch_dir("book-wipe-a");
        let fx = spawn_docs(&first_replica).await;
        let ns = TrailDocs::init(
            fx.docs.clone(),
            fx.blobs.clone(),
            first_replica.clone(),
            Some(book(&state)),
            None,
        )
        .await
        .unwrap()
        .own_namespace();

        // The cache directory is purged: a brand-new replica, the same state_dir.
        let wiped = scratch_dir("book-wipe-b");
        let fx2 = spawn_docs(&wiped).await;
        let td = TrailDocs::init(
            fx2.docs.clone(),
            fx2.blobs.clone(),
            wiped.clone(),
            Some(book(&state)),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            td.own_namespace(),
            ns,
            "a wiped replica must come back as the SAME namespace"
        );

        // And it is writable, not a read-only shell: we still hold the secret.
        let author = [7u8; 32];
        td.write(ns, &author, b"after the wipe".to_vec())
            .await
            .expect("our own namespace must stay writable after a wipe");

        for dir in [state, first_replica, wiped] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn a_legacy_install_keeps_its_namespace_and_saves_its_secret() {
        let state = scratch_dir("book-legacy-state");
        let replica = scratch_dir("book-legacy");
        let fx = spawn_docs(&replica).await;
        // An install from before the book: the id file is the only record.
        let legacy = TrailDocs::init(
            fx.docs.clone(),
            fx.blobs.clone(),
            replica.clone(),
            None,
            None,
        )
        .await
        .unwrap()
        .own_namespace();

        let book = book(&state);
        let upgraded = TrailDocs::init(
            fx.docs.clone(),
            fx.blobs.clone(),
            replica.clone(),
            Some(book.clone()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            upgraded.own_namespace(),
            legacy,
            "the upgrade must not rotate the namespace"
        );
        assert!(
            book.own_secret().is_some(),
            "the upgrade must copy the secret into the book"
        );

        // From then on even a wipe keeps it.
        let wiped = scratch_dir("book-legacy-wiped");
        let fx2 = spawn_docs(&wiped).await;
        let after = TrailDocs::init(
            fx2.docs.clone(),
            fx2.blobs.clone(),
            wiped.clone(),
            Some(book),
            None,
        )
        .await
        .unwrap();
        assert_eq!(after.own_namespace(), legacy);

        for dir in [state, replica, wiped] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn friend_namespaces_are_reopened_on_the_next_start() {
        let friend_dir = scratch_dir("book-friend-theirs");
        let friend_fx = spawn_docs(&friend_dir).await;
        let friend = TrailDocs::init(
            friend_fx.docs.clone(),
            friend_fx.blobs.clone(),
            friend_dir.clone(),
            None,
            None,
        )
        .await
        .unwrap();
        let ticket = friend.read_ticket(friend.own_namespace()).await.unwrap();

        let state = scratch_dir("book-friend-state");
        let replica = scratch_dir("book-friend-ours");
        let fx = spawn_docs(&replica).await;
        let ours = TrailDocs::init(
            fx.docs.clone(),
            fx.blobs.clone(),
            replica.clone(),
            Some(book(&state)),
            None,
        )
        .await
        .unwrap();
        let theirs = ours.import_ticket(&ticket).await.unwrap();
        assert_eq!(ours.friend_tickets(), vec![ticket.clone()]);

        // A start with nobody calling `import_ticket` — the native runtime's start.
        let restarted = TrailDocs::init(
            fx.docs.clone(),
            fx.blobs.clone(),
            replica.clone(),
            Some(book(&state)),
            None,
        )
        .await
        .unwrap();
        assert!(
            restarted.namespaces().await.contains(&theirs),
            "a start must reconcile every friend it had, not only its own namespace"
        );

        // Even from a wiped replica: an empty read replica that the next sync refills.
        let wiped = scratch_dir("book-friend-wiped");
        let fx2 = spawn_docs(&wiped).await;
        let rebuilt = TrailDocs::init(
            fx2.docs.clone(),
            fx2.blobs.clone(),
            wiped.clone(),
            Some(book(&state)),
            None,
        )
        .await
        .unwrap();
        assert!(rebuilt.namespaces().await.contains(&theirs));

        // Forgetting a removed friend keeps every later start from reopening them.
        assert!(rebuilt.forget_ticket(&ticket).await.unwrap());
        assert!(!rebuilt.namespaces().await.contains(&theirs));
        assert!(rebuilt.friend_tickets().is_empty());
        let after_forget = TrailDocs::init(
            fx2.docs.clone(),
            fx2.blobs.clone(),
            wiped.clone(),
            Some(book(&state)),
            None,
        )
        .await
        .unwrap();
        assert!(!after_forget.namespaces().await.contains(&theirs));

        for dir in [friend_dir, state, replica, wiped] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[tokio::test]
    async fn our_own_ticket_is_never_booked_as_a_friend() {
        let state = scratch_dir("book-self-state");
        let replica = scratch_dir("book-self");
        let fx = spawn_docs(&replica).await;
        let td = TrailDocs::init(
            fx.docs.clone(),
            fx.blobs.clone(),
            replica.clone(),
            Some(book(&state)),
            None,
        )
        .await
        .unwrap();
        let own = td.read_ticket(td.own_namespace()).await.unwrap();
        td.import_ticket(&own).await.unwrap();
        assert!(td.friend_tickets().is_empty());
        assert!(
            !td.forget_ticket(&own).await.unwrap(),
            "our own namespace is not forgettable"
        );
        assert!(td.namespaces().await.contains(&td.own_namespace()));
        for dir in [state, replica] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn an_unreadable_book_refuses_rather_than_starting_over() {
        // Treating it as empty would mint a new own namespace — the failure the book exists for.
        let state = scratch_dir("book-corrupt");
        std::fs::write(state.join(ns_book::TRAIL_BOOK_FILE), b"\xff\xff not a book").unwrap();
        assert!(NamespaceBook::open(&state, ns_book::TRAIL_BOOK_FILE).is_err());
        let _ = std::fs::remove_dir_all(&state);
    }

    // ── The replica watch ─────────────────────────────────────────────────────────────────────
    //
    // The docs-only transport's one receive path: every entry a peer hands a friend namespace is
    // reported once, and its author is announced once the content is local — never before, or
    // the app's read would find an entry it cannot open yet and report nothing.

    #[derive(Default)]
    struct Seen {
        delivered: std::sync::Mutex<Vec<([u8; 32], [u8; 32])>>,
        readable: std::sync::Mutex<Vec<Vec<[u8; 32]>>>,
    }

    impl Seen {
        fn readable(&self) -> Vec<Vec<[u8; 32]>> {
            self.readable.lock().unwrap().clone()
        }

        fn times_readable(&self, author: [u8; 32]) -> usize {
            self.readable()
                .iter()
                .filter(|report| report.contains(&author))
                .count()
        }

        fn delivered(&self) -> Vec<([u8; 32], [u8; 32])> {
            self.delivered.lock().unwrap().clone()
        }
    }

    impl ReplicaObserver for Seen {
        fn delivered(&self, deliveries: Vec<([u8; 32], [u8; 32])>) {
            self.delivered.lock().unwrap().extend(deliveries);
        }

        fn readable(&self, authors: Vec<[u8; 32]>) {
            self.readable.lock().unwrap().push(authors);
        }
    }

    const PEER: [u8; 32] = [1; 32];
    const MAYA: [u8; 32] = [2; 32];
    const JUNE: [u8; 32] = [3; 32];

    fn flushed(batch: &mut WatchBatch) -> Seen {
        let seen = Seen::default();
        batch.flush(&seen);
        seen
    }

    #[test]
    fn an_entry_whose_content_is_local_is_readable_at_once() {
        let mut batch = WatchBatch::default();
        batch.insert(PEER, MAYA, Hash::new(b"one"), ContentStatus::Complete);
        assert!(batch.pending());
        let seen = flushed(&mut batch);
        assert_eq!(seen.delivered(), vec![(PEER, MAYA)]);
        assert_eq!(seen.readable(), vec![vec![MAYA]]);
    }

    #[test]
    fn an_entry_is_readable_only_once_its_content_lands() {
        let mut batch = WatchBatch::default();
        let hash = Hash::new(b"one");
        batch.insert(PEER, MAYA, hash, ContentStatus::Missing);
        let seen = flushed(&mut batch);
        assert_eq!(
            seen.delivered(),
            vec![(PEER, MAYA)],
            "the delivery counts now"
        );
        assert!(seen.readable().is_empty(), "but nothing is readable yet");
        assert!(!batch.pending());

        batch.content_ready(Hash::new(b"someone else's"));
        assert!(!batch.pending(), "unrelated content completes nothing");
        batch.content_ready(hash);
        let seen = flushed(&mut batch);
        assert!(seen.delivered().is_empty(), "a delivery is reported once");
        assert_eq!(seen.readable(), vec![vec![MAYA]]);

        batch.content_ready(hash);
        assert!(!batch.pending(), "and an author once per entry");
    }

    #[test]
    fn a_newer_entry_replaces_the_wait() {
        let mut batch = WatchBatch::default();
        let (old, new) = (Hash::new(b"old"), Hash::new(b"new"));
        batch.insert(PEER, MAYA, old, ContentStatus::Incomplete);
        batch.insert(PEER, MAYA, new, ContentStatus::Missing);
        flushed(&mut batch);
        batch.content_ready(old);
        assert!(
            !batch.pending(),
            "the superseded entry's content is not the newest entry's"
        );
        batch.content_ready(new);
        assert_eq!(flushed(&mut batch).readable(), vec![vec![MAYA]]);
    }

    #[test]
    fn a_newer_complete_entry_ends_an_older_wait() {
        let mut batch = WatchBatch::default();
        let old = Hash::new(b"old");
        batch.insert(PEER, MAYA, old, ContentStatus::Missing);
        batch.insert(PEER, MAYA, Hash::new(b"new"), ContentStatus::Complete);
        assert_eq!(flushed(&mut batch).readable(), vec![vec![MAYA]]);
        batch.content_ready(old);
        assert!(!batch.pending(), "nothing is still waiting on the old hash");
    }

    #[test]
    fn an_author_is_announced_once_per_report_however_many_entries_land() {
        let mut batch = WatchBatch::default();
        batch.insert(PEER, MAYA, Hash::new(b"fix"), ContentStatus::Complete);
        batch.insert(PEER, MAYA, Hash::new(b"null"), ContentStatus::Complete);
        batch.insert(PEER, JUNE, Hash::new(b"june"), ContentStatus::Complete);
        let seen = flushed(&mut batch);
        assert_eq!(seen.delivered().len(), 3, "every delivery is evidence");
        assert_eq!(seen.readable(), vec![vec![MAYA, JUNE]]);
    }

    #[test]
    fn an_empty_batch_reports_nothing_and_a_full_one_says_so() {
        let mut batch = WatchBatch::default();
        let seen = flushed(&mut batch);
        assert!(seen.delivered().is_empty() && seen.readable().is_empty());
        for i in 0..REPLICA_FLUSH_AT {
            assert!(!batch.full());
            batch.insert(
                PEER,
                MAYA,
                Hash::new(i.to_le_bytes()),
                ContentStatus::Missing,
            );
        }
        assert!(batch.full());
        flushed(&mut batch);
        assert!(!batch.full() && !batch.pending());
    }

    /// A replica on a real endpoint that serves docs, blobs and gossip — what two phones are.
    struct LiveReplica {
        td: TrailDocs,
        endpoint: Endpoint,
        _router: iroh::protocol::Router,
    }

    async fn live_replica(
        dir: &std::path::Path,
        book: Option<Arc<NamespaceBook>>,
        observer: Option<Arc<dyn ReplicaObserver>>,
    ) -> LiveReplica {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(SecretKey::generate())
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .expect("bind test endpoint");
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let blobs = FsStore::load(dir.join("blobs"))
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
        let td = TrailDocs::init(docs, (*blobs).clone(), dir.to_path_buf(), book, observer)
            .await
            .expect("init trail");
        // A read ticket carries the addresses the endpoint has at the time; with no relay that
        // is only its direct ones, which take a moment to appear after the bind.
        for _ in 0..200 {
            if !endpoint.addr().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        LiveReplica {
            td,
            endpoint,
            _router: router,
        }
    }

    async fn until(what: &str, mut check: impl FnMut() -> bool) {
        for _ in 0..600 {
            if check() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("timed out waiting for {what}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_friend_write_reaches_a_watching_replica_with_no_pull() {
        let a_dir = scratch_dir("live-author");
        let b_dir = scratch_dir("live-reader");
        let author_node = live_replica(&a_dir, None, None).await;
        let seen = Arc::new(Seen::default());
        let reader = live_replica(&b_dir, None, Some(seen.clone())).await;
        let ns = author_node.td.own_namespace();
        let a = &author_node.td;

        a.write(ns, &MAYA, b"sealed one".to_vec()).await.unwrap();
        let ticket = a.read_ticket(ns).await.unwrap();
        reader.td.import_ticket(&ticket).await.unwrap();
        until("the imported entry is announced", || {
            seen.times_readable(MAYA) >= 1
        })
        .await;
        let from = *author_node.endpoint.id().as_bytes();
        assert!(
            seen.delivered().contains(&(from, MAYA)),
            "the delivery names the peer that served it: {:?}",
            seen.delivered()
        );

        // Nothing on the reader is called from here on: no import, no sync, no push.
        a.write(ns, &MAYA, b"sealed two".to_vec()).await.unwrap();
        until("the next write is announced", || {
            seen.times_readable(MAYA) >= 2
        })
        .await;
        a.write_nul(ns, &MAYA, b"sealed null".to_vec())
            .await
            .unwrap();
        until("a null-lane write is announced too", || {
            seen.times_readable(MAYA) >= 3
        })
        .await;
        let held = reader.td.read_latest_sealed().await.unwrap();
        assert!(held.contains(&b"sealed two".to_vec()), "{held:?}");
        assert!(held.contains(&b"sealed null".to_vec()), "{held:?}");

        // A control record is not a position; its slot is not announced.
        let before = seen.readable().len();
        a.write_rsy(ns, &MAYA, b"control".to_vec()).await.unwrap();
        a.write(ns, &JUNE, b"june's".to_vec()).await.unwrap();
        until("the write after it is announced", || {
            seen.times_readable(JUNE) >= 1
        })
        .await;
        let after: Vec<Vec<[u8; 32]>> = seen.readable()[before..].to_vec();
        assert!(
            after.iter().all(|report| !report.contains(&MAYA)),
            "the control record must not announce its author: {after:?}"
        );

        for dir in [a_dir, b_dir] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The 2026-11-10 incident, end to end. A reader reconciles a friend's record from a peer
    /// that does not hold the bytes yet — the stash, between the record reaching it and the
    /// writer's upload — so the docs engine's single download attempt fails. The bytes then land
    /// on that peer out-of-band (the stash's HTTP `PUT` imports straight into its blob store),
    /// which sends no `ContentReady`. Nothing in iroh-docs asks again, so before `settle_stranded`
    /// the reader never read that friend's slot. Two nodes reproduce it exactly: the author plays
    /// the stash, writing a record whose bytes it does not have and adding them afterwards.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_slot_reconciled_before_its_bytes_is_fetched_once_they_land() {
        let a_dir = scratch_dir("stranded-author");
        let r_dir = scratch_dir("stranded-reader");
        let author_node = live_replica(&a_dir, None, None).await;
        let seen = Arc::new(Seen::default());
        let reader = live_replica(&r_dir, None, Some(seen.clone())).await;
        let ns = author_node.td.own_namespace();

        // The record, without its bytes: what the stash holds before an upload lands.
        let sealed = b"sealed: the fix that raced its own upload".to_vec();
        let hash = Hash::new(&sealed);
        let doc = author_node.td.doc_for(ns).await.unwrap();
        doc.set_hash(
            author_node.td.author,
            encode_key(&MAYA),
            hash,
            sealed.len() as u64,
        )
        .await
        .unwrap();

        let ticket = author_node.td.read_ticket(ns).await.unwrap();
        reader.td.import_ticket(&ticket).await.unwrap();
        for _ in 0..600 {
            if !reader.td.stranded_slots().await.unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let stranded = reader.td.stranded_slots().await.unwrap();
        assert_eq!(stranded.len(), 1, "the record arrives without its bytes");
        assert_eq!(stranded[0].author, MAYA);
        assert_eq!(stranded[0].hash, hash);

        // The bytes land on the serving peer out-of-band, as the stash's HTTP upload does.
        author_node
            .td
            .blobs
            .add_bytes(sealed.clone())
            .await
            .expect("add the uploaded bytes");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(
            reader.td.read_latest_sealed().await.unwrap().is_empty(),
            "nothing in iroh-docs retries the download: this is the stranded state"
        );
        assert_eq!(seen.times_readable(MAYA), 0, "and the app was never told");

        // A pull's settle step asks the peers it dialled.
        let report = reader
            .td
            .settle_stranded(&reader.endpoint, &[author_node.endpoint.id()], None)
            .await
            .unwrap();
        assert_eq!(report.stranded, 1);
        assert_eq!(report.fetched, 1);
        assert_eq!(report.readable, vec![MAYA]);
        assert_eq!(
            reader.td.read_latest_sealed().await.unwrap(),
            vec![sealed],
            "the friend's slot reads again"
        );
        assert_eq!(seen.times_readable(MAYA), 1, "the app is told once");
        assert!(reader.td.stranded_slots().await.unwrap().is_empty());

        // Nothing stranded is a cheap no-op, and says so.
        let again = reader
            .td
            .settle_stranded(&reader.endpoint, &[author_node.endpoint.id()], None)
            .await
            .unwrap();
        assert_eq!(again, SettleReport::default());
        assert_eq!(seen.times_readable(MAYA), 1);

        for dir in [a_dir, r_dir] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A slot whose bytes nobody has yet stays stranded and is reported, not raised — and a pass
    /// that has no time left does not dial at all.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_slot_nobody_can_serve_stays_stranded_without_failing_the_pass() {
        let a_dir = scratch_dir("unservable-author");
        let r_dir = scratch_dir("unservable-reader");
        let author_node = live_replica(&a_dir, None, None).await;
        let reader = live_replica(&r_dir, None, None).await;
        let ns = author_node.td.own_namespace();
        let sealed = b"sealed: bytes nobody holds".to_vec();
        let doc = author_node.td.doc_for(ns).await.unwrap();
        doc.set_hash(
            author_node.td.author,
            encode_nul_key(&JUNE),
            Hash::new(&sealed),
            sealed.len() as u64,
        )
        .await
        .unwrap();
        reader
            .td
            .import_ticket(&author_node.td.read_ticket(ns).await.unwrap())
            .await
            .unwrap();
        for _ in 0..600 {
            if !reader.td.stranded_slots().await.unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        let deadline = Instant::now() + Duration::from_secs(3);
        let report = reader
            .td
            .settle_stranded(
                &reader.endpoint,
                &[author_node.endpoint.id()],
                Some(deadline),
            )
            .await
            .unwrap();
        assert_eq!(report.stranded, 1, "the null lane counts too");
        assert_eq!(report.fetched, 0);
        assert!(report.readable.is_empty());

        let spent = reader
            .td
            .settle_stranded(
                &reader.endpoint,
                &[author_node.endpoint.id()],
                Some(Instant::now()),
            )
            .await
            .unwrap();
        assert_eq!((spent.stranded, spent.fetched), (1, 0));

        for dir in [a_dir, r_dir] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn stranded_sources_ask_the_dialled_peers_first_then_the_author_never_ourselves() {
        let stash = SecretKey::generate().public();
        let own = SecretKey::generate().public();
        let author = SecretKey::generate().public();
        let relay = SecretKey::generate().public();

        assert_eq!(
            stranded_sources(
                &[stash, own],
                *author.as_bytes(),
                Some(*relay.as_bytes()),
                own
            ),
            vec![stash, author, relay],
        );
        // The stash that served the record is also a dialled peer: asked once.
        assert_eq!(
            stranded_sources(&[stash], *author.as_bytes(), Some(*stash.as_bytes()), own),
            vec![stash, author],
        );
        // An author key that is not a valid endpoint id is simply not a source.
        let mut not_a_point = [0u8; 32];
        for candidate in 0u8..=255 {
            not_a_point = [candidate; 32];
            if iroh::EndpointId::from_bytes(&not_a_point).is_err() {
                break;
            }
        }
        assert_eq!(stranded_sources(&[], not_a_point, None, own), Vec::new());
    }

    #[test]
    fn every_friend_lane_names_its_author_and_nothing_else_does() {
        assert_eq!(decode_lane_author(&encode_key(&MAYA)), Some(MAYA));
        assert_eq!(decode_lane_author(&encode_nul_key(&MAYA)), Some(MAYA));
        assert_eq!(decode_lane_author(&encode_rsy_key(&MAYA)), Some(MAYA));
        assert_eq!(decode_lane_author(b"ctl/0202"), None);
        assert_eq!(decode_lane_author(b"rsy/not-hex"), None);
        assert_eq!(decode_lane_author(b"no-separator"), None);
    }

    /// `leave` alone already stops the namespace syncing; the watch is aborted as well so an entry
    /// the engine was mid-way through handing over cannot reach the app after the friend is gone.
    /// This pins the outcome, which is what the app relies on, not which of the two delivers it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn forgetting_a_friend_stops_its_watch() {
        let a_dir = scratch_dir("forget-author");
        let b_dir = scratch_dir("forget-reader");
        let author_node = live_replica(&a_dir, None, None).await;
        let seen = Arc::new(Seen::default());
        let reader = live_replica(&b_dir, None, Some(seen.clone())).await;
        let ns = author_node.td.own_namespace();
        let a = &author_node.td;

        a.write(ns, &MAYA, b"before".to_vec()).await.unwrap();
        let ticket = a.read_ticket(ns).await.unwrap();
        reader.td.import_ticket(&ticket).await.unwrap();
        until("the friend is announced", || seen.times_readable(MAYA) >= 1).await;

        assert!(reader.td.forget_ticket(&ticket).await.unwrap());
        a.write(ns, &MAYA, b"after".to_vec()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        assert_eq!(
            seen.times_readable(MAYA),
            1,
            "a removed friend's writes must not reach the app"
        );

        for dir in [a_dir, b_dir] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A start reaches a booked friend from the addresses its ticket recorded, with nothing else to
    /// go on: no address lookup (none is configured here), no peer the replica remembers (it is a
    /// fresh one, as after a wipe), and a friend that has never heard of this endpoint. The
    /// remembered-peer path dials by id alone, so on a phone whose lookup is failing — the
    /// 2026-10-11 DNS outage — a rebuilt node would otherwise replicate nothing until a pull.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_start_reaches_a_booked_friend_from_its_ticket_alone() {
        let a_dir = scratch_dir("ticket-author");
        let state = scratch_dir("ticket-state");
        let first_dir = scratch_dir("ticket-first");
        let fresh_dir = scratch_dir("ticket-fresh");
        let author_node = live_replica(&a_dir, None, None).await;
        let ns = author_node.td.own_namespace();
        author_node
            .td
            .write(ns, &MAYA, b"sealed".to_vec())
            .await
            .unwrap();
        let ticket = author_node.td.read_ticket(ns).await.unwrap();
        {
            let first = live_replica(&first_dir, Some(book(&state)), None).await;
            first.td.import_ticket(&ticket).await.unwrap();
        }

        let seen = Arc::new(Seen::default());
        let fresh = live_replica(&fresh_dir, Some(book(&state)), Some(seen.clone())).await;
        assert!(fresh.td.namespaces().await.contains(&ns));
        until("the booked friend's entry arrives on its own", || {
            seen.times_readable(MAYA) >= 1
        })
        .await;

        for dir in [a_dir, state, first_dir, fresh_dir] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
