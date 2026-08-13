//! The seam between the Double Ratchet schedule and the envelope: one session per friend,
//! loaded, stepped, and persisted around every publish and every receive.
//!
//! See `docs/social/FORWARD-SECRECY.md` §4.2. `ratchet.rs` is the schedule and knows nothing
//! about storage; `session_store.rs` is the storage and knows nothing about the schedule's use;
//! this module is the only place that holds both at once, which makes it the only place the
//! **persist-before-publish** rule can be enforced.
//!
//! ```text
//! publish:  lock → load → next_send → SAVE → seal → broadcast
//! receive:  verify → load → matches → accept → SAVE → open
//! ```
//!
//! # Why the whole critical section is one lock
//!
//! §4.2 requires the state lock be held across *load → derive → persist → seal → publish*. Two
//! concurrent publishes that each loaded the same state would each derive the same message key
//! at the same position, and the zero nonce in the v3 wrap makes that catastrophic rather than
//! merely wrong. The lock here is the in-process half; the cross-context half is
//! [`SessionStore`]'s writer claim, which is structural (§4.2 requires that too, because
//! expo-task-manager hands every headless callback a fresh JS context whose module-level guards
//! cannot see each other).
//!
//! # Failure is fail-stop, deliberately
//!
//! A recipient whose state cannot be loaded or persisted is **dropped from this publish**, not
//! published to under the state we last had in memory. §4.2 is explicit that a silent persist
//! no-op *is* key reuse. Dropping one recipient costs them one interval of freshness; publishing
//! anyway costs the whole session its forward secrecy.

use std::sync::Mutex;

use crate::crypto::{SealWrap, VerifiedEnvelope};
use crate::ratchet::{
    OsRatchetKeys, RatchetState, DEFAULT_ACCEPT_WINDOW, DEFAULT_T_LAPSE_MS, KEY_LEN, SESSION_ID_LEN,
};
use crate::session_store::{SessionStore, StoreError};

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("session store: {0}")]
    Store(#[from] StoreError),
    /// No session with this peer yet — they have never been bootstrapped (§4.2), so there is
    /// nothing to wrap for and nothing to open with.
    #[error("no ratchet session with this peer")]
    NoSession,
    /// The envelope carried no wrap this session can open. Ordinary and expected: it is either
    /// addressed to somebody else, a replay from the archive, or beyond the acceptance window.
    #[error("no wrap in this envelope belongs to us")]
    NotForUs,
    /// The schedule refused the position after it matched — a desync (§4.6).
    #[error("ratchet refused the position: {0}")]
    Ratchet(#[from] crate::ratchet::RatchetError),
    /// The lock guarding the critical section was poisoned by a panic in another thread.
    #[error("session lock poisoned")]
    Poisoned,
}

/// Why a recipient was left out of a publish. Surfaced so the caller can telemeter it rather
/// than discovering a silently short wrap list (`sc.drop_reason`, per infra/otel/README.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    /// No session yet: not bootstrapped, or the session was removed.
    NoSession,
    /// No fresh ratchet key from this peer within `T_lapse` (§4.5). Structurally identical to a
    /// revocation until they check back in.
    Lapsed,
    /// The state could not be loaded, or could not be persisted before publishing.
    StateUnavailable,
    /// The sending chain could not step — a responder still awaiting the initiator's first
    /// envelope, or an exhausted chain.
    NoSendingChain,
}

impl DropReason {
    /// The `sc.drop_reason` value for this outcome.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoSession => "no_session",
            Self::Lapsed => "lapsed",
            Self::StateUnavailable => "state_unavailable",
            Self::NoSendingChain => "no_sending_chain",
        }
    }
}

/// One publish's worth of wrap material, plus who was left out and why.
pub struct WrapSet {
    pub wraps: Vec<SealWrap>,
    /// `(peer endpoint id, reason)` for every recipient not in `wraps`.
    pub dropped: Vec<(Vec<u8>, DropReason)>,
}

