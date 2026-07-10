//! Bilateral **pairing** over the iroh Endpoint — the `streetcryptid/pair/1` ALPN.
//!
//! See `docs/social/ARCHITECTURE.md` §3. Pairing turns two authenticated iroh endpoints into
//! mutual "friends". It is deliberately *separate* from location sharing: completing a pair
//! only exchanges identity + the read-tickets needed to replicate each other's profile / trail
//! namespaces. Granting a location share (a per-recipient wrap) is a later, independent step.
//!
//! ## Wire protocol
//! Every exchange opens a fresh QUIC bi-stream on the existing [`Endpoint`]. Messages are
//! **length-prefixed** ([`read_frame`]/[`write_frame`]: a 4-byte big-endian length + a postcard
//! body) with a hard [`MAX_FRAME`] ceiling enforced on both read and write. Each [`PairMsg`] is
//! versioned ([`PAIR_WIRE_V`]) and **ed25519-signed** by the sender's identity seed over a
//! canonical, signature-independent encoding.
//!
//! ## Trust / binding
//! Two independent bindings make the handshake safe even though tickets travel in-band:
//! * the QUIC connection is authenticated by iroh (TLS over the ed25519 identity), and the
//!   handler pins `msg.from_endpoint == connection.remote_id()` — so an asserted `EndpointId`
//!   can't be spoofed; and
//! * the `recv_pub` (X25519 receiving key) is inside the signed message, so its binding to the
//!   endpoint id is durable and verifiable regardless of transport.
//!
//! ## Consent model
//! `Hello` discloses `recv_pub` and raises a **local pending request** on the receiver. Each
//! side then independently `respond`s Accept/Reject. A friendship [`PairResultData`] is only
//! produced once **both** sides have accepted (`result_emitted` guards idempotency). Duplicate
//! deliveries, replayed invites and expired invites are all rejected; sessions are keyed by a
//! stable 16-byte id (the invite id, or a deterministic hash of the two endpoint ids for a
//! nearby pair) so retries are idempotent.
//!
//! ## Pure vs live
//! Everything up to and including [`encode_frame`]/[`decode_frame`], [`sign_msg`]/[`verify_msg`],
//! the invite codec, [`check_invite`] and the [`PairSession`] state machine is pure and
//! unit-tested here. [`PairCore`] + [`PairProtocol`] wrap the live endpoint.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointAddr, EndpointId};
use iroh_tickets::endpoint::EndpointTicket;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::docs::TrailDocs;
use crate::profile::{ProfileDocs, ProfileSink};

/// The pairing ALPN. Bump the trailing version on any breaking wire change.
pub const PAIR_ALPN: &[u8] = b"streetcryptid/pair/1";

/// Wire schema version carried in every [`PairMsg`].
pub const PAIR_WIRE_V: u8 = 1;

/// Invite schema version carried in every [`InviteData`].
pub const INVITE_V: u8 = 1;

/// Hard ceiling on a single framed pairing message body, enforced on read and write. Pairing
/// messages are tiny (two tickets at most), so 64 KiB is generous and bounds memory on the
/// accept path against a hostile peer.
pub const MAX_FRAME: usize = 64 * 1024;

/// Domain-separation prefix mixed into the bytes we ed25519-sign, so a pairing signature can
/// never be confused with a profile/envelope signature.
const PAIR_SIG_CTX: &[u8] = b"streetcryptid/pair/v1";

/// Domain-separation prefix for the deterministic nearby-session id.
const NEARBY_CTX: &[u8] = b"streetcryptid/pair/nearby";

/// Opaque token prefix for an encoded invite.
const INVITE_PREFIX: &str = "scpair1:";

const SESSION_ID_LEN: usize = 16;
const INVITE_SECRET_LEN: usize = 16;
const ENDPOINT_LEN: usize = 32;
const RECV_PUB_LEN: usize = 32;
const SIG_LEN: usize = 64;

// ── Time helper ─────────────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Hex (dependency-free, round-trips with hex_decode) ────────────────────────────────────

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn hex_decode(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        bail!("odd-length hex");
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char)
            .to_digit(16)
            .ok_or_else(|| anyhow!("bad hex digit"))?;
        let lo = (pair[1] as char)
            .to_digit(16)
            .ok_or_else(|| anyhow!("bad hex digit"))?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

// ── Length-prefixed framing (pure + stream helpers) ───────────────────────────────────────

/// Wrap `body` in a 4-byte big-endian length prefix. Errors if `body` exceeds [`MAX_FRAME`].
pub fn encode_frame(body: &[u8]) -> Result<Vec<u8>> {
    if body.len() > MAX_FRAME {
        bail!("frame body {} exceeds MAX_FRAME {MAX_FRAME}", body.len());
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    Ok(out)
}

/// Parse a length-prefixed frame, validating the declared length against [`MAX_FRAME`] and the
/// actual buffer length. The inverse of [`encode_frame`].
pub fn decode_frame(buf: &[u8]) -> Result<Vec<u8>> {
    if buf.len() < 4 {
        bail!("frame shorter than length prefix");
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_FRAME {
        bail!("declared frame length {len} exceeds MAX_FRAME {MAX_FRAME}");
    }
    if buf.len() != 4 + len {
        bail!(
            "frame length mismatch: declared {len}, have {}",
            buf.len() - 4
        );
    }
    Ok(buf[4..].to_vec())
}

async fn write_frame(send: &mut SendStream, body: &[u8]) -> Result<()> {
    let framed = encode_frame(body)?;
    send.write_all(&framed)
        .await
        .map_err(|e| anyhow!("write frame: {e}"))?;
    send.finish().map_err(|e| anyhow!("finish: {e}"))?;
    Ok(())
}

async fn read_frame(recv: &mut RecvStream) -> Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    recv.read_exact(&mut len_buf)
        .await
        .map_err(|e| anyhow!("read len: {e}"))?;
    // Guard the declared length before allocating so a hostile peer can't force a huge buffer.
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME {
        bail!("declared frame length {len} exceeds MAX_FRAME {MAX_FRAME}");
    }
    let mut framed = vec![0u8; 4 + len];
    framed[..4].copy_from_slice(&len_buf);
    recv.read_exact(&mut framed[4..])
        .await
        .map_err(|e| anyhow!("read body: {e}"))?;
    // Reuse the pure parser for the final length-consistency + MAX_FRAME validation.
    decode_frame(&framed)
}

// ── Wire message ─────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
enum Decision {
    Hello,
    Accept,
    Reject,
}

/// One pairing message. Byte fields are `Vec<u8>` (validated on decode) to keep postcard framing
/// simple and consistent with [`crate::crypto`]'s envelope.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct PairMsg {
    v: u8,
    /// 16-byte session id (invite id or derived nearby id).
    session_id: Vec<u8>,
    /// Present (16 bytes) only on an invite-based `Hello`; empty otherwise.
    invite_secret: Vec<u8>,
    /// 32-byte asserted endpoint id of the sender (pinned against the authenticated connection).
    from_endpoint: Vec<u8>,
    /// 32-byte X25519 receiving public key of the sender.
    recv_pub: Vec<u8>,
    decision: Decision,
    /// Dial hint (our current endpoint ticket); always populated best-effort.
    endpoint_ticket: String,
    /// Profile read-ticket; populated only on `Accept`.
    profile_ticket: String,
    /// Trail read-ticket; populated only on `Accept`.
    trail_ticket: String,
    ts: u64,
    /// 64-byte ed25519 signature over the canonical (sig-less) encoding.
    sig: Vec<u8>,
}

