//! Live in-memory replica + HTTP control API. **Behind the `live` feature.**
//!
//! This is the only module that talks to a real iroh node. It boots a **fully in-memory**
//! iroh-docs replica (`Docs::memory()` + `MemStore`, exactly as the web/WASM node does — see
//! `modules/iroh-location/rust-wasm/src/lib.rs`), imports opted-in trail namespaces from their
//! read-tickets, watches each for new remote entries, and nudges subscribers via the [`Waker`].
//! Nothing is written to disk; a restart clears the replica and devices re-register.
//!
//! ## Content is not entries
//! iroh-docs reconciliation moves *entry records*; the bytes they name are a separate iroh-blobs
//! transfer, and the engine's built-in downloader gets exactly one shot at the author. Phones
//! publish from a headless task and are frozen by the OS moments later, so that shot usually
//! misses and the hash is parked awaiting a gossip `ContentReady` a sleeping phone never sends —
//! leaving the stash full of entries it cannot serve. Everything around [`ContentIndex`] exists to
//! fix that: track what is referenced, keep retrying the fetch until it lands, wake subscribers
//! only once the entry is actually servable, and report what is still missing. See
//! [`crate::content`].
//!
//! ## Build status
//! Runtime-tested against iroh-docs `0.101` / iroh-blobs `0.103` by the two-node integration tests
//! below (`cargo test --features live`), which cover import → reconcile → **content** → wake, the
//! frozen-author recovery path, and retention releasing ciphertext. The pure modules this wires
//! together are fully unit-tested.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router as AxumRouter,
};
use iroh::{protocol::Router, Endpoint, RelayMap, RelayMode, SecretKey};
use iroh_blobs::{store::mem::MemStore, BlobsProtocol, Hash};
use iroh_docs::{api::Doc, engine::LiveEvent, protocol::Docs, store::Query, DocTicket};
use iroh_gossip::net::Gossip;
use iroh_tickets::endpoint::EndpointTicket;
use n0_future::StreamExt;
use tokio::sync::Mutex;

use crate::api::{parse_namespace_hex, parse_platform, validate_register, RegisterRequest};
use crate::auth::{authorize, bearer_token};
use crate::content::ContentIndex;
use crate::mls::{Admission, DeliveryService, EnvelopeRef, PassthroughDelivery};
use crate::retention::RetentionPolicy;
use crate::subscriptions::{NamespaceId as NsBytes, NamespaceRegistry, PushSubscription};
use crate::waker::{NoopWaker, Waker};

/// How often the settle loop re-checks whether pushed/downloaded bytes have landed.
const SETTLE_INTERVAL_MS: u64 = 250;

/// How long one content fetch attempt may run before the settle loop gives up and retries later.
const FETCH_TIMEOUT_SECS: u64 = 20;

/// How often the blob GC sweep reclaims ciphertext no unpruned entry references any more.
/// Retention decides *when* an entry dies; this decides how promptly its bytes are freed.
const GC_INTERVAL_SECS: u64 = 300;

/// How long an entry may sit without its content before we wake subscribers anyway. Waking with
/// nothing to serve is close to useless — the reader syncs and gets `Unable to download` — but a
/// client that never pushes may still be able to fetch from the author directly, and silently
/// dropping the wake would be a liveness regression for already-deployed app versions. Logged
/// distinctly (`degraded=true`) so the fallback is never invisible.
const WAKE_FALLBACK_MS: u64 = 30_000;

/// When an entry was written, in **milliseconds**.
///
/// iroh-docs stamps `Entry::timestamp()` in **microseconds** (`sync.rs::system_time_now`), while
/// retention — like the envelopes and everything else here — works in milliseconds. Comparing the
/// two directly makes every entry look ~1000× too young, so a retention window would never expire
/// anything. Convert once, at the boundary, rather than trusting the units to line up.
fn entry_written_ms(entry: &iroh_docs::Entry) -> u64 {
    entry.timestamp() / 1_000
}

/// Wall-clock milliseconds since the Unix epoch (the clock envelopes + docs entries use).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The always-on, ciphertext-blind stash node.
pub struct StashNode {
    endpoint: Endpoint,
    docs: Docs,
    blobs: iroh_blobs::api::Store,
    registry: Arc<NamespaceRegistry>,
    delivery: Arc<dyn DeliveryService>,
    waker: Arc<dyn Waker>,
    retention: RetentionPolicy,
    handles: Mutex<HashMap<NsBytes, Doc>>,
    /// Which content hashes entries reference, and whether their bytes have landed. Gates pushes
    /// and backs the missing-content health signal. `std::sync::Mutex`: every critical section is
    /// a few map operations with no `.await` inside.
    content: Arc<std::sync::Mutex<ContentIndex>>,
    /// Replicated entries and what the settle loop still owes them. Entries live here until
    /// retention prunes them, so a fetch is retried for as long as the entry is worth serving.
    tracked: Mutex<HashMap<Hash, TrackedEntry>>,
    _router: Router,
}

/// A replicated entry the settle loop is shepherding toward "servable".
#[derive(Debug, Clone)]
struct TrackedEntry {
    namespace: NsBytes,
    author: Vec<u8>,
    /// The peer that handed us this record. Often *not* the author: a phone replicates its
    /// friends' trails too, so it can serve content for an author that is long offline. Trying it
    /// first is also strictly better odds than the author — it was connected moments ago.
    delivered_by: iroh::EndpointId,
    seq: u64,
    first_seen_ms: u64,
    /// Whether the bytes are in the local store — i.e. whether this entry is servable.
    content_present: bool,
    /// Whether subscribers have already been woken for this entry (wakes fire once).
    woken: bool,
    /// Earliest time to retry the content fetch — exponential backoff so an author that is asleep
    /// for hours costs a couple of attempts, not thousands.
    next_attempt_ms: u64,
    /// Consecutive failed fetches, used to grow the backoff.
    attempts: u32,
}

impl TrackedEntry {
    /// Backoff schedule: retry quickly at first (the author is often still connected, finishing
    /// its own sync), then back off toward a slow poll that costs nothing while it sleeps.
    fn backoff_ms(attempts: u32) -> u64 {
        const BASE_MS: u64 = 500;
        const CEILING_MS: u64 = 60_000;
        BASE_MS
            .saturating_mul(1u64 << attempts.min(7))
            .min(CEILING_MS)
    }
}