impl std::fmt::Debug for WrapSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WrapSet")
            .field("wraps", &self.wraps.len())
            .field("dropped", &self.dropped.len())
            .finish()
    }
}

/// Every friend's ratchet session, and the critical section around them.
pub struct SessionManager {
    store: SessionStore,
    /// Guards the whole load → derive → persist sequence. `()` because the state itself lives on
    /// disk — this exists to make the sequence atomic, not to own anything.
    critical: Mutex<()>,
    window: u32,
    t_lapse_ms: u64,
}

impl std::fmt::Debug for SessionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionManager")
            .field("store", &self.store)
            .field("window", &self.window)
            .field("t_lapse_ms", &self.t_lapse_ms)
            .finish()
    }
}

impl SessionManager {
    pub fn new(store: SessionStore) -> Self {
        Self {
            store,
            critical: Mutex::new(()),
            window: DEFAULT_ACCEPT_WINDOW,
            t_lapse_ms: DEFAULT_T_LAPSE_MS,
        }
    }

    /// Override the §4.5 lapse bound. Tests drive it; §8.4 leaves the production value open.
    pub fn with_t_lapse_ms(mut self, t_lapse_ms: u64) -> Self {
        self.t_lapse_ms = t_lapse_ms;
        self
    }

    pub fn has_session(&self, peer: &[u8]) -> bool {
        let _guard = self.critical.lock();
        matches!(self.store.load(peer), Ok(Some(_)))
    }

    /// Install a bootstrapped session for `peer`, replacing any existing one.
    ///
    /// `rk0` must come from the §4.6 primitive — fresh ephemerals from both sides, identity
    /// signed, transcript bound. **Never** from static-static DH, which a seized device can
    /// recompute from keys it still holds (§3). The role is fixed by endpoint-id ordering
    /// (`ratchet::initiator_by_endpoint`) so both devices agree without negotiating.
    pub fn bootstrap(
        &self,
        peer: &[u8],
        session_id: [u8; SESSION_ID_LEN],
        rk0: [u8; KEY_LEN],
        peer_ratchet_pub: [u8; KEY_LEN],
        now_ms: u64,
    ) -> Result<(), SessionError> {
        let _guard = self.critical.lock().map_err(|_| SessionError::Poisoned)?;
        let mut keys = OsRatchetKeys;
        let state = RatchetState::bootstrap_initiator(
            session_id,
            rk0,
            peer_ratchet_pub,
            now_ms,
            &mut keys,
        )?;
        self.store.save(peer, &state)?;
        Ok(())
    }

    /// Install the responder half of a bootstrap: we contributed `our_ratchet` to the bump and
    /// have no sending chain until the initiator's first envelope arrives.
    pub fn bootstrap_responder(
        &self,
        peer: &[u8],
        session_id: [u8; SESSION_ID_LEN],
        rk0: [u8; KEY_LEN],
        our_ratchet: x25519_dalek::StaticSecret,
        now_ms: u64,
    ) -> Result<(), SessionError> {
        let _guard = self.critical.lock().map_err(|_| SessionError::Poisoned)?;
        let state = RatchetState::bootstrap_responder(session_id, rk0, our_ratchet, now_ms);
        self.store.save(peer, &state)?;
        Ok(())
    }

    pub fn remove(&self, peer: &[u8]) -> Result<(), SessionError> {
        let _guard = self.critical.lock().map_err(|_| SessionError::Poisoned)?;
        self.store.remove(peer)?;
        Ok(())
    }