/// Canonical, signature-independent encoding used for signing + verification.
fn pair_signing_bytes(m: &PairMsg) -> Result<Vec<u8>> {
    let mut unsigned = m.clone();
    unsigned.sig = Vec::new();
    let mut out = PAIR_SIG_CTX.to_vec();
    out.extend_from_slice(&postcard::to_allocvec(&unsigned).map_err(|e| anyhow!("encode: {e}"))?);
    Ok(out)
}

fn sign_msg(identity_seed: &[u8; 32], mut m: PairMsg) -> Result<PairMsg> {
    let sk = SigningKey::from_bytes(identity_seed);
    // The asserted endpoint id must be the public half of the signing seed.
    if sk.verifying_key().to_bytes().as_slice() != m.from_endpoint.as_slice() {
        bail!("from_endpoint is not the public half of the signing seed");
    }
    let sig = sk.sign(&pair_signing_bytes(&m)?);
    m.sig = sig.to_bytes().to_vec();
    Ok(m)
}

/// Structural + signature verification (does NOT check the connection binding).
fn verify_msg(m: &PairMsg) -> Result<()> {
    if m.v != PAIR_WIRE_V {
        bail!("unsupported pair wire version {}", m.v);
    }
    if m.session_id.len() != SESSION_ID_LEN
        || m.from_endpoint.len() != ENDPOINT_LEN
        || m.recv_pub.len() != RECV_PUB_LEN
        || m.sig.len() != SIG_LEN
    {
        bail!("pair message field length invalid");
    }
    if !(m.invite_secret.is_empty() || m.invite_secret.len() == INVITE_SECRET_LEN) {
        bail!("invite secret length invalid");
    }
    if m.endpoint_ticket.len() > MAX_FRAME
        || m.profile_ticket.len() > MAX_FRAME
        || m.trail_ticket.len() > MAX_FRAME
    {
        bail!("pair message ticket too large");
    }
    let ep: [u8; ENDPOINT_LEN] = m
        .from_endpoint
        .clone()
        .try_into()
        .map_err(|_| anyhow!("bad endpoint id"))?;
    let vk = VerifyingKey::from_bytes(&ep).map_err(|_| anyhow!("bad verifying key"))?;
    let sig = Signature::from_slice(&m.sig).map_err(|_| anyhow!("bad signature bytes"))?;
    vk.verify_strict(&pair_signing_bytes(m)?, &sig)
        .map_err(|_| anyhow!("pair signature invalid"))?;
    Ok(())
}

/// [`verify_msg`] + pin the asserted endpoint id to the authenticated connection's remote id.
fn verify_bound(m: &PairMsg, remote: &[u8; 32]) -> Result<()> {
    verify_msg(m)?;
    if m.from_endpoint.as_slice() != remote.as_slice() {
        bail!("asserted endpoint id does not match the authenticated peer");
    }
    Ok(())
}

fn encode_msg(m: &PairMsg) -> Result<Vec<u8>> {
    postcard::to_allocvec(m).map_err(|e| anyhow!("encode pair message: {e}"))
}

fn decode_msg(b: &[u8]) -> Result<PairMsg> {
    postcard::from_bytes(b).map_err(|e| anyhow!("decode pair message: {e}"))
}

// ── Invite ───────────────────────────────────────────────────────────────────────────────

/// The out-of-band invite. It carries only *immutable* bootstrap material: version, a random
/// id + secret, the issuer's endpoint id, an endpoint ticket (dial hint) and an expiry. Mutable
/// data (profile, recv keys, doc tickets) travels later over the authenticated iroh connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InviteData {
    pub version: u8,
    pub invite_id: [u8; SESSION_ID_LEN],
    pub secret: [u8; INVITE_SECRET_LEN],
    pub endpoint_id: [u8; ENDPOINT_LEN],
    pub endpoint_ticket: String,
    pub expires_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct InviteWire {
    v: u8,
    invite_id: Vec<u8>,
    secret: Vec<u8>,
    endpoint_id: Vec<u8>,
    endpoint_ticket: String,
    expires_at_ms: u64,
}

/// Encode an invite to an opaque, dependency-free `scpair1:<hex>` token.
pub fn encode_invite(inv: &InviteData) -> Result<String> {
    let w = InviteWire {
        v: inv.version,
        invite_id: inv.invite_id.to_vec(),
        secret: inv.secret.to_vec(),
        endpoint_id: inv.endpoint_id.to_vec(),
        endpoint_ticket: inv.endpoint_ticket.clone(),
        expires_at_ms: inv.expires_at_ms,
    };
    let bytes = postcard::to_allocvec(&w).map_err(|e| anyhow!("encode invite: {e}"))?;
    Ok(format!("{INVITE_PREFIX}{}", hex_encode(&bytes)))
}