impl StashNode {
    /// Boot the in-memory node. `secret` gives the stash a stable dialable identity across
    /// restarts (supply it from a secret manager / env — it is a key, not user data, so this stays
    /// consistent with "nothing user-derived at rest"). `delivery` defaults to the MLS passthrough
    /// stub; `waker` to the no-op until push credentials are wired.
    pub async fn spawn(
        secret: SecretKey,
        retention: RetentionPolicy,
        relay_urls: &[String],
        relay_token: Option<&str>,
        delivery: Arc<dyn DeliveryService>,
        waker: Arc<dyn Waker>,
    ) -> Result<Arc<Self>> {
        let mut endpoint_builder =
            Endpoint::builder(iroh::endpoint::presets::N0).secret_key(secret);
        if !relay_urls.is_empty() {
            let relay_map = RelayMap::try_from_iter(relay_urls.iter().map(String::as_str))
                .map_err(|e| anyhow!("invalid custom relay URL: {e}"))?;
            let relay_map = match relay_token {
                Some(token) => relay_map.with_auth_token(token),
                None => relay_map,
            };
            endpoint_builder = endpoint_builder.relay_mode(RelayMode::Custom(relay_map));
        }
        let endpoint = endpoint_builder
            .bind()
            .await
            .map_err(|e| anyhow!("bind endpoint: {e}"))?;

        let gossip = Gossip::builder().spawn(endpoint.clone());

        // Fully in-memory: no fs-store, no redb. Same constructors the WASM node uses.
        //
        // GC is what actually reclaims memory. iroh-blobs keeps every blob that is tagged or
        // protected, and `delete` is crate-private, so the supported way to drop content is to stop
        // protecting it and let a sweep collect it. The protect callback answers "which ciphertext
        // is still referenced by an unpruned entry?" straight from the content index, which makes
        // that index the single source of truth for blob liveness: retention prunes an entry →
        // `forget` drops the reference → the next sweep frees the bytes. Without this a RAM-only
        // process would grow for its entire lifetime once it started storing content for real.
        let content = Arc::new(std::sync::Mutex::new(ContentIndex::new()));
        let protect = content.clone();
        let mem = MemStore::new_with_opts(iroh_blobs::store::mem::Options {
            gc_config: Some(iroh_blobs::store::GcConfig {
                interval: std::time::Duration::from_secs(GC_INTERVAL_SECS),
                add_protected: Some(Arc::new(
                    move |live: &mut std::collections::HashSet<Hash>| {
                        let protect = protect.clone();
                        Box::pin(async move {
                            for hash in protect.lock().expect("content index poisoned").referenced()
                            {
                                live.insert(Hash::from_bytes(hash));
                            }
                            iroh_blobs::store::ProtectOutcome::Continue
                        })
                    },
                )),
            }),
        });
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*mem).clone(), gossip.clone())
            .await
            .map_err(|e| anyhow!("spawn docs: {e}"))?;

        // Blob writes stay disabled (`None` ⇒ `EventMask::DEFAULT`, which refuses pushes). Having
        // the writer *push* its ciphertext looks like the obvious fix for a sleepy author, but
        // iroh-blobs 0.103 marks push experimental, its receive path silently stores nothing here,
        // and `execute_push` returns success without any acknowledgement — so it could never tell a
        // phone whether it is safe to sleep. The stash pulls instead (see `settle_once`) and
        // reports content presence over the control API, which is a real delivery receipt.
        let router = Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&mem, None))
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();

        let node = Arc::new(Self {
            endpoint,
            docs,
            blobs: (*mem).clone(),
            registry: Arc::new(NamespaceRegistry::new()),
            delivery,
            waker,
            retention,
            handles: Mutex::new(HashMap::new()),
            content,
            tracked: Mutex::new(HashMap::new()),
            _router: router,
        });
        tokio::spawn(node.clone().run_settle_loop());
        Ok(node)
    }

    /// How many replicated entries are still missing their bytes, and how many are tracked.
    ///
    /// A stash that is doing its job keeps `missing` near zero: it spikes as entries arrive and
    /// falls as pushes land. **Persistently non-zero means the stash is holding hashes it cannot
    /// serve** — readers will get `Unable to download <hash>`. Surfaced on `/healthz` because the
    /// absence of exactly this number let a blobless stash look healthy indefinitely.
    pub fn content_stats(&self) -> (usize, usize) {
        let index = self.content.lock().expect("content index poisoned");
        (index.missing_count(), index.tracked_count())
    }

    /// The stash's endpoint ticket. Publish this as `EXPO_PUBLIC_TRAIL_STASH_TICKET`; the app
    /// parses it to an `EndpointAddr` and adds it to the `sync`/`sync_all` peer list.
    pub fn node_ticket(&self) -> String {
        EndpointTicket::new(self.endpoint.addr()).to_string()
    }

    /// Handle a validated `POST /v1/namespaces`: import the read capability (idempotent), record
    /// the opt-in grant + optional wake subscription, and start watching the namespace once.
    ///
    /// Registration deliberately does **not** dial the bootstrap nodes embedded in the ticket.
    /// The registering phone already has the stash endpoint and drives the initial reconciliation;
    /// dialing the writer here races that phone, produces `AlreadySyncing`, and can wedge
    /// iroh-docs 0.101 callers in a permanently-running state. We still call `start_sync([])` once
    /// so the stash joins the namespace gossip swarm and can receive later live inserts.
    #[tracing::instrument(
        name = "stash.namespace.import",
        skip_all,
        fields(
            sc.namespace = tracing::field::Empty,
            first_watch = tracing::field::Empty,
            ticket_bootstrap_nodes = tracing::field::Empty,
            registration_dialed_peer = false,
        )
    )]
    pub async fn register(
        self: &Arc<Self>,
        read_ticket: &str,
        subscription: Option<PushSubscription>,
    ) -> Result<NsBytes> {
        let ticket: DocTicket = read_ticket
            .parse()
            .map_err(|e| anyhow!("parse doc ticket: {e}"))?;
        let ns_bytes = ticket.capability.id().to_bytes();
        tracing::Span::current().record(
            "sc.namespace",
            tracing::field::display(crate::telemetry::short_hex(&ns_bytes)),
        );
        tracing::Span::current().record("ticket_bootstrap_nodes", ticket.nodes.len());

        // Hold the map lock through the first import so two simultaneous registrations cannot both
        // create watchers/start the same namespace. Registrations are rare control-plane calls;
        // serializing this small critical section is preferable to duplicate live engines.
        let doc = {
            let mut handles = self.handles.lock().await;
            if let Some(doc) = handles.get(&ns_bytes) {
                doc.clone()
            } else {
                let doc = self
                    .docs
                    .import_namespace(ticket.capability)
                    .await
                    .map_err(|e| anyhow!("import namespace capability: {e}"))?;
                // Enable gossip/listening without using the ticket's author addresses as outbound
                // sync targets. The phone's explicit stash sync supplies the first connection.
                doc.start_sync(Vec::new())
                    .await
                    .map_err(|e| anyhow!("join namespace without bootstrap peers: {e}"))?;
                handles.insert(ns_bytes, doc.clone());
                doc
            }
        };

        let first = self.registry.register(ns_bytes, subscription);
        tracing::Span::current().record("first_watch", first);
        if first {
            self.clone().spawn_watch(ns_bytes, doc);
        }
        Ok(ns_bytes)
    }

    /// Drop a device's wake subscription for a namespace (`DELETE …/subscription`). Idempotent.
    pub fn unsubscribe(&self, ns: &NsBytes, sub: &PushSubscription) -> bool {
        self.registry.unsubscribe(ns, sub)
    }

    /// Kick off range reconciliation for a namespace against explicit peers (mirrors
    /// `docs.rs::sync`'s `doc.start_sync`). In production the phones dial the stash and drive sync;
    /// this lets the stash also proactively reconcile against a known peer (and is what the
    /// integration test drives with the writer's address).
    pub async fn sync_now(&self, ns: NsBytes, peers: Vec<iroh::EndpointAddr>) -> Result<()> {
        if let Some(doc) = self.handle(ns).await {
            doc.start_sync(peers).await?;
        }
        Ok(())
    }

    /// Watch one namespace: on each new *remote* entry, run the delivery-service admission check
    /// (passthrough today) and, if admitted, wake the namespace's subscribers.
    fn spawn_watch(self: Arc<Self>, ns_bytes: NsBytes, doc: Doc) {
        tokio::spawn(async move {
            let mut events = match doc.subscribe().await {
                Ok(e) => e,
                Err(e) => {
                    tracing::warn!("stash: subscribe failed: {e}");
                    return;
                }
            };
            while let Some(ev) = events.next().await {
                match ev {
                    Ok(LiveEvent::InsertRemote { entry, from, .. }) => {
                        use tracing::Instrument;
                        // `sc.entry_hash` here is the iroh-blobs content hash — the same short
                        // hash the sender stamped on its publish span and the receiver stamps on
                        // its backfill, so one Tempo query joins all three hops of a ping.
                        let hash = entry.content_hash();
                        let span = tracing::info_span!(
                            "stash.entry.received",
                            sc.namespace = %crate::telemetry::short_hex(&ns_bytes),
                            sc.entry_hash = %crate::telemetry::short_hex(hash.as_bytes()),
                            sc.author = tracing::field::Empty,
                            sc.seq = tracing::field::Empty,
                            content_present = tracing::field::Empty,
                        );
                        let ready = async {
                            let (author, seq) = decode_author_seq(entry.key());
                            let current = tracing::Span::current();
                            current.record(
                                "sc.author",
                                tracing::field::display(crate::telemetry::short_hex(&author)),
                            );
                            current.record("sc.seq", seq);

                            // Reconciliation delivered the *record*; the bytes are a separate
                            // transfer. Registering the hash both authorizes the writer's push and
                            // puts the entry on the missing-content ledger until it lands.
                            self.content
                                .lock()
                                .expect("content index poisoned")
                                .want(ns_bytes, *hash.as_bytes());

                            let present = self.blobs.blobs().has(hash).await.unwrap_or(false);
                            current.record("content_present", present);
                            let entry = TrackedEntry {
                                namespace: ns_bytes,
                                author,
                                delivered_by: from,
                                seq,
                                first_seen_ms: now_ms(),
                                content_present: present,
                                // Woken immediately below when the content is already here;
                                // otherwise the settle loop owns the wake.
                                woken: present,
                                next_attempt_ms: 0,
                                attempts: 0,
                            };
                            // Re-reconciling a known entry must not reset its fetch backoff or
                            // re-wake subscribers, so only insert what we do not already track.
                            let known = self
                                .tracked
                                .lock()
                                .await
                                .entry(hash)
                                .or_insert_with(|| entry.clone())
                                .woken;
                            if present {
                                // Already here — a re-reconciled entry, or the docs engine's
                                // downloader won the race against the writer going to sleep.
                                self.content
                                    .lock()
                                    .expect("content index poisoned")
                                    .mark_present(*hash.as_bytes());
                            }
                            // The settle loop owns every other path to a wake.
                            (present && !known).then_some(entry)
                        }
                        .instrument(span)
                        .await;

                        if let Some(entry) = ready {
                            self.wake_for(hash, &entry, false).await;
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        tracing::warn!("stash: doc event stream error: {e}");
                        break;
                    }
                }
            }
        });
    }

    async fn handle(&self, ns: NsBytes) -> Option<Doc> {
        self.handles.lock().await.get(&ns).cloned()
    }

    /// Watch for the bytes behind replicated entries to land — whether pushed by the writer or
    /// pulled by the docs engine's downloader — and wake subscribers once the stash can actually
    /// serve the entry.
    ///
    /// This is the self-healing half of the invariant: a push that arrives late, a writer that
    /// only becomes reachable on its next wake-up, a transient dial failure — all converge here
    /// instead of orphaning the entry forever.
    async fn run_settle_loop(self: Arc<Self>) {
        let mut ticker =
            tokio::time::interval(tokio::time::Duration::from_millis(SETTLE_INTERVAL_MS));
        loop {
            ticker.tick().await;
            let settled = self.settle_once(now_ms()).await;
            for (hash, entry, degraded) in settled {
                self.wake_for(hash, &entry, degraded).await;
            }
        }
    }

    /// One settle pass: for every entry still missing its bytes, try to fetch them from the author,
    /// then release the ones that are ready to wake.
    ///
    /// The docs engine queues its own download when an entry arrives, but that is a single attempt
    /// against a peer that is usually about to be frozen by the OS — and a failure leaves the hash
    /// parked until a gossip `ContentReady` that a sleeping phone never sends. Retrying here is
    /// what makes the stash converge: whenever the author is reachable (notably while it is
    /// connected doing its own sync) the fetch succeeds and the entry becomes servable.
    ///
    /// Returns entries whose subscribers should be woken, each flagged with whether it is being
    /// released *without* content (the fallback path). Waking is one-shot; fetching is not — an
    /// entry woken degraded keeps being retried, so late content still becomes servable.
    async fn settle_once(&self, now: u64) -> Vec<(Hash, TrackedEntry, bool)> {
        let outstanding: Vec<(Hash, TrackedEntry)> = {
            let tracked = self.tracked.lock().await;
            tracked
                .iter()
                .filter(|(_, entry)| !entry.content_present)
                .map(|(hash, entry)| (*hash, entry.clone()))
                .collect()
        };

        let mut wake = Vec::new();
        for (hash, entry) in outstanding {
            let present = self.blobs.blobs().has(hash).await.unwrap_or(false)
                || (now >= entry.next_attempt_ms && self.fetch_content(hash, &entry).await);

            let mut tracked = self.tracked.lock().await;
            let Some(live) = tracked.get_mut(&hash) else {
                continue; // pruned out from under us mid-pass
            };
            if present {
                live.content_present = true;
                self.content
                    .lock()
                    .expect("content index poisoned")
                    .mark_present(*hash.as_bytes());
            } else if now >= entry.next_attempt_ms {
                live.attempts = live.attempts.saturating_add(1);
                live.next_attempt_ms = now + TrackedEntry::backoff_ms(live.attempts);
            }

            let overdue = now.saturating_sub(live.first_seen_ms) >= WAKE_FALLBACK_MS;
            if !live.woken && (present || overdue) {
                live.woken = true;
                wake.push((hash, entry, !present));
            }
        }
        wake
    }

    /// Fetch an entry's bytes from anyone who might have them.
    ///
    /// Candidates are the peer that delivered the record and the entry's author (its `EndpointId`
    /// is encoded in the docs key, so no address book is needed — iroh resolves it over the relay).
    /// Both matter: a phone replicates its friends' trails, so it can serve content whose author
    /// has been offline for days, and asking only the author would strand exactly the entries
    /// offline delivery exists to carry.
    ///
    /// Failure is the normal case for a phone that has gone back to sleep; it is logged at debug
    /// and retried on the next pass, so a transient miss never orphans an entry.
    async fn fetch_content(&self, hash: Hash, entry: &TrackedEntry) -> bool {
        let mut sources = vec![entry.delivered_by];
        if let Ok(author) = <[u8; 32]>::try_from(entry.author.as_slice()) {
            if let Ok(author) = iroh::EndpointId::from_bytes(&author) {
                if author != entry.delivered_by {
                    sources.push(author);
                }
            }
        }
        let downloader = self.blobs.downloader(&self.endpoint);
        let attempt = tokio::time::timeout(
            tokio::time::Duration::from_secs(FETCH_TIMEOUT_SECS),
            downloader.download(iroh_blobs::HashAndFormat::raw(hash), sources),
        )
        .await;
        match attempt {
            Ok(Ok(())) => true,
            Ok(Err(error)) => {
                tracing::debug!(
                    sc.entry_hash = %crate::telemetry::short_hex(hash.as_bytes()),
                    sc.author = %crate::telemetry::short_hex(&entry.author),
                    %error,
                    "stash: content fetch failed; will retry"
                );
                false
            }
            Err(_) => {
                tracing::debug!(
                    sc.entry_hash = %crate::telemetry::short_hex(hash.as_bytes()),
                    "stash: content fetch timed out; will retry"
                );
                false
            }
        }
    }

    /// Run the delivery-service admission check and, if admitted, wake the namespace's subscribers.
    async fn wake_for(&self, hash: Hash, entry: &TrackedEntry, degraded: bool) {
        use tracing::Instrument;
        let span = tracing::info_span!(
            "stash.entry.ready",
            sc.namespace = %crate::telemetry::short_hex(&entry.namespace),
            sc.entry_hash = %crate::telemetry::short_hex(hash.as_bytes()),
            sc.author = %crate::telemetry::short_hex(&entry.author),
            sc.seq = entry.seq,
            wake_targets = tracing::field::Empty,
            // true ⇒ woken without content: subscribers will sync and find nothing to download.
            degraded = degraded,
        );
        async {
            if degraded {
                tracing::warn!(
                    "stash: waking without content after {}ms — the writer never handed over its \
                     bytes and could not be pulled",
                    WAKE_FALLBACK_MS
                );
            }
            // The bytes are ours now; reading them back is cheap and keeps the delivery service
            // honest — a real MLS DS must see real framing, not the empty slice it used to get.
            let bytes = if degraded {
                Vec::new()
            } else {
                self.blobs
                    .blobs()
                    .get_bytes(hash)
                    .await
                    .map(|b| b.to_vec())
                    .unwrap_or_default()
            };
            let env = EnvelopeRef {
                namespace: &entry.namespace,
                author: &entry.author,
                seq: entry.seq,
                bytes: &bytes,
            };
            match self.delivery.admit(&env) {
                Admission::Accept => {
                    let targets = self.registry.wake_targets(&entry.namespace);
                    tracing::Span::current().record("wake_targets", targets.len());
                    if !targets.is_empty() {
                        // Inside the span so the waker's push spans (and the traceparent embedded
                        // in the payload) parent here.
                        self.waker.wake(&entry.namespace, &targets);
                    }
                }
                Admission::Reject(reason) => {
                    tracing::info!("stash: delivery rejected entry: {reason}");
                }
            }
        }
        .instrument(span)
        .await;
    }

    /// One retention sweep across every granted namespace: stop holding the **ciphertext** of
    /// entries older than the window, and let the GC sweep reclaim it. Returns the number of blobs
    /// released.
    ///
    /// This deliberately does not try to delete the docs entries. The stash holds a *read*
    /// capability, and `Doc::del` only removes entries by the author you pass — so the old
    /// `del(self.author, ..)` here could never match a phone-authored entry and silently reported
    /// `removed = 0` on every sweep. Entry *records* are the author's to retire (their tombstones
    /// replicate to us like any other write); the ciphertext is what actually consumes this
    /// RAM-only process, and dropping our reference to it is a bound we can enforce unilaterally.
    ///
    /// A blob is released only when the last entry referencing it has expired, so two namespaces
    /// holding identical ciphertext can't have one's sweep pull the rug from the other.
    #[tracing::instrument(
        name = "stash.prune",
        skip_all,
        fields(
            released = tracing::field::Empty,
            content_missing = tracing::field::Empty,
        )
    )]
    pub async fn prune_once(&self, now_ms: u64) -> Result<u64> {
        let cutoff = self.retention.cutoff(now_ms);
        let mut released = 0u64;
        for ns in self.registry.known_namespaces() {
            let Some(doc) = self.handle(ns).await else {
                continue;
            };
            let stream = doc.get_many(Query::all().build()).await?;
            tokio::pin!(stream);
            let mut expired = Vec::new();
            while let Some(entry) = stream.next().await {
                let entry = entry?;
                if entry_written_ms(&entry) < cutoff {
                    expired.push(entry.content_hash());
                }
            }
            for hash in expired {
                // Stop chasing content for an entry past its window...
                self.tracked.lock().await.remove(&hash);
                // ...and drop our reference so the sweep can free the ciphertext.
                let last_reference = self
                    .content
                    .lock()
                    .expect("content index poisoned")
                    .forget(&ns, hash.as_bytes());
                if last_reference {
                    released += 1;
                }
            }
        }
        let span = tracing::Span::current();
        span.record("released", released);
        span.record("content_missing", self.content_stats().0);
        Ok(released)
    }

    /// Periodic prune loop; runs until the process exits.
    pub async fn run_prune_loop(self: Arc<Self>, interval_min: u64) {
        let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(interval_min * 60));
        loop {
            ticker.tick().await;
            match self.prune_once(now_ms()).await {
                Ok(n) if n > 0 => {
                    tracing::info!("stash: released content for {n} expired entries")
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("stash: prune sweep error: {e}"),
            }
        }
    }

    /// Serve the HTTP control API until shutdown. `psk`, when set, is required as
    /// `Authorization: Bearer <psk>` on the `/v1/*` routes (anti-abuse gate; `/healthz` is open).
    pub async fn serve_control_api(self: Arc<Self>, port: u16, psk: Option<String>) -> Result<()> {
        let psk = Arc::new(psk);
        let app = AxumRouter::new()
            .route("/v1/namespaces", post(register_handler))
            .route(
                "/v1/namespaces/:id/subscription",
                delete(unsubscribe_handler),
            )
            // route_layer applies ONLY to the routes above, not to /healthz added after.
            .route_layer(middleware::from_fn_with_state(psk, psk_guard))
            .route("/healthz", get(healthz))
            .with_state(self);
        // Outermost layer so the request span wraps the PSK guard too, and the phone's
        // `traceparent` header parents the whole request. Dormant-telemetry builds still pay one
        // cheap disabled span per request; non-otel builds have no layer at all.
        #[cfg(feature = "otel")]
        let app = app.layer(middleware::from_fn(crate::telemetry::http_request_span));
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
        tracing::info!("stash: control API listening on :{port}");
        axum::serve(listener, app).await?;
        Ok(())
    }
}

