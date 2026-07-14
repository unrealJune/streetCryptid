//! Bilateral **pairing** over the iroh Endpoint — the `streetcryptid/pair/2` ALPN.
//!
//! ## Mandatory visual SAS gate (v2)
//! A pair NEVER reaches `Complete`/`PairResult` on transport success alone. After the signed
//! `Hello`/endpoint binding, both humans must clear a **Short Authentication String** gate:
//! * Round 1 (`Hello`) carries only a BLAKE3 **commitment** to a fresh 32-byte per-session nonce.
//! * Round 2 (`Reveal`) exchanges the nonces; each side verifies the peer's commitment
//!   (commit-then-reveal, so a responder can't grind after seeing the peer nonce).
//! * A symmetric seed is derived from the full transcript (domain tag, ALPN/wire version, session
//!   id, and the canonically-ordered `(endpoint id, recv pub, nonce)` of both sides). The seed
//!   fixes one deterministic **displayer** role (independent of who initiated, so simultaneous
//!   nearby initiators get opposite roles), a `target` figure index in a 256-entry catalog, and a
//!   4-way picker option set (target + 3 unique distractors, deterministically shuffled).
//! * The displayer confirms the other human matched the shown figure; the picker selects the
//!   matching figure. Only a correct pick / affirmative confirm latches that side's SAS and sends
//!   `Accept`. A wrong pick, negative confirm, cancel, timeout, or bad reveal is **terminal**.
//! The correct answer never travels on the wire; `respond`/`Accept` are gated on the local SAS
//! latch, so a bilateral `Accept` now implies bilateral human verification.
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
pub const PAIR_ALPN: &[u8] = b"streetcryptid/pair/2";

/// Wire schema version carried in every [`PairMsg`].
pub const PAIR_WIRE_V: u8 = 2;

/// Invite schema version carried in every [`InviteData`].
pub const INVITE_V: u8 = 1;

/// Hard ceiling on a single framed pairing message body, enforced on read and write. Pairing
/// messages are tiny (two tickets at most), so 64 KiB is generous and bounds memory on the
/// accept path against a hostile peer.
pub const MAX_FRAME: usize = 64 * 1024;

/// Domain-separation prefix mixed into the bytes we ed25519-sign, so a pairing signature can
/// never be confused with a profile/envelope signature. Bumped to `v2` alongside the wire schema.
const PAIR_SIG_CTX: &[u8] = b"streetcryptid/pair/v2";

/// Domain-separation prefix for the deterministic nearby-session id.
const NEARBY_CTX: &[u8] = b"streetcryptid/pair/nearby";

/// Domain tag for the per-session SAS nonce commitment (`Hello`), binding the nonce to the
/// committer's session + endpoint id + recv key so a commitment can't be reflected or reused.
const SAS_COMMIT_CTX: &[u8] = b"streetcryptid/pair/sas-commit/v2";

/// Domain tag for the symmetric SAS transcript seed.
const SAS_SEED_CTX: &[u8] = b"streetcryptid/pair/sas-seed/v2";

/// Domain tag for expanding the SAS seed into a catalog target + picker options.
const SAS_FIGURE_CTX: &[u8] = b"streetcryptid/pair/sas-figure/v2";

/// Length of the fresh per-session SAS nonce and its BLAKE3 commitment.
const SAS_NONCE_LEN: usize = 32;
const SAS_COMMIT_LEN: usize = 32;

/// Number of figures in the SAS catalog. A single seed byte maps cleanly onto `0..256`.
pub const SAS_CATALOG_LEN: u16 = 256;

/// Number of figures the picker chooses between (the target + 3 distractors).
pub const SAS_OPTION_COUNT: usize = 4;

/// Bounded human-verification window. Actions after the deadline are terminal.
const SAS_TIMEOUT_MS: u64 = 60_000;

/// Maximum time for the automatic commit/reveal exchange to reach the visual SAS gate.
const PAIR_HANDSHAKE_TIMEOUT_MS: u64 = 60_000;

/// Once this side accepted on time, allow a small delivery grace for the peer's independently
/// on-time `Accept` to arrive before expiring the still-incomplete session.
const SAS_ACCEPTED_GRACE_MS: u64 = 10_000;

/// Preferred minimum index separation between shuffled picker options — a best-effort visual
/// spread that never overrides uniqueness/correctness.
const SAS_MIN_SEPARATION: u16 = 8;

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
    /// Round 2 of the SAS handshake: reveals the nonce committed to in `Hello`.
    Reveal,
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
    /// 32-byte BLAKE3 commitment to the sender's SAS nonce; present on `Hello`, empty otherwise.
    sas_commit: Vec<u8>,
    /// 32-byte SAS nonce; present on `Reveal`, empty otherwise. Never carries the correct answer.
    sas_nonce: Vec<u8>,
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
    if !(m.sas_commit.is_empty() || m.sas_commit.len() == SAS_COMMIT_LEN) {
        bail!("sas commitment length invalid");
    }
    if !(m.sas_nonce.is_empty() || m.sas_nonce.len() == SAS_NONCE_LEN) {
        bail!("sas nonce length invalid");
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

// ── SAS (Short Authentication String) commit / reveal / catalog (pure) ─────────────────────

/// The deterministic SAS role, derived from the transcript (NOT `initiator`). The displayer shows
/// the target figure; the picker chooses the matching figure among the options.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SasRole {
    /// Displays the target figure and confirms the other human matched it.
    Displayer,
    /// Chooses the matching figure among [`SasChallengeData::option_indices`].
    Picker,
}

/// The per-session SAS challenge surfaced to the UI while a pair is in [`PairPhase::Verifying`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SasChallengeData {
    pub role: SasRole,
    /// Correct figure index (displayer shows it; picker must match it). Never sent on the wire.
    pub target_index: u16,
    /// The picker's `SAS_OPTION_COUNT` shuffled figure indices (includes the target).
    pub option_indices: Vec<u16>,
    /// Absolute wall-clock deadline (ms). Actions after this are terminal.
    pub deadline_ms: u64,
}

/// What a human action (or [`PairCore::respond`]) is trying to do to a session's *local*
/// decision. Every local terminal transition funnels through [`PairSession::decide_local`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalIntent {
    /// A correct pick / affirmative confirm / post-SAS accept — attempt to accept.
    Accept,
    /// An explicit reject (the non-SAS `respond(false)` path).
    Reject,
    /// A terminal SAS failure — wrong pick, negative confirm, cancel, or timeout.
    Fail,
}

/// The monotonic result of attempting a local decision. Exactly one caller ever transitions a
/// session out of the undecided state; concurrent repeats resolve to `NoopOk` (the same, safe
/// outcome) or `Contradiction` (a losing, conflicting action) *without* mutating state or
/// emitting a second, contradictory wire decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalDecision {
    /// This call latched the local accept — send `Accept` and finalize if now bilateral.
    Accept,
    /// This call latched an explicit reject — send `Reject` and raise `Rejected`.
    Reject,
    /// This call latched a terminal failure — best-effort `Reject` and raise `Failed`.
    Fail,
    /// A prior decision already covers this action; no state change and no wire message.
    NoopOk,
    /// A conflicting decision already won; refuse without changing state or sending anything.
    Contradiction(&'static str),
}

/// A committer's 96-byte transcript record: `endpoint id || recv pub || nonce`.
fn sas_record(
    endpoint: &[u8; ENDPOINT_LEN],
    recv_pub: &[u8; RECV_PUB_LEN],
    nonce: &[u8; SAS_NONCE_LEN],
) -> [u8; ENDPOINT_LEN + RECV_PUB_LEN + SAS_NONCE_LEN] {
    let mut rec = [0u8; ENDPOINT_LEN + RECV_PUB_LEN + SAS_NONCE_LEN];
    rec[..ENDPOINT_LEN].copy_from_slice(endpoint);
    rec[ENDPOINT_LEN..ENDPOINT_LEN + RECV_PUB_LEN].copy_from_slice(recv_pub);
    rec[ENDPOINT_LEN + RECV_PUB_LEN..].copy_from_slice(nonce);
    rec
}

/// Domain-separated BLAKE3 commitment binding a nonce to its committer's session + identity, so a
/// commitment can neither be reflected onto the peer nor reused across sessions.
fn sas_commitment(
    session_id: &[u8; SESSION_ID_LEN],
    endpoint: &[u8; ENDPOINT_LEN],
    recv_pub: &[u8; RECV_PUB_LEN],
    nonce: &[u8; SAS_NONCE_LEN],
) -> [u8; SAS_COMMIT_LEN] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(SAS_COMMIT_CTX);
    hasher.update(session_id);
    hasher.update(endpoint);
    hasher.update(recv_pub);
    hasher.update(nonce);
    *hasher.finalize().as_bytes()
}

/// Symmetric transcript seed + which of the two records is the deterministic **displayer**.
///
/// Both sides feed the same domain tag, ALPN, wire version, session id and the canonically-ordered
/// `(endpoint, recv pub, nonce)` records, so the seed — and thus role/target/options — is identical
/// on both endpoints. The displayer is the side whose record sorts first; because endpoint ids
/// differ the roles are always complementary (even for two simultaneous nearby initiators).
fn sas_seed(
    session_id: &[u8; SESSION_ID_LEN],
    local_rec: &[u8; ENDPOINT_LEN + RECV_PUB_LEN + SAS_NONCE_LEN],
    peer_rec: &[u8; ENDPOINT_LEN + RECV_PUB_LEN + SAS_NONCE_LEN],
) -> ([u8; 32], bool) {
    let local_is_displayer = local_rec.as_slice() < peer_rec.as_slice();
    let (lo, hi) = if local_is_displayer {
        (local_rec, peer_rec)
    } else {
        (peer_rec, local_rec)
    };
    let mut hasher = blake3::Hasher::new();
    hasher.update(SAS_SEED_CTX);
    hasher.update(PAIR_ALPN);
    hasher.update(&[PAIR_WIRE_V]);
    hasher.update(session_id);
    hasher.update(lo);
    hasher.update(hi);
    (*hasher.finalize().as_bytes(), local_is_displayer)
}