/// Decode + structurally validate an `scpair1:` invite token.
pub fn decode_invite(s: &str) -> Result<InviteData> {
    let hex = s
        .strip_prefix(INVITE_PREFIX)
        .ok_or_else(|| anyhow!("bad invite prefix"))?;
    let bytes = hex_decode(hex)?;
    let w: InviteWire = postcard::from_bytes(&bytes).map_err(|e| anyhow!("decode invite: {e}"))?;
    if w.v != INVITE_V {
        bail!("unsupported invite version {}", w.v);
    }
    let invite_id: [u8; SESSION_ID_LEN] = w
        .invite_id
        .try_into()
        .map_err(|_| anyhow!("bad invite id length"))?;
    let secret: [u8; INVITE_SECRET_LEN] = w
        .secret
        .try_into()
        .map_err(|_| anyhow!("bad invite secret length"))?;
    let endpoint_id: [u8; ENDPOINT_LEN] = w
        .endpoint_id
        .try_into()
        .map_err(|_| anyhow!("bad endpoint id length"))?;
    Ok(InviteData {
        version: w.v,
        invite_id,
        secret,
        endpoint_id,
        endpoint_ticket: w.endpoint_ticket,
        expires_at_ms: w.expires_at_ms,
    })
}

/// A locally-issued invite we're waiting for a peer to redeem.
#[derive(Clone, Debug)]
struct IssuedInvite {
    secret: [u8; INVITE_SECRET_LEN],
    expires_at_ms: u64,
    /// Bound to the first peer that redeems it (one-shot); a second, different peer is rejected.
    bound_peer: Option<[u8; ENDPOINT_LEN]>,
}

/// Result of validating an inbound invite-based `Hello` against our issued invites.
#[derive(Debug, PartialEq, Eq)]
enum InviteCheck {
    Ok,
    Unknown,
    Expired,
    BadSecret,
    WrongPeer,
}

/// Pure invite expiry test.
pub fn is_invite_expired(expires_at_ms: u64, now_ms: u64) -> bool {
    now_ms > expires_at_ms
}

fn check_invite(
    issued: Option<&IssuedInvite>,
    secret: &[u8],
    remote: &[u8; ENDPOINT_LEN],
    now_ms: u64,
) -> InviteCheck {
    let Some(inv) = issued else {
        return InviteCheck::Unknown;
    };
    if is_invite_expired(inv.expires_at_ms, now_ms) {
        return InviteCheck::Expired;
    }
    if secret != inv.secret.as_slice() {
        return InviteCheck::BadSecret;
    }
    match inv.bound_peer {
        Some(p) if &p != remote => InviteCheck::WrongPeer,
        _ => InviteCheck::Ok,
    }
}

/// Deterministic 16-byte session id for a nearby (invite-less) pair. Symmetric in the two
/// endpoint ids so both sides derive the same id.
fn derive_nearby_id(a: &[u8; ENDPOINT_LEN], b: &[u8; ENDPOINT_LEN]) -> [u8; SESSION_ID_LEN] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut hasher = blake3::Hasher::new();
    hasher.update(NEARBY_CTX);
    hasher.update(lo);
    hasher.update(hi);
    let mut id = [0u8; SESSION_ID_LEN];
    id.copy_from_slice(&hasher.finalize().as_bytes()[..SESSION_ID_LEN]);
    id
}

// ── Session state machine (pure) ──────────────────────────────────────────────────────────

/// The coarse, UI-facing phase of a pairing session, derived from the two decisions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairPhase {
    /// `Hello` sent/received but the peer hasn't disclosed its recv key yet.
    Handshaking,
    /// Both sides exchanged `Hello`; awaiting local + peer decisions.
    Pending,
    /// We accepted; waiting on the peer.
    LocalAccepted,
    /// The peer accepted; waiting on us.
    PeerAccepted,
    /// Both accepted — a friendship result is available.
    Complete,
    /// Either side rejected.
    Rejected,
    /// Unrecoverable protocol/transport failure. Reserved for the exhaustive UniFFI contract
    /// (maps to `PairState::Failed`); the current state machine surfaces hard errors as `Result`
    /// returns rather than latching a session into this phase.
    #[allow(dead_code)]
    Failed,
}

/// A node-level pairing notice, drained via [`PairCore::poll_notices`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairSignal {
    /// A peer wants to pair with us (or our outbound `Hello` landed) — the app should prompt.
    PendingRequest,
    /// The peer sent their decision (accept/reject observed).
    PeerResponded,
    /// Both sides accepted — call [`PairCore::result_data`].
    Ready,
    /// The session was rejected by either side.
    Rejected,
    /// The session failed. Reserved for the exhaustive UniFFI contract (maps to
    /// `PairEventKind::Failed`); hard errors are currently surfaced as `Result` returns.
    #[allow(dead_code)]
    Failed,
}

/// A drained notice.
#[derive(Clone, Debug)]
pub struct PairNotice {
    pub signal: PairSignal,
    pub session_id: [u8; SESSION_ID_LEN],
    pub peer_endpoint: [u8; ENDPOINT_LEN],
    /// Whether this session is an invite-less nearby pair (vs invite-based). Fixed at session
    /// creation; see [`PairSession::nearby`].
    pub nearby: bool,
}

/// A snapshot of a session's state for the bridge.
#[derive(Clone, Debug)]
pub struct PairStateData {
    pub session_id: [u8; SESSION_ID_LEN],
    pub peer_endpoint: [u8; ENDPOINT_LEN],
    pub phase: PairPhase,
    pub local_accepted: bool,
    pub peer_accepted: bool,
    pub initiator: bool,
    /// Whether this session is an invite-less nearby pair (vs invite-based). Fixed at session
    /// creation; see [`PairSession::nearby`].
    pub nearby: bool,
}

/// The material handed back on a completed pair (the bridge enriches it with the verified,
/// synced profile before surfacing a `PairResult`).
#[derive(Clone, Debug)]
pub struct PairResultData {
    pub session_id: [u8; SESSION_ID_LEN],
    pub peer_endpoint: [u8; ENDPOINT_LEN],
    pub peer_recv_pub: [u8; RECV_PUB_LEN],
    pub peer_endpoint_ticket: String,
    pub peer_profile_ticket: String,
    pub peer_trail_ticket: String,
}

/// Per-session state. Pure: no I/O, fully unit-testable.
#[derive(Clone, Debug)]
struct PairSession {
    session_id: [u8; SESSION_ID_LEN],
    initiator: bool,
    /// Whether this is an invite-less nearby pair (vs invite-based). Set once at session
    /// creation and never mutated afterwards — later Accept/Reject messages must not change the
    /// route a session took to get here.
    nearby: bool,
    peer_endpoint: [u8; ENDPOINT_LEN],
    peer_recv_pub: Option<[u8; RECV_PUB_LEN]>,
    local_decision: Option<bool>,
    peer_decision: Option<bool>,
    peer_endpoint_ticket: Option<String>,
    peer_profile_ticket: Option<String>,
    peer_trail_ticket: Option<String>,
    pending_emitted: bool,
    result_emitted: bool,
    #[allow(dead_code)]
    created_ms: u64,
}