/// Anti-abuse gate: require a matching pre-shared key on protected routes (no-op when unset).
async fn psk_guard(State(psk): State<Arc<Option<String>>>, req: Request, next: Next) -> Response {
    let provided = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok());
    if authorize(psk.as_deref(), bearer_token(provided)).is_allowed() {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            "missing or invalid pre-shared key",
        )
            .into_response()
    }
}

/// Convenience defaults: passthrough MLS delivery + no-op waker.
pub fn default_delivery() -> Arc<dyn DeliveryService> {
    Arc::new(PassthroughDelivery)
}
pub fn default_waker() -> Arc<dyn Waker> {
    Arc::new(NoopWaker)
}

// ── HTTP handlers ────────────────────────────────────────────────────────────────────────

/// Liveness **and** the content-invariant readout.
///
/// `content_missing` is the number the stash never used to report — replicated entries whose bytes
/// never arrived. It spikes as entries land and should fall back toward zero within seconds. If it
/// sits high, the stash is holding hashes it cannot serve and every reader syncing through it will
/// get `Unable to download <hash>`, no matter how healthy everything else looks.
async fn healthz(State(node): State<Arc<StashNode>>) -> impl IntoResponse {
    let (content_missing, content_tracked) = node.content_stats();
    Json(serde_json::json!({
        "status": "ok",
        "content_missing": content_missing,
        "content_tracked": content_tracked,
    }))
}

