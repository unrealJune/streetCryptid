//! Live in-memory replica + HTTP control API. **Behind the `live` feature.**
//!
//! This is the only module that talks to a real iroh node. It boots a **fully in-memory**
//! iroh-docs replica (`Docs::memory()` + `MemStore`, exactly as the web/WASM node does — see
//! `modules/iroh-location/rust-wasm/src/lib.rs`), imports opted-in trail namespaces from their
//! read-tickets, watches each for new remote entries, and nudges subscribers via the [`Waker`].
//! Nothing is written to disk; a restart clears the replica and devices re-register.
//!
//! ## Build status
//! Compiles cleanly against iroh-docs `0.101` / iroh-blobs `0.103` (`cargo check --features live`,
//! verified 2026-07-10). Not yet runtime-tested end-to-end — there is no two-node integration test
//! of import → reconcile → wake yet. The pure modules this wires together are fully unit-tested.

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
use iroh_blobs::{store::mem::MemStore, BlobsProtocol};
use iroh_docs::{api::Doc, engine::LiveEvent, protocol::Docs, store::Query, AuthorId, DocTicket};
use iroh_gossip::net::Gossip;
use iroh_tickets::endpoint::EndpointTicket;
use n0_future::StreamExt;
use tokio::sync::Mutex;

use crate::api::{parse_namespace_hex, parse_platform, validate_register, RegisterRequest};
use crate::auth::{authorize, bearer_token};
use crate::mls::{Admission, DeliveryService, EnvelopeRef, PassthroughDelivery};
use crate::retention::RetentionPolicy;
use crate::subscriptions::{NamespaceId as NsBytes, NamespaceRegistry, PushSubscription};
use crate::waker::{NoopWaker, Waker};

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
    /// Docs author we sign our own (delete-tombstone) writes with.
    author: AuthorId,
    registry: Arc<NamespaceRegistry>,
    delivery: Arc<dyn DeliveryService>,
    waker: Arc<dyn Waker>,
    retention: RetentionPolicy,
    handles: Mutex<HashMap<NsBytes, Doc>>,
    _router: Router,
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
        let mem = MemStore::new();
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*mem).clone(), gossip.clone())
            .await
            .map_err(|e| anyhow!("spawn docs: {e}"))?;

        let router = Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&mem, None))
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();

        let author = docs
            .author_default()
            .await
            .map_err(|e| anyhow!("author_default: {e}"))?;

        Ok(Arc::new(Self {
            endpoint,
            docs,
            blobs: (*mem).clone(),
            author,
            registry: Arc::new(NamespaceRegistry::new()),
            delivery,
            waker,
            retention,
            handles: Mutex::new(HashMap::new()),
            _router: router,
        }))
    }

    /// The stash's endpoint ticket. Publish this as `EXPO_PUBLIC_TRAIL_STASH_TICKET`; the app
    /// parses it to an `EndpointAddr` and adds it to the `sync`/`sync_all` peer list.
    pub fn node_ticket(&self) -> String {
        EndpointTicket::new(self.endpoint.addr()).to_string()
    }

    /// Handle a validated `POST /v1/namespaces`: import the read-ticket (idempotent), record the
    /// opt-in grant + optional wake subscription, and start watching the namespace once.
    #[tracing::instrument(
        name = "stash.namespace.import",
        skip_all,
        fields(sc.namespace = tracing::field::Empty, first_watch = tracing::field::Empty)
    )]
    pub async fn register(
        self: &Arc<Self>,
        read_ticket: &str,
        subscription: Option<PushSubscription>,
    ) -> Result<NsBytes> {
        let ticket: DocTicket = read_ticket
            .parse()
            .map_err(|e| anyhow!("parse doc ticket: {e}"))?;
        let doc = self
            .docs
            .import(ticket)
            .await
            .map_err(|e| anyhow!("import ticket: {e}"))?;
        let ns_bytes = doc.id().to_bytes();
        tracing::Span::current().record(
            "sc.namespace",
            tracing::field::display(crate::telemetry::short_hex(&ns_bytes)),
        );

        self.handles
            .lock()
            .await
            .entry(ns_bytes)
            .or_insert_with(|| doc.clone());

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
                    Ok(LiveEvent::InsertRemote { entry, .. }) => {
                        use tracing::Instrument;
                        // `sc.entry_hash` here is the iroh-blobs content hash — the same short
                        // hash the sender stamped on its publish span and the receiver stamps on
                        // its backfill, so one Tempo query joins all three hops of a ping.
                        let span = tracing::info_span!(
                            "stash.entry.received",
                            sc.namespace = %crate::telemetry::short_hex(&ns_bytes),
                            sc.entry_hash = %crate::telemetry::short_hex(entry.content_hash().as_bytes()),
                            sc.author = tracing::field::Empty,
                            sc.seq = tracing::field::Empty,
                            wake_targets = tracing::field::Empty,
                        );
                        async {
                            // The entry has arrived — that alone is reason to wake subscribers so
                            // they sync. Fetch the opaque bytes best-effort (they may still be in
                            // flight); the passthrough delivery service ignores them, and a future
                            // MLS-aware one can re-fetch. Never skip the wake just because the
                            // blob isn't local yet.
                            let bytes = self
                                .blobs
                                .blobs()
                                .get_bytes(entry.content_hash())
                                .await
                                .unwrap_or_default();
                            let (author, seq) = decode_author_seq(entry.key());
                            let current = tracing::Span::current();
                            current.record(
                                "sc.author",
                                tracing::field::display(crate::telemetry::short_hex(&author)),
                            );
                            current.record("sc.seq", seq);
                            let env = EnvelopeRef {
                                namespace: &ns_bytes,
                                author: &author,
                                seq,
                                bytes: &bytes,
                            };
                            match self.delivery.admit(&env) {
                                Admission::Accept => {
                                    let targets = self.registry.wake_targets(&ns_bytes);
                                    current.record("wake_targets", targets.len());
                                    if !targets.is_empty() {
                                        // Called inside this span so the waker's push spans (and
                                        // the traceparent embedded in the payload) parent here.
                                        self.waker.wake(&ns_bytes, &targets);
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

    /// One retention sweep across every granted namespace, dropping entries older than the window.
    ///
    /// Best-effort: entries are authored by the phones, so deleting them from this in-memory
    /// replica drops our local copy but does not (and need not) propagate a tombstone. The hard
    /// memory bound is the retention window × fix rate × granted namespaces, plus the fact that a
    /// restart clears everything.
    #[tracing::instrument(name = "stash.prune", skip_all, fields(removed = tracing::field::Empty))]
    pub async fn prune_once(&self, now_ms: u64) -> Result<u64> {
        let cutoff = self.retention.cutoff(now_ms);
        let mut removed = 0u64;
        for ns in self.registry.known_namespaces() {
            let Some(doc) = self.handle(ns).await else {
                continue;
            };
            let stream = doc.get_many(Query::all().build()).await?;
            tokio::pin!(stream);
            let mut victims = Vec::new();
            while let Some(entry) = stream.next().await {
                let entry = entry?;
                if entry.timestamp() < cutoff {
                    victims.push(entry.key().to_vec());
                }
            }
            for key in victims {
                if let Ok(n) = doc.del(self.author, key).await {
                    removed += n as u64;
                }
            }
        }
        tracing::Span::current().record("removed", removed);
        Ok(removed)
    }

    /// Periodic prune loop; runs until the process exits.
    pub async fn run_prune_loop(self: Arc<Self>, interval_min: u64) {
        let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(interval_min * 60));
        loop {
            ticker.tick().await;
            match self.prune_once(now_ms()).await {
                Ok(n) if n > 0 => tracing::info!("stash: pruned {n} expired entries"),
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

async fn healthz() -> StatusCode {
    StatusCode::OK
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
    if s.len() % 2 != 0 {
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

    use iroh_docs::api::protocol::{AddrInfoOptions, ShareMode};

    use crate::subscriptions::Platform;

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
}
