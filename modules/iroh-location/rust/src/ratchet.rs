//! The **Double Ratchet key schedule** — forward secrecy for location envelopes.
//!
//! See `docs/social/FORWARD-SECRECY.md` §4.2. This module is the schedule and *nothing else*:
//! no I/O, no iroh, no persistence, no wire format. It turns a session's state into a sequence
//! of single-use message keys, and that is all. The wrap layer (envelope v3, §4.7) consumes
//! [`MessageKey`] and owns the AEAD; the caller owns storage.
//!
//! ```text
//! DH ratchet (on an envelope from the peer carrying a new ratchet pub):
//!   RK, CKr ← KDF_rk(RK, DH(our_ratchet_priv, peer_pub_new))
//!   our_ratchet ← fresh X25519 keypair            // old private dropped, dalek zeroizes it
//!   RK, CKs ← KDF_rk(RK, DH(our_ratchet_priv_new, peer_pub_new))
//!
//! symmetric step (every message sent or accepted):
//!   MK ← KDF_mk(CK);  CK ← KDF_ck(CK)             // MK single-use, then scrubbed
//! ```
//!
//! # The one deviation from the Signal spec
//!
//! **There is no skipped-message key storage.** A receiver handed a message ahead of its
//! position steps its receiving chain forward to reach it and never derives the intervening
//! message keys at all — stronger than deriving-then-deleting, and the intermediate *chain*
//! keys are scrubbed as the loop walks past them. Messages those keys would have opened are
//! unrecoverable, deliberately: under last-write-wins there is no history to catch up on, and
//! against an adversary holding the stash archive a skipped-key table is a stored key index
//! *into* that archive (§9).
//!
//! Everything else follows the published schedule, so it inherits the published analysis.
//!
//! # Roles
//!
//! Standard Double Ratchet is asymmetric: the initiator can send immediately, the responder
//! cannot until the initiator's first message arrives. Our bootstrap (§4.2) is an in-person SAS
//! bump where both sides exchange ephemerals at once, so the role is not implied by who spoke
//! first and has to be *assigned*. [`initiator_by_endpoint`] fixes it by endpoint-id ordering:
//! total, symmetric, and requiring no negotiation.
//!
//! The alternative — deriving both chains symmetrically from one root step so neither side
//! waits — was rejected. It would be a second deviation from the normative schedule, and the
//! reason for adopting that schedule is to inherit its analysis rather than to re-earn one.
//!
//! Consequence, stated because it qualifies the sender-liveness invariant: a responder between
//! bootstrap and the initiator's first envelope has **no sending chain** and [`next_send`]
//! fails with [`RatchetError::NoSendingChain`]. That window is bounded by the bump itself —
//! both devices are connected, in person, when it opens. It is a bootstrap state, not a
//! reachable steady state, and §4.6 resync covers a device that somehow persists in it.
//!
//! [`next_send`]: RatchetState::next_send

use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};
use zeroize::Zeroize;

/// Length of a root key, chain key, and message key.
pub const KEY_LEN: usize = 32;
/// Length of a rotating wrap id (§4.7).
pub const KID_LEN: usize = 8;
/// Length of a session identifier.
pub const SESSION_ID_LEN: usize = 16;

/// How far ahead of our receiving position a message may claim to be before we refuse to walk
/// there. Bounds the work an unauthenticated counter can make us do; a peer further ahead than
/// this is a desync, which §4.6 recovers by restarting the session rather than by scanning.
pub const DEFAULT_ACCEPT_WINDOW: u32 = 512;

/// Default `T_lapse` (§4.2): 24 h without a fresh ratchet pub from the peer drops them from the
/// wrap set until one arrives.
pub const DEFAULT_T_LAPSE_MS: u64 = 24 * 60 * 60 * 1000;

