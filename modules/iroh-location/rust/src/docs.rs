//! Durable trail path — the iroh-docs half of the location core.
//!
//! See `docs/social/ARCHITECTURE.md` §2, §5–6. Alongside the live iroh-gossip broadcast
//! (in [`crate`]'s [`Subscription`](crate::Subscription)), every fix is *also* written to a
//! replicated iroh-docs namespace under key `author/seq`. Because docs stores the **exact
//! same sealed envelope bytes** as gossip (see [`crate::crypto`]), per-recipient revocation
//! carries over unchanged: a dropped recipient may keep replicating the ciphertext but has
//! no wrap, so the bytes are opaque to it.
//!
//! ## What lives here
//! * [`TrailDocs`] — wraps the persistent `Docs` replica store (own namespace + imported
//!   friend namespaces) and the iroh-blobs content store the entries point at.
//! * A set of **pure** helpers ([`encode_key`], [`decode_key`], [`author_prefix`],
//!   [`keys_to_prune`], [`is_within_since`]) that hold the key-encoding, explicit-pruning and
//!   range-filtering logic. These are `#[cfg(test)]`-covered without a live iroh node.
//!
//! ## Build status
//! The live-node methods target iroh-docs `0.101` / iroh-blobs `0.103`; the exact wiring of
//! range reconciliation over an already-connected swarm is best-effort until the mobile
//! cross-compile gate is unblocked (see `README.md`). The pure logic above is fully tested.

use std::collections::HashMap;

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
use n0_future::time::{timeout, Duration};
use n0_future::StreamExt;
use tokio::sync::Mutex;

use crate::crypto;

/// Stop a reconciliation after this many seconds without a new event (peer likely unreachable),
/// so `sync` always returns instead of hanging on a stalled connection.
const SYNC_IDLE_TIMEOUT_SECS: u64 = 8;

/// Key separator between the hex author and the zero-padded sequence number.
pub const KEY_SEP: u8 = b'/';
/// Width of the zero-padded decimal sequence number. `u64::MAX` has 20 digits, so this keeps
/// keys lexicographically sortable in the same order as the numeric `seq`.
pub const SEQ_WIDTH: usize = 20;

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

/// Encode the docs entry key for an `(author, seq)` pair as `hex(author)/{seq:020}`.
///
/// The hex author + `/` form a stable per-author prefix (see [`author_prefix`]) so a friend's
/// slice of a namespace can be range-queried; the zero-padded seq keeps entries ordered.
pub fn encode_key(author: &[u8], seq: u64) -> Vec<u8> {
    let mut key = hex_encode(author).into_bytes();
    key.push(KEY_SEP);
    key.extend_from_slice(format!("{seq:0width$}", width = SEQ_WIDTH).as_bytes());
    key
}

/// The `hex(author)/` key prefix used to range-query a single author's entries.
pub fn author_prefix(author: &[u8]) -> Vec<u8> {
    let mut key = hex_encode(author).into_bytes();
    key.push(KEY_SEP);
    key
}

/// Decode a key produced by [`encode_key`] back into `(author_bytes, seq)`.
pub fn decode_key(key: &[u8]) -> Option<(Vec<u8>, u64)> {
    let pos = key.iter().position(|&b| b == KEY_SEP)?;
    let author_hex = std::str::from_utf8(&key[..pos]).ok()?;
    let author = hex_decode(author_hex)?;
    let seq = std::str::from_utf8(&key[pos + 1..])
        .ok()?
        .parse::<u64>()
        .ok()?;
    Some((author, seq))
}

