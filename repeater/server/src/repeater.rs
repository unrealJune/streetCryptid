//! The live repeater: the `streetcryptid/repeater/1` handler, the roster it keeps on disk, and the
//! client calls phones and sibling repeaters make. **Behind the `live` feature.**
//!
//! A [`Repeater`] exists only for a persistent node (`Storage::Persistent`). It belongs to at most
//! one roster, owned by the phone that claimed it, and it keeps that roster in `roster.bin` next
//! to the grant book. What it enforces is **carrying**: whose namespaces it holds and accepts
//! pushes for. Reading stays open — iroh-docs serves any peer that names a namespace, and that is
//! the design (streetCryptid `docs/social/REPEATERS.md` §2.1).
//!
//! ## Claiming, and why it attests the owner
//! An unclaimed repeater holds a one-time **claim secret**, shown only on its own console as a
//! claim link ([`streetcryptid_repeater::wire::claim_url`], also a QR code) and replaced every [`CLAIM_WINDOW_MS`]. A
//! `Claim` must present it, and must come from the endpoint that signed the roster's genesis — the
//! QUIC handshake authenticates the caller, so "the phone at my console" and "the owner the roster
//! names" are the same key or the claim is refused. The repeater then signs a [`RepeaterCert`]
//! over `(roster, owner, itself)`. See [`streetcryptid_repeater::roster`] for how that cert, the owner's
//! `AddRepeater`, and a friend's card make the full chain.
//!
//! ## Granting, and why it attests the namespace
//! A carried member hands over a namespace with a proof signed by that **namespace's own key**
//! ([`streetcryptid_repeater::wire::sign_grant`]). Only the namespace's writer holds that key; friends
//! hold read tickets for each other's trails, and without the proof enrolling would let anyone
//! volunteer a friend's trail to be carried. When a member stops being carried, every namespace
//! granted on their behalf is released.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use ed25519_dalek::SigningKey;
use iroh::endpoint::{Connection, RecvStream};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointAddr};

use crate::node::{now_ms, StashNode};
use streetcryptid_repeater::roster::{
    CertBody, EndpointId, RepeaterCert, Roster, RosterState, SignedOp,
};
use streetcryptid_repeater::wire::{
    declared_len, decode_body, encode, secrets_match, verify_grant, Refusal, Request, Response,
    ALPN, MAX_CARRIERS, MAX_HAVE_HASHES, MAX_NAMESPACES_PER_MEMBER, MAX_PUBLISH_OPS,
};

/// How long a claim secret stays valid before the repeater replaces it.
pub const CLAIM_WINDOW_MS: u64 = 30 * 60 * 1000;
/// How long one inbound exchange may take, end to end.
const INBOUND_TIMEOUT: Duration = Duration::from_secs(20);
/// How long one outbound call may take, dial included.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// How long to wait for a well-behaved caller to close after the reply.
const CLOSE_LINGER: Duration = Duration::from_secs(2);

const ROSTER_FILE: &str = "roster.bin";

struct ClaimWindow {
    secret: [u8; 32],
    expires_ms: u64,
}

/// A persistent node's repeater state: its signing identity, its roster, its claim window.
pub struct Repeater {
    path: PathBuf,
    key: SigningKey,
    id: EndpointId,
    roster: Mutex<Option<Roster>>,
    claim: Mutex<Option<ClaimWindow>>,
    node: OnceLock<Weak<StashNode>>,
}

impl std::fmt::Debug for Repeater {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Repeater")
            .field("id", &crate::telemetry::short_hex(&self.id))
            .finish_non_exhaustive()
    }
}