impl PairSession {
    fn new(
        session_id: [u8; SESSION_ID_LEN],
        initiator: bool,
        nearby: bool,
        peer_endpoint: [u8; ENDPOINT_LEN],
        created_ms: u64,
    ) -> Self {
        Self {
            session_id,
            initiator,
            nearby,
            peer_endpoint,
            peer_recv_pub: None,
            local_decision: None,
            peer_decision: None,
            peer_endpoint_ticket: None,
            peer_profile_ticket: None,
            peer_trail_ticket: None,
            pending_emitted: false,
            result_emitted: false,
            created_ms,
        }
    }

    fn phase(&self) -> PairPhase {
        if self.local_decision == Some(false) || self.peer_decision == Some(false) {
            return PairPhase::Rejected;
        }
        match (self.local_decision, self.peer_decision) {
            (Some(true), Some(true)) => PairPhase::Complete,
            (Some(true), _) => PairPhase::LocalAccepted,
            (_, Some(true)) => PairPhase::PeerAccepted,
            _ => {
                if self.peer_recv_pub.is_some() {
                    PairPhase::Pending
                } else {
                    PairPhase::Handshaking
                }
            }
        }
    }

    fn is_complete(&self) -> bool {
        self.local_decision == Some(true) && self.peer_decision == Some(true)
    }

    fn state_data(&self) -> PairStateData {
        PairStateData {
            session_id: self.session_id,
            peer_endpoint: self.peer_endpoint,
            phase: self.phase(),
            local_accepted: self.local_decision == Some(true),
            peer_accepted: self.peer_decision == Some(true),
            initiator: self.initiator,
            nearby: self.nearby,
        }
    }

    /// Fold a peer message (Hello disclosure / Accept tickets / decision) into this session.
    fn ingest_peer(&mut self, msg: &PairMsg) {
        if self.peer_recv_pub.is_none() {
            if let Ok(pr) = <[u8; RECV_PUB_LEN]>::try_from(msg.recv_pub.clone()) {
                self.peer_recv_pub = Some(pr);
            }
        }
        if !msg.endpoint_ticket.is_empty() {
            self.peer_endpoint_ticket = Some(msg.endpoint_ticket.clone());
        }
        match msg.decision {
            Decision::Accept => {
                if !msg.profile_ticket.is_empty() {
                    self.peer_profile_ticket = Some(msg.profile_ticket.clone());
                }
                if !msg.trail_ticket.is_empty() {
                    self.peer_trail_ticket = Some(msg.trail_ticket.clone());
                }
                self.peer_decision = Some(true);
            }
            Decision::Reject => self.peer_decision = Some(false),
            Decision::Hello => {}
        }
    }
}

// ── Live core ─────────────────────────────────────────────────────────────────────────────

/// Runtime handles injected once [`crate::LocationNode::start`] has bound the endpoint + docs.
struct PairRuntime {
    endpoint: Endpoint,
    trail: Arc<TrailDocs>,
    profile: Arc<ProfileDocs>,
    profile_sink: Arc<dyn ProfileSink>,
}

/// The shared pairing state + behaviour. Held by [`PairProtocol`] (inbound) and the
/// [`crate::LocationNode`] (outbound). Cheap to clone via `Arc`.
pub struct PairCore {
    identity_seed: [u8; 32],
    endpoint_id: [u8; ENDPOINT_LEN],
    recv_public: Vec<u8>,
    sessions: Mutex<HashMap<[u8; SESSION_ID_LEN], PairSession>>,
    invites: Mutex<HashMap<[u8; SESSION_ID_LEN], IssuedInvite>>,
    notices: Mutex<VecDeque<PairNotice>>,
    runtime: Mutex<Option<PairRuntime>>,
    pairing_ready: AtomicBool,
}

impl PairCore {
    pub fn new(identity_seed: [u8; 32], endpoint_id: [u8; 32], recv_public: Vec<u8>) -> Arc<Self> {
        Arc::new(Self {
            identity_seed,
            endpoint_id,
            recv_public,
            sessions: Mutex::new(HashMap::new()),
            invites: Mutex::new(HashMap::new()),
            notices: Mutex::new(VecDeque::new()),
            runtime: Mutex::new(None),
            pairing_ready: AtomicBool::new(false),
        })
    }

    /// Inject the live endpoint/docs handles. Called once from `start()`.
    pub async fn attach_runtime(
        &self,
        endpoint: Endpoint,
        trail: Arc<TrailDocs>,
        profile: Arc<ProfileDocs>,
        profile_sink: Arc<dyn ProfileSink>,
    ) {
        *self.runtime.lock().await = Some(PairRuntime {
            endpoint,
            trail,
            profile,
            profile_sink,
        });
    }

    /// Whether we currently accept *nearby* (invite-less) pair requests. Invite-based requests
    /// are always allowed (creating an invite is itself consent).
    pub fn set_pairing_ready(&self, ready: bool) {
        self.pairing_ready.store(ready, Ordering::SeqCst);
    }

    pub fn pairing_ready(&self) -> bool {
        self.pairing_ready.load(Ordering::SeqCst)
    }

    async fn runtime_endpoint(&self) -> Result<Endpoint> {
        let guard = self.runtime.lock().await;
        let rt = guard
            .as_ref()
            .ok_or_else(|| anyhow!("pair runtime not attached"))?;
        Ok(rt.endpoint.clone())
    }

    async fn runtime_docs(
        &self,
    ) -> Result<(Arc<TrailDocs>, Arc<ProfileDocs>, Arc<dyn ProfileSink>)> {
        let guard = self.runtime.lock().await;
        let rt = guard
            .as_ref()
            .ok_or_else(|| anyhow!("pair runtime not attached"))?;
        Ok((
            rt.trail.clone(),
            rt.profile.clone(),
            rt.profile_sink.clone(),
        ))
    }

    async fn our_endpoint_ticket(&self) -> String {
        match self.runtime_endpoint().await {
            Ok(ep) => EndpointTicket::new(ep.addr()).to_string(),
            Err(_) => String::new(),
        }
    }