/// Range test: a fix at `fix_ts` is surfaced iff `fix_ts >= since_ts`
/// (`since_ts == 0` ⇒ full history).
pub fn is_within_since(fix_ts: u64, since_ts: u64) -> bool {
    fix_ts >= since_ts
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

/// A decrypted fix read back from (or reconciled into) the durable replica. `payload` is the
/// still-encoded [`crate::LocationFix`] bytes — the caller (lib.rs) owns the postcard decode so
/// this module stays decoupled from the UniFFI record type.
#[derive(Debug, Clone)]
pub struct TrailFix {
    pub author: Vec<u8>,
    pub seq: u64,
    pub payload: Vec<u8>,
}

/// Sink for reconciliation progress + backfilled fixes. Implemented in lib.rs to forward to the
/// foreign [`crate::FixListener`]. Kept here so [`TrailDocs::sync`] owns the decrypt loop.
pub trait TrailSink: Send + Sync {
    /// A missed envelope, reconciled and decrypted for us. `payload` = encoded `LocationFix`.
    fn on_backfill(&self, author: Vec<u8>, seq: u64, payload: Vec<u8>);
    /// Progress for a namespace sync: `started` | `completed` | `error` (+ recovered count).
    fn on_sync_status(&self, author: Vec<u8>, status: String, recovered: Option<u64>);
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
}

impl TrailDocs {
    /// Initialise from an already-spawned [`Docs`] protocol + its backing blobs store.
    ///
    /// Creates (or, on a persistent store, reuses) our own trail namespace and the default
    /// docs author. The caller is responsible for having registered the `Docs`/`Blobs`/`Gossip`
    /// protocols on the iroh [`Router`](iroh::protocol::Router).
    pub async fn init(docs: Docs, blobs: BlobsStore) -> Result<Self> {
        let author = docs.author_default().await?;
        let own = docs.create().await?;
        let own_ns = own.id();
        let mut handles = HashMap::new();
        handles.insert(own_ns.to_bytes(), own);
        Ok(Self {
            docs,
            blobs,
            author,
            own_ns,
            handles: Mutex::new(handles),
        })
    }

    /// Our own trail namespace id.
    pub fn own_namespace(&self) -> NamespaceId {
        self.own_ns
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

    /// Write a sealed envelope to `ns` under key `author/seq` (ARCHITECTURE §5). `envelope` must
    /// be the identical bytes broadcast on gossip so revocation carries over.
    pub async fn write(
        &self,
        ns: NamespaceId,
        author: &[u8],
        seq: u64,
        envelope: Vec<u8>,
    ) -> Result<()> {
        let doc = self.doc_for(ns).await?;
        doc.set_bytes(self.author, encode_key(author, seq), envelope)
            .await?;
        Ok(())
    }

    /// Read + decrypt entries for `author` in `ns` with `fix.ts >= since_ts`. Entries we can't
    /// open (not addressed to us / revoked) are silently skipped.
    pub async fn read_range(
        &self,
        ns: NamespaceId,
        author: &[u8],
        since_ts: u64,
        recv_secret: &[u8],
    ) -> Result<Vec<TrailFix>> {
        let doc = self.doc_for(ns).await?;
        let query = Query::key_prefix(author_prefix(author)).build();
        let stream = doc.get_many(query).await?;
        tokio::pin!(stream);
        let mut out = Vec::new();
        while let Some(entry) = stream.next().await {
            let entry = entry?;
            let bytes = match self.blobs.blobs().get_bytes(entry.content_hash()).await {
                Ok(b) => b,
                Err(_) => continue, // content not yet available locally
            };
            let opened = match crypto::open(recv_secret, &bytes) {
                Ok(o) => o,
                Err(_) => continue, // opaque to us
            };
            if let Some((author_bytes, seq)) = decode_key(entry.key()) {
                // We rely on the payload's own ts; peek it from the LocationFix header the caller
                // will decode — but bound by since_ts here by decoding the ts field only.
                if fix_ts_at_least(&opened.payload, since_ts) {
                    out.push(TrailFix {
                        author: author_bytes,
                        seq,
                        payload: opened.payload,
                    });
                }
            }
        }
        Ok(out)
    }

    /// Read + decrypt `author`'s fixes across **every** known namespace (own + friends). Used by
    /// the `readTrail` API, which is only given an envelope `author`, not a namespace.
    pub async fn read_trail(
        &self,
        author: &[u8],
        since_ts: u64,
        recv_secret: &[u8],
    ) -> Result<Vec<TrailFix>> {
        let namespaces: Vec<NamespaceId> = {
            let handles = self.handles.lock().await;
            handles.keys().map(|b| NamespaceId::from(*b)).collect()
        };
        let mut out = Vec::new();
        for ns in namespaces {
            out.extend(self.read_range(ns, author, since_ts, recv_secret).await?);
        }
        Ok(out)
    }

    /// Trigger range-based set reconciliation for `ns` and surface backfilled, decryptable fixes
    /// to `sink`. `since_ts` bounds which reconciled fixes we emit (0 = full history).
    ///
    /// NOTE: iroh-docs reconciles the whole namespace; `since_ts` is applied when surfacing
    /// entries, not to bound the wire protocol. Peers are the already-connected swarm members.
    pub async fn sync(
        &self,
        ns: NamespaceId,
        since_ts: u64,
        peers: Vec<EndpointAddr>,
        sink: &dyn TrailSink,
        recv_secret: &[u8],
    ) -> Result<u64> {
        let doc = self.doc_for(ns).await?;
        let author_label = ns.to_bytes().to_vec();
        sink.on_sync_status(author_label.clone(), "started".to_string(), None);

        let mut events = doc.subscribe().await?;
        doc.start_sync(peers).await?;

        let mut recovered: u64 = 0;
        // Bound the reconciliation: with no reachable peer (e.g. relay-only web where direct-IP
        // transmits are dropped) `SyncFinished` may never arrive, which would hang this call — and
        // therefore the `syncTrail` promise — forever. Break after an idle gap and report what we
        // recovered so the UI always gets a `completed` (with count), never a dead button.
        loop {
            match timeout(Duration::from_secs(SYNC_IDLE_TIMEOUT_SECS), events.next()).await {
                Ok(Some(Ok(LiveEvent::InsertRemote { entry, .. }))) => {
                    let bytes = match self.blobs.blobs().get_bytes(entry.content_hash()).await {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    if let Ok(opened) = crypto::open(recv_secret, &bytes) {
                        if let Some((author_bytes, seq)) = decode_key(entry.key()) {
                            if fix_ts_at_least(&opened.payload, since_ts) {
                                recovered += 1;
                                sink.on_backfill(author_bytes, seq, opened.payload);
                            }
                        }
                    }
                }
                Ok(Some(Ok(LiveEvent::SyncFinished(_)))) => break,
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) => break,
                Ok(None) => break, // stream ended
                Err(_) => break,   // idle timeout — stop waiting, report what we have
            }
        }

        sink.on_sync_status(author_label, "completed".to_string(), Some(recovered));
        Ok(recovered)
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

    /// Reconcile **every** known namespace (own + friends), surfacing backfill to `sink`.
    /// Returns the total number of recovered, decryptable fixes.
    pub async fn sync_all(
        &self,
        since_ts: u64,
        peers: Vec<EndpointAddr>,
        sink: &dyn TrailSink,
        recv_secret: &[u8],
    ) -> Result<u64> {
        let mut total = 0u64;
        for ns in self.namespaces().await {
            total += self
                .sync(ns, since_ts, peers.clone(), sink, recv_secret)
                .await?;
        }
        Ok(total)
    }
}

/// Decode just the `ts` field of a postcard-encoded `LocationFix` and test `>= since_ts`.
///
/// `LocationFix` is `{ lat: f64, lon: f64, accuracy_m: f64, heading_deg: f64, ts: u64 }`; the
/// four f64s are fixed-width (8B each in postcard), so `ts` is the trailing varint. To avoid a
/// dependency cycle with the UniFFI record we decode leniently and, on any parse hiccup, fall
/// back to "within window" so a decryptable fix is never dropped.
fn fix_ts_at_least(payload: &[u8], since_ts: u64) -> bool {
    if since_ts == 0 {
        return true;
    }
    match decode_fix_ts(payload) {
        Some(ts) => is_within_since(ts, since_ts),
        None => true,
    }
}

/// Best-effort extraction of the trailing `u64 ts` varint from a postcard `LocationFix`.
fn decode_fix_ts(payload: &[u8]) -> Option<u64> {
    const F64_BYTES: usize = 8 * 4; // lat, lon, accuracy_m, heading_deg
    if payload.len() <= F64_BYTES {
        return None;
    }
    let (varint, _) = read_varint_u64(&payload[F64_BYTES..])?;
    Some(varint)
}

/// Minimal postcard/LEB128-style varint decoder for a single `u64`.
fn read_varint_u64(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    for (i, &byte) in bytes.iter().enumerate() {
        if shift >= 64 {
            return None;
        }
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some((result, i + 1));
        }
        shift += 7;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── key encoding round-trip ──────────────────────────────────────────────────────────
    #[test]
    fn key_round_trip() {
        let author = [0xabu8; 32];
        for seq in [0u64, 1, 42, 999_999, u64::MAX] {
            let key = encode_key(&author, seq);
            let (a, s) = decode_key(&key).expect("decodes");
            assert_eq!(a, author.to_vec());
            assert_eq!(s, seq);
        }
    }

    #[test]
    fn keys_sort_by_seq_lexicographically() {
        let author = [1u8; 32];
        let k1 = encode_key(&author, 2);
        let k2 = encode_key(&author, 10);
        // zero-padding means numeric order == byte order.
        assert!(k1 < k2, "seq 2 should sort before seq 10");
    }

    #[test]
    fn author_prefix_is_key_prefix() {
        let author = [7u8; 32];
        let prefix = author_prefix(&author);
        let key = encode_key(&author, 5);
        assert!(key.starts_with(&prefix));
    }

    #[test]
    fn decode_key_rejects_garbage() {
        assert!(decode_key(b"no-separator-here").is_none());
        assert!(decode_key(b"zz/00000000000000000001").is_none()); // non-hex author
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

    #[test]
    fn since_window_boundaries() {
        assert!(is_within_since(100, 100));
        assert!(is_within_since(101, 100));
        assert!(!is_within_since(99, 100));
        assert!(is_within_since(0, 0));
    }

    // ── ts extraction from a postcard LocationFix ────────────────────────────────────────
    #[test]
    fn decode_fix_ts_matches_postcard() {
        // Mirror crate::LocationFix layout so we don't need to import it here.
        #[derive(serde::Serialize)]
        struct Fix {
            lat: f64,
            lon: f64,
            accuracy_m: f64,
            heading_deg: f64,
            ts: u64,
        }
        for ts in [0u64, 1, 127, 128, 300, 1_000_000, u64::MAX] {
            let f = Fix {
                lat: 1.0,
                lon: 2.0,
                accuracy_m: 3.0,
                heading_deg: 4.0,
                ts,
            };
            let bytes = postcard::to_allocvec(&f).unwrap();
            assert_eq!(decode_fix_ts(&bytes), Some(ts), "ts={ts}");
        }
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

        // fix #1 shared with B and C, written to docs under author/seq.
        let payload = b"durable trail point";
        let envelope =
            crypto::seal(&seed, &author, 1, 1000, 0, payload, &[b_pk.clone(), c_pk]).unwrap();
        let _key = encode_key(&author, 1); // exercises the docs key path

        // Both recipients can open the SAME stored bytes.
        assert_eq!(crypto::open(&b_sk, &envelope).unwrap().payload, payload);
        assert_eq!(crypto::open(&c_sk, &envelope).unwrap().payload, payload);

        // fix #2: C revoked (dropped from wraps). The durable bytes are opaque to C, still
        // readable by B — no docs node required to prove it.
        let e2 = crypto::seal(&seed, &author, 2, 2000, 0, b"after revoke", &[b_pk]).unwrap();
        assert!(crypto::open(&b_sk, &e2).is_ok());
        assert!(matches!(
            crypto::open(&c_sk, &e2),
            Err(crypto::CryptoError::NotARecipient)
        ));
    }
}