    /// Derive one wrap per recipient, persisting each advanced session **before returning**.
    ///
    /// Persist-before-publish is the whole point of doing this in one call: by the time the
    /// caller holds a [`WrapSet`], every counter it represents is already on disk. A crash
    /// between here and the broadcast burns those counter values, which the next publish steps
    /// past locally — no peer round-trip, no deadlock (the sender-liveness invariant, §7 step 6).
    ///
    /// Recipients that cannot participate are dropped with a reason rather than failing the
    /// publish: one friend's missing session must not stop the others from being reached.
    pub fn next_wraps(&self, peers: &[Vec<u8>], now_ms: u64) -> Result<WrapSet, SessionError> {
        let _guard = self.critical.lock().map_err(|_| SessionError::Poisoned)?;
        let mut wraps = Vec::with_capacity(peers.len());
        let mut dropped = Vec::new();

        for peer in peers {
            let mut state = match self.store.load(peer) {
                Ok(Some(state)) => state,
                Ok(None) => {
                    dropped.push((peer.clone(), DropReason::NoSession));
                    continue;
                }
                Err(err) => {
                    tracing::warn!(error = %err, sc.drop_reason = "state_unavailable",
                        "ratchet state could not be loaded; recipient dropped from this publish");
                    dropped.push((peer.clone(), DropReason::StateUnavailable));
                    continue;
                }
            };

            // §4.5: a peer who has not contributed a fresh ratchet key within T_lapse is treated
            // exactly like a revoked one. This is what bounds how long we publish into a
            // one-sided session, and it is why a seized device must keep actively emitting
            // signed envelopes to keep tracking (§1.1).
            if state.is_lapsed(now_ms, self.t_lapse_ms) {
                dropped.push((peer.clone(), DropReason::Lapsed));
                continue;
            }

            let slot = match state.next_send() {
                Ok(slot) => slot,
                Err(err) => {
                    tracing::debug!(error = %err, sc.drop_reason = "no_sending_chain",
                        "no sending chain for this recipient yet");
                    dropped.push((peer.clone(), DropReason::NoSendingChain));
                    continue;
                }
            };

            // The counter is spent the moment `next_send` returned. If it cannot be written down,
            // the only safe move is to discard the slot — publishing under state we failed to
            // persist is exactly the key reuse §4.2 forbids.
            if let Err(err) = self.store.save(peer, &state) {
                tracing::warn!(error = %err, sc.drop_reason = "state_unavailable",
                    "ratchet state could not be persisted; recipient dropped rather than published \
                     to under unpersisted state");
                dropped.push((peer.clone(), DropReason::StateUnavailable));
                continue;
            }

            wraps.push(SealWrap {
                kid: slot.kid,
                header: slot.header,
                session_id: state.session_id(),
                key: slot.key,
            });
        }

        Ok(WrapSet { wraps, dropped })
    }

    /// Open a verified envelope from `author` against that author's session.
    ///
    /// The envelope must already have had its signature checked ([`crypto::verify_v3`]) — this
    /// takes a [`VerifiedEnvelope`] rather than bytes so that ordering is a type-level fact
    /// rather than a convention (§4.2).
    ///
    /// Locating our wrap runs first and mutates nothing, so an envelope addressed to somebody
    /// else, or replayed out of the archive, costs at most one DH and leaves the session exactly
    /// where it was.
    pub fn open(
        &self,
        author: &[u8],
        verified: &VerifiedEnvelope,
        now_ms: u64,
    ) -> Result<Vec<u8>, SessionError> {
        let _guard = self.critical.lock().map_err(|_| SessionError::Poisoned)?;
        let mut state = self.store.load(author)?.ok_or(SessionError::NoSession)?;

        let located = verified
            .locators()
            .into_iter()
            .enumerate()
            .find(|(_, loc)| state.matches(&loc.header, &loc.kid, self.window));
        let (index, loc) = located.ok_or(SessionError::NotForUs)?;

        let mut keys = OsRatchetKeys;
        let key = state.accept(&loc.header, now_ms, self.window, &mut keys)?;
        let session_id = state.session_id();

        // Persist the advanced receiving state before handing the payload up. A crash here would
        // otherwise let the same envelope be accepted again after restart — harmless for key
        // reuse (receiving derives, it never seals) but it would resurrect a fix the UI has
        // already consumed.
        self.store.save(author, &state)?;

        let opened = verified
            .open_wrap(index, &session_id, key)
            .map_err(|_| SessionError::NotForUs)?;
        Ok(opened.payload)
    }
}