    async fn our_profile_ticket(&self) -> String {
        match self.runtime_docs().await {
            Ok((_, profile, _)) => profile.ticket().await.unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    async fn our_trail_ticket(&self) -> String {
        match self.runtime_docs().await {
            Ok((trail, _, _)) => {
                let ns = trail.own_namespace();
                trail.read_ticket(ns).await.unwrap_or_default()
            }
            Err(_) => String::new(),
        }
    }

    /// Build + sign one of our messages. `Accept` carries our profile + trail read-tickets.
    async fn build_msg(
        &self,
        decision: Decision,
        session_id: [u8; SESSION_ID_LEN],
        invite_secret: Vec<u8>,
    ) -> Result<PairMsg> {
        let endpoint_ticket = self.our_endpoint_ticket().await;
        let (profile_ticket, trail_ticket) = match decision {
            Decision::Accept => (
                self.our_profile_ticket().await,
                self.our_trail_ticket().await,
            ),
            _ => (String::new(), String::new()),
        };
        let msg = PairMsg {
            v: PAIR_WIRE_V,
            session_id: session_id.to_vec(),
            invite_secret,
            from_endpoint: self.endpoint_id.to_vec(),
            recv_pub: self.recv_public.clone(),
            decision,
            endpoint_ticket,
            profile_ticket,
            trail_ticket,
            ts: now_ms(),
            sig: Vec::new(),
        };
        sign_msg(&self.identity_seed, msg)
    }

    /// Our current stance, as a response message (Accept w/ tickets, Reject, or Hello disclosure).
    async fn build_response(&self, session_id: [u8; SESSION_ID_LEN]) -> Result<PairMsg> {
        let local = self
            .sessions
            .lock()
            .await
            .get(&session_id)
            .and_then(|s| s.local_decision);
        let decision = match local {
            Some(true) => Decision::Accept,
            Some(false) => Decision::Reject,
            None => Decision::Hello,
        };
        self.build_msg(decision, session_id, Vec::new()).await
    }

    fn peer_addr(
        &self,
        peer_endpoint: [u8; ENDPOINT_LEN],
        ticket: Option<&str>,
    ) -> Result<EndpointAddr> {
        if let Some(t) = ticket {
            if let Ok(et) = t.parse::<EndpointTicket>() {
                return Ok(et.endpoint_addr().clone());
            }
        }
        let id =
            EndpointId::from_bytes(&peer_endpoint).map_err(|e| anyhow!("bad endpoint id: {e}"))?;
        Ok(EndpointAddr::new(id))
    }

    async fn push_notice(
        &self,
        signal: PairSignal,
        session_id: [u8; SESSION_ID_LEN],
        peer_endpoint: [u8; ENDPOINT_LEN],
        nearby: bool,
    ) {
        self.notices.lock().await.push_back(PairNotice {
            signal,
            session_id,
            peer_endpoint,
            nearby,
        });
    }

    /// Drain queued notices (node-level poll API — avoids foreign callbacks for testability).
    pub async fn poll_notices(&self) -> Vec<PairNotice> {
        self.notices.lock().await.drain(..).collect()
    }

    pub async fn session_state(&self, session_id: &[u8; SESSION_ID_LEN]) -> Option<PairStateData> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(PairSession::state_data)
    }

    pub async fn list_sessions(&self) -> Vec<PairStateData> {
        self.sessions
            .lock()
            .await
            .values()
            .map(PairSession::state_data)
            .collect()
    }

    /// The completed friendship material, or `None` if the session isn't complete.
    pub async fn result_data(&self, session_id: &[u8; SESSION_ID_LEN]) -> Option<PairResultData> {
        let sessions = self.sessions.lock().await;
        let s = sessions.get(session_id)?;
        if !s.is_complete() {
            return None;
        }
        let peer_recv_pub = s.peer_recv_pub?;
        Some(PairResultData {
            session_id: s.session_id,
            peer_endpoint: s.peer_endpoint,
            peer_recv_pub,
            peer_endpoint_ticket: s.peer_endpoint_ticket.clone().unwrap_or_default(),
            peer_profile_ticket: s.peer_profile_ticket.clone().unwrap_or_default(),
            peer_trail_ticket: s.peer_trail_ticket.clone().unwrap_or_default(),
        })
    }

    // ── Outbound ──────────────────────────────────────────────────────────────────────────

    /// Mint + store a fresh invite (one-shot, `ttl_secs`-lived).
    pub async fn create_invite(&self, ttl_secs: u64) -> Result<InviteData> {
        let mut invite_id = [0u8; SESSION_ID_LEN];
        let mut secret = [0u8; INVITE_SECRET_LEN];
        OsRng.fill_bytes(&mut invite_id);
        OsRng.fill_bytes(&mut secret);
        let endpoint_ticket = self.our_endpoint_ticket().await;
        if endpoint_ticket.is_empty() {
            bail!("node not started: no endpoint ticket for invite");
        }
        let expires_at_ms = now_ms().saturating_add(ttl_secs.saturating_mul(1000));
        self.invites.lock().await.insert(
            invite_id,
            IssuedInvite {
                secret,
                expires_at_ms,
                bound_peer: None,
            },
        );
        Ok(InviteData {
            version: INVITE_V,
            invite_id,
            secret,
            endpoint_id: self.endpoint_id,
            endpoint_ticket,
            expires_at_ms,
        })
    }

    /// Begin an invite-based pair: dial the issuer and exchange `Hello`. Returns the session id.
    pub async fn initiate_by_invite(&self, inv: &InviteData) -> Result<[u8; SESSION_ID_LEN]> {
        if inv.version != INVITE_V {
            bail!("unsupported invite version {}", inv.version);
        }
        if is_invite_expired(inv.expires_at_ms, now_ms()) {
            bail!("invite expired");
        }
        let session_id = inv.invite_id;
        let peer_endpoint = inv.endpoint_id;
        {
            let mut sessions = self.sessions.lock().await;
            let s = sessions.entry(session_id).or_insert_with(|| {
                PairSession::new(session_id, true, false, peer_endpoint, now_ms())
            });
            s.peer_endpoint_ticket = Some(inv.endpoint_ticket.clone());
        }
        let msg = self
            .build_msg(Decision::Hello, session_id, inv.secret.to_vec())
            .await?;
        let endpoint = self.runtime_endpoint().await?;
        let addr = self.peer_addr(peer_endpoint, Some(&inv.endpoint_ticket))?;
        let resp = dial_exchange(&endpoint, addr, &msg).await?;
        self.ingest_response(&session_id, &peer_endpoint, resp)
            .await?;
        // Raise a local pending request so our UI confirms before we accept.
        self.push_notice(PairSignal::PendingRequest, session_id, peer_endpoint, false)
            .await;
        Ok(session_id)
    }

    /// Begin a nearby (invite-less) pair with a peer we discovered (e.g. over BLE). Returns the
    /// deterministic session id. The peer must have `set_pairing_ready(true)`.
    pub async fn initiate_nearby(
        &self,
        peer_endpoint: [u8; ENDPOINT_LEN],
    ) -> Result<[u8; SESSION_ID_LEN]> {
        let session_id = derive_nearby_id(&self.endpoint_id, &peer_endpoint);
        {
            let mut sessions = self.sessions.lock().await;
            sessions.entry(session_id).or_insert_with(|| {
                PairSession::new(session_id, true, true, peer_endpoint, now_ms())
            });
        }
        let msg = self
            .build_msg(Decision::Hello, session_id, Vec::new())
            .await?;
        let endpoint = self.runtime_endpoint().await?;
        let addr = self.peer_addr(peer_endpoint, None)?;
        let resp = dial_exchange(&endpoint, addr, &msg).await?;
        self.ingest_response(&session_id, &peer_endpoint, resp)
            .await?;
        self.push_notice(PairSignal::PendingRequest, session_id, peer_endpoint, true)
            .await;
        Ok(session_id)
    }

    /// Respond to a pending session. Records our decision locally first (so completion still
    /// happens if the peer reaches us later), then best-effort notifies the peer.
    pub async fn respond(&self, session_id: &[u8; SESSION_ID_LEN], accept: bool) -> Result<()> {
        let (peer_endpoint, peer_ticket, nearby) = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            s.local_decision = Some(accept);
            (s.peer_endpoint, s.peer_endpoint_ticket.clone(), s.nearby)
        };

        let decision = if accept {
            Decision::Accept
        } else {
            Decision::Reject
        };
        let msg = self.build_msg(decision, *session_id, Vec::new()).await?;

        // Best-effort notify: if the peer is unreachable we keep our recorded decision.
        if let Ok(endpoint) = self.runtime_endpoint().await {
            if let Ok(addr) = self.peer_addr(peer_endpoint, peer_ticket.as_deref()) {
                if let Ok(resp) = dial_exchange(&endpoint, addr, &msg).await {
                    let _ = self.ingest_response(session_id, &peer_endpoint, resp).await;
                }
            }
        }

        if accept {
            let complete = self
                .sessions
                .lock()
                .await
                .get(session_id)
                .map(PairSession::is_complete)
                .unwrap_or(false);
            if complete {
                self.finalize(session_id, peer_endpoint).await?;
            }
        } else {
            self.push_notice(PairSignal::Rejected, *session_id, peer_endpoint, nearby)
                .await;
        }
        Ok(())
    }