const RK_CONTEXT: &str = "sc-dr/v1/rk";
const CK_CONTEXT: &str = "sc-dr/v1/ck";
const MK_CONTEXT: &str = "sc-dr/v1/mk";
const KID_CONTEXT: &str = "sc-dr/v1/kid";
/// Context for the §4.6 bootstrap / resync root derivation. Exposed because the pairing path
/// derives `RK₀` and must use the same domain separation.
pub const BOOT_CONTEXT: &str = "sc-dr/v1/boot";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RatchetError {
    /// No sending chain yet — a responder before the initiator's first envelope (see module docs).
    #[error("no sending chain in this session yet")]
    NoSendingChain,
    /// An envelope arrived for a receiving chain we do not have.
    #[error("no receiving chain in this session yet")]
    NoReceivingChain,
    /// The position is at or behind our state: a replay, or an entry served stale from the archive.
    #[error("ratchet position is not ahead of our state")]
    NotAhead,
    /// The claimed position is further ahead than the acceptance window allows.
    #[error("ratchet position is beyond the acceptance window")]
    BeyondWindow,
    /// Same epoch, different ratchet public key — the peer cannot have two keys in one epoch.
    #[error("conflicting ratchet key within one epoch")]
    EpochKeyConflict,
    /// The peer's ratchet public key is a low-order point; the shared secret would be degenerate.
    #[error("peer ratchet key is a low-order point")]
    DegenerateKey,
    /// The sending chain has run to the end of its counter space.
    #[error("sending chain exhausted")]
    ChainExhausted,
    /// Persisted state is truncated, or carries a version this build does not understand.
    #[error("persisted ratchet state is malformed or from a newer build")]
    MalformedState,
}

/// Wire version of the persisted session blob. Bump on any layout change — a session that cannot
/// be read is a desync, which §4.6 recovers by restarting the session, never by falling back.
pub const STATE_V: u8 = 2;

/// Size of a serialized session (see [`RatchetState::to_bytes`]).
pub const STATE_LEN: usize = 1      // version
    + SESSION_ID_LEN                // session_id
    + KEY_LEN                       // rk
    + KEY_LEN                       // dh_self
    + 1 + KEY_LEN                   // dh_peer (present flag + key)
    + 1 + KEY_LEN                   // cks
    + 1 + KEY_LEN                   // ckr
    + 4 * 3                         // ns, nr, pn
    + 4 * 2                         // send_epoch, recv_epoch
    + 8                             // peer_advanced_ms
    + 8; // resync_ts

/// A **single-use** message key.
///
/// Not `Clone`, not `Copy`, and its bytes are reachable only by [`MessageKey::use_once`], which
/// consumes it. That is the normative "one `MK`, one AEAD invocation" rule (§4.2) expressed in
/// the type system rather than left to reviewer discipline — and it is what makes the zero
/// nonce in the v3 wrap safe.
#[must_use = "a derived message key must be used or the counter it consumed is wasted"]
pub struct MessageKey([u8; KEY_LEN]);

impl MessageKey {
    /// Hand the key to `f` exactly once, then scrub it.
    pub fn use_once<T>(mut self, f: impl FnOnce(&[u8; KEY_LEN]) -> T) -> T {
        let out = f(&self.0);
        self.0.zeroize();
        out
    }
}

impl Drop for MessageKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for MessageKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MessageKey(<redacted>)")
    }
}

/// The per-wrap ratchet header (§4.7). Travels inside the wrap's AAD and under the envelope
/// signature, so it is authenticated before any of it reaches [`RatchetState::accept`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RatchetHeader {
    /// The sender's current ratchet public key.
    pub sender_ratchet_pub: [u8; KEY_LEN],
    /// DH epoch `i` — increments on each DH ratchet step.
    pub epoch: u32,
    /// Position `n` within the sending chain of that epoch.
    pub counter: u32,
}

/// Everything one outgoing wrap needs from the schedule.
///
/// The `kid` is taken at derive time and handed over with the key, because chain keys are
/// one-way: once [`RatchetState::next_send`] has stepped the chain, the id of the position it
/// just used is no longer computable from the state.
#[must_use = "the counter this consumed is spent whether or not the slot is used"]
pub struct SendSlot {
    /// Goes inside the wrap's AAD and under the envelope signature.
    pub header: RatchetHeader,
    /// Plaintext wrap id the recipient matches against its own chain (§4.7).
    pub kid: [u8; KID_LEN],
    /// The single-use key for this position.
    pub key: MessageKey,
}

impl std::fmt::Debug for SendSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Hand-written rather than derived so the key stays redacted even when a slot lands in a
        // panic message or a log line.
        f.debug_struct("SendSlot")
            .field("header", &self.header)
            .field("kid", &self.kid)
            .field("key", &self.key)
            .finish()
    }
}