/// Expand a SAS seed into `(target, options)`: a catalog target index plus a deterministically
/// shuffled `SAS_OPTION_COUNT`-way option set containing the target and unique distractors. Draws
/// prefer visually-separated indices but never sacrifice uniqueness/inclusion of the target.
fn sas_catalog(seed: &[u8; 32]) -> (u16, Vec<u16>) {
    let mut reader = {
        let mut hasher = blake3::Hasher::new();
        hasher.update(SAS_FIGURE_CTX);
        hasher.update(seed);
        hasher.finalize_xof()
    };
    let mut next_byte = move || {
        let mut b = [0u8; 1];
        reader.fill(&mut b);
        b[0]
    };

    let target = next_byte() as u16 % SAS_CATALOG_LEN;
    let mut options: Vec<u16> = vec![target];

    // Prefer a distractor that is unique AND at least SAS_MIN_SEPARATION from every chosen index;
    // after a bounded search fall back to the first merely-unique candidate so we always finish.
    while options.len() < SAS_OPTION_COUNT {
        let mut fallback: Option<u16> = None;
        let mut chosen: Option<u16> = None;
        for _ in 0..64 {
            let cand = next_byte() as u16 % SAS_CATALOG_LEN;
            if options.contains(&cand) {
                continue;
            }
            if fallback.is_none() {
                fallback = Some(cand);
            }
            if options
                .iter()
                .all(|o| o.abs_diff(cand) >= SAS_MIN_SEPARATION)
            {
                chosen = Some(cand);
                break;
            }
        }
        match chosen.or(fallback) {
            Some(c) => options.push(c),
            None => {
                // Exhausted random draws without a unique candidate — scan the catalog directly so
                // correctness (distinct options) is never compromised.
                let mut c = 0u16;
                while options.contains(&c) {
                    c += 1;
                }
                options.push(c);
            }
        }
    }

    // Fisher–Yates shuffle so the target's slot is unpredictable.
    for i in (1..options.len()).rev() {
        let j = (next_byte() as usize) % (i + 1);
        options.swap(i, j);
    }
    (target, options)
}

// ── Session state machine (pure) ──────────────────────────────────────────────────────────

/// The coarse, UI-facing phase of a pairing session, derived from the two decisions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairPhase {
    /// `Hello` sent/received but the peer hasn't disclosed its recv key yet.
    Handshaking,
    /// Both sides exchanged `Hello`; awaiting the SAS reveal round.
    Pending,
    /// The SAS nonces are revealed + verified; both humans must clear the visual gate before any
    /// `Accept`. No `PairResult` is reachable from here.
    Verifying,
    /// We accepted (SAS confirmed); waiting on the peer.
    LocalAccepted,
    /// The peer accepted; waiting on us.
    PeerAccepted,
    /// Both accepted — a friendship result is available.
    Complete,
    /// Either side rejected.
    Rejected,
    /// Unrecoverable protocol/SAS failure (wrong pick, negative confirm, cancel, timeout, bad
    /// reveal). Terminal: a fresh attempt is required.
    Failed,
}

/// A node-level pairing notice, drained via [`PairCore::poll_notices`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairSignal {
    /// A peer wants to pair with us (or our outbound `Hello` landed) — the app should prompt.
    PendingRequest,
    /// The SAS gate is ready — fetch the [`SasChallengeData`] and show the visual challenge.
    Verifying,
    /// The peer sent their decision (accept/reject observed).
    PeerResponded,
    /// Both sides accepted — call [`PairCore::result_data`].
    Ready,
    /// The session was rejected by either side.
    Rejected,
    /// The session failed (SAS mismatch/cancel/timeout or a protocol error).
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
    /// Whether the peer's SAS reveal verified (the visual gate is ready/underway).
    pub sas_verified: bool,
    /// Whether this side's human cleared the SAS gate (required before any local `Accept`).
    pub local_sas_confirmed: bool,
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
    created_ms: u64,
    // ── SAS material ──────────────────────────────────────────────────────────────────────
    /// Our own identity/keys/nonce, captured at creation so the transcript is pure + testable.
    local_endpoint: [u8; ENDPOINT_LEN],
    local_recv_pub: [u8; RECV_PUB_LEN],
    sas_nonce: [u8; SAS_NONCE_LEN],
    peer_sas_commit: Option<[u8; SAS_COMMIT_LEN]>,
    peer_sas_nonce: Option<[u8; SAS_NONCE_LEN]>,
    /// The peer's reveal verified against its commitment — the visual gate is live.
    sas_verified: bool,
    /// Computed once the reveal verifies; the challenge shown to this side's human.
    challenge: Option<SasChallengeData>,
    /// This side's human cleared the SAS gate (correct pick / affirmative confirm).
    local_sas_confirmed: bool,
    /// Terminal SAS/action failure latch (wrong pick, negative confirm, cancel, late action, bad
    /// reveal). Once set, only a fresh session may retry.
    failed: bool,
    /// The visual-verification window elapsed before the pair became bilateral. Kept separate from
    /// `failed` so an on-time local `Accept` remains immutable while the incomplete session still
    /// expires cleanly.
    timed_out: bool,
}