    /// Fold a dial response (the peer's current stance) into an existing session.
    async fn ingest_response(
        &self,
        session_id: &[u8; SESSION_ID_LEN],
        peer_endpoint: &[u8; ENDPOINT_LEN],
        resp: PairMsg,
    ) -> Result<()> {
        verify_bound(&resp, peer_endpoint)?;
        let (became_accept, nearby) = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            let before = s.peer_decision;
            s.ingest_peer(&resp);
            (
                s.peer_decision == Some(true) && before != Some(true),
                s.nearby,
            )
        };
        if became_accept {
            self.push_notice(
                PairSignal::PeerResponded,
                *session_id,
                *peer_endpoint,
                nearby,
            )
            .await;
        }
        Ok(())
    }

    /// Import the peer's tickets, start watching their profile, and raise a `Ready` notice —
    /// exactly once per session.
    async fn finalize(
        &self,
        session_id: &[u8; SESSION_ID_LEN],
        peer_endpoint: [u8; ENDPOINT_LEN],
    ) -> Result<()> {
        let (profile_ticket, trail_ticket, nearby) = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            if s.result_emitted {
                return Ok(());
            }
            s.result_emitted = true;
            (
                s.peer_profile_ticket.clone(),
                s.peer_trail_ticket.clone(),
                s.nearby,
            )
        };

        if let Ok((trail, profile, sink)) = self.runtime_docs().await {
            if let Some(pt) = profile_ticket.as_deref() {
                if let Ok(ns) = profile.import_ticket(pt).await {
                    profile.watch(ns, sink);
                }
            }
            if let Some(tt) = trail_ticket.as_deref() {
                let _ = trail.import_ticket(tt).await;
            }
        }

        self.push_notice(PairSignal::Ready, *session_id, peer_endpoint, nearby)
            .await;
        Ok(())
    }

    // ── Inbound (protocol handler) ──────────────────────────────────────────────────────────

    async fn handle_incoming(&self, remote: [u8; ENDPOINT_LEN], msg: PairMsg) -> Result<PairMsg> {
        verify_bound(&msg, &remote)?;
        let now = now_ms();
        let session_id: [u8; SESSION_ID_LEN] = msg
            .session_id
            .clone()
            .try_into()
            .map_err(|_| anyhow!("bad session id"))?;

        match msg.decision {
            Decision::Hello => {
                let nearby = msg.invite_secret.is_empty();
                if nearby {
                    // Nearby: gated on pairing_ready and a matching deterministic id.
                    if !self.pairing_ready() {
                        bail!("not accepting nearby pair requests");
                    }
                    let expected = derive_nearby_id(&self.endpoint_id, &remote);
                    if expected != session_id {
                        bail!("nearby session id mismatch");
                    }
                } else {
                    // Invite-based: validate + one-shot bind against our issued invites.
                    let check = {
                        let invites = self.invites.lock().await;
                        check_invite(invites.get(&session_id), &msg.invite_secret, &remote, now)
                    };
                    if check != InviteCheck::Ok {
                        bail!("invite rejected: {check:?}");
                    }
                    if let Some(inv) = self.invites.lock().await.get_mut(&session_id) {
                        inv.bound_peer = Some(remote);
                    }
                }

                let emit_pending = {
                    let mut sessions = self.sessions.lock().await;
                    let s = sessions.entry(session_id).or_insert_with(|| {
                        PairSession::new(session_id, false, nearby, remote, now)
                    });
                    s.ingest_peer(&msg);
                    if !s.pending_emitted {
                        s.pending_emitted = true;
                        true
                    } else {
                        false
                    }
                };
                if emit_pending {
                    self.push_notice(PairSignal::PendingRequest, session_id, remote, nearby)
                        .await;
                }
                self.build_response(session_id).await
            }
            Decision::Accept => {
                let (complete, nearby) = {
                    let mut sessions = self.sessions.lock().await;
                    let s = sessions
                        .get_mut(&session_id)
                        .ok_or_else(|| anyhow!("accept for unknown session"))?;
                    s.ingest_peer(&msg);
                    (s.is_complete(), s.nearby)
                };
                self.push_notice(PairSignal::PeerResponded, session_id, remote, nearby)
                    .await;
                if complete {
                    self.finalize(&session_id, remote).await?;
                }
                self.build_response(session_id).await
            }
            Decision::Reject => {
                let nearby = {
                    let mut sessions = self.sessions.lock().await;
                    if let Some(s) = sessions.get_mut(&session_id) {
                        s.ingest_peer(&msg);
                        s.nearby
                    } else {
                        false
                    }
                };
                self.push_notice(PairSignal::Rejected, session_id, remote, nearby)
                    .await;
                self.build_response(session_id).await
            }
        }
    }
}