/// One friend's session state. Persisted between publishes (~200 B; see §4.2).
///
/// **Persist before publish.** The caller must hold its state lock across
/// load → derive → persist → seal → publish. A crash after persisting burns one counter value,
/// which the next publish steps past locally — no peer round-trip, no deadlock.
pub struct RatchetState {
    session_id: [u8; SESSION_ID_LEN],
    rk: [u8; KEY_LEN],
    dh_self: XStaticSecret,
    dh_peer: Option<[u8; KEY_LEN]>,
    cks: Option<[u8; KEY_LEN]>,
    ckr: Option<[u8; KEY_LEN]>,
    /// Next position to send in the current sending chain.
    ns: u32,
    /// Next position expected on the current receiving chain.
    nr: u32,
    /// Length of the previous sending chain, carried for diagnostics.
    pn: u32,
    /// How many DH ratchets *we* have performed. Rides in the header of everything we send.
    send_epoch: u32,
    /// The peer's epoch that our current receiving chain corresponds to.
    ///
    /// Tracked separately from [`send_epoch`] because the two sides ratchet at different moments:
    /// a single shared counter would have to be negotiated, and the peer's epoch is exactly what
    /// the monotonic-acceptance check needs to compare against.
    ///
    /// [`send_epoch`]: Self::send_epoch
    recv_epoch: u32,
    /// When the peer last contributed a fresh ratchet key (ms since epoch). Drives `T_lapse`.
    peer_advanced_ms: u64,
    /// Timestamp of the resync record that created this session, or `0` if it came from a bump.
    ///
    /// This is the **durable** half of §4.6's replay defence, and it is durable because the other
    /// half cannot be. `PeerHealth::seen_nonces` lives in memory by design, so a process restart
    /// forgets every record it has applied — and the stash is modelled as hostile and keeps
    /// whatever versions of the `rsy` slot it likes. Replaying a record within the freshness
    /// window after a restart would therefore restart a session that was working, for free, as
    /// often as the stash cared to.
    ///
    /// One monotonic value closes that without persisting an unbounded set: a resync record is
    /// only acceptable if it is *newer* than the one that produced the session it would replace.
    /// Every replay is by definition not newer. A session from a bump carries `0`, so a genuine
    /// first resync always applies.
    resync_ts: u64,
}

impl std::fmt::Debug for RatchetState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RatchetState")
            .field("send_epoch", &self.send_epoch)
            .field("recv_epoch", &self.recv_epoch)
            .field("ns", &self.ns)
            .field("nr", &self.nr)
            .field("has_send_chain", &self.cks.is_some())
            .field("has_recv_chain", &self.ckr.is_some())
            .finish_non_exhaustive()
    }
}

impl Drop for RatchetState {
    fn drop(&mut self) {
        self.rk.zeroize();
        if let Some(mut ck) = self.cks.take() {
            ck.zeroize();
        }
        if let Some(mut ck) = self.ckr.take() {
            ck.zeroize();
        }
    }
}

/// Where a fresh ratchet keypair comes from.
///
/// A seam rather than a bare `OsRng` call, for two reasons. It makes the one place new ratchet
/// entropy enters the schedule explicit for review, and it lets the vector fixture drive a whole
/// session deterministically — otherwise every DH step would mint an unreproducible key and the
/// schedule could only be tested against itself.
pub trait RatchetKeySource {
    fn next_ratchet_secret(&mut self) -> XStaticSecret;
}

/// The production source: the operating system CSPRNG.
pub struct OsRatchetKeys;

impl RatchetKeySource for OsRatchetKeys {
    fn next_ratchet_secret(&mut self) -> XStaticSecret {
        XStaticSecret::random_from_rng(OsRng)
    }
}

/// Which side takes the initiator role, decided from the two endpoint ids.
///
/// Total and symmetric: both devices compute the same answer with no negotiation, which is what
/// lets an in-person bump bootstrap the standard asymmetric schedule (see module docs).
pub fn initiator_by_endpoint(ours: &[u8], theirs: &[u8]) -> bool {
    ours < theirs
}