impl PairSession {
    #[allow(clippy::too_many_arguments)]
    fn new(
        session_id: [u8; SESSION_ID_LEN],
        initiator: bool,
        nearby: bool,
        peer_endpoint: [u8; ENDPOINT_LEN],
        created_ms: u64,
        local_endpoint: [u8; ENDPOINT_LEN],
        local_recv_pub: [u8; RECV_PUB_LEN],
        sas_nonce: [u8; SAS_NONCE_LEN],
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
            local_endpoint,
            local_recv_pub,
            sas_nonce,
            peer_sas_commit: None,
            peer_sas_nonce: None,
            sas_verified: false,
            challenge: None,
            local_sas_confirmed: false,
            failed: false,
            timed_out: false,
        }
    }

    /// Our BLAKE3 commitment to `sas_nonce` — sent on `Hello`.
    fn local_commit(&self) -> [u8; SAS_COMMIT_LEN] {
        sas_commitment(
            &self.session_id,
            &self.local_endpoint,
            &self.local_recv_pub,
            &self.sas_nonce,
        )
    }

    fn phase(&self) -> PairPhase {
        if self.failed || self.timed_out {
            return PairPhase::Failed;
        }
        if self.local_decision == Some(false) || self.peer_decision == Some(false) {
            return PairPhase::Rejected;
        }
        match (self.local_decision, self.peer_decision) {
            (Some(true), Some(true)) => PairPhase::Complete,
            (Some(true), _) => PairPhase::LocalAccepted,
            (_, Some(true)) => PairPhase::PeerAccepted,
            _ => {
                if self.sas_verified {
                    PairPhase::Verifying
                } else if self.peer_recv_pub.is_some() {
                    PairPhase::Pending
                } else {
                    PairPhase::Handshaking
                }
            }
        }
    }

    fn is_complete(&self) -> bool {
        !self.failed
            && !self.timed_out
            && self.local_decision == Some(true)
            && self.peer_decision == Some(true)
    }

    /// Whether this session is in a terminal, non-retryable state (failed or rejected). A fresh
    /// *human-triggered* nearby attempt is allowed to replace such a session with fresh SAS
    /// material; automated same-session retries are not.
    fn is_terminal_failure(&self) -> bool {
        self.failed
            || self.timed_out
            || self.local_decision == Some(false)
            || self.peer_decision == Some(false)
    }

    fn is_untouched_handshake(&self) -> bool {
        self.peer_recv_pub.is_none()
            && self.peer_sas_commit.is_none()
            && self.peer_sas_nonce.is_none()
            && self.local_decision.is_none()
            && self.peer_decision.is_none()
            && !self.sas_verified
            && !self.local_sas_confirmed
            && !self.result_emitted
    }

    /// Bind every message after session creation to the authenticated endpoint that established it.
    fn ensure_peer(&self, remote: &[u8; ENDPOINT_LEN]) -> Result<()> {
        if &self.peer_endpoint != remote {
            bail!("pair message came from an unexpected peer");
        }
        Ok(())
    }

    /// Whether a human SAS action is currently permitted (gate live, not yet decided, not late).
    fn sas_action_allowed(&self, now_ms: u64) -> bool {
        self.sas_verified
            && !self.is_terminal_failure()
            && self.challenge.is_some()
            && self.local_decision.is_none()
            && !self.local_sas_confirmed
            && now_ms <= self.verify_deadline()
    }

    /// Whether the challenge should remain visible. Unlike [`Self::sas_action_allowed`], this stays
    /// true after an on-time local confirmation so the UI can show "waiting for the other phone".
    fn sas_challenge_visible(&self, now_ms: u64) -> bool {
        self.sas_verified
            && !self.is_terminal_failure()
            && !self.is_complete()
            && self.challenge.is_some()
            && now_ms <= self.timeout_deadline()
    }

    fn verify_deadline(&self) -> u64 {
        self.challenge.as_ref().map(|c| c.deadline_ms).unwrap_or(0)
    }

    fn timeout_deadline(&self) -> u64 {
        let deadline = self.verify_deadline();
        if self.local_decision == Some(true) {
            deadline.saturating_add(SAS_ACCEPTED_GRACE_MS)
        } else {
            deadline
        }
    }

    fn expiration_deadline(&self) -> u64 {
        if self.sas_verified && self.challenge.is_some() {
            self.timeout_deadline()
        } else {
            self.created_ms.saturating_add(PAIR_HANDSHAKE_TIMEOUT_MS)
        }
    }

    /// Latch timeout exactly once for any incomplete handshake or verified challenge.
    fn expire_if_needed(&mut self, now_ms: u64) -> bool {
        if !self.is_terminal_failure() && !self.is_complete() && now_ms > self.expiration_deadline()
        {
            self.timed_out = true;
            return true;
        }
        false
    }

    /// Atomically make (or reconcile) this side's single terminal local decision. This is the one
    /// place `local_decision` / `failed` / `local_sas_confirmed` leave their initial state, so every
    /// local action — correct pick, wrong pick, negative confirm, cancel, late action, reject, and
    /// any retry — funnels through here under the session lock. Passive expiry uses the separate
    /// `timed_out` latch. The local-decision transition is:
    ///   * **write-once**: an accept (`local_decision == Some(true)`) and a negative decision
    ///     (`failed` or `local_decision == Some(false)`) are mutually exclusive and are never
    ///     overwritten; and
    ///   * **monotonic / fail-closed**: a repeat of the decision already made is a harmless
    ///     `NoopOk`, while a *conflicting* later action is refused (`Contradiction`) rather than
    ///     allowed to produce a second, contradictory decision (so a session can never end up
    ///     `failed == true && local_decision == Some(true)` and can never send both Accept and
    ///     Reject).
    /// An accept only latches while the SAS gate is genuinely live ([`sas_action_allowed`]); a
    /// correct-but-late accept degrades to a `Fail` (timeout), preserving the two-human gate.
    fn decide_local(&mut self, intent: LocalIntent, now_ms: u64) -> LocalDecision {
        let want_accept = matches!(intent, LocalIntent::Accept);
        // A peer rejection is sticky. Never send an Accept after observing it.
        if self.peer_decision == Some(false) {
            return if want_accept {
                LocalDecision::Contradiction("peer already rejected the pairing session")
            } else {
                LocalDecision::NoopOk
            };
        }
        // A prior accept is terminal: only another accept is a (no-op) repeat.
        if self.local_decision == Some(true) {
            return if want_accept {
                LocalDecision::NoopOk
            } else {
                LocalDecision::Contradiction("session already accepted the SAS check")
            };
        }
        // A prior negative decision (fail or reject) is terminal and fails closed: any further
        // negative action is a no-op, but an accept can never override it.
        if self.failed || self.timed_out || self.local_decision == Some(false) {
            return if want_accept {
                LocalDecision::Contradiction("session already failed, timed out, or was rejected")
            } else {
                LocalDecision::NoopOk
            };
        }
        // Undecided: this call makes the one and only local decision.
        match intent {
            LocalIntent::Accept => {
                if self.sas_action_allowed(now_ms) {
                    self.local_sas_confirmed = true;
                    self.local_decision = Some(true);
                    LocalDecision::Accept
                } else {
                    // Correct action, but the gate is no longer live (expired / not ready): the
                    // SAS window lapsed, which is a terminal timeout, not an accept.
                    self.failed = true;
                    LocalDecision::Fail
                }
            }
            LocalIntent::Reject => {
                self.local_decision = Some(false);
                LocalDecision::Reject
            }
            LocalIntent::Fail => {
                self.failed = true;
                LocalDecision::Fail
            }
        }
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
            sas_verified: self.sas_verified,
            local_sas_confirmed: self.local_sas_confirmed,
        }
    }

    /// Common disclosure folding: peer recv key, dial hint, and SAS commitment (all authenticated
    /// by the signed message). Never advances a decision.
    fn absorb_disclosure(&mut self, msg: &PairMsg) {
        if self.peer_recv_pub.is_none() {
            if let Ok(pr) = <[u8; RECV_PUB_LEN]>::try_from(msg.recv_pub.clone()) {
                self.peer_recv_pub = Some(pr);
            }
        }
        if !msg.endpoint_ticket.is_empty() {
            self.peer_endpoint_ticket = Some(msg.endpoint_ticket.clone());
        }
        if self.peer_sas_commit.is_none() {
            if let Ok(c) = <[u8; SAS_COMMIT_LEN]>::try_from(msg.sas_commit.clone()) {
                self.peer_sas_commit = Some(c);
            }
        }
    }

    /// Fold a peer `Reveal`: verify the nonce against the earlier commitment, then compute the
    /// deterministic SAS challenge. Errors (bad/missing reveal) are terminal for the caller.
    fn ingest_reveal(&mut self, msg: &PairMsg, now_ms: u64) -> Result<()> {
        self.absorb_disclosure(msg);
        let peer_recv = self
            .peer_recv_pub
            .ok_or_else(|| anyhow!("reveal before peer recv key"))?;
        let commit = self
            .peer_sas_commit
            .ok_or_else(|| anyhow!("reveal before peer commitment"))?;
        let nonce: [u8; SAS_NONCE_LEN] = msg
            .sas_nonce
            .clone()
            .try_into()
            .map_err(|_| anyhow!("reveal missing nonce"))?;
        let expect = sas_commitment(&self.session_id, &self.peer_endpoint, &peer_recv, &nonce);
        if expect != commit {
            bail!("sas commitment does not match revealed nonce");
        }
        self.peer_sas_nonce = Some(nonce);
        self.compute_challenge(now_ms)
    }

    /// Derive the transcript seed → role/target/options once both nonces are known.
    fn compute_challenge(&mut self, now_ms: u64) -> Result<()> {
        if self.challenge.is_some() {
            return Ok(());
        }
        let peer_recv = self
            .peer_recv_pub
            .ok_or_else(|| anyhow!("no peer recv key"))?;
        let peer_nonce = self
            .peer_sas_nonce
            .ok_or_else(|| anyhow!("no peer nonce"))?;
        let local_rec = sas_record(&self.local_endpoint, &self.local_recv_pub, &self.sas_nonce);
        let peer_rec = sas_record(&self.peer_endpoint, &peer_recv, &peer_nonce);
        let (seed, local_is_displayer) = sas_seed(&self.session_id, &local_rec, &peer_rec);
        let (target, options) = sas_catalog(&seed);
        let role = if local_is_displayer {
            SasRole::Displayer
        } else {
            SasRole::Picker
        };
        self.sas_verified = true;
        self.challenge = Some(SasChallengeData {
            role,
            target_index: target,
            option_indices: options,
            deadline_ms: now_ms.saturating_add(SAS_TIMEOUT_MS),
        });
        Ok(())
    }

    /// Fold a peer decision (`Accept` tickets / `Reject`). Disclosure-only messages are ignored.
    /// Monotonic and fail-closed: a peer `Reject` is sticky and always wins, so a contradictory
    /// Accept-vs-Reject (in either arrival order, or duplicated) can never leave us completable.
    fn ingest_decision(&mut self, msg: &PairMsg) {
        self.absorb_disclosure(msg);
        match msg.decision {
            Decision::Accept => {
                // Fail closed: never let a (later or racing) Accept override a peer Reject.
                if self.peer_decision == Some(false) {
                    return;
                }
                if !msg.profile_ticket.is_empty() {
                    self.peer_profile_ticket = Some(msg.profile_ticket.clone());
                }
                if !msg.trail_ticket.is_empty() {
                    self.peer_trail_ticket = Some(msg.trail_ticket.clone());
                }
                self.peer_decision = Some(true);
            }
            // Reject is monotonic and authoritative: it overrides any earlier accept and sticks.
            Decision::Reject => self.peer_decision = Some(false),
            Decision::Hello | Decision::Reveal => {}
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

    /// Build + sign one of our messages. `Hello` carries our SAS commitment; `Reveal` carries our
    /// SAS nonce; `Accept` carries our profile + trail read-tickets. The SAS material is read from
    /// the (already-created) session so it stays bound to that session's fresh nonce.
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
        let (sas_commit, sas_nonce) = {
            let sessions = self.sessions.lock().await;
            match sessions.get(&session_id) {
                Some(s) => match decision {
                    Decision::Hello => (s.local_commit().to_vec(), Vec::new()),
                    Decision::Reveal => (Vec::new(), s.sas_nonce.to_vec()),
                    _ => (Vec::new(), Vec::new()),
                },
                None => (Vec::new(), Vec::new()),
            }
        };
        let msg = PairMsg {
            v: PAIR_WIRE_V,
            session_id: session_id.to_vec(),
            invite_secret,
            from_endpoint: self.endpoint_id.to_vec(),
            recv_pub: self.recv_public.clone(),
            decision,
            sas_commit,
            sas_nonce,
            endpoint_ticket,
            profile_ticket,
            trail_ticket,
            ts: now_ms(),
            sig: Vec::new(),
        };
        sign_msg(&self.identity_seed, msg)
    }

    /// A fresh 32-byte SAS nonce for a new session.
    fn fresh_nonce() -> [u8; SAS_NONCE_LEN] {
        let mut n = [0u8; SAS_NONCE_LEN];
        OsRng.fill_bytes(&mut n);
        n
    }

    /// Our X25519 receiving public key as a fixed array (validated once at construction).
    fn local_recv_arr(&self) -> Result<[u8; RECV_PUB_LEN]> {
        <[u8; RECV_PUB_LEN]>::try_from(self.recv_public.as_slice())
            .map_err(|_| anyhow!("local recv public key is not 32 bytes"))
    }

    /// Construct a fresh session with new SAS material bound to our local identity.
    fn new_session(
        &self,
        session_id: [u8; SESSION_ID_LEN],
        initiator: bool,
        nearby: bool,
        peer_endpoint: [u8; ENDPOINT_LEN],
        created_ms: u64,
    ) -> Result<PairSession> {
        Ok(PairSession::new(
            session_id,
            initiator,
            nearby,
            peer_endpoint,
            created_ms,
            self.endpoint_id,
            self.local_recv_arr()?,
            Self::fresh_nonce(),
        ))
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

    /// Expire every incomplete session whose handshake or local SAS window elapsed. Poll/snapshot
    /// APIs call this before returning, so timeout is a native terminal transition even when the
    /// peer disappears or the human never presses another control. No second wire decision is sent
    /// here: each peer enforces its own deadline, while a later inbound message receives our
    /// terminal stance.
    async fn expire_pair_sessions(&self) {
        let now = now_ms();
        let expired = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .values_mut()
                .filter_map(|s| {
                    s.expire_if_needed(now)
                        .then_some((s.session_id, s.peer_endpoint, s.nearby))
                })
                .collect::<Vec<_>>()
        };
        for (session_id, peer_endpoint, nearby) in expired {
            self.push_notice(PairSignal::Failed, session_id, peer_endpoint, nearby)
                .await;
        }
    }

    /// Drain queued notices (node-level poll API — avoids foreign callbacks for testability).
    pub async fn poll_notices(&self) -> Vec<PairNotice> {
        self.expire_pair_sessions().await;
        self.notices.lock().await.drain(..).collect()
    }

    pub async fn session_state(&self, session_id: &[u8; SESSION_ID_LEN]) -> Option<PairStateData> {
        self.expire_pair_sessions().await;
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(PairSession::state_data)
    }

    pub async fn list_sessions(&self) -> Vec<PairStateData> {
        self.expire_pair_sessions().await;
        self.sessions
            .lock()
            .await
            .values()
            .map(PairSession::state_data)
            .collect()
    }

    /// The completed friendship material, or `None` if the session isn't complete.
    pub async fn result_data(&self, session_id: &[u8; SESSION_ID_LEN]) -> Option<PairResultData> {
        self.expire_pair_sessions().await;
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

    /// Begin an invite-based pair: dial the issuer, exchange `Hello` (SAS commit) then `Reveal`
    /// (SAS nonce), and land in the visual verification gate. Returns the session id.
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
            if !sessions.contains_key(&session_id) {
                sessions.insert(
                    session_id,
                    self.new_session(session_id, true, false, peer_endpoint, now_ms())?,
                );
            }
            if let Some(s) = sessions.get_mut(&session_id) {
                s.peer_endpoint_ticket = Some(inv.endpoint_ticket.clone());
            }
        }
        // Raise a local pending request so our UI knows a pair started before the SAS gate opens.
        self.push_notice(PairSignal::PendingRequest, session_id, peer_endpoint, false)
            .await;
        self.run_sas_handshake(
            session_id,
            peer_endpoint,
            inv.secret.to_vec(),
            Some(inv.endpoint_ticket.clone()),
            false,
        )
        .await?;
        Ok(session_id)
    }

    /// Begin a nearby (invite-less) pair with a peer we discovered (e.g. over BLE). Returns the
    /// deterministic session id. The peer must have `set_pairing_ready(true)`.
    ///
    /// Buttonless / simultaneous initiation is preserved: both sides may call this and still get
    /// complementary SAS roles. A prior *terminal* session under the deterministic id is replaced
    /// with fresh SAS material so a human-triggered retry is never permanently blocked.
    pub async fn initiate_nearby(
        &self,
        peer_endpoint: [u8; ENDPOINT_LEN],
    ) -> Result<[u8; SESSION_ID_LEN]> {
        let session_id = derive_nearby_id(&self.endpoint_id, &peer_endpoint);
        {
            let mut sessions = self.sessions.lock().await;
            let terminal = sessions
                .get(&session_id)
                .map(PairSession::is_terminal_failure)
                .unwrap_or(false);
            if terminal {
                sessions.remove(&session_id);
            }
            if !sessions.contains_key(&session_id) {
                sessions.insert(
                    session_id,
                    self.new_session(session_id, true, true, peer_endpoint, now_ms())?,
                );
            }
        }
        self.push_notice(PairSignal::PendingRequest, session_id, peer_endpoint, true)
            .await;
        self.run_sas_handshake(session_id, peer_endpoint, Vec::new(), None, true)
            .await?;
        Ok(session_id)
    }

    /// Drive the two-round SAS handshake from the initiator: `Hello` (commit) then `Reveal`
    /// (nonce). On the reveal round both commitments are checked and the visual gate opens.
    async fn run_sas_handshake(
        &self,
        session_id: [u8; SESSION_ID_LEN],
        peer_endpoint: [u8; ENDPOINT_LEN],
        invite_secret: Vec<u8>,
        ticket: Option<String>,
        nearby: bool,
    ) -> Result<()> {
        let outcome = async {
            let endpoint = self.runtime_endpoint().await?;

            // Round 1 — Hello / commitment exchange.
            let hello = self
                .build_msg(Decision::Hello, session_id, invite_secret)
                .await?;
            let addr = self.peer_addr(peer_endpoint, ticket.as_deref())?;
            let resp = dial_exchange(&endpoint, addr, &hello).await?;
            self.fold_peer_msg(&session_id, &peer_endpoint, resp, nearby)
                .await?;

            // Round 2 — Reveal / nonce exchange + commitment verification.
            let reveal = self
                .build_msg(Decision::Reveal, session_id, Vec::new())
                .await?;
            let addr = self.peer_addr(peer_endpoint, ticket.as_deref())?;
            let resp = dial_exchange(&endpoint, addr, &reveal).await?;
            self.fold_peer_msg(&session_id, &peer_endpoint, resp, nearby)
                .await?;
            Ok(())
        }
        .await;

        if let Err(error) = outcome {
            self.discard_untouched_handshake(&session_id).await;
            return Err(error);
        }
        Ok(())
    }

    async fn discard_untouched_handshake(&self, session_id: &[u8; SESSION_ID_LEN]) -> bool {
        let mut sessions = self.sessions.lock().await;
        let removed = if sessions
            .get(session_id)
            .is_some_and(PairSession::is_untouched_handshake)
        {
            sessions.remove(session_id);
            true
        } else {
            false
        };
        drop(sessions);
        if removed {
            self.notices.lock().await.retain(|notice| {
                notice.session_id != *session_id || notice.signal != PairSignal::PendingRequest
            });
        }
        removed
    }

    /// Respond to a pending session. `accept` requires the local SAS latch to be set first (the
    /// SAS APIs do that + send `Accept`), which closes the door on legacy/premature acceptance.
    /// `accept == false` is a cancel/reject path.
    pub async fn respond(&self, session_id: &[u8; SESSION_ID_LEN], accept: bool) -> Result<()> {
        if accept {
            {
                // The two-human gate: `respond(true)` may only ratify an accept the SAS APIs have
                // already latched; it must never be able to confirm the SAS itself.
                let sessions = self.sessions.lock().await;
                let s = sessions
                    .get(session_id)
                    .ok_or_else(|| anyhow!("no such pair session"))?;
                if !s.local_sas_confirmed {
                    bail!("cannot accept before the SAS visual check is confirmed");
                }
            }
            return self.accept_after_sas(session_id).await;
        }
        let decision = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            s.decide_local(LocalIntent::Reject, now_ms())
        };
        self.apply_local_decision(session_id, decision).await
    }

    /// Ratify our local accept (SAS already cleared) and, if the pair is now bilateral, finalize.
    /// The accept is reserved under the session lock via [`PairSession::decide_local`] *before*
    /// any network I/O, so it can never be set once the session has failed/rejected/expired, and a
    /// concurrent repeat resolves to a harmless no-op instead of a second, contradictory `Accept`.
    async fn accept_after_sas(&self, session_id: &[u8; SESSION_ID_LEN]) -> Result<()> {
        let now = now_ms();
        let decision = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            s.decide_local(LocalIntent::Accept, now)
        };
        self.apply_local_decision(session_id, decision).await
    }

    /// Perform the network side-effect of a [`LocalDecision`] that was reserved under the session
    /// lock. A losing, contradictory action surfaces an error; an idempotent repeat is a silent
    /// success — neither mutates state nor emits a wire message here.
    async fn apply_local_decision(
        &self,
        session_id: &[u8; SESSION_ID_LEN],
        decision: LocalDecision,
    ) -> Result<()> {
        match decision {
            LocalDecision::Accept => self.send_accept_and_finalize(session_id).await,
            LocalDecision::Reject => self.send_negative(session_id, PairSignal::Rejected).await,
            LocalDecision::Fail => self.send_negative(session_id, PairSignal::Failed).await,
            LocalDecision::NoopOk => Ok(()),
            LocalDecision::Contradiction(msg) => Err(anyhow!(msg)),
        }
    }

    /// Deliver our (already-latched) `Accept` to the peer and finalize if the pair is bilateral.
    async fn send_accept_and_finalize(&self, session_id: &[u8; SESSION_ID_LEN]) -> Result<()> {
        let (peer_endpoint, peer_ticket, nearby) = {
            let sessions = self.sessions.lock().await;
            let s = sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            (s.peer_endpoint, s.peer_endpoint_ticket.clone(), s.nearby)
        };
        let msg = self
            .build_msg(Decision::Accept, *session_id, Vec::new())
            .await?;
        self.best_effort_notify(peer_endpoint, peer_ticket, msg, session_id, nearby)
            .await;
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
        Ok(())
    }

    /// Best-effort deliver our (already-latched) negative decision (`Reject`) to the peer and
    /// raise `signal` (`Rejected` for an explicit reject, `Failed` for a terminal SAS failure).
    /// Our recorded local state stays authoritative regardless of delivery.
    async fn send_negative(
        &self,
        session_id: &[u8; SESSION_ID_LEN],
        signal: PairSignal,
    ) -> Result<()> {
        let (peer_endpoint, peer_ticket, nearby) = {
            let sessions = self.sessions.lock().await;
            let s = sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            (s.peer_endpoint, s.peer_endpoint_ticket.clone(), s.nearby)
        };
        let msg = self
            .build_msg(Decision::Reject, *session_id, Vec::new())
            .await?;
        self.best_effort_notify(peer_endpoint, peer_ticket, msg, session_id, nearby)
            .await;
        self.push_notice(signal, *session_id, peer_endpoint, nearby)
            .await;
        Ok(())
    }

    /// Best-effort dial to deliver our decision; if the peer is unreachable we keep the recorded
    /// local state (which stays authoritative).
    async fn best_effort_notify(
        &self,
        peer_endpoint: [u8; ENDPOINT_LEN],
        peer_ticket: Option<String>,
        msg: PairMsg,
        session_id: &[u8; SESSION_ID_LEN],
        nearby: bool,
    ) {
        if let Ok(endpoint) = self.runtime_endpoint().await {
            if let Ok(addr) = self.peer_addr(peer_endpoint, peer_ticket.as_deref()) {
                if let Ok(resp) = dial_exchange(&endpoint, addr, &msg).await {
                    let _ = self
                        .fold_peer_msg(session_id, &peer_endpoint, resp, nearby)
                        .await;
                }
            }
        }
    }

    /// Fold a dial response (the peer's `Hello`/`Reveal`/decision) into an existing session,
    /// emitting `Verifying`/`PeerResponded` as appropriate. A bad reveal is terminal.
    async fn fold_peer_msg(
        &self,
        session_id: &[u8; SESSION_ID_LEN],
        peer_endpoint: &[u8; ENDPOINT_LEN],
        resp: PairMsg,
        nearby: bool,
    ) -> Result<()> {
        verify_bound(&resp, peer_endpoint)?;
        if resp.session_id.as_slice() != session_id.as_slice() {
            bail!("response session id mismatch");
        }
        let now = now_ms();
        let mut emit: Option<PairSignal> = None;
        let mut reveal_err: Option<anyhow::Error> = None;
        {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            if s.expire_if_needed(now) {
                emit = Some(PairSignal::Failed);
            } else {
                match resp.decision {
                    Decision::Hello => s.absorb_disclosure(&resp),
                    Decision::Reveal => {
                        let before = s.sas_verified;
                        if let Err(e) = s.ingest_reveal(&resp, now) {
                            s.failed = true;
                            reveal_err = Some(e);
                        } else if s.sas_verified && !before {
                            emit = Some(PairSignal::Verifying);
                        }
                    }
                    Decision::Accept | Decision::Reject => {
                        let before = s.peer_decision;
                        s.ingest_decision(&resp);
                        if s.peer_decision == Some(true) && before != Some(true) {
                            emit = Some(PairSignal::PeerResponded);
                        } else if s.peer_decision == Some(false) {
                            emit = Some(PairSignal::Rejected);
                        }
                    }
                }
            }
        }
        if let Some(err) = reveal_err {
            self.push_notice(PairSignal::Failed, *session_id, *peer_endpoint, nearby)
                .await;
            return Err(err);
        }
        if let Some(sig) = emit {
            self.push_notice(sig, *session_id, *peer_endpoint, nearby)
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
            // Fail closed: only ever complete a genuinely bilateral, non-terminal pair. A racing
            // or contradictory peer `Reject` folded after our caller's completeness check (or a
            // stale/incomplete session) must not complete based on arrival order.
            if !s.is_complete() {
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

    // ── SAS visual gate (human-driven) ──────────────────────────────────────────────────────

    /// The current SAS challenge for a session, or `None` if the gate isn't live (not yet
    /// verified, complete/terminal, or expired). It remains visible after an on-time local
    /// confirmation so the UI can show that this phone is waiting for its peer.
    pub async fn sas_challenge(
        &self,
        session_id: &[u8; SESSION_ID_LEN],
    ) -> Option<SasChallengeData> {
        self.expire_pair_sessions().await;
        let sessions = self.sessions.lock().await;
        let s = sessions.get(session_id)?;
        if !s.sas_challenge_visible(now_ms()) {
            return None;
        }
        s.challenge.clone()
    }

    /// The picker submits its chosen figure index. A correct choice latches the local SAS and
    /// sends `Accept`; a wrong choice (or a late/invalid action) is terminal. Idempotent: a
    /// concurrent duplicate of the same action resolves to the same safe outcome without a second,
    /// contradictory wire decision (see [`PairSession::decide_local`]).
    pub async fn submit_sas_choice(
        &self,
        session_id: &[u8; SESSION_ID_LEN],
        chosen_index: u16,
    ) -> Result<()> {
        let now = now_ms();
        let decision = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            let challenge = s
                .challenge
                .clone()
                .ok_or_else(|| anyhow!("no active SAS challenge"))?;
            if challenge.role != SasRole::Picker {
                bail!("this side is the SAS displayer, not the picker");
            }
            let intent = if chosen_index == challenge.target_index {
                LocalIntent::Accept
            } else {
                LocalIntent::Fail
            };
            s.decide_local(intent, now)
        };
        self.apply_local_decision(session_id, decision).await
    }

    /// The displayer confirms whether the other human matched the shown figure. `matched == true`
    /// latches the local SAS and sends `Accept`; `false` (or a late action) is terminal. Idempotent
    /// under concurrent duplicates via [`PairSession::decide_local`].
    pub async fn confirm_sas_display(
        &self,
        session_id: &[u8; SESSION_ID_LEN],
        matched: bool,
    ) -> Result<()> {
        let now = now_ms();
        let decision = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            let challenge = s
                .challenge
                .clone()
                .ok_or_else(|| anyhow!("no active SAS challenge"))?;
            if challenge.role != SasRole::Displayer {
                bail!("this side is the SAS picker, not the displayer");
            }
            let intent = if matched {
                LocalIntent::Accept
            } else {
                LocalIntent::Fail
            };
            s.decide_local(intent, now)
        };
        self.apply_local_decision(session_id, decision).await
    }

    /// Explicitly cancel a pairing under verification — terminal. Reserved under the session lock
    /// so a cancel that races a correct action can never both win: if the accept already latched
    /// the cancel is refused (and sends no `Reject`), and if the cancel wins a later accept is
    /// refused (and sends no `Accept`).
    pub async fn cancel_sas(&self, session_id: &[u8; SESSION_ID_LEN]) -> Result<()> {
        let now = now_ms();
        let decision = {
            let mut sessions = self.sessions.lock().await;
            let s = sessions
                .get_mut(session_id)
                .ok_or_else(|| anyhow!("no such pair session"))?;
            s.decide_local(LocalIntent::Fail, now)
        };
        self.apply_local_decision(session_id, decision).await
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
                        let mut invites = self.invites.lock().await;
                        let check = check_invite(
                            invites.get(&session_id),
                            &msg.invite_secret,
                            &remote,
                            now,
                        );
                        if check == InviteCheck::Ok {
                            if let Some(invite) = invites.get_mut(&session_id) {
                                invite.bound_peer.get_or_insert(remote);
                            }
                        }
                        check
                    };
                    if check != InviteCheck::Ok {
                        bail!("invite rejected: {check:?}");
                    }
                }
                if msg.sas_commit.len() != SAS_COMMIT_LEN {
                    bail!("hello missing sas commitment");
                }

                let emit_pending = {
                    let mut sessions = self.sessions.lock().await;
                    if let Some(existing) = sessions.get_mut(&session_id) {
                        existing.expire_if_needed(now);
                    }
                    // A fresh nearby Hello after a terminal session is a human-triggered retry —
                    // replace the dead session with fresh SAS material. Live sessions are reused
                    // so automated same-session retries can't resurrect a terminal one.
                    if nearby
                        && sessions
                            .get(&session_id)
                            .map(PairSession::is_terminal_failure)
                            .unwrap_or(false)
                    {
                        sessions.remove(&session_id);
                    }
                    if !sessions.contains_key(&session_id) {
                        sessions.insert(
                            session_id,
                            self.new_session(session_id, false, nearby, remote, now)?,
                        );
                    }
                    let s = sessions
                        .get_mut(&session_id)
                        .ok_or_else(|| anyhow!("session vanished"))?;
                    s.ensure_peer(&remote)?;
                    if s.is_terminal_failure() {
                        bail!("pair session is terminal; start a fresh attempt");
                    }
                    s.absorb_disclosure(&msg);
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
                // Respond with our own Hello (carrying our commitment).
                self.build_msg(Decision::Hello, session_id, Vec::new())
                    .await
            }
            Decision::Reveal => {
                let (nearby, verify_result) = {
                    let mut sessions = self.sessions.lock().await;
                    let s = sessions
                        .get_mut(&session_id)
                        .ok_or_else(|| anyhow!("reveal for unknown session"))?;
                    s.ensure_peer(&remote)?;
                    let before = s.sas_verified;
                    let res = if s.expire_if_needed(now) {
                        Err(anyhow!("SAS verification timed out"))
                    } else {
                        s.ingest_reveal(&msg, now)
                    };
                    if res.is_err() {
                        if !s.timed_out {
                            s.failed = true;
                        }
                    }
                    (s.nearby, res.map(|()| s.sas_verified && !before))
                };
                match verify_result {
                    Ok(just_verified) => {
                        if just_verified {
                            self.push_notice(PairSignal::Verifying, session_id, remote, nearby)
                                .await;
                        }
                        // Respond with our own Reveal (carrying our nonce).
                        self.build_msg(Decision::Reveal, session_id, Vec::new())
                            .await
                    }
                    Err(e) => {
                        self.push_notice(PairSignal::Failed, session_id, remote, nearby)
                            .await;
                        Err(e)
                    }
                }
            }
            Decision::Accept => {
                let (complete, nearby, expired) = {
                    let mut sessions = self.sessions.lock().await;
                    let s = sessions
                        .get_mut(&session_id)
                        .ok_or_else(|| anyhow!("accept for unknown session"))?;
                    s.ensure_peer(&remote)?;
                    let expired = s.expire_if_needed(now);
                    if !expired {
                        s.ingest_decision(&msg);
                    }
                    (s.is_complete(), s.nearby, expired)
                };
                self.push_notice(
                    if expired {
                        PairSignal::Failed
                    } else {
                        PairSignal::PeerResponded
                    },
                    session_id,
                    remote,
                    nearby,
                )
                .await;
                if complete {
                    self.finalize(&session_id, remote).await?;
                }
                self.build_stance_response(session_id).await
            }
            Decision::Reject => {
                let (nearby, expired) = {
                    let mut sessions = self.sessions.lock().await;
                    let s = sessions
                        .get_mut(&session_id)
                        .ok_or_else(|| anyhow!("reject for unknown session"))?;
                    s.ensure_peer(&remote)?;
                    let expired = s.expire_if_needed(now);
                    if !expired {
                        s.ingest_decision(&msg);
                    }
                    (s.nearby, expired)
                };
                self.push_notice(
                    if expired {
                        PairSignal::Failed
                    } else {
                        PairSignal::Rejected
                    },
                    session_id,
                    remote,
                    nearby,
                )
                .await;
                self.build_stance_response(session_id).await
            }
        }
    }

    /// Our current decision stance, as a response to a peer decision message (Accept w/ tickets,
    /// Reject, or a bare Hello disclosure while we're still deciding).
    async fn build_stance_response(&self, session_id: [u8; SESSION_ID_LEN]) -> Result<PairMsg> {
        let stance = self
            .sessions
            .lock()
            .await
            .get(&session_id)
            .map(|s| (s.local_decision, s.is_terminal_failure()));
        let decision = match stance {
            Some((_, true)) => Decision::Reject,
            Some((Some(true), false)) => Decision::Accept,
            Some((Some(false), false)) => Decision::Reject,
            Some((None, false)) | None => Decision::Hello,
        };
        self.build_msg(decision, session_id, Vec::new()).await
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

/// The inbound `streetcryptid/pair/2` protocol handler.
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
            sas_commit: Vec::new(),
            sas_nonce: Vec::new(),
            endpoint_ticket: "ticket".into(),
            profile_ticket: String::new(),
            trail_ticket: String::new(),
            ts: 123,
            sig: Vec::new(),
        };
        sign_msg(seed, msg).unwrap()
    }

    /// A test session with fixed local identity/recv/nonce (SAS material is deterministic).
    fn test_session(
        session_id: [u8; SESSION_ID_LEN],
        initiator: bool,
        nearby: bool,
        peer: [u8; ENDPOINT_LEN],
    ) -> PairSession {
        PairSession::new(
            session_id,
            initiator,
            nearby,
            peer,
            0,
            [0xAAu8; ENDPOINT_LEN],
            [0xBBu8; RECV_PUB_LEN],
            [0xCCu8; SAS_NONCE_LEN],
        )
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
            sas_commit: Vec::new(),
            sas_nonce: Vec::new(),
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
        // v1 (legacy) is rejected by the v2 wire.
        msg.v = 1;
        assert!(verify_msg(&msg).is_err());
        // Re-sign a genuine v1 message and confirm it is still rejected (fail-closed to v2).
        let mut legacy = sample_msg(&seed, &endpoint, Decision::Hello);
        legacy.v = 1;
        legacy = PairMsg {
            sig: Vec::new(),
            ..legacy
        };
        let legacy = sign_msg(&seed, legacy).unwrap();
        assert!(verify_msg(&legacy).is_err());
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

        let invite_session = test_session(sid, true, false, peer);
        assert!(!invite_session.state_data().nearby);

        let nearby_session = test_session(sid, true, true, peer);
        assert!(nearby_session.state_data().nearby);
    }

    #[test]
    fn session_nearby_flag_is_fixed_at_creation_and_survives_accept() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = test_session(sid, true, true, peer);
        assert!(s.nearby);

        let (seed, endpoint) = identity();
        let accept = sample_msg(&seed, &endpoint, Decision::Accept);
        s.ingest_decision(&accept);
        // Accept must never flip the route a session took to get here.
        assert!(s.nearby);
        assert!(s.state_data().nearby);
    }

    #[test]
    fn session_nearby_flag_is_fixed_at_creation_and_survives_reject() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = test_session(sid, false, false, peer);
        assert!(!s.nearby);

        let (seed, endpoint) = identity();
        let reject = sample_msg(&seed, &endpoint, Decision::Reject);
        s.ingest_decision(&reject);
        // Reject must never flip the route a session took to get here.
        assert!(!s.nearby);
        assert!(!s.state_data().nearby);
    }

    #[test]
    fn session_bilateral_accept_transitions() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = test_session(sid, true, false, peer);
        assert_eq!(s.phase(), PairPhase::Handshaking);

        // peer discloses recv key via Hello
        let (seed, endpoint) = identity();
        let hello = sample_msg(&seed, &endpoint, Decision::Hello);
        s.ingest_decision(&hello);
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
        s.ingest_decision(&accept);
        assert_eq!(s.phase(), PairPhase::Complete);
        assert!(s.is_complete());
        assert_eq!(s.peer_profile_ticket.as_deref(), Some("p"));
        assert_eq!(s.peer_trail_ticket.as_deref(), Some("t"));
    }

    #[test]
    fn session_reject_transitions() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = test_session(sid, false, false, peer);
        s.local_decision = Some(true);
        let (seed, endpoint) = identity();
        let reject = sample_msg(&seed, &endpoint, Decision::Reject);
        s.ingest_decision(&reject);
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

    // ── SAS: commit / reveal / transcript / catalog ─────────────────────────────────────────

    /// An unsigned peer `Reveal` (signatures are checked at the transport layer, not by ingest).
    fn reveal_msg(
        peer_ep: [u8; ENDPOINT_LEN],
        peer_recv: [u8; RECV_PUB_LEN],
        peer_nonce: [u8; SAS_NONCE_LEN],
        sid: [u8; SESSION_ID_LEN],
    ) -> PairMsg {
        PairMsg {
            v: PAIR_WIRE_V,
            session_id: sid.to_vec(),
            invite_secret: Vec::new(),
            from_endpoint: peer_ep.to_vec(),
            recv_pub: peer_recv.to_vec(),
            decision: Decision::Reveal,
            sas_commit: Vec::new(),
            sas_nonce: peer_nonce.to_vec(),
            endpoint_ticket: String::new(),
            profile_ticket: String::new(),
            trail_ticket: String::new(),
            ts: 0,
            sig: Vec::new(),
        }
    }

    /// A session already primed with the peer's `Hello` disclosure (recv key + commitment).
    #[allow(clippy::too_many_arguments)]
    fn primed_session(
        sid: [u8; SESSION_ID_LEN],
        initiator: bool,
        local_ep: [u8; ENDPOINT_LEN],
        local_recv: [u8; RECV_PUB_LEN],
        local_nonce: [u8; SAS_NONCE_LEN],
        peer_ep: [u8; ENDPOINT_LEN],
        peer_recv: [u8; RECV_PUB_LEN],
        peer_nonce: [u8; SAS_NONCE_LEN],
    ) -> PairSession {
        let mut s = PairSession::new(
            sid,
            initiator,
            true,
            peer_ep,
            0,
            local_ep,
            local_recv,
            local_nonce,
        );
        s.peer_recv_pub = Some(peer_recv);
        s.peer_sas_commit = Some(sas_commitment(&sid, &peer_ep, &peer_recv, &peer_nonce));
        s
    }

    #[test]
    fn sas_reveal_verifies_and_rejects_bad_nonce() {
        let sid = [9u8; SESSION_ID_LEN];
        let (a_ep, a_recv, a_nonce) = (
            [1u8; ENDPOINT_LEN],
            [2u8; RECV_PUB_LEN],
            [3u8; SAS_NONCE_LEN],
        );
        let (b_ep, b_recv, b_nonce) = (
            [4u8; ENDPOINT_LEN],
            [5u8; RECV_PUB_LEN],
            [6u8; SAS_NONCE_LEN],
        );

        // Good reveal: nonce matches the earlier commitment → verified + challenge produced.
        let mut a = primed_session(sid, true, a_ep, a_recv, a_nonce, b_ep, b_recv, b_nonce);
        assert_eq!(a.phase(), PairPhase::Pending);
        a.ingest_reveal(&reveal_msg(b_ep, b_recv, b_nonce, sid), 1_000)
            .expect("good reveal verifies");
        assert!(a.sas_verified);
        assert!(a.challenge.is_some());
        assert_eq!(a.phase(), PairPhase::Verifying);

        // Bad reveal: a different nonce does not match the commitment → rejected.
        let mut a2 = primed_session(sid, true, a_ep, a_recv, a_nonce, b_ep, b_recv, b_nonce);
        let bad = reveal_msg(b_ep, b_recv, [7u8; SAS_NONCE_LEN], sid);
        assert!(a2.ingest_reveal(&bad, 1_000).is_err());
        assert!(!a2.sas_verified);
        assert!(a2.challenge.is_none());
    }

    #[test]
    fn sas_transcript_symmetric_with_opposite_roles() {
        let sid = derive_nearby_id(&[10u8; ENDPOINT_LEN], &[20u8; ENDPOINT_LEN]);
        let (a_ep, a_recv, a_nonce) = (
            [10u8; ENDPOINT_LEN],
            [11u8; RECV_PUB_LEN],
            [12u8; SAS_NONCE_LEN],
        );
        let (b_ep, b_recv, b_nonce) = (
            [20u8; ENDPOINT_LEN],
            [21u8; RECV_PUB_LEN],
            [22u8; SAS_NONCE_LEN],
        );

        // Simultaneous nearby initiation: BOTH sides are `initiator = true`.
        let mut a = primed_session(sid, true, a_ep, a_recv, a_nonce, b_ep, b_recv, b_nonce);
        let mut b = primed_session(sid, true, b_ep, b_recv, b_nonce, a_ep, a_recv, a_nonce);
        a.ingest_reveal(&reveal_msg(b_ep, b_recv, b_nonce, sid), 1_000)
            .unwrap();
        b.ingest_reveal(&reveal_msg(a_ep, a_recv, a_nonce, sid), 1_000)
            .unwrap();

        let ca = a.challenge.clone().unwrap();
        let cb = b.challenge.clone().unwrap();
        // Identical transcript ⇒ identical target + identical shuffled options on both sides.
        assert_eq!(ca.target_index, cb.target_index);
        assert_eq!(ca.option_indices, cb.option_indices);
        // Deterministic roles are always complementary (independent of `initiator`).
        assert_ne!(ca.role, cb.role);
        assert!(matches!(
            (ca.role, cb.role),
            (SasRole::Displayer, SasRole::Picker) | (SasRole::Picker, SasRole::Displayer)
        ));
    }

    #[test]
    fn sas_catalog_bounds_uniqueness_and_inclusion() {
        for i in 0u32..1_000 {
            let mut h = blake3::Hasher::new();
            h.update(b"catalog-test");
            h.update(&i.to_le_bytes());
            let seed = *h.finalize().as_bytes();
            let (target, options) = sas_catalog(&seed);

            assert!(target < SAS_CATALOG_LEN, "target in catalog range");
            assert_eq!(options.len(), SAS_OPTION_COUNT, "exactly N options");
            assert!(options.contains(&target), "target is one of the options");
            for (idx, o) in options.iter().enumerate() {
                assert!(*o < SAS_CATALOG_LEN, "option in catalog range");
                // Distinct options.
                assert!(
                    options.iter().skip(idx + 1).all(|other| other != o),
                    "options are unique"
                );
            }
        }
    }

    #[test]
    fn pre_sas_handshake_expires_once() {
        let created = 1_000;
        let mut s = PairSession::new(
            [1u8; SESSION_ID_LEN],
            true,
            false,
            [2u8; ENDPOINT_LEN],
            created,
            [3u8; ENDPOINT_LEN],
            [4u8; RECV_PUB_LEN],
            [5u8; SAS_NONCE_LEN],
        );
        let deadline = created + PAIR_HANDSHAKE_TIMEOUT_MS;

        assert!(!s.expire_if_needed(deadline));
        assert!(s.expire_if_needed(deadline + 1));
        assert_eq!(s.phase(), PairPhase::Failed);
        assert!(s.timed_out);
        assert!(!s.expire_if_needed(deadline + 2));
    }

    #[test]
    fn sas_action_allowed_respects_deadline_and_latches() {
        let sid = [9u8; SESSION_ID_LEN];
        let (a_ep, a_recv, a_nonce) = (
            [1u8; ENDPOINT_LEN],
            [2u8; RECV_PUB_LEN],
            [3u8; SAS_NONCE_LEN],
        );
        let (b_ep, b_recv, b_nonce) = (
            [4u8; ENDPOINT_LEN],
            [5u8; RECV_PUB_LEN],
            [6u8; SAS_NONCE_LEN],
        );
        let mut s = primed_session(sid, true, a_ep, a_recv, a_nonce, b_ep, b_recv, b_nonce);
        s.ingest_reveal(&reveal_msg(b_ep, b_recv, b_nonce, sid), 1_000)
            .unwrap();
        let deadline = s.verify_deadline();
        assert_eq!(deadline, 1_000 + SAS_TIMEOUT_MS);

        // Live before the deadline, terminal after it.
        assert!(s.sas_action_allowed(deadline - 1));
        assert!(s.sas_action_allowed(deadline));
        assert!(!s.sas_action_allowed(deadline + 1));

        // Once confirmed, no further SAS action is permitted (no automated retry).
        s.local_sas_confirmed = true;
        assert!(!s.sas_action_allowed(deadline - 1));
        s.local_sas_confirmed = false;
        s.failed = true;
        assert!(!s.sas_action_allowed(deadline - 1));
        assert_eq!(s.phase(), PairPhase::Failed);
    }

    #[test]
    fn sas_challenge_stays_visible_while_waiting_then_expires_once() {
        let sid = [9u8; SESSION_ID_LEN];
        let (a_ep, a_recv, a_nonce) = (
            [1u8; ENDPOINT_LEN],
            [2u8; RECV_PUB_LEN],
            [3u8; SAS_NONCE_LEN],
        );
        let (b_ep, b_recv, b_nonce) = (
            [4u8; ENDPOINT_LEN],
            [5u8; RECV_PUB_LEN],
            [6u8; SAS_NONCE_LEN],
        );
        let mut s = primed_session(sid, true, a_ep, a_recv, a_nonce, b_ep, b_recv, b_nonce);
        s.ingest_reveal(&reveal_msg(b_ep, b_recv, b_nonce, sid), 1_000)
            .unwrap();
        let deadline = s.verify_deadline();

        s.local_sas_confirmed = true;
        s.local_decision = Some(true);
        assert_eq!(s.phase(), PairPhase::LocalAccepted);
        assert!(!s.sas_action_allowed(deadline));
        assert!(s.sas_challenge_visible(deadline));
        assert!(s.sas_challenge_visible(deadline + SAS_ACCEPTED_GRACE_MS));
        assert!(!s.expire_if_needed(deadline + SAS_ACCEPTED_GRACE_MS));

        assert!(s.expire_if_needed(deadline + SAS_ACCEPTED_GRACE_MS + 1));
        assert_eq!(s.phase(), PairPhase::Failed);
        assert!(s.timed_out);
        assert!(!s.sas_challenge_visible(deadline + SAS_ACCEPTED_GRACE_MS + 1));
        assert!(!s.expire_if_needed(deadline + SAS_ACCEPTED_GRACE_MS + 2));
    }

    #[test]
    fn peer_rejection_prevents_a_late_local_accept() {
        let sid = [9u8; SESSION_ID_LEN];
        let (a_ep, a_recv, a_nonce) = (
            [1u8; ENDPOINT_LEN],
            [2u8; RECV_PUB_LEN],
            [3u8; SAS_NONCE_LEN],
        );
        let (b_ep, b_recv, b_nonce) = (
            [4u8; ENDPOINT_LEN],
            [5u8; RECV_PUB_LEN],
            [6u8; SAS_NONCE_LEN],
        );
        let mut s = primed_session(sid, true, a_ep, a_recv, a_nonce, b_ep, b_recv, b_nonce);
        s.ingest_reveal(&reveal_msg(b_ep, b_recv, b_nonce, sid), 1_000)
            .unwrap();
        s.peer_decision = Some(false);

        assert!(!s.sas_action_allowed(1_001));
        assert!(matches!(
            s.decide_local(LocalIntent::Accept, 1_001),
            LocalDecision::Contradiction(_)
        ));
        assert_eq!(s.local_decision, None);
        assert_eq!(s.phase(), PairPhase::Rejected);
    }

    #[test]
    fn sas_not_verified_has_no_challenge() {
        let sid = [9u8; SESSION_ID_LEN];
        let s = primed_session(
            sid,
            true,
            [1u8; ENDPOINT_LEN],
            [2u8; RECV_PUB_LEN],
            [3u8; SAS_NONCE_LEN],
            [4u8; ENDPOINT_LEN],
            [5u8; RECV_PUB_LEN],
            [6u8; SAS_NONCE_LEN],
        );
        assert!(!s.sas_action_allowed(1_000));
        assert!(s.challenge.is_none());
    }

    #[test]
    fn is_terminal_failure_covers_fail_and_reject() {
        let sid = [1u8; SESSION_ID_LEN];
        let peer = [2u8; ENDPOINT_LEN];
        let mut s = test_session(sid, true, true, peer);
        assert!(!s.is_terminal_failure());
        s.failed = true;
        assert!(s.is_terminal_failure());
        s.failed = false;
        s.local_decision = Some(false);
        assert!(s.is_terminal_failure());
        s.local_decision = None;
        s.peer_decision = Some(false);
        assert!(s.is_terminal_failure());
        s.peer_decision = None;
        s.timed_out = true;
        assert!(s.is_terminal_failure());
    }

    // ── SAS: live-core gating over PairCore ─────────────────────────────────────────────────

    /// A `PairCore` whose `endpoint_id` is the public half of a fresh identity seed.
    fn test_core() -> (Arc<PairCore>, [u8; 32], [u8; RECV_PUB_LEN]) {
        let sk = SigningKey::generate(&mut OsRng);
        let endpoint = sk.verifying_key().to_bytes();
        let mut recv = [0u8; RECV_PUB_LEN];
        OsRng.fill_bytes(&mut recv);
        let core = PairCore::new(sk.to_bytes(), endpoint, recv.to_vec());
        (core, endpoint, recv)
    }

    #[tokio::test]
    async fn failed_untouched_initiator_handshake_is_removed_for_retry() {
        let (core, endpoint, _) = test_core();
        let peer = SigningKey::generate(&mut OsRng).verifying_key().to_bytes();
        let session_id = derive_nearby_id(&endpoint, &peer);

        assert!(core.initiate_nearby(peer).await.is_err());
        assert!(core.session_state(&session_id).await.is_none());
        assert!(core.poll_notices().await.is_empty());
    }

    #[tokio::test]
    async fn outbound_failure_cleanup_preserves_peer_advanced_session() {
        let (core, endpoint, _) = test_core();
        let peer = SigningKey::generate(&mut OsRng).verifying_key().to_bytes();
        let session_id = derive_nearby_id(&endpoint, &peer);
        let mut session = core
            .new_session(session_id, true, true, peer, now_ms())
            .unwrap();
        session.peer_recv_pub = Some([9u8; RECV_PUB_LEN]);
        session.peer_sas_commit = Some([8u8; SAS_COMMIT_LEN]);
        core.sessions.lock().await.insert(session_id, session);

        assert!(!core.discard_untouched_handshake(&session_id).await);
        assert!(core.session_state(&session_id).await.is_some());
    }

    /// A signed nearby `Hello` from a peer, carrying its SAS commitment.
    fn signed_hello_nearby(
        peer_seed: &[u8; 32],
        peer_endpoint: &[u8; ENDPOINT_LEN],
        peer_recv: &[u8; RECV_PUB_LEN],
        sid: [u8; SESSION_ID_LEN],
        commit: [u8; SAS_COMMIT_LEN],
    ) -> PairMsg {
        let msg = PairMsg {
            v: PAIR_WIRE_V,
            session_id: sid.to_vec(),
            invite_secret: Vec::new(),
            from_endpoint: peer_endpoint.to_vec(),
            recv_pub: peer_recv.to_vec(),
            decision: Decision::Hello,
            sas_commit: commit.to_vec(),
            sas_nonce: Vec::new(),
            endpoint_ticket: String::new(),
            profile_ticket: String::new(),
            trail_ticket: String::new(),
            ts: now_ms(),
            sig: Vec::new(),
        };
        sign_msg(peer_seed, msg).unwrap()
    }

    #[tokio::test]
    async fn respond_accept_rejected_before_sas_confirmed_and_no_result() {
        let (core, our_ep, _our_recv) = test_core();
        core.set_pairing_ready(true);
        let peer_sk = SigningKey::generate(&mut OsRng);
        let peer_ep = peer_sk.verifying_key().to_bytes();
        let peer_recv = [7u8; RECV_PUB_LEN];
        let sid = derive_nearby_id(&our_ep, &peer_ep);
        let commit = sas_commitment(&sid, &peer_ep, &peer_recv, &[8u8; SAS_NONCE_LEN]);

        // Inbound Hello creates a session but leaves SAS unconfirmed.
        core.handle_incoming(
            peer_ep,
            signed_hello_nearby(&peer_sk.to_bytes(), &peer_ep, &peer_recv, sid, commit),
        )
        .await
        .expect("hello handled");

        // Premature accept is refused, and no PairResult exists.
        assert!(core.respond(&sid, true).await.is_err());
        assert!(core.result_data(&sid).await.is_none());
    }

    #[tokio::test]
    async fn fresh_nearby_hello_after_terminal_resets_sas_material() {
        let (core, our_ep, _our_recv) = test_core();
        core.set_pairing_ready(true);
        let peer_sk = SigningKey::generate(&mut OsRng);
        let peer_ep = peer_sk.verifying_key().to_bytes();
        let peer_recv = [7u8; RECV_PUB_LEN];
        let sid = derive_nearby_id(&our_ep, &peer_ep);

        let commit1 = sas_commitment(&sid, &peer_ep, &peer_recv, &[1u8; SAS_NONCE_LEN]);
        core.handle_incoming(
            peer_ep,
            signed_hello_nearby(&peer_sk.to_bytes(), &peer_ep, &peer_recv, sid, commit1),
        )
        .await
        .unwrap();

        // Capture the first session's fresh nonce, then latch it terminal.
        let nonce1 = {
            let mut sessions = core.sessions.lock().await;
            let s = sessions.get_mut(&sid).unwrap();
            s.failed = true;
            s.sas_nonce
        };

        // A fresh human-triggered attempt (new Hello) must replace the dead session with new SAS
        // material rather than being permanently blocked.
        let commit2 = sas_commitment(&sid, &peer_ep, &peer_recv, &[2u8; SAS_NONCE_LEN]);
        core.handle_incoming(
            peer_ep,
            signed_hello_nearby(&peer_sk.to_bytes(), &peer_ep, &peer_recv, sid, commit2),
        )
        .await
        .unwrap();

        let sessions = core.sessions.lock().await;
        let s = sessions.get(&sid).unwrap();
        assert!(!s.failed, "fresh session is not terminal");
        assert_ne!(s.sas_nonce, nonce1, "fresh session uses a fresh SAS nonce");
    }

    // ── Concurrency / monotonicity of the SAS decision state machine ────────────────────────

    /// Insert a session into `core` that is already in the SAS `Verifying` state with a live
    /// challenge, returning its session id and the computed challenge (role/target).
    async fn insert_verifying(
        core: &PairCore,
        peer_ep: [u8; ENDPOINT_LEN],
    ) -> ([u8; SESSION_ID_LEN], SasChallengeData) {
        let sid = derive_nearby_id(&core.endpoint_id, &peer_ep);
        let local_recv: [u8; RECV_PUB_LEN] = core.recv_public.clone().try_into().unwrap();
        let local_nonce = [0x11u8; SAS_NONCE_LEN];
        let peer_recv = [0x22u8; RECV_PUB_LEN];
        let peer_nonce = [0x33u8; SAS_NONCE_LEN];
        let mut s = PairSession::new(
            sid,
            true,
            true,
            peer_ep,
            0,
            core.endpoint_id,
            local_recv,
            local_nonce,
        );
        s.peer_recv_pub = Some(peer_recv);
        s.peer_sas_commit = Some(sas_commitment(&sid, &peer_ep, &peer_recv, &peer_nonce));
        s.ingest_reveal(&reveal_msg(peer_ep, peer_recv, peer_nonce, sid), now_ms())
            .unwrap();
        let challenge = s.challenge.clone().unwrap();
        core.sessions.lock().await.insert(sid, s);
        (sid, challenge)
    }

    #[tokio::test]
    async fn inbound_pair_messages_are_bound_to_the_session_peer() {
        let (core, _our_ep, _recv) = test_core();
        let expected_peer = SigningKey::generate(&mut OsRng).verifying_key().to_bytes();
        let (sid, _) = insert_verifying(&core, expected_peer).await;
        let attacker = SigningKey::generate(&mut OsRng);
        let attacker_ep = attacker.verifying_key().to_bytes();
        let attacker_recv = [0x77u8; RECV_PUB_LEN];

        for decision in [Decision::Reveal, Decision::Accept, Decision::Reject] {
            let msg = sign_msg(
                &attacker.to_bytes(),
                decision_msg(decision, attacker_ep, attacker_recv, sid, true),
            )
            .unwrap();
            let error = core
                .handle_incoming(attacker_ep, msg)
                .await
                .expect_err("a different authenticated endpoint cannot target this session");
            assert!(error.to_string().contains("unexpected peer"));
        }

        let sessions = core.sessions.lock().await;
        let session = sessions.get(&sid).unwrap();
        assert!(!session.failed);
        assert!(!session.timed_out);
        assert_eq!(session.local_decision, None);
        assert_eq!(session.peer_decision, None);
        assert!(session.peer_profile_ticket.is_none());
        assert!(session.peer_trail_ticket.is_none());
        assert_eq!(session.phase(), PairPhase::Verifying);
    }

    #[tokio::test]
    async fn polling_expires_an_abandoned_sas_session_once() {
        let (core, _ep, _recv) = test_core();
        let peer_ep = SigningKey::generate(&mut OsRng).verifying_key().to_bytes();
        let (sid, _) = insert_verifying(&core, peer_ep).await;
        {
            let mut sessions = core.sessions.lock().await;
            sessions
                .get_mut(&sid)
                .unwrap()
                .challenge
                .as_mut()
                .unwrap()
                .deadline_ms = now_ms().saturating_sub(1);
        }

        let notices = core.poll_notices().await;
        assert_eq!(
            notices
                .iter()
                .filter(|notice| notice.signal == PairSignal::Failed)
                .count(),
            1
        );
        assert_eq!(
            core.session_state(&sid).await.unwrap().phase,
            PairPhase::Failed
        );
        assert!(
            core.poll_notices().await.is_empty(),
            "timeout is emitted only once"
        );
    }

    /// Perform the *correct* SAS action for whichever role this side drew.
    async fn correct_action(
        core: &PairCore,
        sid: &[u8; SESSION_ID_LEN],
        challenge: &SasChallengeData,
    ) -> Result<()> {
        match challenge.role {
            SasRole::Picker => core.submit_sas_choice(sid, challenge.target_index).await,
            SasRole::Displayer => core.confirm_sas_display(sid, true).await,
        }
    }

    /// An unsigned peer decision message (signatures are checked at the transport layer).
    fn decision_msg(
        decision: Decision,
        peer_ep: [u8; ENDPOINT_LEN],
        peer_recv: [u8; RECV_PUB_LEN],
        sid: [u8; SESSION_ID_LEN],
        tickets: bool,
    ) -> PairMsg {
        PairMsg {
            v: PAIR_WIRE_V,
            session_id: sid.to_vec(),
            invite_secret: Vec::new(),
            from_endpoint: peer_ep.to_vec(),
            recv_pub: peer_recv.to_vec(),
            decision,
            sas_commit: Vec::new(),
            sas_nonce: Vec::new(),
            endpoint_ticket: String::new(),
            profile_ticket: if tickets { "p".into() } else { String::new() },
            trail_ticket: if tickets { "t".into() } else { String::new() },
            ts: 0,
            sig: Vec::new(),
        }
    }

    /// Two concurrent correct actions (a double-tap) must be idempotent: exactly one accept
    /// latches, both calls succeed, and the session never ends up simultaneously accepted *and*
    /// failed (which the old split-lock code could produce, sending both Accept and Reject).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_duplicate_correct_actions_are_idempotent() {
        let (core, _ep, _recv) = test_core();
        let peer_ep = SigningKey::generate(&mut OsRng).verifying_key().to_bytes();
        let (sid, challenge) = insert_verifying(&core, peer_ep).await;

        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let core = core.clone();
            let barrier = barrier.clone();
            let challenge = challenge.clone();
            handles.push(tokio::spawn(async move {
                barrier.wait().await;
                correct_action(&core, &sid, &challenge).await
            }));
        }
        let mut oks = 0;
        for h in handles {
            if h.await.unwrap().is_ok() {
                oks += 1;
            }
        }
        // Idempotent: both the latching call and its duplicate report success.
        assert_eq!(oks, 2, "duplicate correct actions both succeed");

        let sessions = core.sessions.lock().await;
        let s = sessions.get(&sid).unwrap();
        assert_eq!(s.local_decision, Some(true), "exactly one accept latched");
        assert!(s.local_sas_confirmed, "SAS confirmed");
        assert!(
            !s.failed,
            "no contradictory failure: never accepted AND failed"
        );
        drop(sessions);

        // No `Failed`/`Rejected` notice was ever emitted — no contradictory Reject went out.
        let notices = core.poll_notices().await;
        assert!(
            !notices
                .iter()
                .any(|n| matches!(n.signal, PairSignal::Failed | PairSignal::Rejected)),
            "no contradictory reject/fail notice"
        );
    }

    /// A correct action racing a cancel must resolve to exactly one terminal decision: either the
    /// accept wins (cancel refused) or the cancel wins (accept refused). It can never be both, so
    /// Accept and Reject can never both be sent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_correct_vs_cancel_never_contradicts() {
        for _ in 0..25 {
            let (core, _ep, _recv) = test_core();
            let peer_ep = SigningKey::generate(&mut OsRng).verifying_key().to_bytes();
            let (sid, challenge) = insert_verifying(&core, peer_ep).await;

            let barrier = Arc::new(tokio::sync::Barrier::new(2));
            let accept_task = {
                let core = core.clone();
                let barrier = barrier.clone();
                let challenge = challenge.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    correct_action(&core, &sid, &challenge).await
                })
            };
            let cancel_task = {
                let core = core.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    core.cancel_sas(&sid).await
                })
            };
            let ra = accept_task.await.unwrap();
            let rb = cancel_task.await.unwrap();

            // Exactly one action wins (Ok); the losing contradictory action is refused (Err) and
            // sends nothing.
            assert_eq!(
                ra.is_ok() as u8 + rb.is_ok() as u8,
                1,
                "exactly one of accept/cancel wins"
            );

            let sessions = core.sessions.lock().await;
            let s = sessions.get(&sid).unwrap();
            assert!(
                !(s.local_decision == Some(true) && s.failed),
                "never accepted AND failed"
            );
            assert!(
                (s.local_decision == Some(true)) ^ s.failed,
                "exactly one terminal decision was reached"
            );
        }
    }

    /// Peer decision ingestion is monotonic and fails closed: a `Reject` always wins over an
    /// `Accept` regardless of arrival order or duplication, and never leaves us completable.
    #[test]
    fn peer_reject_wins_over_accept_regardless_of_order() {
        let sid = derive_nearby_id(&[1u8; ENDPOINT_LEN], &[2u8; ENDPOINT_LEN]);
        let peer_ep = [2u8; ENDPOINT_LEN];
        let peer_recv = [3u8; RECV_PUB_LEN];
        let accept = decision_msg(Decision::Accept, peer_ep, peer_recv, sid, true);
        let reject = decision_msg(Decision::Reject, peer_ep, peer_recv, sid, false);

        // Order 1: Accept then Reject → reject wins.
        let mut s = test_session(sid, true, true, peer_ep);
        s.local_decision = Some(true);
        s.ingest_decision(&accept);
        assert_eq!(s.peer_decision, Some(true));
        assert!(s.is_complete());
        s.ingest_decision(&reject);
        assert_eq!(
            s.peer_decision,
            Some(false),
            "reject overrides earlier accept"
        );
        assert!(!s.is_complete(), "cannot complete once peer rejected");

        // Order 2: Reject then Accept → reject sticks; a later accept cannot resurrect it.
        let mut s2 = test_session(sid, true, true, peer_ep);
        s2.local_decision = Some(true);
        s2.ingest_decision(&reject);
        s2.ingest_decision(&accept);
        assert_eq!(
            s2.peer_decision,
            Some(false),
            "sticky reject wins over later accept"
        );
        assert!(!s2.is_complete());

        // Duplicates are harmless.
        s2.ingest_decision(&reject);
        s2.ingest_decision(&accept);
        assert_eq!(s2.peer_decision, Some(false));
    }

    /// End-to-end fail-closed: even after we've locally accepted, a peer `Reject` that races a
    /// peer `Accept` must never yield a `PairResult`, in either fold order.
    #[tokio::test]
    async fn contradictory_peer_decisions_never_complete() {
        for reject_first in [true, false] {
            let (core, our_ep, _recv) = test_core();
            let peer_ep = SigningKey::generate(&mut OsRng).verifying_key().to_bytes();
            let sid = derive_nearby_id(&our_ep, &peer_ep);
            let peer_recv = [9u8; RECV_PUB_LEN];

            {
                let mut s = PairSession::new(
                    sid,
                    true,
                    true,
                    peer_ep,
                    0,
                    our_ep,
                    core.recv_public.clone().try_into().unwrap(),
                    [1u8; SAS_NONCE_LEN],
                );
                s.peer_recv_pub = Some(peer_recv);
                s.local_sas_confirmed = true;
                s.local_decision = Some(true);
                core.sessions.lock().await.insert(sid, s);
            }

            let accept = decision_msg(Decision::Accept, peer_ep, peer_recv, sid, true);
            let reject = decision_msg(Decision::Reject, peer_ep, peer_recv, sid, false);
            {
                let mut sessions = core.sessions.lock().await;
                let s = sessions.get_mut(&sid).unwrap();
                if reject_first {
                    s.ingest_decision(&reject);
                    s.ingest_decision(&accept);
                } else {
                    s.ingest_decision(&accept);
                    s.ingest_decision(&reject);
                }
            }

            // The finalize guard fails closed regardless of which message we "acted" on.
            core.finalize(&sid, peer_ep).await.unwrap();
            assert!(
                core.result_data(&sid).await.is_none(),
                "contradictory peer decisions must never complete (reject_first={reject_first})"
            );
        }
    }
}
