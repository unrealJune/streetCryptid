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

use std::collections::HashMap;
use std::sync::Mutex;

use crate::crypto::{SealWrap, VerifiedEnvelope};
use crate::ratchet::{
    OsRatchetKeys, RatchetState, DEFAULT_ACCEPT_WINDOW, DEFAULT_T_LAPSE_MS, KEY_LEN, SESSION_ID_LEN,
};
use crate::session_store::{SessionStore, StoreError};

/// How many consecutive signature-valid but unopenable envelopes from one peer mark the session
/// desynced (`R` in §4.6).
///
/// Not 1: a single miss is ordinary. An envelope addressed to somebody else is indistinguishable
/// from one we merely failed to open, and in a pool that happens constantly — every envelope
/// carries a wrap per recipient and only one of them is ever ours. Requiring a run makes the
/// signal mean "this peer keeps talking and we keep failing", which is what a desync looks like.
pub const DEFAULT_DESYNC_THRESHOLD: u32 = 3;

/// How long a resync record stays acceptable (§4.6 replay defence).
///
/// The stash can withhold and replay at will and the resync slot is overwritten in place, so a
/// stale record served deliberately is the expected attack. Freshness plus nonce dedup bounds it
/// to the churn §4.6 already accepts as a DoS that recovery heals.
pub const RESYNC_FRESHNESS_MS: u64 = 60 * 60 * 1000;

/// How old our own pending resync record may get before `publish_resync` mints a new one.
///
/// Half the freshness window, so a re-minted record is always published with at least half a
/// window of validity ahead of it and there is never a moment when what we have published is
/// already unacceptable. Derived from [`RESYNC_FRESHNESS_MS`] rather than written out, because
/// the relationship between them is the property that matters — a re-mint interval that drifted
/// past the freshness window would reintroduce the deadlock it exists to prevent.
pub const RESYNC_REMINT_MS: u64 = RESYNC_FRESHNESS_MS / 2;

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
    ///
    /// # Lock order: `health` before `critical`, never the reverse
    ///
    /// Both orders exist in this module today and only one of them is safe to *hold*:
    ///
    /// - `open` takes `critical`, then `note_miss` takes `health` **inside** it.
    /// - `is_desynced` and `apply_resync` take `health` first, then `critical`.
    ///
    /// That is a textbook inversion, and it does not deadlock only because the second group
    /// always *releases* `health` before acquiring `critical` — in `is_desynced` because the guard
    /// is a statement temporary, in `apply_resync` because the health scope closes explicitly.
    /// Both are properties of brace placement, so they are stated here rather than left to be
    /// rediscovered: hoisting either guard up a scope deadlocks the publish path against the
    /// receive path, and it will do so intermittently rather than in tests.
    critical: Mutex<()>,
    window: u32,
    t_lapse_ms: u64,
    /// Consecutive unopenable envelopes per peer, and how many resyncs we have driven with them.
    ///
    /// In memory only. A restart forgets both, which merely delays detection by `R` envelopes —
    /// whereas persisting it would put a "this peer is failing" counter on disk that survives the
    /// very restart most likely to have fixed the problem.
    health: Mutex<HashMap<Vec<u8>, PeerHealth>>,
    desync_threshold: u32,
}

/// What the store holds for a peer. Three states, because "no session" and "a session we cannot
/// read" call for opposite responses and only one of them is recoverable by resync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionPresence {
    /// Nothing on disk: never bootstrapped, or deliberately forgotten. Waiting on a bump.
    Absent,
    /// A session that loads.
    Present,
    /// A session file that will not decrypt or will not parse. Unrecoverable in place — a blob
    /// that fails AEAD is not going to start working — so it is a desync verdict on its own,
    /// without waiting for `R` misses that can never accumulate.
    Damaged,
}