impl RatchetState {
    /// Bootstrap the **initiator** side: we hold the peer's bootstrap ratchet public key and can
    /// send immediately.
    ///
    /// `rk0` must come from the §4.6 primitive (fresh ephemerals from both sides, identity-signed,
    /// transcript-bound) — never from static-static DH, which would be recomputable from keys a
    /// seized device still holds (§3).
    pub fn bootstrap_initiator(
        session_id: [u8; SESSION_ID_LEN],
        rk0: [u8; KEY_LEN],
        peer_ratchet_pub: [u8; KEY_LEN],
        now_ms: u64,
        keys: &mut impl RatchetKeySource,
    ) -> Result<Self, RatchetError> {
        let dh_self = keys.next_ratchet_secret();
        let mut state = Self {
            session_id,
            rk: rk0,
            dh_self,
            dh_peer: None,
            cks: None,
            ckr: None,
            ns: 0,
            nr: 0,
            pn: 0,
            send_epoch: 0,
            recv_epoch: 0,
            peer_advanced_ms: now_ms,
            resync_ts: 0,
        };
        // One root step gives the initiator its sending chain. The receiving chain arrives with
        // the responder's first envelope, which carries their new ratchet pub.
        let dh = dh_or_err(&state.dh_self, &peer_ratchet_pub)?;
        let (rk, cks) = kdf_rk(&state.rk, &dh);
        state.rk = rk;
        state.cks = Some(cks);
        state.dh_peer = Some(peer_ratchet_pub);
        Ok(state)
    }

    /// Bootstrap the **responder** side: we contributed `our_ratchet` to the bump and wait for the
    /// initiator's first envelope before we have a sending chain.
    pub fn bootstrap_responder(
        session_id: [u8; SESSION_ID_LEN],
        rk0: [u8; KEY_LEN],
        our_ratchet: XStaticSecret,
        now_ms: u64,
    ) -> Self {
        Self {
            session_id,
            rk: rk0,
            dh_self: our_ratchet,
            dh_peer: None,
            cks: None,
            ckr: None,
            ns: 0,
            nr: 0,
            pn: 0,
            send_epoch: 0,
            recv_epoch: 0,
            peer_advanced_ms: now_ms,
            resync_ts: 0,
        }
    }

    /// Timestamp of the resync record this session was created from (`0` for a bump).
    ///
    /// The §4.6 monotonic-acceptance bound: a resync record is acceptable only if `record.ts` is
    /// strictly greater than this. See [`RatchetState::resync_ts`].
    pub fn resync_ts(&self) -> u64 {
        self.resync_ts
    }

    /// Record which resync produced this session. Called only by `SessionManager::apply_resync`,
    /// immediately after the bootstrap that record implies.
    pub fn set_resync_ts(&mut self, ts: u64) {
        self.resync_ts = ts;
    }

    /// Our current ratchet public key — what goes in the header of everything we send.
    pub fn ratchet_public(&self) -> [u8; KEY_LEN] {
        XPublicKey::from(&self.dh_self).to_bytes()
    }

    pub fn session_id(&self) -> [u8; SESSION_ID_LEN] {
        self.session_id
    }

    /// How many DH ratchets we have performed — the epoch we stamp on what we send.
    pub fn send_epoch(&self) -> u32 {
        self.send_epoch
    }

    /// The peer epoch our receiving chain currently tracks.
    pub fn recv_epoch(&self) -> u32 {
        self.recv_epoch
    }

    /// When the peer last contributed a fresh ratchet key (ms since epoch).
    ///
    /// Exposed so a caller holding the session open can apply the §4.5 bound *and* another
    /// judgement to the same load — `SessionManager::is_desynced` needs both "does it load" and
    /// "has it lapsed" under one pass of the critical section.
    pub fn peer_advanced_ms(&self) -> u64 {
        self.peer_advanced_ms
    }

    /// Whether the peer has gone quiet past `t_lapse_ms` (§4.5). A lapsed recipient is treated
    /// exactly like a revoked one — dropped from the wrap set until they check back in.
    pub fn is_lapsed(&self, now_ms: u64, t_lapse_ms: u64) -> bool {
        now_ms.saturating_sub(self.peer_advanced_ms) >= t_lapse_ms
    }