/// Open a fresh bi-stream, send our framed message, and read the framed response.
async fn dial_exchange(endpoint: &Endpoint, addr: EndpointAddr, msg: &PairMsg) -> Result<PairMsg> {
    let conn = endpoint
        .connect(addr, PAIR_ALPN)
        .await
        .map_err(|e| anyhow!("pair dial: {e}"))?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| anyhow!("open_bi: {e}"))?;
    write_frame(&mut send, &encode_msg(msg)?).await?;
    let resp_bytes = read_frame(&mut recv).await?;
    let resp = decode_msg(&resp_bytes)?;
    conn.close(0u32.into(), b"pair-done");
    Ok(resp)
}

/// The inbound `streetcryptid/pair/1` protocol handler.
#[derive(Clone)]
pub struct PairProtocol {
    core: Arc<PairCore>,
}

impl PairProtocol {
    pub fn new(core: Arc<PairCore>) -> Self {
        Self { core }
    }
}

impl std::fmt::Debug for PairProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairProtocol")
    }
}

fn accept_err(e: impl std::fmt::Display) -> AcceptError {
    AcceptError::from_err(std::io::Error::other(e.to_string()))
}

impl ProtocolHandler for PairProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let remote = conn.remote_id();
        let remote_bytes = *remote.as_bytes();
        let (mut send, mut recv) = conn.accept_bi().await.map_err(accept_err)?;
        let req = read_frame(&mut recv).await.map_err(accept_err)?;
        let msg = decode_msg(&req).map_err(accept_err)?;
        let resp = self
            .core
            .handle_incoming(remote_bytes, msg)
            .await
            .map_err(accept_err)?;
        let encoded = encode_msg(&resp).map_err(accept_err)?;
        write_frame(&mut send, &encoded).await.map_err(accept_err)?;
        conn.closed().await;
        Ok(())
    }
}