/// Per-peer desync bookkeeping (§4.6).
#[derive(Debug, Default, Clone)]
struct PeerHealth {
    /// Consecutive signature-valid envelopes from this peer we could not open.
    misses: u32,
    /// Resyncs driven with this peer. A climbing count is the "re-pair with this friend" signal:
    /// recovery that keeps recovering is not recovering.
    resyncs: u32,
    /// Nonces of resync records already applied, so a replayed one is a no-op.
    seen_nonces: Vec<[u8; 16]>,
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
            health: Mutex::new(HashMap::new()),
            desync_threshold: DEFAULT_DESYNC_THRESHOLD,
        }
    }

    /// Override the §4.5 lapse bound. Tests drive it; §8.4 leaves the production value open.
    pub fn with_t_lapse_ms(mut self, t_lapse_ms: u64) -> Self {
        self.t_lapse_ms = t_lapse_ms;
        self
    }

    pub fn has_session(&self, peer: &[u8]) -> bool {
        matches!(self.presence(peer), SessionPresence::Present)
    }

    /// What is actually on disk for this peer — the distinction `has_session` alone cannot make.
    ///
    /// §4.6 names "state loss on one side (reinstall without backup, storage corruption)" as an
    /// expected cause of desync, and it is the one cause miss-counting cannot see: a peer whose
    /// blob will not decrypt never gets far enough to miss anything, because every `open` fails at
    /// the load. Collapsing that into `false` reports a broken session as an un-bootstrapped one,
    /// which is the opposite of the truth — un-bootstrapped is waiting for a bump, damaged needs a
    /// resync.
    ///
    /// Read fresh each call rather than cached in `health`: once a resync writes a good blob the
    /// verdict corrects itself, with no flag to clear.
    fn presence(&self, peer: &[u8]) -> SessionPresence {
        let _guard = self.critical.lock();
        match self.store.load(peer) {
            Ok(Some(_)) => SessionPresence::Present,
            Ok(None) => SessionPresence::Absent,
            Err(err) => {
                tracing::warn!(error = %err, "ratchet session state is unreadable; treating the \
                    session as desynced so §4.6 recovery can run");
                SessionPresence::Damaged
            }
        }
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

            tracing::debug!(
                sc.peer = %crate::telemetry::short_hex(peer),
                ratchet.epoch = slot.header.epoch,
                ratchet.counter = slot.header.counter,
                "ratchet send position persisted"
            );
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
    ) -> Result<zeroize::Zeroizing<Vec<u8>>, SessionError> {
        let _guard = self.critical.lock().map_err(|_| SessionError::Poisoned)?;
        let mut state = self.store.load(author)?.ok_or(SessionError::NoSession)?;

        let located = verified
            .locators()
            .into_iter()
            .enumerate()
            .find(|(_, loc)| state.matches(&loc.header, &loc.kid, self.window));
        let Some((index, loc)) = located else {
            // Signature-valid, but nothing here is ours. Ordinary in a pool — but a *run* of
            // these from one peer is what §4.6 calls a desync.
            self.note_miss(author);
            return Err(SessionError::NotForUs);
        };

        let mut keys = OsRatchetKeys;
        let key = state.accept(&loc.header, now_ms, self.window, &mut keys)?;
        let session_id = state.session_id();

        // Persist the advanced receiving state before handing the payload up. A crash here would
        // otherwise let the same envelope be accepted again after restart — harmless for key
        // reuse (receiving derives, it never seals) but it would resurrect a fix the UI has
        // already consumed.
        self.store.save(author, &state)?;
        tracing::debug!(
            sc.peer = %crate::telemetry::short_hex(author),
            ratchet.epoch = loc.header.epoch,
            ratchet.counter = loc.header.counter,
            ratchet.recv_epoch = state.recv_epoch(),
            "ratchet receive position persisted"
        );

        let opened = verified
            .open_wrap(index, &session_id, key)
            .map_err(|_| SessionError::NotForUs)?;
        self.clear_misses(author);
        Ok(opened.payload)
    }

    // ── desync detection and resync (§4.6) ────────────────────────────────────────────────

    fn note_miss(&self, peer: &[u8]) {
        if let Ok(mut health) = self.health.lock() {
            health.entry(peer.to_vec()).or_default().misses += 1;
        }
    }

    fn clear_misses(&self, peer: &[u8]) {
        if let Ok(mut health) = self.health.lock() {
            if let Some(entry) = health.get_mut(peer) {
                entry.misses = 0;
            }
        }
    }

    /// Whether this peer's session needs §4.6 recovery.
    ///
    /// Two ways in, because there are two ways a session breaks:
    ///
    /// - **`R` consecutive misses** against a session that loads fine — we are talking past each
    ///   other, the classic desync.
    /// - **A damaged state file**, which reports desynced immediately. Misses cannot accumulate
    ///   here (every `open` fails before it can miss), so waiting for `R` would wait forever.
    ///
    /// With nothing on disk the answer is "not desynced, un-bootstrapped": there is no session to
    /// be out of step with, and the fix is a bump rather than a resync.
    ///
    /// **Lock order.** `health` is taken and released before `presence` takes `critical`; see the
    /// note on [`SessionManager::critical`]. The `let` below must keep its guard temporary
    /// confined to the statement — do not hoist it.
    pub fn is_desynced(&self, peer: &[u8]) -> bool {
        let misses = self
            .health
            .lock()
            .ok()
            .and_then(|h| h.get(peer).map(|e| e.misses))
            .unwrap_or(0);
        match self.presence(peer) {
            SessionPresence::Damaged => true,
            SessionPresence::Present => misses >= self.desync_threshold,
            SessionPresence::Absent => false,
        }
    }

    /// Forget which resync records we have applied, across every peer.
    ///
    /// Called only when our own resync ephemeral is re-minted: the nonces in that set are records
    /// we applied *against the old ephemeral*, and once it is gone those results are ones we need
    /// to be able to reach again. Keeps `misses` and `resyncs` — the first is about envelopes and
    /// the second is the "re-pair with this friend" signal, and neither has anything to do with
    /// which ephemeral we are currently offering.
    ///
    /// This does not weaken the replay defence: the durable half is
    /// [`RatchetState::resync_ts`](crate::ratchet::RatchetState::resync_ts), which is unaffected
    /// and still refuses anything not newer than the session it would replace.
    pub fn forget_applied_resyncs(&self) {
        if let Ok(mut health) = self.health.lock() {
            for entry in health.values_mut() {
                entry.seen_nonces.clear();
            }
        }
    }

    /// How many resyncs we have driven with this peer.
    ///
    /// §4.6: "a resync loop surfaces a 're-pair with this friend' prompt rather than retrying
    /// forever". This is the number that prompt is driven from — recovery that keeps recovering
    /// is not recovering, and the honest move is to send the humans back to an in-person bump.
    pub fn resync_count(&self, peer: &[u8]) -> u32 {
        self.health
            .lock()
            .ok()
            .and_then(|h| h.get(peer).map(|e| e.resyncs))
            .unwrap_or(0)
    }

    /// Adopt a peer's resync record, replacing the session with one rooted in the two ephemerals.
    ///
    /// Returns `false` when the record is refused — stale, already applied, or one we have
    /// already acted on. Refusal is not an error: the stash can serve an old record from the
    /// overwritten slot at any time, and that has to be ordinary rather than alarming.
    ///
    /// **There is no fallback path here.** Either both ephemerals are present and the new root
    /// comes from their DH, or nothing happens. §4.6 is explicit that no code path may root a
    /// session in static-static DH, and this is the function that would be tempted to.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_resync(
        &self,
        peer: &[u8],
        record_nonce: [u8; 16],
        record_ts: u64,
        session_id: [u8; SESSION_ID_LEN],
        rk0: [u8; KEY_LEN],
        peer_ephemeral: [u8; KEY_LEN],
        our_ephemeral: Option<x25519_dalek::StaticSecret>,
        now_ms: u64,
    ) -> Result<bool, SessionError> {
        if now_ms.saturating_sub(record_ts) > RESYNC_FRESHNESS_MS {
            return Ok(false); // stale: a replay out of the overwritten slot
        }
        {
            let mut health = self.health.lock().map_err(|_| SessionError::Poisoned)?;
            let entry = health.entry(peer.to_vec()).or_default();
            if entry.seen_nonces.contains(&record_nonce) {
                return Ok(false);
            }
            entry.seen_nonces.push(record_nonce);
            // Bounded: the list only needs to outlive the freshness window, and an unbounded
            // one is a memory leak an adversary controls the size of.
            if entry.seen_nonces.len() > 32 {
                entry.seen_nonces.remove(0);
            }
            entry.resyncs += 1;
            entry.misses = 0;
        }

        let guard = self.critical.lock().map_err(|_| SessionError::Poisoned)?;

        // Monotonic acceptance, checked under the same guard that installs the replacement so
        // there is no window between deciding and doing. This is the half of §4.6's replay
        // defence that survives a restart: `seen_nonces` above is in memory by design, so after a
        // restart every record inside the freshness window looks new again, and the stash may
        // serve whatever version of the `rsy` slot it kept. A record may only replace a session
        // older than itself, and a replay never is.
        //
        // Scoped to a session we can actually read, deliberately: with nothing on disk, or a blob
        // that will not decrypt, there is no working session to protect, and refusing here would
        // lock out the exact case §4.6 exists for.
        if let Ok(Some(existing)) = self.store.load(peer) {
            if record_ts <= existing.resync_ts() {
                return Ok(false);
            }
        }

        let mut keys = OsRatchetKeys;
        let mut state = match our_ephemeral {
            // We are the responder for the new session: our bump ephemeral is the ratchet key
            // the initiator's root step already ran against.
            Some(ours) => RatchetState::bootstrap_responder(session_id, rk0, ours, now_ms),
            None => RatchetState::bootstrap_initiator(
                session_id,
                rk0,
                peer_ephemeral,
                now_ms,
                &mut keys,
            )?,
        };
        // Stamp the record that created this session before it is written, so the bound above is
        // in force from the very first save rather than from the next one.
        state.set_resync_ts(record_ts);
        self.store.save(peer, &state)?;
        drop(guard);
        Ok(true)
    }
}