    /// Derive the next sending key and the header that must accompany it.
    ///
    /// **Never blocks on the peer.** This is the sender-liveness invariant (§7 step 6): from any
    /// persisted state that has a sending chain, the next publish derives with no peer message
    /// consumed. Any future change that makes this wait on the peer violates the invariant and
    /// reintroduces the revision-1 deadlock.
    pub fn next_send(&mut self) -> Result<SendSlot, RatchetError> {
        let ck = self.cks.as_mut().ok_or(RatchetError::NoSendingChain)?;
        if self.ns == u32::MAX {
            return Err(RatchetError::ChainExhausted);
        }
        // The kid is taken here, from the chain key at *this* position — chain keys are one-way,
        // so it cannot be recovered after the step below.
        let kid = kdf_kid(ck);
        let mk = kdf_mk(ck);
        let next = kdf_ck(ck);
        ck.zeroize();
        *ck = next;

        let header = RatchetHeader {
            sender_ratchet_pub: XPublicKey::from(&self.dh_self).to_bytes(),
            epoch: self.send_epoch,
            counter: self.ns,
        };
        self.ns += 1;
        Ok(SendSlot {
            header,
            kid,
            key: MessageKey(mk),
        })
    }

    /// Candidate `(kid, counter)` pairs for the next `window` positions of the receiving chain,
    /// without mutating state.
    ///
    /// This is how a receiver finds *its* wrap among N when kids rotate (§4.7): compute forward
    /// from the position it holds and match. Bounded by `window`, so the work is bounded even
    /// when the sender is far ahead.
    pub fn peek_recv_kids(&self, window: u32) -> Vec<([u8; KID_LEN], u32)> {
        let Some(ckr) = self.ckr.as_ref() else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(window as usize);
        let mut ck = *ckr;
        for offset in 0..window {
            out.push((kdf_kid(&ck), self.nr.saturating_add(offset)));
            let next = kdf_ck(&ck);
            ck.zeroize();
            ck = next;
        }
        ck.zeroize();
        out
    }

    /// Whether an authenticated wrap header + `kid` addresses **us**, decided without mutating
    /// anything.
    ///
    /// This is the receive-side counterpart of the rotating `kid` (§4.7). An envelope carries one
    /// wrap per recipient and we must pick ours out before [`accept`] touches state, because
    /// `accept` performs a DH ratchet — running it on somebody else's wrap would burn our chain
    /// on a key that was never meant for us.
    ///
    /// Two cases, and the second is the one that makes the `kid` worth its eight bytes:
    ///
    /// * **Same ratchet key as we already hold.** Walk our receiving chain forward to the claimed
    ///   counter and compare. Cheap, no DH.
    /// * **A ratchet key we have not adopted.** We cannot tell from the header alone whether this
    ///   wrap is ours or another recipient's — every wrap in the envelope carries a *different*
    ///   sender ratchet key, because sessions are per pair. So derive what our receiving chain
    ///   *would* become under that key and check the `kid` against it. A match means the sender
    ///   derived it from a chain rooted in our shared secret, which nobody else can do. A miss
    ///   costs one DH and leaves state untouched.
    ///
    /// Returns `false` for anything at or behind our position, beyond `window`, or malformed —
    /// the same refusals [`accept`] would make, so a `true` here is not a promise that `accept`
    /// succeeds, only that it is worth attempting.
    ///
    /// [`accept`]: Self::accept
    pub fn matches(&self, header: &RatchetHeader, kid: &[u8; KID_LEN], window: u32) -> bool {
        match (self.ckr.as_ref(), self.dh_peer) {
            // The chain we are already on.
            (Some(ckr), Some(peer)) if peer == header.sender_ratchet_pub => {
                if header.epoch != self.recv_epoch || header.counter < self.nr {
                    return false;
                }
                let skip = header.counter - self.nr;
                if skip > window {
                    return false;
                }
                kid_at(ckr, skip) == *kid
            }
            // A key we have not adopted: it must belong to a later epoch than the chain we hold.
            _ => {
                if self.ckr.is_some() && header.epoch <= self.recv_epoch {
                    return false;
                }
                // A DH ratchet resets the receiving counter, so the claimed position is measured
                // from zero rather than from `nr`.
                if header.counter > window {
                    return false;
                }
                let Ok(dh) = dh_or_err(&self.dh_self, &header.sender_ratchet_pub) else {
                    return false;
                };
                let (mut rk, mut ckr) = kdf_rk(&self.rk, &dh);
                rk.zeroize();
                let found = kid_at(&ckr, header.counter) == *kid;
                ckr.zeroize();
                found
            }
        }
    }