// ── Tests (pure) ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn identity() -> ([u8; 32], [u8; 32]) {
        let sk = SigningKey::generate(&mut OsRng);
        (sk.to_bytes(), sk.verifying_key().to_bytes())
    }

    fn recv_pub() -> Vec<u8> {
        let mut b = vec![0u8; RECV_PUB_LEN];
        OsRng.fill_bytes(&mut b);
        b
    }

    fn sample_msg(seed: &[u8; 32], endpoint: &[u8; 32], decision: Decision) -> PairMsg {
        let msg = PairMsg {
            v: PAIR_WIRE_V,
            session_id: vec![7u8; SESSION_ID_LEN],
            invite_secret: Vec::new(),
            from_endpoint: endpoint.to_vec(),
            recv_pub: recv_pub(),
            decision,
            endpoint_ticket: "ticket".into(),
            profile_ticket: String::new(),
            trail_ticket: String::new(),
            ts: 123,
            sig: Vec::new(),
        };
        sign_msg(seed, msg).unwrap()
    }

    #[test]
    fn frame_roundtrip() {
        let body = b"hello pairing";
        let framed = encode_frame(body).unwrap();
        assert_eq!(framed.len(), 4 + body.len());
        assert_eq!(decode_frame(&framed).unwrap(), body);
    }

    #[test]
    fn frame_rejects_oversize_on_encode() {
        let big = vec![0u8; MAX_FRAME + 1];
        assert!(encode_frame(&big).is_err());
    }

    #[test]
    fn frame_rejects_oversize_declared_length() {
        // declared length > MAX_FRAME
        let mut buf = ((MAX_FRAME as u32) + 1).to_be_bytes().to_vec();
        buf.extend_from_slice(b"x");
        assert!(decode_frame(&buf).is_err());
    }

    #[test]
    fn frame_rejects_length_mismatch() {
        let mut buf = 10u32.to_be_bytes().to_vec();
        buf.extend_from_slice(b"short");
        assert!(decode_frame(&buf).is_err());
    }

    #[test]
    fn msg_sign_verify_roundtrip() {
        let (seed, endpoint) = identity();
        let msg = sample_msg(&seed, &endpoint, Decision::Hello);
        verify_msg(&msg).unwrap();
        verify_bound(&msg, &endpoint).unwrap();
    }

    #[test]
    fn msg_tamper_is_detected() {
        let (seed, endpoint) = identity();
        let mut msg = sample_msg(&seed, &endpoint, Decision::Hello);
        msg.recv_pub[0] ^= 0xff;
        assert!(verify_msg(&msg).is_err());
    }

    #[test]
    fn msg_binding_mismatch_is_rejected() {
        let (seed, endpoint) = identity();
        let (_, other) = identity();
        let msg = sample_msg(&seed, &endpoint, Decision::Hello);
        // Signature is valid, but the connection's remote id differs.
        assert!(verify_msg(&msg).is_ok());
        assert!(verify_bound(&msg, &other).is_err());
    }

    #[test]
    fn msg_wrong_endpoint_for_seed_cannot_sign() {
        let (seed, _endpoint) = identity();
        let (_, other) = identity();
        let msg = PairMsg {
            v: PAIR_WIRE_V,
            session_id: vec![1u8; SESSION_ID_LEN],
            invite_secret: Vec::new(),
            from_endpoint: other.to_vec(), // not the public half of `seed`
            recv_pub: recv_pub(),
            decision: Decision::Hello,
            endpoint_ticket: String::new(),
            profile_ticket: String::new(),
            trail_ticket: String::new(),
            ts: 0,
            sig: Vec::new(),
        };
        assert!(sign_msg(&seed, msg).is_err());
    }

    #[test]
    fn msg_bad_version_rejected() {
        let (seed, endpoint) = identity();
        let mut msg = sample_msg(&seed, &endpoint, Decision::Hello);
        msg.v = 2;
        assert!(verify_msg(&msg).is_err());
    }

    #[test]
    fn invite_codec_roundtrip() {
        let inv = InviteData {
            version: INVITE_V,
            invite_id: [3u8; SESSION_ID_LEN],
            secret: [9u8; INVITE_SECRET_LEN],
            endpoint_id: [5u8; ENDPOINT_LEN],
            endpoint_ticket: "endpoint-ticket-abc".into(),
            expires_at_ms: 1_700_000_000_000,
        };
        let token = encode_invite(&inv).unwrap();
        assert!(token.starts_with(INVITE_PREFIX));
        let back = decode_invite(&token).unwrap();
        assert_eq!(inv, back);
    }

    #[test]
    fn invite_bad_prefix_rejected() {
        assert!(decode_invite("nope:deadbeef").is_err());
    }

    #[test]
    fn invite_expiry_boundary() {
        assert!(!is_invite_expired(1000, 1000)); // not expired exactly at expiry
        assert!(is_invite_expired(1000, 1001));
        assert!(!is_invite_expired(1000, 999));
    }

    #[test]
    fn check_invite_variants() {
        let secret = [4u8; INVITE_SECRET_LEN];
        let peer = [8u8; ENDPOINT_LEN];
        let other = [9u8; ENDPOINT_LEN];
        let base = IssuedInvite {
            secret,
            expires_at_ms: 10_000,
            bound_peer: None,
        };
        // unknown invite
        assert_eq!(check_invite(None, &secret, &peer, 1), InviteCheck::Unknown);
        // ok (unbound)
        assert_eq!(
            check_invite(Some(&base), &secret, &peer, 1),
            InviteCheck::Ok
        );
        // expired
        assert_eq!(
            check_invite(Some(&base), &secret, &peer, 20_000),
            InviteCheck::Expired
        );
        // bad secret
        assert_eq!(
            check_invite(Some(&base), &[0u8; INVITE_SECRET_LEN], &peer, 1),
            InviteCheck::BadSecret
        );
        // wrong peer once bound (replay/steal by a different endpoint)
        let bound = IssuedInvite {
            bound_peer: Some(peer),
            ..base.clone()
        };
        assert_eq!(
            check_invite(Some(&bound), &secret, &other, 1),
            InviteCheck::WrongPeer
        );
        // same bound peer retry is idempotent-OK
        assert_eq!(
            check_invite(Some(&bound), &secret, &peer, 1),
            InviteCheck::Ok
        );
    }

    #[test]
    fn nearby_id_is_symmetric() {
        let a = [1u8; ENDPOINT_LEN];
        let b = [2u8; ENDPOINT_LEN];
        assert_eq!(derive_nearby_id(&a, &b), derive_nearby_id(&b, &a));
        let c = [3u8; ENDPOINT_LEN];
        assert_ne!(derive_nearby_id(&a, &b), derive_nearby_id(&a, &c));
    }

    #[test]
    fn session_nearby_flag_reflected_in_state_data() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];

        let invite_session = PairSession::new(sid, true, false, peer, 0);
        assert!(!invite_session.state_data().nearby);

        let nearby_session = PairSession::new(sid, true, true, peer, 0);
        assert!(nearby_session.state_data().nearby);
    }

    #[test]
    fn session_nearby_flag_is_fixed_at_creation_and_survives_accept() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = PairSession::new(sid, true, true, peer, 0);
        assert!(s.nearby);

        let (seed, endpoint) = identity();
        let accept = sample_msg(&seed, &endpoint, Decision::Accept);
        s.ingest_peer(&accept);
        // Accept must never flip the route a session took to get here.
        assert!(s.nearby);
        assert!(s.state_data().nearby);
    }

    #[test]
    fn session_nearby_flag_is_fixed_at_creation_and_survives_reject() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = PairSession::new(sid, false, false, peer, 0);
        assert!(!s.nearby);

        let (seed, endpoint) = identity();
        let reject = sample_msg(&seed, &endpoint, Decision::Reject);
        s.ingest_peer(&reject);
        // Reject must never flip the route a session took to get here.
        assert!(!s.nearby);
        assert!(!s.state_data().nearby);
    }

    #[test]
    fn session_bilateral_accept_transitions() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = PairSession::new(sid, true, false, peer, 0);
        assert_eq!(s.phase(), PairPhase::Handshaking);

        // peer discloses recv key via Hello
        let (seed, endpoint) = identity();
        let hello = sample_msg(&seed, &endpoint, Decision::Hello);
        s.ingest_peer(&hello);
        assert_eq!(s.phase(), PairPhase::Pending);

        // we accept locally
        s.local_decision = Some(true);
        assert_eq!(s.phase(), PairPhase::LocalAccepted);
        assert!(!s.is_complete());

        // peer accepts
        let mut accept = PairMsg {
            profile_ticket: "p".into(),
            trail_ticket: "t".into(),
            ..sample_msg(&seed, &endpoint, Decision::Accept)
        };
        accept = sign_msg(
            &seed,
            PairMsg {
                sig: Vec::new(),
                ..accept
            },
        )
        .unwrap();
        s.ingest_peer(&accept);
        assert_eq!(s.phase(), PairPhase::Complete);
        assert!(s.is_complete());
        assert_eq!(s.peer_profile_ticket.as_deref(), Some("p"));
        assert_eq!(s.peer_trail_ticket.as_deref(), Some("t"));
    }

    #[test]
    fn session_reject_transitions() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = PairSession::new(sid, false, false, peer, 0);
        s.local_decision = Some(true);
        let (seed, endpoint) = identity();
        let reject = sample_msg(&seed, &endpoint, Decision::Reject);
        s.ingest_peer(&reject);
        assert_eq!(s.phase(), PairPhase::Rejected);
        assert!(!s.is_complete());
    }

    #[test]
    fn msg_encode_decode_roundtrip() {
        let (seed, endpoint) = identity();
        let msg = sample_msg(&seed, &endpoint, Decision::Accept);
        let bytes = encode_msg(&msg).unwrap();
        let back = decode_msg(&bytes).unwrap();
        verify_bound(&back, &endpoint).unwrap();
    }
}