async fn register_handler(
    State(node): State<Arc<StashNode>>,
    Json(req): Json<RegisterRequest>,
) -> impl IntoResponse {
    let valid = match validate_register(&req) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    match node.register(&valid.read_ticket, valid.subscription).await {
        Ok(_) => StatusCode::CREATED.into_response(),
        // A malformed ticket that slipped past the light guard is the client's fault (400); a
        // transient import/network failure is not (502).
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("parse doc ticket") {
                (StatusCode::BAD_REQUEST, msg).into_response()
            } else {
                (StatusCode::BAD_GATEWAY, msg).into_response()
            }
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct UnsubscribeRequest {
    push_token: String,
    platform: String,
}

async fn unsubscribe_handler(
    State(node): State<Arc<StashNode>>,
    Path(id): Path<String>,
    Json(req): Json<UnsubscribeRequest>,
) -> impl IntoResponse {
    let ns = match parse_namespace_hex(&id) {
        Ok(ns) => ns,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    let Some(platform) = parse_platform(&req.platform) else {
        return (StatusCode::BAD_REQUEST, "platform must be 'apns' or 'fcm'").into_response();
    };
    let sub = PushSubscription {
        platform,
        token: req.push_token,
    };
    // Idempotent + does not leak presence: 204 whether or not it existed.
    let _ = node.unsubscribe(&ns, &sub);
    StatusCode::NO_CONTENT.into_response()
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────

/// Decode the `hex(author)/{seq:020}` docs key (see `docs.rs::encode_key`) into `(author, seq)`.
/// On any parse hiccup returns `(empty, 0)` — the passthrough delivery service ignores these
/// fields, and a future MLS impl can treat an undecodable key as reject.
fn decode_author_seq(key: &[u8]) -> (Vec<u8>, u64) {
    let Some(pos) = key.iter().position(|&b| b == b'/') else {
        return (Vec::new(), 0);
    };
    let author = std::str::from_utf8(&key[..pos])
        .ok()
        .and_then(hex_decode)
        .unwrap_or_default();
    let seq = std::str::from_utf8(&key[pos + 1..])
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    (author, seq)
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < b.len() {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Some(out)
}

// ── two-node integration test (real iroh nodes) ───────────────────────────────────────────
//
// Only built with `--features live`. Proves the offline-delivery path end to end: a writer node
// creates a trail namespace and writes an entry; the stash imports the writer's read-ticket and
// must observe the entry via reconciliation, firing the waker. This exercises exactly what makes
// the stash useful — a phone can catch up from the stash without the other phone being present.
#[cfg(all(test, feature = "live"))]
mod live_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use iroh::protocol::{AcceptError as ProtocolAcceptError, ProtocolHandler};
    use iroh_docs::api::protocol::{AddrInfoOptions, ShareMode};
    use iroh_docs::{
        actor::{OpenOpts, SyncHandle},
        net::{connect_and_sync, AbortReason, ConnectError},
        store::Store as DocsStore,
    };
    use tokio::sync::Notify;

    use crate::subscriptions::Platform;

    /// Opt-in logging for these tests: silent unless `RUST_LOG` is set.
    fn init_test_tracing() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "off".into()),
            )
            .try_init();
    }

    /// A waker that just counts calls; the test polls the counter (race-free vs a Notify that could
    /// fire before the waiter registers).
    struct CountWaker {
        count: AtomicUsize,
    }
    impl crate::waker::Waker for CountWaker {
        fn wake(&self, _ns: &NsBytes, targets: &[PushSubscription]) {
            self.count.fetch_add(targets.len().max(1), Ordering::SeqCst);
        }
    }

    /// A docs-ALPN peer that accepts the QUIC connection but never answers the reconciliation
    /// protocol until released. Pointing a ticket at it makes an unwanted registration-time
    /// `start_sync` deterministic instead of racing a fast real writer. The same endpoint later
    /// initiates a reader sync back to the stash, reproducing the exact same-peer collision.
    #[derive(Debug)]
    struct StalledDocsPeer {
        entered: Notify,
        release: Notify,
    }

    impl ProtocolHandler for StalledDocsPeer {
        async fn accept(
            &self,
            _connection: iroh::endpoint::Connection,
        ) -> Result<(), ProtocolAcceptError> {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(())
        }
    }

    /// A writer node the test can drive, mirroring the phone: it owns the namespace and is the
    /// side that dials out (phones are NAT'd; the stash never dials them).
    struct Writer {
        ticket: String,
        doc: Doc,
        _router: Router,
    }

    impl Writer {
        /// The content hash of the single entry this writer published.
        async fn entry_hash(&self) -> anyhow::Result<iroh_blobs::Hash> {
            let stream = self.doc.get_many(Query::all().build()).await?;
            tokio::pin!(stream);
            let entry = stream
                .next()
                .await
                .ok_or_else(|| anyhow!("writer has no entry"))??;
            Ok(entry.content_hash())
        }
    }

    /// A blobs endpoint that can be put to sleep, modelling a phone the OS has frozen: the docs
    /// entry is already at the stash, but blob requests get nothing back. Waking it lets the
    /// stash's retry succeed, which is exactly the recovery the settle loop exists for.
    #[derive(Debug)]
    struct SleepableBlobs {
        inner: BlobsProtocol,
        awake: Arc<std::sync::atomic::AtomicBool>,
    }

    impl ProtocolHandler for SleepableBlobs {
        async fn accept(
            &self,
            connection: iroh::endpoint::Connection,
        ) -> Result<(), ProtocolAcceptError> {
            if !self.awake.load(Ordering::SeqCst) {
                // Frozen: the connection is accepted and then goes nowhere, like a process the OS
                // has suspended mid-flight.
                return Ok(());
            }
            self.inner.accept(connection).await
        }
    }

    /// Build a minimal writer node that behaves like the phone: endpoint + gossip + in-memory
    /// docs/blobs, one namespace with one entry, and a `Doc` handle so the test can drive
    /// `start_sync` outbound exactly the way `docs.rs::sync` does.
    async fn spawn_writer_node(seed: u8) -> anyhow::Result<Writer> {
        spawn_writer_node_with(seed, Arc::new(std::sync::atomic::AtomicBool::new(true))).await
    }

    /// A node holding a namespace whose entries are keyed to `author_hex` — modelling a phone that
    /// relays a *friend's* trail, where the author is some other device entirely.
    async fn spawn_writer_node_for_author(seed: u8, author_hex: &str) -> anyhow::Result<Writer> {
        spawn_writer_inner(
            seed,
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
            author_hex,
        )
        .await
    }

    /// `awake = false` models the production reality: a phone that publishes from a headless
    /// background task and is frozen by the OS moments later. Its docs entry is already at the
    /// stash, but it can no longer answer a blob pull. Flip the flag to wake it back up.
    ///
    /// `seed` must be unique per test: these run in parallel, and two endpoints sharing an identity
    /// dial each other's connections and fail in ways that look like protocol bugs.
    async fn spawn_writer_node_with(
        seed: u8,
        awake: Arc<std::sync::atomic::AtomicBool>,
    ) -> anyhow::Result<Writer> {
        spawn_writer_inner(seed, awake, &"0".repeat(64)).await
    }

    async fn spawn_writer_inner(
        seed: u8,
        awake: Arc<std::sync::atomic::AtomicBool>,
        author_hex: &str,
    ) -> anyhow::Result<Writer> {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(SecretKey::from_bytes(&[seed; 32]))
            .bind()
            .await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let mem = MemStore::new();
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*mem).clone(), gossip.clone())
            .await?;
        let router = Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip.clone())
            .accept(iroh_docs::ALPN, docs.clone())
            .accept(
                iroh_blobs::ALPN,
                SleepableBlobs {
                    inner: BlobsProtocol::new(&mem, None),
                    awake,
                },
            )
            .spawn();

        let author = docs.author_default().await?;
        let doc = docs.create().await?;
        let key = format!("{author_hex}/{:020}", 1u64).into_bytes();
        doc.set_bytes(author, key, b"opaque-sealed-envelope".to_vec())
            .await?;
        let ticket = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await?
            .to_string();
        Ok(Writer {
            ticket,
            doc,
            _router: router,
        })
    }

    /// Build a minimal writer node: endpoint + gossip + in-memory docs/blobs, one namespace with
    /// one entry. Returns the read-ticket (with addresses) and keeps the node alive via the router.
    async fn spawn_writer() -> anyhow::Result<(String, Endpoint, Router)> {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(SecretKey::from_bytes(&[9u8; 32]))
            .bind()
            .await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let mem = MemStore::new();
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*mem).clone(), gossip.clone())
            .await?;
        let router = Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&mem, None))
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();

        let author = docs.author_default().await?;
        let doc = docs.create().await?;
        // Key shape mirrors docs.rs `encode_key` (hex(author)/seq); the passthrough delivery
        // service ignores the fields, but this keeps the entry realistic.
        let key = format!("{}/{:020}", "0".repeat(64), 1u64).into_bytes();
        doc.set_bytes(author, key, b"opaque-sealed-envelope".to_vec())
            .await?;
        let ticket = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await?
            .to_string();
        Ok((ticket, endpoint, router))
    }

    #[tokio::test]
    async fn stash_reconciles_a_writers_entry_offline() -> anyhow::Result<()> {
        let (ticket, writer_ep, _writer_router) = spawn_writer().await?;

        let waker = Arc::new(CountWaker {
            count: AtomicUsize::new(0),
        });
        let stash = StashNode::spawn(
            SecretKey::from_bytes(&[7u8; 32]),
            RetentionPolicy::from_hours(48),
            &[],
            None,
            default_delivery(),
            waker.clone(),
        )
        .await?;

        let sub = PushSubscription {
            platform: Platform::Fcm,
            token: "integration".to_string(),
        };
        // Register while the writer is reachable: import + start replicating.
        let ns = stash.register(&ticket, Some(sub)).await?;
        // Proactively reconcile against the writer's address (loopback direct dial).
        stash.sync_now(ns, vec![writer_ep.addr()]).await?;

        // The stash must observe the writer's entry via reconciliation and fire the waker. Poll up
        // to 30s so a stalled sync fails the test rather than hanging.
        let mut observed = false;
        for _ in 0..300 {
            if waker.count.load(Ordering::SeqCst) >= 1 {
                observed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            observed,
            "stash did not reconcile the writer's entry within 30s"
        );
        Ok(())
    }

    /// The stash is a **store-and-forward** node: replicating an entry is worthless unless the
    /// opaque bytes come with it, because the whole point is serving a reader when the author is
    /// gone. iroh-docs reconciliation only transfers entry records (key/author/hash/len/sig) —
    /// content is a separate iroh-blobs transfer. This asserts the content actually landed.
    #[tokio::test]
    async fn stash_stores_the_content_not_just_the_entry() -> anyhow::Result<()> {
        let (ticket, writer_ep, _writer_router) = spawn_writer().await?;

        let stash = StashNode::spawn(
            SecretKey::from_bytes(&[31u8; 32]),
            RetentionPolicy::from_hours(48),
            &[],
            None,
            default_delivery(),
            Arc::new(NoopWaker),
        )
        .await?;

        let ns = stash.register(&ticket, None).await?;
        stash.sync_now(ns, vec![writer_ep.addr()]).await?;

        // Poll for the entry, then for its content. Reported separately so a failure says which
        // half is missing rather than just "timed out".
        let mut entry_hash = None;
        for _ in 0..300 {
            if let Some(doc) = stash.handle(ns).await {
                let stream = doc.get_many(Query::all().build()).await?;
                tokio::pin!(stream);
                if let Some(entry) = stream.next().await {
                    entry_hash = Some(entry?.content_hash());
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let hash = entry_hash.expect("stash did not reconcile the writer's entry within 30s");

        let mut bytes = None;
        for _ in 0..300 {
            if let Ok(found) = stash.blobs.blobs().get_bytes(hash).await {
                bytes = Some(found);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let bytes = bytes.expect(
            "stash holds the entry but never fetched its content — a reader syncing through the \
             stash gets 'Unable to download <hash>'",
        );
        assert_eq!(
            bytes.as_ref(),
            b"opaque-sealed-envelope",
            "stash served different bytes than the writer published"
        );
        Ok(())
    }

    /// Production topology: the **writer dials the stash** and the stash never dials back. Phones
    /// are NAT'd and asleep most of the time, and `register` deliberately does not dial the
    /// ticket's bootstrap nodes — so the stash only ever has an inbound connection and a bare
    /// `EndpointId` for the author. The content must still land, or offline delivery is a lie.
    #[tokio::test]
    async fn stash_stores_content_when_only_the_writer_dials() -> anyhow::Result<()> {
        let writer = spawn_writer_node(41).await?;

        let stash = StashNode::spawn(
            SecretKey::from_bytes(&[32u8; 32]),
            RetentionPolicy::from_hours(48),
            &[],
            None,
            default_delivery(),
            Arc::new(NoopWaker),
        )
        .await?;

        let ns = stash.register(&writer.ticket, None).await?;
        // The phone's half of `docs.rs::sync`: the writer dials the stash. The stash is NEVER
        // given the writer's address — no `sync_now`, no bootstrap dial.
        writer.doc.start_sync(vec![stash.endpoint.addr()]).await?;

        let mut entry_hash = None;
        for _ in 0..300 {
            if let Some(doc) = stash.handle(ns).await {
                let stream = doc.get_many(Query::all().build()).await?;
                tokio::pin!(stream);
                if let Some(entry) = stream.next().await {
                    entry_hash = Some(entry?.content_hash());
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let hash = entry_hash.expect("stash did not reconcile the entry the writer pushed");

        let mut bytes = None;
        for _ in 0..300 {
            if let Ok(found) = stash.blobs.blobs().get_bytes(hash).await {
                bytes = Some(found);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            bytes.is_some(),
            "stash holds the entry but never fetched its content when the writer drove the sync \
             — this is the production path, and a reader gets 'Unable to download <hash>'"
        );
        Ok(())
    }

    /// **The production failure, and the recovery.** The phone publishes from a headless task and
    /// the OS freezes it moments later, so the docs engine's single pull attempt finds nobody home
    /// and parks the hash — waiting on a gossip `ContentReady` a sleeping phone will never send.
    /// The entry is then stranded forever: replicated, unservable, invisible.
    ///
    /// The settle loop must keep retrying, so that the moment the author is reachable again the
    /// content lands and the entry becomes servable without any new docs sync.
    #[tokio::test]
    async fn stash_recovers_content_after_the_writer_wakes_again() -> anyhow::Result<()> {
        init_test_tracing();
        let awake = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = spawn_writer_node_with(43, awake.clone()).await?;

        let stash = StashNode::spawn(
            SecretKey::from_bytes(&[33u8; 32]),
            RetentionPolicy::from_hours(48),
            &[],
            None,
            default_delivery(),
            Arc::new(NoopWaker),
        )
        .await?;

        stash.register(&writer.ticket, None).await?;
        writer.doc.start_sync(vec![stash.endpoint.addr()]).await?;

        // The entry replicates even though the author is frozen — that half never was the problem.
        let hash = writer.entry_hash().await?;
        let mut replicated = false;
        for _ in 0..300 {
            if stash.content_stats().1 == 1 {
                replicated = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(replicated, "stash did not reconcile the entry");
        assert_eq!(
            stash.content_stats().0,
            1,
            "a frozen author cannot serve its bytes, so the entry must be reported as missing \
             content — this is the number whose absence hid the bug"
        );

        // The phone wakes up for its next fix.
        awake.store(true, Ordering::SeqCst);

        let mut recovered = false;
        for _ in 0..600 {
            if stash.content_stats().0 == 0 {
                recovered = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            recovered,
            "the stash never retried the fetch after the author came back — entries stay \
             permanently unservable"
        );
        let bytes = stash.blobs.blobs().get_bytes(hash).await?;
        assert_eq!(bytes.as_ref(), b"opaque-sealed-envelope");
        Ok(())
    }

    /// Retention must reclaim the *ciphertext*, not just the record. The stash is RAM-only, so an
    /// entry-only prune would let it grow for its whole process lifetime now that it really stores
    /// content. Dropping the last reference is the half we own; the GC sweep then collects the
    /// blob because our protect callback stops naming it.
    #[tokio::test]
    async fn pruning_an_entry_releases_its_content_for_collection() -> anyhow::Result<()> {
        init_test_tracing();
        let writer = spawn_writer_node(44).await?;
        let stash = StashNode::spawn(
            SecretKey::from_bytes(&[34u8; 32]),
            // Zero-hour window: every entry is already expired.
            RetentionPolicy::from_hours(0),
            &[],
            None,
            default_delivery(),
            Arc::new(NoopWaker),
        )
        .await?;

        stash.register(&writer.ticket, None).await?;
        writer.doc.start_sync(vec![stash.endpoint.addr()]).await?;

        let mut settled = false;
        for _ in 0..300 {
            if stash.content_stats() == (0, 1) {
                settled = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            settled,
            "content never landed, so there is nothing to prune"
        );

        // now + 1h so the entry is unambiguously past a zero-length window.
        let released = stash.prune_once(now_ms() + 3_600_000).await?;
        assert_eq!(
            released, 1,
            "the expired entry's content should be released"
        );
        assert_eq!(
            stash.content_stats(),
            (0, 0),
            "pruning the last entry referencing a blob must release it — while it is still \
             referenced the GC sweep will keep protecting it and memory never falls"
        );
        Ok(())
    }

    /// Seen in production: a phone relays its **friends'** trails as well as its own, so the stash
    /// receives entries whose author is a different device that may have been offline for days.
    /// Fetching only from the author strands exactly those entries — the ones offline delivery
    /// exists to carry. The peer that handed us the record is a valid source and must be tried.
    #[tokio::test]
    async fn content_is_fetched_from_the_relaying_peer_not_only_the_author() -> anyhow::Result<()> {
        init_test_tracing();
        // The relay holds a namespace whose entries are keyed to an author that never comes
        // online at all (no endpoint for it exists in this test).
        let absent_author = "ab".repeat(32);
        let relay = spawn_writer_node_for_author(45, &absent_author).await?;

        let stash = StashNode::spawn(
            SecretKey::from_bytes(&[36u8; 32]),
            RetentionPolicy::from_hours(48),
            &[],
            None,
            default_delivery(),
            Arc::new(NoopWaker),
        )
        .await?;

        stash.register(&relay.ticket, None).await?;
        relay.doc.start_sync(vec![stash.endpoint.addr()]).await?;

        let hash = relay.entry_hash().await?;
        let mut recovered = false;
        for _ in 0..300 {
            if stash.content_stats() == (0, 1) {
                recovered = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            recovered,
            "the stash never fetched content whose author is unreachable, even though the peer \
             that delivered the record was right there holding the bytes"
        );
        let bytes = stash.blobs.blobs().get_bytes(hash).await?;
        assert_eq!(bytes.as_ref(), b"opaque-sealed-envelope");
        Ok(())
    }

    #[tokio::test]
    async fn registration_does_not_make_a_reader_hit_already_syncing() -> anyhow::Result<()> {
        let (writer_ticket, _writer_ep, _writer_router) = spawn_writer().await?;
        let mut ticket: DocTicket = writer_ticket.parse()?;

        let stash = StashNode::spawn(
            SecretKey::from_bytes(&[35u8; 32]),
            RetentionPolicy::from_hours(48),
            &[],
            None,
            default_delivery(),
            Arc::new(NoopWaker),
        )
        .await?;

        // Choose a peer id that makes the live engine's deterministic collision rule retain the
        // stash's outgoing direction, so this same peer is rejected with `AlreadySyncing` on old
        // code when it dials back.
        let stash_id = stash.endpoint.id();
        let reader_secret = (12u8..=u8::MAX)
            .map(|byte| SecretKey::from_bytes(&[byte; 32]))
            .find(|secret| secret.public().as_bytes() > stash_id.as_bytes())
            .expect("find a reader endpoint ordered after the stash");
        let stalled = Arc::new(StalledDocsPeer {
            entered: Notify::new(),
            release: Notify::new(),
        });
        let stalled_endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(reader_secret)
            .bind()
            .await?;
        let _stalled_router = Router::builder(stalled_endpoint.clone())
            .accept(iroh_docs::ALPN, stalled.clone())
            .spawn();
        ticket.nodes = vec![stalled_endpoint.addr()];

        stash.register(&ticket.to_string(), None).await?;

        // Old behavior: registration calls `Docs::import`, which starts an outbound sync to the
        // ticket's writer. Wait briefly so that unwanted connection is definitely occupying this
        // namespace before the reader arrives. Fixed behavior never dials it.
        let registration_dialed_writer =
            tokio::time::timeout(Duration::from_secs(2), stalled.entered.notified())
                .await
                .is_ok();

        let sync = SyncHandle::spawn(DocsStore::memory(), None, "regression-reader".into());
        let namespace = sync.import_namespace(ticket.capability.clone()).await?;
        sync.open(namespace, OpenOpts::default().sync()).await?;

        let result = tokio::time::timeout(
            Duration::from_secs(10),
            connect_and_sync(
                &stalled_endpoint,
                &sync,
                namespace,
                stash.endpoint.addr(),
                None,
            ),
        )
        .await
        .map_err(|_| anyhow!("reader sync timed out"))?;
        stalled.release.notify_one();
        let _ = sync.shutdown().await;

        if matches!(
            result,
            Err(ConnectError::RemoteAbort(AbortReason::AlreadySyncing))
        ) {
            return Err(anyhow!(
                "registration occupied the namespace and made the stash reject its reader with AlreadySyncing"
            ));
        }
        result?;
        assert!(
            !registration_dialed_writer,
            "registration must import the capability without dialing ticket bootstrap nodes"
        );
        Ok(())
    }
}
