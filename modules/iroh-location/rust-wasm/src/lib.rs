//! The browser build of the location core: an in-memory iroh-docs replica over relay-only
//! connections, and nothing else.
//!
//! **Web replicates; it neither reads nor publishes fixes.** Every fix on the wire is a v3
//! envelope wrapped under a Double Ratchet session (FORWARD-SECRECY.md §4.7), and a session is
//! sequential state that must survive a reload. The browser has no filesystem — this replica and
//! its blob store vanish with the tab — so a session kept here would rewind on every reload,
//! which is key reuse rather than a missing feature. Sessions are also installed by pairing,
//! which needs the native radio stack. So the web node can hold namespaces, reconcile them with
//! the stash and with friends, and report what it could serve (`trail_replica_status`), and that
//! is all. Making web a real peer means a persistent, rollback-safe store first.
//!
//! iroh-gossip is here only because iroh-docs' live engine runs on it (each namespace is a gossip
//! topic for "I have new entries" announcements). There is no application gossip.

use anyhow::{anyhow, Context, Result};
use iroh::{protocol::Router, Endpoint, SecretKey};
use iroh_blobs::{store::mem::MemStore, BlobsProtocol};
use iroh_docs::protocol::Docs;
use iroh_gossip::net::Gossip;
use iroh_tickets::endpoint::EndpointTicket;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing_subscriber::EnvFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{prelude::wasm_bindgen, JsError, JsValue};

// The shared modules are compiled whole, but the web uses only their replica half: it holds and
// reconciles namespaces and never opens or seals an envelope (see the crate docs). `docs.rs`
// names the envelope code, so it comes along unused.
#[allow(dead_code)]
#[path = "../../rust/src/crypto.rs"]
mod crypto;
#[allow(dead_code)]
#[path = "../../rust/src/docs.rs"]
mod docs;
// `docs.rs` names the namespace book; the web store is in memory and never builds one.
#[allow(dead_code)]
#[path = "../../rust/src/ns_book.rs"]
mod ns_book;
// crypto.rs's v3 envelope wraps under a Double Ratchet message key, so the schedule comes with it.
#[allow(dead_code)]
#[path = "../../rust/src/ratchet.rs"]
mod ratchet;
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

use docs::TrailDocs;

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

struct Started {
    endpoint: Endpoint,
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
        // The docs live engine's transport, not a lane of ours: see the crate docs.
        let gossip = Gossip::builder().spawn(endpoint.clone());

        // Browsers have no filesystem, so both the blob store and the docs replica are in memory
        // (the redb/fs-store features are compiled out for wasm) and are lost with the tab.
        let blobs = MemStore::new();
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await
            .map_err(to_js_err)?;

        let router = Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip)
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .accept(iroh_docs::ALPN, docs.clone())
            .spawn();

        let trail = Arc::new(
            // Wasm uses an in-memory docs store (`Docs::memory()`), so there is no persistent
            // data dir: namespace persistence is a no-op here (fs reads yield None → a fresh
            // namespace each load), which is correct for the ephemeral web store.
            TrailDocs::init(
                docs,
                (*blobs).clone(),
                std::path::PathBuf::new(),
                None,
                None,
            )
            .await
            .map_err(to_js_err)?,
        );

        *guard = Some(Started {
            endpoint,
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

    /// Reconcile our own + every imported friend namespace so each author's **current** slot is
    /// exchanged (one last-write-wins slot per author; there is no history to recover).
    ///
    /// `peer_tickets` is every endpoint worth dialing: the trail stash, and every pool member.
    /// Mirrors the native `LocationNode::sync_latest` — see its doc comment for why recovery has
    /// to be able to reach a pool member and not just the author or the stash. Unparseable
    /// tickets are skipped rather than failing the pass.
    pub async fn sync_latest(&self, peer_tickets: Vec<String>) -> Result<(), JsError> {
        let trail = {
            let guard = self.started.lock().await;
            let started = guard
                .as_ref()
                .ok_or_else(|| JsError::new("node not started"))?;
            started.trail.clone()
        };
        let peers: Vec<_> = peer_tickets
            .iter()
            .filter_map(|ticket| ticket.parse::<EndpointTicket>().ok())
            .map(|ticket| ticket.endpoint_addr().clone())
            .collect();
        trail.sync_all(peers).await.map_err(to_js_err)?;
        Ok(())
    }

    /// What this replica can SERVE, per author — presence, never payload. Mirrors the native
    /// `LocationNode::trail_replica_status`. No decryption, which is the only kind of read the
    /// web node can do (see the crate docs).
    pub async fn trail_replica_status(&self) -> Result<JsValue, JsError> {
        let guard = self.started.lock().await;
        let started = guard
            .as_ref()
            .ok_or_else(|| JsError::new("node not started"))?;
        let slots = started.trail.replica_status().await.map_err(to_js_err)?;
        let out: Vec<JsReplicaSlot> = slots
            .into_iter()
            .map(|slot| JsReplicaSlot {
                author: hex::encode(&slot.author),
                seq: slot.seq as f64,
                fix_ts: slot.fix_ts as f64,
                has_content: slot.has_content,
            })
            .collect();
        serde_wasm_bindgen::to_value(&out).map_err(JsError::from)
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

    /// Import a friend's docs read-ticket so we replicate their trail namespace.
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

/// One author's slot in the local replica (mirrors the TS `TrailReplicaAuthor`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JsReplicaSlot {
    author: String,
    seq: f64,
    fix_ts: f64,
    has_content: bool,
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
