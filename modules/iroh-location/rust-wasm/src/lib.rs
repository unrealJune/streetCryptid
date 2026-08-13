use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use iroh::{protocol::Router, Endpoint, EndpointId, SecretKey};
use iroh_blobs::{store::mem::MemStore, BlobsProtocol};
use iroh_docs::protocol::Docs;
use iroh_gossip::{
    api::{Event, GossipSender},
    net::{Gossip, GOSSIP_ALPN},
    proto::TopicId,
};
use iroh_tickets::endpoint::EndpointTicket;
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{prelude::wasm_bindgen, JsError, JsValue};
use wasm_streams::ReadableStream;

#[path = "../../rust/src/crypto.rs"]
mod crypto;
#[path = "../../rust/src/docs.rs"]
mod docs;
#[path = "../../rust/src/pad.rs"]
mod pad;
#[path = "../../rust/src/relay.rs"]
mod relay;

mod telemetry {
    pub(crate) fn short_hex(bytes: &[u8]) -> String {
        bytes
            .iter()
            .take(5)
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

use docs::{LatestFix, TrailDocs};

const TOPIC_PREFIX: &[u8] = b"streetcryptid.loc";

/// The `mesh_epoch` every docs/gossip envelope carries. Mirrors `iroh_location::DOCS_MESH_EPOCH`
/// — this crate includes `crypto.rs` by path rather than depending on the mobile crate, so the
/// constant is restated rather than imported. There is no mesh path in the browser build.
const DOCS_MESH_EPOCH: u32 = 0;

#[wasm_bindgen(start)]
fn wasm_start() {
    console_error_panic_hook::set_once();
    // Quiet iroh's chatty internals — docs live-sync retries (`NotFound` aborts when a swarm peer
    // is asked for a namespace it hasn't imported) and QUIC/relay path churn — which otherwise
    // flood the browser console and jank the main thread. Keep warnings from our own crate.
    let filter = EnvFilter::try_new(
        // `iroh::socket=error` silences the expected relay-only "dropped transmit: IP unsupported
        // in browser" spam (browsers can't do direct UDP); keep our own crate at info.
        "warn,iroh_docs::engine::live=off,noq_proto=off,iroh::socket=error,iroh_location_wasm=info",
    )
    .unwrap_or_else(|_| EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG))
        .without_time()
        .with_ansi(false)
        .try_init();
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsLocationFix {
    lat: f64,
    lon: f64,
    accuracy_m: f64,
    heading_deg: f64,
    ts: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireLocationFix {
    lat: f64,
    lon: f64,
    accuracy_m: f64,
    heading_deg: f64,
    ts: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum JsLocationEvent {
    Fix {
        author: String,
        seq: f64,
        fix: JsLocationFix,
        /// `true` when this fix was recovered via durable range-reconciliation
        /// (iroh-docs catch-up) rather than the live gossip path.
        backfill: bool,
    },
    Opaque {
        author: String,
        seq: f64,
    },
    Status {
        status: String,
    },
}

struct Started {
    endpoint: Endpoint,
    gossip: Gossip,
    trail: Arc<TrailDocs>,
    _router: Router,
}

#[wasm_bindgen]
pub struct WasmLocationNode {
    identity_seed: [u8; 32],
    author: [u8; 32],
    recv_secret: Vec<u8>,
    recv_public: Vec<u8>,
    started: Arc<Mutex<Option<Started>>>,
}

#[wasm_bindgen]
impl WasmLocationNode {
    #[wasm_bindgen(constructor)]
    pub fn new(
        identity_secret_hex: Option<String>,
        recv_secret_hex: Option<String>,
    ) -> Result<WasmLocationNode, JsError> {
        let secret = match identity_secret_hex {
            Some(hex) if !hex.is_empty() => {
                let bytes = decode_fixed_32(&hex).map_err(to_js_err)?;
                SecretKey::from_bytes(&bytes)
            }
            _ => SecretKey::generate(),
        };
        let identity_seed = secret.to_bytes();
        let author = *secret.public().as_bytes();

        let (recv_secret, recv_public) = match recv_secret_hex {
            Some(hex) if !hex.is_empty() => {
                let sk = hex::decode(hex)
                    .context("bad receiving secret hex")
                    .map_err(to_js_err)?;
                let pk = derive_recv_public(&sk).map_err(to_js_err)?;
                (sk, pk)
            }
            _ => crypto::generate_recv_keypair(),
        };

        Ok(Self {
            identity_seed,
            author,
            recv_secret,
            recv_public,
            started: Arc::new(Mutex::new(None)),
            docs_events: Arc::new(Mutex::new(None)),
        })
    }

    pub fn endpoint_id(&self) -> String {
        hex::encode(self.author)
    }

    pub fn identity_secret(&self) -> String {
        hex::encode(self.identity_seed)
    }

    pub fn recv_secret(&self) -> String {
        hex::encode(&self.recv_secret)
    }

    pub fn recv_public(&self) -> String {
        hex::encode(&self.recv_public)
    }

    pub async fn start(
        &self,
        relay_urls: Vec<String>,
        relay_auth_token: String,
    ) -> Result<(), JsError> {
        let mut guard = self.started.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let secret = SecretKey::from_bytes(&self.identity_seed);
        let relay_mode = relay::custom_relay_mode(&relay_urls, &relay_auth_token)
            .map_err(|error| JsError::new(&error))?;
        let builder = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(secret)
            .alpns(vec![GOSSIP_ALPN.to_vec()])
            .relay_mode(relay_mode);
        let endpoint = builder.bind().await.map_err(to_js_err)?;
        // Browsers can't hole-punch or use direct UDP, so every connection must route over a relay.
        // `bind()` returns before a home relay is picked, so minting a ticket now would embed only
        // direct (unusable) addresses → peers get "IP unsupported"/dial timeouts. Wait until we're
        // relay-connected so tickets carry a dialable relay address. Bounded so a dead relay can't
        // hang startup (we proceed best-effort on timeout).
        let _ =
            n0_future::time::timeout(n0_future::time::Duration::from_secs(10), endpoint.online())
                .await;
        let gossip = Gossip::builder().spawn(endpoint.clone());

        // Durable trail: browsers have no filesystem, so both the blobs content store and the
        // docs replica are in-memory (redb/fs-store features are compiled out for wasm).
        // Durability caveat: the trail is ephemeral — it is lost on page reload / tab close.
        // Recovery still works within a session (and across peers) via range reconciliation.
        let blobs = MemStore::new();
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await
            .map_err(to_js_err)?;

        let router = Router::builder(endpoint.clone())
            .accept(GOSSIP_ALPN, gossip.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();

        let trail = Arc::new(
            // Wasm uses an in-memory docs store (`Docs::memory()`), so there is no persistent
            // data dir: namespace persistence is a no-op here (fs reads yield None → a fresh
            // namespace each load), which is correct for the ephemeral web store.
            TrailDocs::init(docs, (*blobs).clone(), std::path::PathBuf::new())
                .await
                .map_err(to_js_err)?,
        );

        *guard = Some(Started {
            endpoint,
            gossip,
            trail,
            _router: router,
        });
        Ok(())
    }

    pub async fn ticket(&self) -> Result<String, JsError> {
        let guard = self.started.lock().await;
        let started = guard
            .as_ref()
            .ok_or_else(|| JsError::new("node not started"))?;
        Ok(EndpointTicket::new(started.endpoint.addr()).to_string())
    }

    pub async fn subscribe(
        &self,
        topic_hex: String,
        bootstrap_tickets: JsValue,
    ) -> Result<WasmLocationSubscription, JsError> {
        let topic = decode_fixed_32(&topic_hex).map_err(to_js_err)?;
        let topic_id = TopicId::from_bytes(topic);
        let tickets: Vec<String> = serde_wasm_bindgen::from_value(bootstrap_tickets)?;
        let mut bootstrap: Vec<EndpointId> = Vec::with_capacity(tickets.len());
        for ticket in tickets {
            let ticket: EndpointTicket = ticket
                .parse()
                .context("bad endpoint ticket")
                .map_err(to_js_err)?;
            bootstrap.push(ticket.endpoint_addr().id);
        }

        let guard = self.started.lock().await;
        let started = guard
            .as_ref()
            .ok_or_else(|| JsError::new("node not started"))?;
        let topic = started
            .gossip
            .subscribe(topic_id, bootstrap)
            .await
            .map_err(to_js_err)?;
        let (sender, receiver) = topic.split();
        drop(guard);

        let recv_secret = self.recv_secret.clone();
        let stream = receiver.map(move |event| match event {
            Ok(Event::Received(message)) => match crypto::open(&recv_secret, &message.content) {
                Ok(opened) => {
                    let payload = decode_fix_payload(&opened.payload)
                        .map_err(|err| JsValue::from_str(&err))?
                        // A null fix (§4.1) carries no position. The browser build has no
                        // watcher cadence of its own, but it must still tolerate a peer's.
                        .ok_or_else(|| JsValue::from_str("null fix"))?;
                    serde_wasm_bindgen::to_value(&JsLocationEvent::Fix {
                        author: hex::encode(opened.author),
                        seq: opened.seq as f64,
                        fix: JsLocationFix {
                            lat: payload.lat,
                            lon: payload.lon,
                            accuracy_m: payload.accuracy_m,
                            heading_deg: payload.heading_deg,
                            ts: payload.ts as f64,
                        },
                        backfill: false,
                    })
                    .map_err(|err| JsValue::from_str(&err.to_string()))
                }
                Err(crypto::CryptoError::NotARecipient) => {
                    serde_wasm_bindgen::to_value(&JsLocationEvent::Opaque {
                        author: String::new(),
                        seq: 0.0,
                    })
                    .map_err(|err| JsValue::from_str(&err.to_string()))
                }
                Err(err) => Err(JsValue::from_str(&err.to_string())),
            },
            Ok(Event::NeighborUp(_)) => serde_wasm_bindgen::to_value(&JsLocationEvent::Status {
                status: "peer-up".to_string(),
            })
            .map_err(|err| JsValue::from_str(&err.to_string())),
            Ok(Event::NeighborDown(_)) => serde_wasm_bindgen::to_value(&JsLocationEvent::Status {
                status: "peer-down".to_string(),
            })
            .map_err(|err| JsValue::from_str(&err.to_string())),
            Ok(Event::Lagged) => serde_wasm_bindgen::to_value(&JsLocationEvent::Status {
                status: "lagged".to_string(),
            })
            .map_err(|err| JsValue::from_str(&err.to_string())),
            Err(err) => Err(JsValue::from_str(&err.to_string())),
        });

        let receiver = ReadableStream::from_stream(stream).into_raw();

        Ok(WasmLocationSubscription {
            sender: Arc::new(Mutex::new(sender)),
            identity_seed: self.identity_seed,
            author: self.author,
            receiver,
        })
    }

    // ── Durable trail (iroh-docs) — mirrors the native path (rust/src/docs.rs) ─────────────
    // In-memory store (no browser fs); the sealed envelope bytes are identical to native, so a
    // web peer's durable entries interoperate with native peers.

    /// Seal `fix` for `recipients_hex` and write it to OUR docs namespace under the single
    /// last-write-wins fix key, mirroring the gossip broadcast (identical sealed bytes, so
    /// revocation carries over). The previous fix is superseded — the replica holds no history.
    pub async fn docs_write(
        &self,
        _subscription_id: String,
        seq: f64,
        fix: JsValue,
        recipients_hex: JsValue,
    ) -> Result<(), JsError> {
        let fix: JsLocationFix = serde_wasm_bindgen::from_value(fix)?;
        let recipient_strings: Vec<String> = serde_wasm_bindgen::from_value(recipients_hex)?;
        let recipients = recipient_strings
            .iter()
            .map(|hex| hex::decode(hex).context("bad recipient key hex"))
            .collect::<Result<Vec<_>>>()
            .map_err(to_js_err)?;
        let wire_fix = WireLocationFix {
            lat: fix.lat,
            lon: fix.lon,
            accuracy_m: fix.accuracy_m,
            heading_deg: fix.heading_deg,
            ts: fix.ts as u64,
        };
        let payload = pad_encoded(&wire_fix)
            .context("encode fix")
            .map_err(to_js_err)?;
        let envelope = crypto::seal(
            &self.identity_seed,
            &self.author,
            seq as u64,
            wire_fix.ts,
            DOCS_MESH_EPOCH,
            &payload,
            &recipients,
        )
        .map_err(to_js_err)?;

        let guard = self.started.lock().await;
        let started = guard
            .as_ref()
            .ok_or_else(|| JsError::new("node not started"))?;
        let ns = started.trail.own_namespace();
        started
            .trail
            .write(ns, &self.author, envelope)
            .await
            .map_err(to_js_err)?;
        Ok(())
    }

    /// Reconcile our own + every imported friend namespace so each friend's **current** fix is
    /// exchanged (the durable path is last-write-wins; there is no missed history to recover).
    /// When `peer_ticket` is present, every namespace explicitly syncs with that endpoint. Read
    /// the results with `read_latest`.
    pub async fn sync_latest(&self, peer_ticket: Option<String>) -> Result<(), JsError> {
        let trail = {
            let guard = self.started.lock().await;
            let started = guard
                .as_ref()
                .ok_or_else(|| JsError::new("node not started"))?;
            started.trail.clone()
        };
        let peers = peer_ticket
            .map(|ticket| {
                ticket
                    .parse::<EndpointTicket>()
                    .map(|ticket| vec![ticket.endpoint_addr().clone()])
                    .map_err(|_| JsError::new("bad sync peer endpoint ticket"))
            })
            .transpose()?
            .unwrap_or_default();
        trail.sync_all(peers).await.map_err(to_js_err)?;
        Ok(())
    }

    /// Push our own trail namespace to `peer_ticket` (the trail stash) and wait for the exchange
    /// to finish. `docs_write` only touches the local replica — iroh-docs broadcasts a local
    /// insert only for namespaces `start_sync` has marked as syncing — so without this a published
    /// fix never leaves this node. Best-effort: a failure only degrades offline delivery.
    pub async fn push_trail(&self, peer_ticket: Option<String>) -> Result<(), JsError> {
        let trail = {
            let guard = self.started.lock().await;
            let started = guard
                .as_ref()
                .ok_or_else(|| JsError::new("node not started"))?;
            started.trail.clone()
        };
        let peers = peer_ticket
            .map(|ticket| {
                ticket
                    .parse::<EndpointTicket>()
                    .map(|ticket| vec![ticket.endpoint_addr().clone()])
                    .map_err(|_| JsError::new("bad sync peer endpoint ticket"))
            })
            .transpose()?
            .unwrap_or_default();
        let ns = trail.own_namespace();
        trail.push(ns, peers).await.map_err(to_js_err)?;
        Ok(())
    }

    /// Read the latest decryptable fix per author from the local replica. One entry per author —
    /// the durable path holds no history. Returns an array of `{ author, seq, fix }`.
    pub async fn read_latest(&self) -> Result<JsValue, JsError> {
        let guard = self.started.lock().await;
        let started = guard
            .as_ref()
            .ok_or_else(|| JsError::new("node not started"))?;
        let fixes = started
            .trail
            .read_latest(&self.recv_secret)
            .await
            .map_err(to_js_err)?;
        let incoming: Vec<JsIncomingFix> = fixes
            .into_iter()
            .filter_map(latest_fix_to_incoming)
            .collect();
        serde_wasm_bindgen::to_value(&incoming).map_err(JsError::from)
    }

    /// Explicitly drop durable entries older than `older_than_ts`.
    pub async fn prune_trail(&self, older_than_ts: f64) -> Result<(), JsError> {
        let guard = self.started.lock().await;
        let started = guard
            .as_ref()
            .ok_or_else(|| JsError::new("node not started"))?;
        let ns = started.trail.own_namespace();
        started
            .trail
            .prune(ns, older_than_ts as u64)
            .await
            .map_err(to_js_err)?;
        Ok(())
    }

    /// A shareable docs **read-ticket** granting replication of our trail namespace.
    pub async fn doc_ticket(&self) -> Result<String, JsError> {
        let guard = self.started.lock().await;
        let started = guard
            .as_ref()
            .ok_or_else(|| JsError::new("node not started"))?;
        let ns = started.trail.own_namespace();
        started.trail.read_ticket(ns).await.map_err(to_js_err)
    }

    /// Import a friend's docs read-ticket so we replicate their trail namespace and can refresh
    /// their current fix via `sync_latest`.
    pub async fn import_doc_ticket(&self, ticket: String) -> Result<(), JsError> {
        let guard = self.started.lock().await;
        let started = guard
            .as_ref()
            .ok_or_else(|| JsError::new("node not started"))?;
        started
            .trail
            .import_ticket(&ticket)
            .await
            .map(|_| ())
            .map_err(to_js_err)
    }
}

/// A decrypted fix read back from the durable replica (mirrors the TS `NativeIncomingFix`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JsIncomingFix {
    author: String,
    seq: f64,
    fix: JsLocationFix,
}

/// Encode a fix and wrap it in the constant-length frame every sealed payload uses (§4.1).
fn pad_encoded(wire_fix: &WireLocationFix) -> Result<Vec<u8>> {
    let encoded = postcard::to_allocvec(wire_fix)?;
    pad::pad(&encoded).map_err(|e| anyhow!(e.to_string()))
}

/// Unpad and decode a sealed fix payload. `Ok(None)` is a null fix — a watcher publishing on
/// cadence so the ratchet has a return contribution (§4.1); it carries no position.
fn decode_fix_payload(payload: &[u8]) -> std::result::Result<Option<WireLocationFix>, String> {
    let inner = pad::unpad(payload).map_err(|e| e.to_string())?;
    if inner.is_empty() {
        return Ok(None);
    }
    postcard::from_bytes::<WireLocationFix>(inner)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Convert a decrypted [`LatestFix`] into [`JsIncomingFix`], decoding the payload.
fn latest_fix_to_incoming(lf: LatestFix) -> Option<JsIncomingFix> {
    let payload = decode_fix_payload(&lf.payload).ok().flatten()?;
    Some(JsIncomingFix {
        author: hex::encode(&lf.author),
        seq: lf.seq as f64,
        fix: JsLocationFix {
            lat: payload.lat,
            lon: payload.lon,
            accuracy_m: payload.accuracy_m,
            heading_deg: payload.heading_deg,
            ts: payload.ts as f64,
        },
    })
}

#[wasm_bindgen]
pub struct WasmLocationSubscription {
    sender: Arc<Mutex<GossipSender>>,
    identity_seed: [u8; 32],
    author: [u8; 32],
    receiver: wasm_streams::readable::sys::ReadableStream,
}

#[wasm_bindgen]
impl WasmLocationSubscription {
    pub fn receiver(&self) -> wasm_streams::readable::sys::ReadableStream {
        self.receiver.clone()
    }

    pub async fn publish(
        &self,
        seq: f64,
        fix: JsValue,
        recipients_hex: JsValue,
    ) -> Result<(), JsError> {
        let fix: JsLocationFix = serde_wasm_bindgen::from_value(fix)?;
        let recipient_strings: Vec<String> = serde_wasm_bindgen::from_value(recipients_hex)?;
        let recipients = recipient_strings
            .iter()
            .map(|hex| hex::decode(hex).context("bad recipient key hex"))
            .collect::<Result<Vec<_>>>()
            .map_err(to_js_err)?;
        let wire_fix = WireLocationFix {
            lat: fix.lat,
            lon: fix.lon,
            accuracy_m: fix.accuracy_m,
            heading_deg: fix.heading_deg,
            ts: fix.ts as u64,
        };
        let payload = pad_encoded(&wire_fix)
            .context("encode fix")
            .map_err(to_js_err)?;
        let envelope = crypto::seal(
            &self.identity_seed,
            &self.author,
            seq as u64,
            wire_fix.ts,
            DOCS_MESH_EPOCH,
            &payload,
            &recipients,
        )
        .map_err(to_js_err)?;
        self.sender
            .lock()
            .await
            .broadcast(envelope.into())
            .await
            .map_err(to_js_err)?;
        Ok(())
    }

    pub fn close(self) {
        drop(self);
    }
}

#[wasm_bindgen]
pub fn derive_topic_hex(author_endpoint_id_hex: String) -> Result<String, JsError> {
    let author = hex::decode(author_endpoint_id_hex)
        .context("bad author endpoint id hex")
        .map_err(to_js_err)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(TOPIC_PREFIX);
    hasher.update(&author);
    Ok(hex::encode(hasher.finalize().as_bytes()))
}

fn decode_fixed_32(input: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(input).context("bad hex")?;
    bytes
        .try_into()
        .map_err(|_| anyhow!("expected 32-byte hex value"))
}

fn derive_recv_public(recv_secret: &[u8]) -> Result<Vec<u8>> {
    use hpke::{Deserializable, Serializable};
    let sk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::PrivateKey::from_bytes(recv_secret)
        .map_err(|_| anyhow!("bad receiving key"))?;
    let pk = <hpke::kem::X25519HkdfSha256 as hpke::Kem>::sk_to_pk(&sk);
    Ok(pk.to_bytes().to_vec())
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}