impl Repeater {
    /// Open the repeater state in `dir`. `secret` is the node's endpoint seed — the repeater signs
    /// certs with the same key it answers dials with, so a cert and a handshake name one machine.
    /// A roster file that exists but cannot be read fails the open, for the grant book's reason:
    /// coming back unclaimed would hand the machine to whoever reads its console next.
    pub fn open(dir: &Path, secret: &[u8; 32]) -> Result<Self> {
        let key = SigningKey::from_bytes(secret);
        let id = key.verifying_key().to_bytes();
        let path = dir.join(ROSTER_FILE);
        let roster = match std::fs::read(&path) {
            Ok(bytes) => {
                let ops: Vec<SignedOp> = postcard::from_bytes(&bytes)
                    .map_err(|e| anyhow!("{} is unreadable: {e}", path.display()))?;
                Some(
                    Roster::from_ops(ops)
                        .map_err(|e| anyhow!("{} holds no valid roster: {e}", path.display()))?,
                )
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(anyhow!("read {}: {e}", path.display())),
        };
        Ok(Self {
            path,
            key,
            id,
            roster: Mutex::new(roster),
            claim: Mutex::new(None),
            node: OnceLock::new(),
        })
    }

    pub(crate) fn attach(&self, node: &Arc<StashNode>) {
        let _ = self.node.set(Arc::downgrade(node));
    }

    pub fn id(&self) -> EndpointId {
        self.id
    }

    pub fn is_claimed(&self) -> bool {
        self.roster.lock().expect("roster poisoned").is_some()
    }

    pub fn roster_state(&self) -> Option<RosterState> {
        self.roster
            .lock()
            .expect("roster poisoned")
            .as_ref()
            .map(Roster::state)
    }

    /// Every op held, for a sibling or a test.
    pub fn roster_ops(&self) -> Vec<SignedOp> {
        self.roster
            .lock()
            .expect("roster poisoned")
            .as_ref()
            .map(Roster::export)
            .unwrap_or_default()
    }

    /// The current claim secret, minting a fresh one when there is none or it has expired.
    /// `None` once the repeater is claimed: a claimed repeater cannot be claimed again.
    pub fn claim_secret(&self) -> Option<[u8; 32]> {
        if self.is_claimed() {
            return None;
        }
        let now = now_ms();
        let mut claim = self.claim.lock().expect("claim poisoned");
        if claim.as_ref().is_none_or(|w| w.expires_ms <= now) {
            *claim = Some(ClaimWindow {
                secret: iroh::SecretKey::generate().to_bytes(),
                expires_ms: now + CLAIM_WINDOW_MS,
            });
        }
        claim.as_ref().map(|w| w.secret)
    }

    fn node(&self) -> Option<Arc<StashNode>> {
        self.node.get().and_then(Weak::upgrade)
    }

    fn persist(&self, roster: &Roster) -> Result<()> {
        let bytes = postcard::to_allocvec(&roster.export()).context("encode roster")?;
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, bytes).with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("replace {}", self.path.display()))?;
        Ok(())
    }

    /// Merge ops into the roster, persist when anything changed, and release whatever the new
    /// state no longer carries. Returns `(accepted, pending, refused)`, or `None` if unclaimed.
    pub async fn merge(&self, ops: Vec<SignedOp>) -> Result<Option<(u32, u32, u32)>> {
        let (counts, state) = {
            let mut guard = self.roster.lock().expect("roster poisoned");
            let Some(current) = guard.as_ref() else {
                return Ok(None);
            };
            let mut next = current.clone();
            let before = (next.len(), next.pending_len());
            let (mut accepted, mut pending, mut refused) = (0u32, 0u32, 0u32);
            for op in ops {
                match next.insert(op) {
                    Ok(streetcryptid_repeater::roster::Inserted::Accepted) => accepted += 1,
                    Ok(streetcryptid_repeater::roster::Inserted::Pending) => pending += 1,
                    Ok(streetcryptid_repeater::roster::Inserted::Known) => {}
                    Err(_) => refused += 1,
                }
            }
            if (next.len(), next.pending_len()) != before {
                self.persist(&next)?;
                let state = next.state();
                *guard = Some(next);
                ((accepted, pending, refused), Some(state))
            } else {
                ((accepted, pending, refused), None)
            }
        };
        if let (Some(state), Some(node)) = (state, self.node()) {
            node.enforce_roster(&state).await;
        }
        Ok(Some(counts))
    }

    /// Answer one request from `remote` (authenticated by the connection, never by the request).
    pub async fn handle(&self, remote: EndpointId, request: Request) -> Response {
        let refused = |reason| Response::Refused { reason };
        match request {
            Request::Claim { secret, ops } => self.claim(remote, secret, ops),
            Request::Publish { ops } => {
                if ops.len() > MAX_PUBLISH_OPS {
                    return refused(Refusal::TooMany);
                }
                match self.merge(ops).await {
                    Ok(Some((accepted, pending, refused_n))) => {
                        let heads = self
                            .roster
                            .lock()
                            .expect("roster poisoned")
                            .as_ref()
                            .map(Roster::heads)
                            .unwrap_or_default();
                        Response::Published {
                            accepted,
                            pending,
                            refused: refused_n,
                            heads,
                        }
                    }
                    Ok(None) => refused(Refusal::NotClaimed),
                    Err(e) => {
                        tracing::warn!(error = %e, "repeater: could not persist the roster");
                        refused(Refusal::Unavailable)
                    }
                }
            }
            Request::Fetch => {
                let guard = self.roster.lock().expect("roster poisoned");
                let Some(roster) = guard.as_ref() else {
                    return refused(Refusal::NotClaimed);
                };
                let state = roster.state();
                let may_read = remote == state.owner
                    || state.carried.contains(&remote)
                    || state.inviters.contains(&remote)
                    || state.repeaters.contains_key(&remote);
                if !may_read {
                    return refused(Refusal::NotCarried);
                }
                Response::Roster {
                    ops: roster.export(),
                }
            }
            Request::Grant {
                ticket,
                proof,
                carriers,
            } => self.grant(remote, &ticket, &proof, &carriers).await,
            Request::Have { hashes } => {
                if hashes.len() > MAX_HAVE_HASHES {
                    return refused(Refusal::TooMany);
                }
                match self.node() {
                    Some(node) => Response::Have {
                        present: node.have(&hashes).await,
                    },
                    None => refused(Refusal::Unavailable),
                }
            }
        }
    }

    fn claim(&self, remote: EndpointId, secret: [u8; 32], ops: Vec<SignedOp>) -> Response {
        let refused = |reason| Response::Refused { reason };
        let mut guard = self.roster.lock().expect("roster poisoned");
        if guard.is_some() {
            return refused(Refusal::AlreadyClaimed);
        }
        {
            let mut claim = self.claim.lock().expect("claim poisoned");
            let valid = claim
                .as_ref()
                .is_some_and(|w| w.expires_ms > now_ms() && secrets_match(&w.secret, &secret));
            if !valid {
                return refused(Refusal::BadClaimSecret);
            }
            // Single use, whatever happens next: a wrong roster burns the secret too, so a
            // console code that leaked cannot be retried against.
            *claim = None;
        }
        let Ok(roster) = Roster::from_ops(ops) else {
            return refused(Refusal::BadClaimRoster);
        };
        if roster.owner() != remote {
            return refused(Refusal::BadClaimRoster);
        }
        let cert = RepeaterCert::issue(
            &self.key,
            &CertBody {
                roster: roster.id(),
                owner: roster.owner(),
                repeater: self.id,
                issued_ms: now_ms(),
            },
        );
        if let Err(e) = self.persist(&roster) {
            tracing::warn!(error = %e, "repeater: could not persist the claim");
            return refused(Refusal::Unavailable);
        }
        tracing::info!(
            owner = %crate::telemetry::short_hex(&roster.owner()),
            roster = %crate::telemetry::short_hex(&roster.id()),
            "repeater: claimed"
        );
        *guard = Some(roster);
        Response::Claimed { cert }
    }

    async fn grant(
        &self,
        remote: EndpointId,
        ticket: &str,
        proof: &[u8],
        carriers: &[EndpointId],
    ) -> Response {
        let refused = |reason| Response::Refused { reason };
        if carriers.len() > MAX_CARRIERS {
            return refused(Refusal::TooMany);
        }
        let carried = match self.roster.lock().expect("roster poisoned").as_ref() {
            None => return refused(Refusal::NotClaimed),
            Some(roster) => roster.is_carried(&remote),
        };
        if !carried {
            return refused(Refusal::NotCarried);
        }
        let Some(node) = self.node() else {
            return refused(Refusal::Unavailable);
        };
        let Ok(namespace) = crate::node::ticket_namespace(ticket) else {
            return refused(Refusal::Invalid);
        };
        if !verify_grant(&namespace, &self.id, &remote, proof) {
            return refused(Refusal::BadProof);
        }
        let carriers: Vec<EndpointId> = carriers
            .iter()
            .copied()
            .filter(|id| *id != self.id && *id != remote)
            .collect();
        match node
            .grant_for(&remote, ticket, &carriers, MAX_NAMESPACES_PER_MEMBER)
            .await
        {
            Ok(Some(namespace)) => Response::Granted { namespace },
            Ok(None) => refused(Refusal::TooMany),
            Err(e) => {
                tracing::warn!(error = %e, "repeater: grant failed");
                refused(Refusal::Unavailable)
            }
        }
    }

    /// The other repeaters the roster lists.
    pub fn siblings(&self) -> Vec<EndpointId> {
        self.roster_state()
            .map(|state| {
                state
                    .repeaters
                    .keys()
                    .copied()
                    .filter(|id| *id != self.id)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Exchange rosters with one sibling: take what it has, then hand it what we have. Returns
    /// whether both halves went through.
    pub async fn sync_roster_with(&self, endpoint: &Endpoint, sibling: EndpointAddr) -> bool {
        let mut ok = true;
        match call(endpoint, sibling.clone(), &Request::Fetch).await {
            Ok(Response::Roster { ops }) => {
                if let Err(e) = self.merge(ops).await {
                    tracing::warn!(error = %e, "repeater: could not merge a sibling's roster");
                    ok = false;
                }
            }
            Ok(other) => {
                tracing::debug!(?other, "repeater: sibling would not hand over its roster");
                ok = false;
            }
            Err(e) => {
                tracing::debug!(error = %e, "repeater: sibling unreachable");
                return false;
            }
        }
        let ops = self.roster_ops();
        if !ops.is_empty() {
            match call(endpoint, sibling, &Request::Publish { ops }).await {
                Ok(Response::Published { .. }) => {}
                _ => ok = false,
            }
        }
        ok
    }
}

/// Reconcile with every sibling on a timer: the roster first, then every carried namespace.
/// Siblings come from the roster's `AddRepeater` ops plus `extra` (configured by hand). A sibling
/// that is down costs a failed dial; nothing waits on it.
pub async fn run_sibling_loop(node: Arc<StashNode>, extra: Vec<EndpointAddr>, interval: Duration) {
    let Some(repeater) = node.repeater() else {
        return;
    };
    let mut ticker = tokio::time::interval(interval);
    loop {
        ticker.tick().await;
        let mut peers = extra.clone();
        for id in repeater.siblings() {
            if let Ok(id) = iroh::EndpointId::from_bytes(&id) {
                if !peers.iter().any(|p| p.id == id) {
                    peers.push(EndpointAddr::from(id));
                }
            }
        }
        if peers.is_empty() {
            continue;
        }
        for peer in &peers {
            repeater
                .sync_roster_with(node.endpoint(), peer.clone())
                .await;
        }
        node.sync_peers(&peers).await;
        node.sync_carriers().await;
    }
}

// ---- wire ---------------------------------------------------------------------------------------

async fn read_frame(recv: &mut RecvStream) -> Result<Vec<u8>> {
    let mut header = [0u8; 4];
    recv.read_exact(&mut header)
        .await
        .map_err(|e| anyhow!("read frame header: {e}"))?;
    let len = declared_len(header)?;
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .map_err(|e| anyhow!("read frame body: {e}"))?;
    Ok(body)
}

/// One request, one response, one connection.
pub async fn call(
    endpoint: &Endpoint,
    addr: impl Into<EndpointAddr>,
    request: &Request,
) -> Result<Response> {
    let addr = addr.into();
    tokio::time::timeout(CALL_TIMEOUT, async {
        let conn = endpoint
            .connect(addr, ALPN)
            .await
            .map_err(|e| anyhow!("dial repeater: {e}"))?;
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| anyhow!("open stream: {e}"))?;
        send.write_all(&encode(request)?)
            .await
            .map_err(|e| anyhow!("send request: {e}"))?;
        send.finish().map_err(|e| anyhow!("finish request: {e}"))?;
        let body = read_frame(&mut recv).await?;
        let response: Response = decode_body(&body)?;
        conn.close(0u32.into(), b"done");
        Ok(response)
    })
    .await
    .map_err(|_| anyhow!("repeater call timed out"))?
}

fn accept_err(e: impl std::fmt::Display) -> AcceptError {
    AcceptError::from_err(std::io::Error::other(e.to_string()))
}

/// The inbound `streetcryptid/repeater/1` handler.
#[derive(Debug, Clone)]
pub struct RepeaterProtocol {
    repeater: Arc<Repeater>,
}

impl RepeaterProtocol {
    pub fn new(repeater: Arc<Repeater>) -> Self {
        Self { repeater }
    }
}

impl ProtocolHandler for RepeaterProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let remote = *conn.remote_id().as_bytes();
        let span = tracing::info_span!(
            "repeater.request",
            sc.peer = %crate::telemetry::short_hex(&remote),
            request = tracing::field::Empty,
            outcome = tracing::field::Empty,
        );
        let served = tokio::time::timeout(INBOUND_TIMEOUT, async {
            let (mut send, mut recv) = conn.accept_bi().await.map_err(accept_err)?;
            let body = read_frame(&mut recv).await.map_err(accept_err)?;
            let response = match decode_body::<Request>(&body) {
                Ok(request) => {
                    span.record("request", request_name(&request));
                    self.repeater.handle(remote, request).await
                }
                Err(_) => Response::Refused {
                    reason: Refusal::Invalid,
                },
            };
            span.record("outcome", response_name(&response));
            send.write_all(&encode(&response).map_err(accept_err)?)
                .await
                .map_err(accept_err)?;
            send.finish().map_err(accept_err)?;
            Ok::<_, AcceptError>(())
        })
        .await;
        match served {
            Ok(result) => {
                let _ = tokio::time::timeout(CLOSE_LINGER, conn.closed()).await;
                result
            }
            Err(_) => {
                span.record("outcome", "timeout");
                conn.close(0u32.into(), b"repeater-slow");
                Err(accept_err("repeater request timed out"))
            }
        }
    }
}

fn request_name(request: &Request) -> &'static str {
    match request {
        Request::Claim { .. } => "claim",
        Request::Publish { .. } => "publish",
        Request::Fetch => "fetch",
        Request::Grant { .. } => "grant",
        Request::Have { .. } => "have",
    }
}

fn response_name(response: &Response) -> &'static str {
    match response {
        Response::Claimed { .. } => "claimed",
        Response::Published { .. } => "published",
        Response::Roster { .. } => "roster",
        Response::Granted { .. } => "granted",
        Response::Have { .. } => "have",
        Response::Refused { reason } => match reason {
            Refusal::BadClaimSecret => "refused:bad_claim_secret",
            Refusal::AlreadyClaimed => "refused:already_claimed",
            Refusal::BadClaimRoster => "refused:bad_claim_roster",
            Refusal::NotClaimed => "refused:not_claimed",
            Refusal::NotCarried => "refused:not_carried",
            Refusal::BadProof => "refused:bad_proof",
            Refusal::TooMany => "refused:too_many",
            Refusal::Invalid => "refused:invalid",
            Refusal::Unavailable => "refused:unavailable",
        },
    }
}