    /// Accept an authenticated header and derive the key that opens its wrap.
    ///
    /// Signature verification and AAD binding happen **before** this is called, preserving the
    /// `crypto.rs` ordering: nothing here mutates state on unauthenticated input.
    ///
    /// Positions must be strictly ahead of ours. A byte-identical replay out of the stash archive
    /// lands at or behind our state and is refused before any mutation.
    pub fn accept(
        &mut self,
        header: &RatchetHeader,
        now_ms: u64,
        window: u32,
        keys: &mut impl RatchetKeySource,
    ) -> Result<MessageKey, RatchetError> {
        // A new ratchet public key from the peer is the only thing that advances the DH epoch.
        // NOT `NeighborUp`: the gossip topic is per author, so its neighbours are the whole pool
        // and a neighbour coming up may be someone else entirely (§4.2).
        if self.dh_peer != Some(header.sender_ratchet_pub) {
            // Once we hold a receiving chain, a new key must belong to a strictly later epoch.
            // This is what refuses an old envelope replayed out of the stash archive: its key and
            // epoch are both behind us, and the chain that opened it is gone.
            if self.ckr.is_some() && header.epoch <= self.recv_epoch {
                return Err(RatchetError::NotAhead);
            }
            self.dh_ratchet(header.sender_ratchet_pub, now_ms, keys)?;
            self.recv_epoch = header.epoch;
        } else if header.epoch != self.recv_epoch {
            // Same key, different epoch: the peer cannot have re-used one ratchet key across two
            // epochs, so this is malformed or tampered rather than merely late.
            return Err(RatchetError::EpochKeyConflict);
        }

        if header.counter < self.nr {
            return Err(RatchetError::NotAhead);
        }
        let skip = header.counter - self.nr;
        if skip > window {
            return Err(RatchetError::BeyondWindow);
        }
        self.advance_recv_to(header.counter)
    }

    /// Step the root key on the peer's new contribution, producing a fresh receiving chain and a
    /// fresh sending chain. The previous ratchet private is dropped here; dalek scrubs it.
    fn dh_ratchet(
        &mut self,
        peer_pub: [u8; KEY_LEN],
        now_ms: u64,
        keys: &mut impl RatchetKeySource,
    ) -> Result<(), RatchetError> {
        let dh_recv = dh_or_err(&self.dh_self, &peer_pub)?;
        let (rk, ckr) = kdf_rk(&self.rk, &dh_recv);
        self.rk = rk;
        if let Some(mut old) = self.ckr.replace(ckr) {
            old.zeroize();
        }

        let fresh = keys.next_ratchet_secret();
        let dh_send = dh_or_err(&fresh, &peer_pub)?;
        let (rk, cks) = kdf_rk(&self.rk, &dh_send);
        self.rk = rk;
        if let Some(mut old) = self.cks.replace(cks) {
            old.zeroize();
        }
        self.dh_self = fresh;

        self.dh_peer = Some(peer_pub);
        self.pn = self.ns;
        self.ns = 0;
        self.nr = 0;
        // Our sending chain was replaced, so everything we send from here is a later epoch. The
        // peer's epoch is set by `accept`, which is the only caller and holds the header.
        self.send_epoch = self.send_epoch.saturating_add(1);
        self.peer_advanced_ms = now_ms;
        Ok(())
    }

    /// Walk the receiving chain to `target`, then hand back that position's key.
    ///
    /// Intervening **message** keys are never derived at all — not derived-then-deleted — and the
    /// intermediate **chain** keys are scrubbed as we step past them. After this returns, nothing
    /// in the process can open a message at a skipped position.
    fn advance_recv_to(&mut self, target: u32) -> Result<MessageKey, RatchetError> {
        let mut ck = self.ckr.take().ok_or(RatchetError::NoReceivingChain)?;
        while self.nr < target {
            let next = kdf_ck(&ck);
            ck.zeroize();
            ck = next;
            self.nr += 1;
        }
        let mk = kdf_mk(&ck);
        let next = kdf_ck(&ck);
        ck.zeroize();
        self.ckr = Some(next);
        self.nr = target.saturating_add(1);
        Ok(MessageKey(mk))
    }
}

// ── persistence ───────────────────────────────────────────────────────────────────────────────

/// Append a `[u8; KEY_LEN]` preceded by a presence flag.
fn put_opt_key(out: &mut Vec<u8>, key: Option<&[u8; KEY_LEN]>) {
    match key {
        Some(k) => {
            out.push(1);
            out.extend_from_slice(k);
        }
        None => {
            out.push(0);
            out.extend_from_slice(&[0u8; KEY_LEN]);
        }
    }
}

/// Read a presence-flagged key, advancing `at`.
fn take_opt_key(bytes: &[u8], at: &mut usize) -> Result<Option<[u8; KEY_LEN]>, RatchetError> {
    let present = *bytes.get(*at).ok_or(RatchetError::MalformedState)?;
    *at += 1;
    let raw = take_key(bytes, at)?;
    match present {
        0 => Ok(None),
        1 => Ok(Some(raw)),
        _ => Err(RatchetError::MalformedState),
    }
}

fn take_key(bytes: &[u8], at: &mut usize) -> Result<[u8; KEY_LEN], RatchetError> {
    let end = *at + KEY_LEN;
    let slice = bytes.get(*at..end).ok_or(RatchetError::MalformedState)?;
    let mut out = [0u8; KEY_LEN];
    out.copy_from_slice(slice);
    *at = end;
    Ok(out)
}

fn take_u32(bytes: &[u8], at: &mut usize) -> Result<u32, RatchetError> {
    let end = *at + 4;
    let slice = bytes.get(*at..end).ok_or(RatchetError::MalformedState)?;
    let out = u32::from_le_bytes(slice.try_into().map_err(|_| RatchetError::MalformedState)?);
    *at = end;
    Ok(out)
}

fn take_u64(bytes: &[u8], at: &mut usize) -> Result<u64, RatchetError> {
    let end = *at + 8;
    let slice = bytes.get(*at..end).ok_or(RatchetError::MalformedState)?;
    let out = u64::from_le_bytes(slice.try_into().map_err(|_| RatchetError::MalformedState)?);
    *at = end;
    Ok(out)
}

impl RatchetState {
    /// Serialize the session to a fixed [`STATE_LEN`] blob, little-endian.
    ///
    /// Hand-written rather than derived, and deliberately so: a `Serialize` impl on this type
    /// would make it trivial for unrelated code to write chain keys into a log line, a telemetry
    /// attribute, or a debug dump. The only way these bytes leave the type is this method, whose
    /// single caller should be the encrypted store.
    ///
    /// **The output is secret key material.** It must be encrypted at rest and written with the
    /// persist-before-publish discipline in §4.2 — a silent persist failure *is* key reuse.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(STATE_LEN);
        out.push(STATE_V);
        out.extend_from_slice(&self.session_id);
        out.extend_from_slice(&self.rk);
        out.extend_from_slice(&self.dh_self.to_bytes());
        put_opt_key(&mut out, self.dh_peer.as_ref());
        put_opt_key(&mut out, self.cks.as_ref());
        put_opt_key(&mut out, self.ckr.as_ref());
        out.extend_from_slice(&self.ns.to_le_bytes());
        out.extend_from_slice(&self.nr.to_le_bytes());
        out.extend_from_slice(&self.pn.to_le_bytes());
        out.extend_from_slice(&self.send_epoch.to_le_bytes());
        out.extend_from_slice(&self.recv_epoch.to_le_bytes());
        out.extend_from_slice(&self.peer_advanced_ms.to_le_bytes());
        out.extend_from_slice(&self.resync_ts.to_le_bytes());
        debug_assert_eq!(out.len(), STATE_LEN);
        out
    }

    /// Restore a session written by [`to_bytes`].
    ///
    /// A blob this build cannot parse is an error, never a silently fresh session: starting over
    /// from a zero state would reuse counter values the peer has already seen, which is exactly
    /// the key reuse the whole design exists to prevent. Callers surface it as a desync and run
    /// the §4.6 resync instead.
    ///
    /// [`to_bytes`]: Self::to_bytes
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, RatchetError> {
        if bytes.len() != STATE_LEN || bytes[0] != STATE_V {
            return Err(RatchetError::MalformedState);
        }
        let mut at = 1usize;

        let session_id_slice = bytes
            .get(at..at + SESSION_ID_LEN)
            .ok_or(RatchetError::MalformedState)?;
        let mut session_id = [0u8; SESSION_ID_LEN];
        session_id.copy_from_slice(session_id_slice);
        at += SESSION_ID_LEN;

        let rk = take_key(bytes, &mut at)?;
        let dh_self = XStaticSecret::from(take_key(bytes, &mut at)?);
        let dh_peer = take_opt_key(bytes, &mut at)?;
        let cks = take_opt_key(bytes, &mut at)?;
        let ckr = take_opt_key(bytes, &mut at)?;
        let ns = take_u32(bytes, &mut at)?;
        let nr = take_u32(bytes, &mut at)?;
        let pn = take_u32(bytes, &mut at)?;
        let send_epoch = take_u32(bytes, &mut at)?;
        let recv_epoch = take_u32(bytes, &mut at)?;
        let peer_advanced_ms = take_u64(bytes, &mut at)?;
        let resync_ts = take_u64(bytes, &mut at)?;

        Ok(Self {
            session_id,
            rk,
            dh_self,
            dh_peer,
            cks,
            ckr,
            ns,
            nr,
            pn,
            send_epoch,
            recv_epoch,
            peer_advanced_ms,
            resync_ts,
        })
    }
}

/// X25519, refusing a low-order peer key so the shared secret cannot be forced to a known value.
fn dh_or_err(
    secret: &XStaticSecret,
    peer_pub: &[u8; KEY_LEN],
) -> Result<[u8; KEY_LEN], RatchetError> {
    let shared = secret.diffie_hellman(&XPublicKey::from(*peer_pub));
    if !shared.was_contributory() {
        return Err(RatchetError::DegenerateKey);
    }
    Ok(shared.to_bytes())
}

/// Root step: `(RK', CK) ← KDF_rk(RK, dh)`. 64 bytes of XOF, split.
pub fn kdf_rk(rk: &[u8; KEY_LEN], dh: &[u8; KEY_LEN]) -> ([u8; KEY_LEN], [u8; KEY_LEN]) {
    let mut hasher = blake3::Hasher::new_derive_key(RK_CONTEXT);
    hasher.update(rk);
    hasher.update(dh);
    let mut out = [0u8; KEY_LEN * 2];
    hasher.finalize_xof().fill(&mut out);

    let mut next_rk = [0u8; KEY_LEN];
    let mut ck = [0u8; KEY_LEN];
    next_rk.copy_from_slice(&out[..KEY_LEN]);
    ck.copy_from_slice(&out[KEY_LEN..]);
    out.zeroize();
    (next_rk, ck)
}

/// Symmetric step: `CK' ← KDF_ck(CK)`.
pub fn kdf_ck(ck: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    derive(CK_CONTEXT, ck)
}

/// Message key: `MK ← KDF_mk(CK)`.
pub fn kdf_mk(ck: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    derive(MK_CONTEXT, ck)
}

/// Rotating wrap id: `kid = KDF_kid(CK)[..8]` (§4.7). Replaces the stable `blake3(recvPub)[..8]`,
/// so an outsider can no longer link a recipient across envelopes or across authors.
pub fn kdf_kid(ck: &[u8; KEY_LEN]) -> [u8; KID_LEN] {
    let full = derive(KID_CONTEXT, ck);
    let mut kid = [0u8; KID_LEN];
    kid.copy_from_slice(&full[..KID_LEN]);
    kid
}

fn derive(context: &str, input: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    let mut hasher = blake3::Hasher::new_derive_key(context);
    hasher.update(input);
    *hasher.finalize().as_bytes()
}

/// The `kid` `skip` positions along a chain from `ck`, scrubbing every chain key it walks past.
///
/// Lookup-only: this derives no message key, so a probe against a wrap that turns out not to be
/// ours costs nothing but hashing and leaves nothing behind.
fn kid_at(ck: &[u8; KEY_LEN], skip: u32) -> [u8; KID_LEN] {
    let mut cur = *ck;
    for _ in 0..skip {
        let next = kdf_ck(&cur);
        cur.zeroize();
        cur = next;
    }
    let kid = kdf_kid(&cur);
    cur.zeroize();
    kid
}
