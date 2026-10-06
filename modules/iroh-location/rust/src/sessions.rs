//! The seam between the Double Ratchet schedule and the envelope: one session record per friend,
//! loaded, stepped, and persisted around every publish and every receive — and the §4.6 restart
//! protocol that replaces a session when it stops working.
//!
//! See `docs/social/FORWARD-SECRECY.md` §4.2 and §4.6. `ratchet.rs` is the schedule and knows
//! nothing about storage; `session_store.rs` is the storage and knows nothing about the schedule's
//! use; this module is the only place that holds both at once, which makes it the only place the
//! **persist-before-publish** rule can be enforced.
//!
//! ```text
//! publish:  lock → load → next_send → SAVE → seal → broadcast
//! receive:  verify → load → matches → accept → open → SAVE
//! ```
//!
//! # Restarting a session (§4.6)
//!
//! Modelled on Signal's X3DH + `PreKeySignalMessage` + Sesame, because the two-sided exchange it
//! replaced had no convergence guarantee (2026-10-02 split a pair for hours; 2026-10-03 left one
//! needing an in-person re-pair):
//!
//! * **One side decides.** The pair's *leader* is the lower endpoint id — the same side that is
//!   the ratchet initiator at pairing. Only the leader restarts a session; the *follower* can only
//!   ask it to ([`RestartRequest`], carried in the follower's control record).
//! * **No round trip, nothing held in memory.** Every device publishes signed **prekeys** in
//!   advance. The leader restarts on its own: a single-use base key, DH'd with the follower's
//!   newest prekey, roots the new session, and the base key's private half is dropped at once.
//! * **The restart rides every envelope until it is answered.** The leader attaches a
//!   [`BootHeader`] to each wrap for that follower until it opens something from them under the
//!   new session. The follower derives the session from any one of those envelopes, whenever it
//!   next reads — hours later is fine — or *primes* it natively without consuming the fix inside
//!   ([`SessionManager::prime`]).
//! * **Old sessions stay readable.** A record keeps the last few replaced sessions for decryption
//!   only, so whatever the peer sealed before it learned of a restart still opens.
//! * **Ordering is the leader's.** A follower adopts a restart only if its `ts` is newer than the
//!   session it is on; the leader makes each restart's `ts` strictly greater than the last. That
//!   is the whole replay defence, it is durable, and it needs no agreement between clocks.
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

use rand::rngs::OsRng;
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

use crate::crypto::{SealWrap, VerifiedEnvelope};
use crate::ratchet::{
    BootHeader, OsRatchetKeys, RatchetState, DEFAULT_ACCEPT_WINDOW, DEFAULT_T_LAPSE_MS, KEY_LEN,
    SESSION_ID_LEN,
};
use crate::session_store::{
    Prekey, RestartRequest, SessionEntry, SessionRecord, SessionStore, StoreError,
};

pub use crate::session_store::MAX_PREVIOUS_SESSIONS;

/// How many consecutive, distinct, signature-valid envelopes from one peer we cannot open before
/// the session counts as broken (`R` in §4.6).
///
/// Not 1: a single miss is ordinary. An envelope addressed to somebody else is indistinguishable
/// from one we merely failed to open, and in a pool that happens constantly — every envelope
/// carries a wrap per recipient and only one of them is ever ours. Requiring a run makes the
/// signal mean "this peer keeps talking and we keep failing", which is what a desync looks like.
pub const DEFAULT_DESYNC_THRESHOLD: u32 = 3;

/// How often a device mints a new restart prekey.
pub const PREKEY_ROTATE_MS: u64 = 24 * 60 * 60 * 1000;

/// The oldest prekey a leader will restart against.
///
/// This is the §4.5 bound restated for restarts. A follower that is alive rotates daily, so a
/// prekey older than this belongs to a device that has stopped running — possibly one sitting in
/// an evidence locker, whose disk still holds that prekey's private half. Restarting against it
/// would hand our position to whoever holds the device, with nothing proving it is still in its
/// owner's hands.
pub const PREKEY_MAX_USE_AGE_MS: u64 = 3 * 24 * 60 * 60 * 1000;

/// How long a follower keeps a superseded prekey's private half: the use bound above plus four
/// days for a restart header to reach a follower that was offline when it was made. The newest
/// prekey is always kept.
pub const PREKEY_RETAIN_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// How many of our newest prekeys the control record publishes. Two, so a leader holding a copy
/// of our record from just before a rotation still has one we can use.
pub const PUBLISHED_PREKEYS: usize = 2;

/// A follower whose session has had no sending chain for this long asks for a restart.
///
/// The responder side of a fresh pairing waits for the leader's first envelope before it can
/// send at all. That is a moment, not a state — unless the leader's envelopes never arrive or
/// never open, which is exactly how a Pixel sat for 24 h on 2026-10-02/03 dropping its friend as
/// `no_sending_chain` while nothing anywhere called it broken.
pub const STUCK_NO_SEND_MS: u64 = 60 * 60 * 1000;

/// How long a follower waits before repeating a restart request the leader has not answered.
pub const REQUEST_REPEAT_MS: u64 = 30 * 60 * 1000;

/// How long a leader leaves a restart it made before restarting again on its own judgement. A
/// restart answers a request immediately; this only paces the leader's own detection, so an
/// unanswered restart is given time to be answered before it is replaced.
pub const RESTART_SETTLE_MS: u64 = 30 * 60 * 1000;

/// Allowance for clock skew between two phones at pairing, applied to the pairing session's
/// origin. A follower adopts a restart only if it is newer than the session it is on; stamping the
/// pairing session slightly in the past keeps a leader whose clock runs behind ours from having its
/// first restart refused, while a restart header replayed from before the pairing is still old.
pub const PAIRING_ORIGIN_SKEW_MS: u64 = 10 * 60 * 1000;

const RESTART_ROOT_CONTEXT: &str = "sc-dr/v1/restart";
const RESTART_ID_CONTEXT: &str = "sc-dr/v1/restart-id";

/// Who restarts a pair's session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Lower endpoint id: restarts sessions, answers requests, attaches restart headers.
    Leader,
    /// Higher endpoint id: adopts the leader's restarts, asks for one when its session is broken.
    Follower,
}

impl Role {
    pub fn for_pair(ours: &[u8], theirs: &[u8]) -> Self {
        if crate::ratchet::initiator_by_endpoint(ours, theirs) {
            Role::Leader
        } else {
            Role::Follower
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Leader => "leader",
            Role::Follower => "follower",
        }
    }
}

/// One of our prekeys as the control record publishes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublishedPrekey {
    pub id: u32,
    pub public: [u8; KEY_LEN],
    pub created_ms: u64,
}

/// Why a session counts as broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Broken {
    /// The record will not decrypt or parse. Only a restart can replace it.
    Damaged,
    /// `R` distinct envelopes from the peer that no session we hold can open.
    Misses,
    /// The peer has not moved the ratchet within `T_lapse` (§4.5).
    Lapsed,
    /// Follower only: no sending chain for [`STUCK_NO_SEND_MS`].
    StuckNoSend,
}

impl Broken {
    pub fn as_str(self) -> &'static str {
        match self {
            Broken::Damaged => "damaged",
            Broken::Misses => "misses",
            Broken::Lapsed => "lapsed",
            Broken::StuckNoSend => "stuck_no_send",
        }
    }
}

/// A session's condition, as recovery needs to see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    /// Nothing on disk: never paired, or deliberately forgotten. Only a pairing can fix this.
    NoSession,
    Healthy,
    Broken(Broken),
}

/// Everything recovery needs to know about one peer, from one load.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Assessment {
    pub role: Role,
    pub health: Health,
    /// The origin `ts` of the session in use (see [`BootHeader::ts`]).
    pub origin_ts: u64,
    /// When we installed the session in use.
    pub created_ms: u64,
    /// Leader only: the session in use is a restart the follower has not answered on yet.
    pub awaiting_answer: bool,
    /// Leader only: the newest request from this peer we have acted on.
    pub answered_request_ts: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("session store: {0}")]
    Store(#[from] StoreError),
    /// No session with this peer yet — they have never been paired (§4.2), so there is nothing to
    /// wrap for and nothing to open with.
    #[error("no ratchet session with this peer")]
    NoSession,
    /// The envelope carried no wrap any session we hold can open. Ordinary and expected: it is
    /// addressed to somebody else, or beyond the acceptance window.
    #[error("no wrap in this envelope belongs to us")]
    NotForUs,
    /// An envelope we have already been handed: one on a chain we hold, at a position we have
    /// passed; one whose `seq` is not newer than the last this peer showed us; or a restart we
    /// already adopted.
    ///
    /// Split from [`Self::NotForUs`] because the two mean opposite things for §4.6. A miss is
    /// evidence the peer is talking past us; a replay is evidence of nothing. The durable path is
    /// one overwritten slot per author and every read opens the whole replica, so the envelope a
    /// quiet friend left there is re-read on every sync — and when that counted as a miss, three
    /// reads in one second were a "desync" (2026-10-02).
    #[error("envelope already seen")]
    Replayed,
    /// The schedule refused the position after it matched.
    #[error("ratchet refused the position: {0}")]
    Ratchet(#[from] crate::ratchet::RatchetError),
    /// The lock guarding the critical section was poisoned by a panic in another thread.
    #[error("session lock poisoned")]
    Poisoned,
    /// Only the pair's leader restarts its session.
    #[error("only the leader of a pair restarts its session")]
    NotLeader,
    /// The follower's newest prekey is older than [`PREKEY_MAX_USE_AGE_MS`].
    #[error("the peer's prekey is too old to restart against")]
    StalePrekey,
    /// A restart could not be derived (a low-order key).
    #[error("degenerate key in a restart")]
    DegenerateKey,
}

/// Why a recipient was left out of a publish. Surfaced so the caller can telemeter it rather
/// than discovering a silently short wrap list (`sc.drop_reason`, per infra/otel/README.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    /// No session yet: not paired, or the session was removed.
    NoSession,
    /// No fresh ratchet key from this peer within `T_lapse` (§4.5). Structurally identical to a
    /// revocation until they check back in.
    Lapsed,
    /// The state could not be loaded, or could not be persisted before publishing.
    StateUnavailable,
    /// The sending chain could not step — a follower still awaiting the leader's first envelope,
    /// or an exhausted chain.
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

/// Every friend's ratchet sessions, and the critical section around them.
pub struct SessionManager {
    store: SessionStore,
    /// Our endpoint id: decides our role in each pair and goes into every restart transcript.
    self_id: [u8; 32],
    /// Guards the whole load → derive → persist sequence. `()` because the state itself lives on
    /// disk — this exists to make the sequence atomic, not to own anything.
    ///
    /// # Lock order: never acquire `critical` while holding `health`
    ///
    /// `open` and the restart paths take `critical`, then `health` inside it. `assess` takes
    /// `health` first — and releases it, because its guard is a statement temporary — before it
    /// takes `critical`. Holding `health` across the acquisition of `critical` anywhere would
    /// invert that and deadlock the publish path against the receive path, intermittently.
    critical: Mutex<()>,
    window: u32,
    t_lapse_ms: std::sync::atomic::AtomicU64,
    /// Miss counting and restart bookkeeping per peer.
    ///
    /// In memory only. A restart of the process forgets it, which merely delays detection by `R`
    /// envelopes — whereas persisting it would put a "this peer is failing" counter on disk that
    /// survives the very restart most likely to have fixed the problem.
    health: Mutex<HashMap<Vec<u8>, PeerHealth>>,
    desync_threshold: u32,
}

/// Per-peer bookkeeping (§4.6).
#[derive(Debug, Default, Clone)]
struct PeerHealth {
    /// Consecutive signature-valid envelopes from this peer we could not open.
    ///
    /// Counted once per envelope, by `seq` — see [`PeerHealth::seen_seq`].
    misses: u32,
    /// The highest envelope `seq` from this peer we have opened or counted as a miss.
    ///
    /// `seq` is the author's single monotonic publish counter (`seq_store.rs`), signed into the
    /// envelope, so an envelope at or below this is one this process has already accounted for.
    /// The durable half is [`RatchetState::has_passed`].
    seen_seq: u64,
    /// Restarts installed with this peer in this process: the "re-pair with this friend" signal.
    restarts: u32,
}

impl std::fmt::Debug for SessionManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionManager")
            .field("store", &self.store)
            .field("window", &self.window)
            .field("t_lapse_ms", &self.t_lapse_ms())
            .finish()
    }
}

/// `RK₀` and the session id of a restarted session.
///
/// `RK₀ = KDF(DH(base, prekey), transcript)` with the transcript binding both identities, both
/// keys, the prekey id and the origin `ts`. Ephemeral × semi-static: the base key is single-use
/// and dropped the moment this returns, and the prekey is deleted on rotation (§4.6), so no
/// long-term key a seized device holds forever can recompute it. Authentication is the envelope
/// signature over the header on one side and the control-record signature over the prekey on the
/// other — the same signed-lane argument §4.1 makes for the ratchet header.
pub fn restart_root(
    dh: &[u8; KEY_LEN],
    leader: &[u8; 32],
    follower: &[u8; 32],
    boot: &BootHeader,
    prekey_public: &[u8; KEY_LEN],
) -> ([u8; KEY_LEN], [u8; SESSION_ID_LEN]) {
    let mut transcript = Vec::with_capacity(32 * 4 + 12);
    transcript.extend_from_slice(leader);
    transcript.extend_from_slice(follower);
    transcript.extend_from_slice(&boot.base);
    transcript.extend_from_slice(prekey_public);
    transcript.extend_from_slice(&boot.prekey_id.to_le_bytes());
    transcript.extend_from_slice(&boot.ts.to_le_bytes());

    let mut hasher = blake3::Hasher::new_derive_key(RESTART_ROOT_CONTEXT);
    hasher.update(dh);
    hasher.update(&transcript);
    let rk0 = *hasher.finalize().as_bytes();

    // A public label, so from the transcript alone (see `derive_boot_root` in lib.rs).
    let mut id_hasher = blake3::Hasher::new_derive_key(RESTART_ID_CONTEXT);
    id_hasher.update(&transcript);
    let mut session_id = [0u8; SESSION_ID_LEN];
    session_id.copy_from_slice(&id_hasher.finalize().as_bytes()[..SESSION_ID_LEN]);
    (rk0, session_id)
}

fn origin_of(record: &SessionRecord) -> u64 {
    record
        .current
        .as_ref()
        .map(|entry| entry.state.resync_ts())
        .unwrap_or(0)
}

impl SessionManager {
    pub fn new(store: SessionStore, self_id: [u8; 32]) -> Self {
        Self {
            store,
            self_id,
            critical: Mutex::new(()),
            window: DEFAULT_ACCEPT_WINDOW,
            t_lapse_ms: std::sync::atomic::AtomicU64::new(DEFAULT_T_LAPSE_MS),
            health: Mutex::new(HashMap::new()),
            desync_threshold: DEFAULT_DESYNC_THRESHOLD,
        }
    }

    /// Override the §4.5 lapse bound. Tests drive it; §8.4 leaves the production value open.
    pub fn with_t_lapse_ms(self, t_lapse_ms: u64) -> Self {
        self.set_t_lapse_ms(t_lapse_ms);
        self
    }

    /// Change the §4.5 lapse bound on a live manager. Tests only: a node's manager is shared, so
    /// lapsing a real pair on demand means changing it in place.
    pub fn set_t_lapse_ms(&self, t_lapse_ms: u64) {
        self.t_lapse_ms
            .store(t_lapse_ms, std::sync::atomic::Ordering::Relaxed);
    }

    fn t_lapse_ms(&self) -> u64 {
        self.t_lapse_ms.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn self_id(&self) -> [u8; 32] {
        self.self_id
    }

    /// Our role in the pair with `peer`.
    pub fn role(&self, peer: &[u8]) -> Role {
        Role::for_pair(&self.self_id, peer)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, SessionError> {
        self.critical.lock().map_err(|_| SessionError::Poisoned)
    }

    pub fn has_session(&self, peer: &[u8]) -> bool {
        let Ok(_guard) = self.lock() else {
            return false;
        };
        matches!(self.store.load_record(peer), Ok(Some(record)) if record.current.is_some())
    }

    /// The id of the session in use with `peer`. Two devices on the same session report the same
    /// id — which is how a test, or a person reading telemetry, tells "agreed" from "split".
    pub fn current_session_id(&self, peer: &[u8]) -> Option<[u8; SESSION_ID_LEN]> {
        let _guard = self.lock().ok()?;
        self.store
            .load_record(peer)
            .ok()??
            .current
            .map(|entry| entry.state.session_id())
    }

    /// Install a session from an in-person pairing, replacing the one in use (which is archived).
    ///
    /// `rk0` must come from the bootstrap primitive — fresh ephemerals from both sides, identity
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
        let mut keys = OsRatchetKeys;
        let state = RatchetState::bootstrap_initiator(
            session_id,
            rk0,
            peer_ratchet_pub,
            now_ms,
            &mut keys,
        )?;
        self.install_paired(peer, state, now_ms)
    }

    /// Install the responder half of a pairing: we contributed `our_ratchet` to the bump and
    /// have no sending chain until the initiator's first envelope arrives.
    pub fn bootstrap_responder(
        &self,
        peer: &[u8],
        session_id: [u8; SESSION_ID_LEN],
        rk0: [u8; KEY_LEN],
        our_ratchet: XStaticSecret,
        now_ms: u64,
    ) -> Result<(), SessionError> {
        let state = RatchetState::bootstrap_responder(session_id, rk0, our_ratchet, now_ms);
        self.install_paired(peer, state, now_ms)
    }

    fn install_paired(
        &self,
        peer: &[u8],
        mut state: RatchetState,
        now_ms: u64,
    ) -> Result<(), SessionError> {
        state.set_resync_ts(now_ms.saturating_sub(PAIRING_ORIGIN_SKEW_MS));
        let _guard = self.lock()?;
        // A damaged record is replaced outright: there is nothing in it worth archiving.
        let mut record = self
            .store
            .load_record(peer)
            .ok()
            .flatten()
            .unwrap_or_default();
        record.install(SessionEntry {
            state,
            created_ms: now_ms,
            pending_boot: None,
        });
        // A new pairing starts the request ledger over: nothing the follower asked for under the
        // old relationship is owed under the new one. As leader, a request stamped before this
        // pairing is void — with the same skew allowance the origin gets, so a follower whose clock
        // runs behind ours is not ignored when it asks about THIS session. Resetting to 0 instead
        // let the follower's still-outstanding request from the broken session restart a pairing
        // five seconds old (2026-10-06, 00:37:41).
        record.answered_request_ts = now_ms.saturating_sub(PAIRING_ORIGIN_SKEW_MS);
        self.store.save_record(peer, &record)?;
        // As follower, withdraw the request itself, or our next control record re-publishes it.
        // Best-effort: a damaged control file must not fail the pairing it is incidental to.
        self.drop_request_best_effort(peer);
        self.reset_seen_seq(peer);
        Ok(())
    }

    pub fn remove(&self, peer: &[u8]) -> Result<(), SessionError> {
        let _guard = self.lock()?;
        self.store.remove(peer)?;
        self.drop_request_best_effort(peer);
        self.reset_seen_seq(peer);
        Ok(())
    }

    fn drop_request_best_effort(&self, peer: &[u8]) {
        if let Err(err) = self.drop_request_locked(peer) {
            tracing::warn!(
                sc.peer = %crate::telemetry::short_hex(peer),
                error = %err,
                "could not withdraw our restart request"
            );
        }
    }

    /// Withdraw our restart request to `peer`, with the lock already held. Returns whether there
    /// was one.
    fn drop_request_locked(&self, peer: &[u8]) -> Result<bool, SessionError> {
        let mut control = self.store.load_control()?;
        let before = control.requests.len();
        control.requests.retain(|r| r.peer.as_slice() != peer);
        if control.requests.len() == before {
            return Ok(false);
        }
        self.store.save_control(&control)?;
        Ok(true)
    }

    /// Withdraw only the ratchet installed by this pairing, never a later re-pair or restart.
    pub(crate) fn remove_if_session(
        &self,
        peer: &[u8],
        session_id: [u8; SESSION_ID_LEN],
    ) -> Result<bool, SessionError> {
        let _guard = self.lock()?;
        let current = self
            .store
            .load_record(peer)?
            .and_then(|record| record.current)
            .map(|entry| entry.state.session_id());
        if current != Some(session_id) {
            return Ok(false);
        }
        self.store.remove(peer)?;
        Ok(true)
    }

    /// Derive one wrap per recipient, persisting each advanced session **before returning**.
    ///
    /// Persist-before-publish is the whole point of doing this in one call: by the time the
    /// caller holds a [`WrapSet`], every counter it represents is already on disk. A crash
    /// between here and the broadcast burns those counter values, which the next publish steps
    /// past locally — no peer round-trip, no deadlock (the sender-liveness invariant, §7 step 6).
    ///
    /// A leader's unanswered restart rides along as the wrap's [`BootHeader`].
    ///
    /// Recipients that cannot participate are dropped with a reason rather than failing the
    /// publish: one friend's missing session must not stop the others from being reached.
    pub fn next_wraps(&self, peers: &[Vec<u8>], now_ms: u64) -> Result<WrapSet, SessionError> {
        let _guard = self.lock()?;
        let mut wraps = Vec::with_capacity(peers.len());
        let mut dropped = Vec::new();

        for peer in peers {
            let mut record = match self.store.load_record(peer) {
                Ok(Some(record)) => record,
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
            let Some(entry) = record.current.as_mut() else {
                dropped.push((peer.clone(), DropReason::StateUnavailable));
                continue;
            };

            // §4.5: a peer who has not contributed a fresh ratchet key within T_lapse is treated
            // exactly like a revoked one. This is what bounds how long we publish into a
            // one-sided session, and it is why a seized device must keep actively emitting
            // signed envelopes to keep tracking (§1.1).
            if entry.state.is_lapsed(now_ms, self.t_lapse_ms()) {
                dropped.push((peer.clone(), DropReason::Lapsed));
                continue;
            }

            let slot = match entry.state.next_send() {
                Ok(slot) => slot,
                Err(err) => {
                    tracing::debug!(error = %err, sc.drop_reason = "no_sending_chain",
                        "no sending chain for this recipient yet");
                    dropped.push((peer.clone(), DropReason::NoSendingChain));
                    continue;
                }
            };
            let boot = entry.pending_boot;
            let session_id = entry.state.session_id();

            // The counter is spent the moment `next_send` returned. If it cannot be written down,
            // the only safe move is to discard the slot — publishing under state we failed to
            // persist is exactly the key reuse §4.2 forbids.
            if let Err(err) = self.store.save_record(peer, &record) {
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
                restart = boot.is_some(),
                "ratchet send position persisted"
            );
            wraps.push(SealWrap {
                kid: slot.kid,
                header: slot.header,
                session_id,
                key: slot.key,
                boot,
            });
        }

        Ok(WrapSet { wraps, dropped })
    }

    /// Open a verified envelope from `author`.
    ///
    /// The envelope must already have had its signature checked ([`crypto::verify_v3`]) — this
    /// takes a [`VerifiedEnvelope`] rather than bytes so that ordering is a type-level fact
    /// rather than a convention (§4.2).
    ///
    /// Tries the session in use, then the archive, then — for a follower — a restart header from
    /// its leader. Nothing is persisted unless the payload actually opens, so a failed decryption
    /// never moves stored state (Signal's "failed decryption does not update stores").
    ///
    /// [`crypto::verify_v3`]: crate::crypto::verify_v3
    pub fn open(
        &self,
        author: &[u8],
        verified: &VerifiedEnvelope,
        now_ms: u64,
    ) -> Result<zeroize::Zeroizing<Vec<u8>>, SessionError> {
        let _guard = self.lock()?;
        let (mut record, load_error) = match self.store.load_record(author) {
            Ok(Some(record)) => (record, None),
            Ok(None) => return Err(SessionError::NoSession),
            Err(err) => (SessionRecord::default(), Some(err)),
        };
        let locators = verified.locators();
        let mut keys = OsRatchetKeys;

        // 1. The session in use, then the archive.
        for (index, loc) in locators.iter().enumerate() {
            let in_use = record
                .current
                .as_ref()
                .is_some_and(|entry| entry.state.matches(&loc.header, &loc.kid, self.window));
            if in_use {
                let entry = record.current.as_mut().expect("checked above");
                let key = entry
                    .state
                    .accept(&loc.header, now_ms, self.window, &mut keys)?;
                let opened = verified
                    .open_wrap(index, &entry.state.session_id(), key)
                    .map_err(|_| SessionError::NotForUs)?;
                // The peer sent under this session, so they have it: a restart is answered.
                let answered = entry.pending_boot.take().is_some();
                self.store.save_record(author, &record)?;
                if answered {
                    tracing::info!(
                        sc.peer = %crate::telemetry::short_hex(author),
                        sc.restart = "answered",
                        "the follower answered on the restarted session"
                    );
                }
                self.clear_misses(author, verified.seq);
                tracing::debug!(
                    sc.peer = %crate::telemetry::short_hex(author),
                    ratchet.epoch = loc.header.epoch,
                    ratchet.counter = loc.header.counter,
                    "ratchet receive position persisted"
                );
                return Ok(opened.payload);
            }
            let archived = record
                .previous
                .iter()
                .position(|entry| entry.state.matches(&loc.header, &loc.kid, self.window));
            if let Some(slot) = archived {
                let entry = &mut record.previous[slot];
                let key = entry
                    .state
                    .accept(&loc.header, now_ms, self.window, &mut keys)?;
                let opened = verified
                    .open_wrap(index, &entry.state.session_id(), key)
                    .map_err(|_| SessionError::NotForUs)?;
                self.store.save_record(author, &record)?;
                self.clear_misses(author, verified.seq);
                tracing::debug!(
                    sc.peer = %crate::telemetry::short_hex(author),
                    archived = slot,
                    "opened an envelope on an archived session"
                );
                return Ok(opened.payload);
            }
        }

        // 2. A restart from our leader that we have not adopted yet.
        if self.role(author) == Role::Follower {
            let origin = origin_of(&record);
            for (index, loc) in locators.iter().enumerate() {
                let Some(boot) = loc.boot else { continue };
                if boot.ts <= origin && load_error.is_none() {
                    continue;
                }
                let Some(mut state) = self.derive_follower_session(author, &boot, now_ms)? else {
                    continue;
                };
                // Another recipient's restart header can name a prekey id that happens to exist
                // here too; only our own derivation reproduces this wrap's kid.
                if !state.matches(&loc.header, &loc.kid, self.window) {
                    continue;
                }
                let key = state.accept(&loc.header, now_ms, self.window, &mut keys)?;
                let session_id = state.session_id();
                let opened = verified
                    .open_wrap(index, &session_id, key)
                    .map_err(|_| SessionError::NotForUs)?;
                self.adopt(author, &mut record, state, now_ms)?;
                self.clear_misses(author, verified.seq);
                tracing::info!(
                    sc.peer = %crate::telemetry::short_hex(author),
                    sc.restart = "adopted",
                    sc.session = %crate::telemetry::short_hex(&session_id),
                    origin_ts = boot.ts,
                    "adopted the leader's restarted session"
                );
                return Ok(opened.payload);
            }
        }

        if let Some(err) = load_error {
            return Err(err.into());
        }

        // 3. Nothing opened it. Something we already passed is not evidence of anything.
        let passed = locators.iter().any(|loc| {
            record
                .current
                .iter()
                .chain(record.previous.iter())
                .any(|entry| entry.state.has_passed(&loc.header))
        });
        if passed || self.is_adopted_restart(author, &record, &locators, now_ms) {
            return Err(SessionError::Replayed);
        }
        if !self.note_miss(author, verified.seq) {
            return Err(SessionError::Replayed);
        }
        // Signature-valid, new, and nothing here is ours. Ordinary in a pool — but a *run* of
        // these from one peer is what §4.6 calls a desync.
        Err(SessionError::NotForUs)
    }

    /// Follower only: adopt a restart header in `verified` **without consuming** the fix it
    /// carries, so a process that cannot hand fixes to anyone (the native background runtime)
    /// can still join the leader's session and start sending on it. The envelope stays openable
    /// by whoever reads it next. Returns whether a session was installed.
    pub fn prime(
        &self,
        author: &[u8],
        verified: &VerifiedEnvelope,
        now_ms: u64,
    ) -> Result<bool, SessionError> {
        if self.role(author) != Role::Follower {
            return Ok(false);
        }
        let _guard = self.lock()?;
        let (mut record, damaged) = match self.store.load_record(author) {
            Ok(Some(record)) => (record, false),
            Ok(None) => return Ok(false),
            Err(_) => (SessionRecord::default(), true),
        };
        let origin = origin_of(&record);
        let mut keys = OsRatchetKeys;
        for loc in verified.locators() {
            let Some(boot) = loc.boot else { continue };
            if boot.ts <= origin && !damaged {
                continue;
            }
            let Some(mut state) = self.derive_follower_session(author, &boot, now_ms)? else {
                continue;
            };
            if !state.matches(&loc.header, &loc.kid, self.window) {
                continue;
            }
            state.prime(&loc.header, now_ms, self.window, &mut keys)?;
            let session_id = state.session_id();
            self.adopt(author, &mut record, state, now_ms)?;
            tracing::info!(
                sc.peer = %crate::telemetry::short_hex(author),
                sc.restart = "primed",
                sc.session = %crate::telemetry::short_hex(&session_id),
                origin_ts = boot.ts,
                "adopted the leader's restarted session without reading it"
            );
            return Ok(true);
        }
        Ok(false)
    }

    /// Install `state` as a follower's session in use and persist it. Caller holds `critical`.
    fn adopt(
        &self,
        author: &[u8],
        record: &mut SessionRecord,
        state: RatchetState,
        now_ms: u64,
    ) -> Result<(), SessionError> {
        record.install(SessionEntry {
            state,
            created_ms: now_ms,
            pending_boot: None,
        });
        self.store.save_record(author, record)?;
        if let Ok(mut health) = self.health.lock() {
            let entry = health.entry(author.to_vec()).or_default();
            entry.misses = 0;
            entry.restarts += 1;
        }
        Ok(())
    }

    /// The follower's side of a restart header: the session the leader derived, if the prekey it
    /// names is one we still hold. Caller holds `critical`.
    fn derive_follower_session(
        &self,
        leader: &[u8],
        boot: &BootHeader,
        now_ms: u64,
    ) -> Result<Option<RatchetState>, SessionError> {
        let Ok(leader) = <[u8; 32]>::try_from(leader) else {
            return Ok(None);
        };
        let control = match self.store.load_control() {
            Ok(control) => control,
            Err(err) => {
                tracing::warn!(error = %err, "restart prekeys could not be read");
                return Ok(None);
            }
        };
        let Some(prekey) = control.prekeys.iter().find(|p| p.id == boot.prekey_id) else {
            return Ok(None);
        };
        let secret = prekey.secret();
        let shared = secret.diffie_hellman(&XPublicKey::from(boot.base));
        if !shared.was_contributory() {
            return Ok(None);
        }
        let (rk0, session_id) = restart_root(
            shared.as_bytes(),
            &leader,
            &self.self_id,
            boot,
            &prekey.public(),
        );
        // The prekey is the responder's first ratchet key — exactly the key the leader's opening
        // root step ran against — and is replaced on the first DH ratchet, i.e. right away.
        let mut state = RatchetState::bootstrap_responder(session_id, rk0, secret, now_ms);
        state.set_resync_ts(boot.ts);
        Ok(Some(state))
    }

    /// Whether any restart header in `locators` derives a session we already hold — the leader
    /// keeps attaching it until it hears back, and every copy after the first is a replay.
    fn is_adopted_restart(
        &self,
        author: &[u8],
        record: &SessionRecord,
        locators: &[crate::crypto::WrapLocator],
        now_ms: u64,
    ) -> bool {
        if self.role(author) != Role::Follower {
            return false;
        }
        let held: Vec<[u8; SESSION_ID_LEN]> = record
            .current
            .iter()
            .chain(record.previous.iter())
            .map(|entry| entry.state.session_id())
            .collect();
        locators.iter().filter_map(|loc| loc.boot).any(|boot| {
            matches!(
                self.derive_follower_session(author, &boot, now_ms),
                Ok(Some(state)) if held.contains(&state.session_id())
            )
        })
    }

    /// Leader only: restart the session with `peer` against their published `prekey`.
    ///
    /// Unilateral and immediate: the new session is in use from the next publish, carrying its
    /// [`BootHeader`] on every wrap for `peer` until they answer on it. `answering` is the `ts` of
    /// the peer's request this restart answers, if any; it is recorded in the same write, so a
    /// request is never answered twice.
    pub fn restart_as_leader(
        &self,
        peer: &[u8],
        prekey: &PublishedPrekey,
        answering: Option<u64>,
        now_ms: u64,
    ) -> Result<BootHeader, SessionError> {
        if self.role(peer) != Role::Leader {
            return Err(SessionError::NotLeader);
        }
        if now_ms.saturating_sub(prekey.created_ms) > PREKEY_MAX_USE_AGE_MS {
            return Err(SessionError::StalePrekey);
        }
        let follower: [u8; 32] = peer.try_into().map_err(|_| SessionError::NoSession)?;
        let _guard = self.lock()?;
        let mut record = match self.store.load_record(peer) {
            Ok(Some(record)) => record,
            Ok(None) => return Err(SessionError::NoSession),
            // Damaged: nothing worth keeping, and a restart is exactly what replaces it.
            Err(_) => SessionRecord::default(),
        };

        // Strictly after the session it replaces, on our own clock: this is what the follower
        // orders restarts by, so it must never repeat or go backwards.
        let ts = now_ms.max(origin_of(&record).saturating_add(1));
        let base = XStaticSecret::random_from_rng(OsRng);
        let boot = BootHeader {
            base: XPublicKey::from(&base).to_bytes(),
            prekey_id: prekey.id,
            ts,
        };
        let shared = base.diffie_hellman(&XPublicKey::from(prekey.public));
        if !shared.was_contributory() {
            return Err(SessionError::DegenerateKey);
        }
        let (rk0, session_id) = restart_root(
            shared.as_bytes(),
            &self.self_id,
            &follower,
            &boot,
            &prekey.public,
        );
        drop(base);

        let mut keys = OsRatchetKeys;
        let mut state =
            RatchetState::bootstrap_initiator(session_id, rk0, prekey.public, now_ms, &mut keys)?;
        state.set_resync_ts(ts);
        record.install(SessionEntry {
            state,
            created_ms: now_ms,
            pending_boot: Some(boot),
        });
        if let Some(request_ts) = answering {
            record.answered_request_ts = record.answered_request_ts.max(request_ts);
        }
        self.store.save_record(peer, &record)?;
        if let Ok(mut health) = self.health.lock() {
            let entry = health.entry(peer.to_vec()).or_default();
            entry.misses = 0;
            entry.restarts += 1;
        }
        tracing::info!(
            sc.peer = %crate::telemetry::short_hex(peer),
            sc.restart = "made",
            sc.session = %crate::telemetry::short_hex(&session_id),
            prekey_id = prekey.id,
            origin_ts = ts,
            answering = answering.unwrap_or(0),
            "restarted the session as leader"
        );
        Ok(boot)
    }

    /// Everything recovery needs to know about `peer`, from one load.
    ///
    /// **Lock order.** `health` is read and released before `critical` is taken; see the note on
    /// [`SessionManager::critical`]. Keep the `misses` read a statement temporary.
    pub fn assess(&self, peer: &[u8], now_ms: u64) -> Assessment {
        let misses = self
            .health
            .lock()
            .ok()
            .and_then(|h| h.get(peer).map(|e| e.misses))
            .unwrap_or(0);
        let role = self.role(peer);
        let mut out = Assessment {
            role,
            health: Health::NoSession,
            origin_ts: 0,
            created_ms: 0,
            awaiting_answer: false,
            answered_request_ts: 0,
        };
        let Ok(_guard) = self.lock() else {
            out.health = Health::Broken(Broken::Damaged);
            return out;
        };
        let record = match self.store.load_record(peer) {
            Ok(Some(record)) => record,
            Ok(None) => return out,
            Err(err) => {
                tracing::warn!(error = %err, "ratchet session state is unreadable; treating the \
                    session as broken so §4.6 recovery can run");
                out.health = Health::Broken(Broken::Damaged);
                return out;
            }
        };
        out.answered_request_ts = record.answered_request_ts;
        let Some(entry) = record.current.as_ref() else {
            out.health = Health::Broken(Broken::Damaged);
            return out;
        };
        out.origin_ts = entry.state.resync_ts();
        out.created_ms = entry.created_ms;
        out.awaiting_answer = entry.pending_boot.is_some();
        out.health = if misses >= self.desync_threshold {
            Health::Broken(Broken::Misses)
        } else if entry.state.is_lapsed(now_ms, self.t_lapse_ms()) {
            Health::Broken(Broken::Lapsed)
        } else if role == Role::Follower
            && !entry.state.has_sending_chain()
            && now_ms.saturating_sub(entry.created_ms) >= STUCK_NO_SEND_MS
        {
            Health::Broken(Broken::StuckNoSend)
        } else {
            Health::Healthy
        };
        out
    }

    /// Whether this peer's session needs §4.6 recovery. See [`Broken`] for the ways in.
    ///
    /// With nothing on disk the answer is "not desynced, un-bootstrapped": there is no session to
    /// be out of step with, and the fix is a pairing rather than a restart.
    pub fn is_desynced(&self, peer: &[u8], now_ms: u64) -> bool {
        matches!(self.assess(peer, now_ms).health, Health::Broken(_))
    }

    /// How many restarts have been installed with this peer in this process.
    ///
    /// §4.6: "a resync loop surfaces a 're-pair with this friend' prompt rather than retrying
    /// forever". This is the number that prompt is driven from.
    pub fn resync_count(&self, peer: &[u8]) -> u32 {
        self.health
            .lock()
            .ok()
            .and_then(|h| h.get(peer).map(|e| e.restarts))
            .unwrap_or(0)
    }

    // ── our own restart material ──────────────────────────────────────────────────────────

    /// Our prekeys as the control record should publish them, newest first — rotating and
    /// expiring first, and persisting before returning, so a published prekey always has its
    /// private half on disk.
    pub fn prekeys_for_publication(
        &self,
        now_ms: u64,
    ) -> Result<Vec<PublishedPrekey>, SessionError> {
        let _guard = self.lock()?;
        let mut control = match self.store.load_control() {
            Ok(control) => control,
            Err(err) => {
                // Starting over is safe here in a way it is not for a session: new prekeys are
                // simply published, and a restart against a lost one asks again.
                tracing::warn!(error = %err, "restart prekeys unreadable; minting new ones");
                Default::default()
            }
        };
        let mut changed = false;
        let due = control
            .prekeys
            .last()
            .is_none_or(|newest| now_ms >= newest.created_ms.saturating_add(PREKEY_ROTATE_MS));
        if due {
            let id = control
                .prekeys
                .last()
                .map(|newest| newest.id.wrapping_add(1))
                .unwrap_or(1);
            let secret = XStaticSecret::random_from_rng(OsRng).to_bytes();
            control.prekeys.push(Prekey::new(id, secret, now_ms));
            changed = true;
        }
        let newest_id = control.prekeys.last().map(|p| p.id);
        let before = control.prekeys.len();
        control.prekeys.retain(|p| {
            Some(p.id) == newest_id || now_ms < p.created_ms.saturating_add(PREKEY_RETAIN_MS)
        });
        changed |= control.prekeys.len() != before;
        if changed {
            self.store.save_control(&control)?;
        }
        Ok(control
            .prekeys
            .iter()
            .rev()
            .take(PUBLISHED_PREKEYS)
            .map(|p| PublishedPrekey {
                id: p.id,
                public: p.public(),
                created_ms: p.created_ms,
            })
            .collect())
    }

    /// Our outstanding restart requests.
    pub fn requests(&self) -> Result<Vec<RestartRequest>, SessionError> {
        let _guard = self.lock()?;
        Ok(self.store.load_control()?.requests)
    }

    /// Record (or replace) our request that `peer` restart our session.
    pub fn set_request(&self, request: RestartRequest) -> Result<(), SessionError> {
        let _guard = self.lock()?;
        let mut control = self.store.load_control()?;
        control.requests.retain(|r| r.peer != request.peer);
        control.requests.push(request);
        self.store.save_control(&control)?;
        Ok(())
    }

    /// Withdraw our request to `peer`. Returns whether there was one.
    pub fn clear_request(&self, peer: &[u8]) -> Result<bool, SessionError> {
        let _guard = self.lock()?;
        self.drop_request_locked(peer)
    }

    // ── miss accounting ───────────────────────────────────────────────────────────────────

    /// Count `seq` as a miss, unless it is not newer than what this peer has already shown us.
    /// Returns whether it counted.
    fn note_miss(&self, peer: &[u8], seq: u64) -> bool {
        let Ok(mut health) = self.health.lock() else {
            return false;
        };
        let entry = health.entry(peer.to_vec()).or_default();
        if seq <= entry.seen_seq {
            return false;
        }
        entry.seen_seq = seq;
        entry.misses += 1;
        true
    }

    fn clear_misses(&self, peer: &[u8], seq: u64) {
        if let Ok(mut health) = self.health.lock() {
            let entry = health.entry(peer.to_vec()).or_default();
            entry.misses = 0;
            entry.seen_seq = entry.seen_seq.max(seq);
        }
    }

    /// A new pairing may come with a peer whose counter started over (a reinstall that lost its
    /// keychain), so nothing it says about seq ordering carries across a re-pair.
    fn reset_seen_seq(&self, peer: &[u8]) {
        if let Ok(mut health) = self.health.lock() {
            if let Some(entry) = health.get_mut(peer) {
                entry.seen_seq = 0;
                entry.misses = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TestStore(PathBuf);

    impl TestStore {
        fn new() -> Self {
            Self(PathBuf::from("target").join(format!(
                "pair-withdrawal-store-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            )))
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn withdrawal_cleanup_cannot_remove_a_newer_ratchet() {
        let scratch = TestStore::new();
        let identity = [0xAA; 32];
        let peer = [0xBB; 32];
        let manager = SessionManager::new(
            SessionStore::open(&scratch.0, &identity).unwrap(),
            [0xAA; 32],
        );
        let install = |id: u8| {
            manager
                .bootstrap_responder(
                    &peer,
                    [id; SESSION_ID_LEN],
                    [id; KEY_LEN],
                    XStaticSecret::from([id; KEY_LEN]),
                    1,
                )
                .unwrap();
        };
        assert!(!manager
            .remove_if_session(&peer, [1; SESSION_ID_LEN])
            .unwrap());
        install(1);
        assert!(!manager
            .remove_if_session(&peer, [2; SESSION_ID_LEN])
            .unwrap());
        assert!(manager.has_session(&peer));
        assert!(manager
            .remove_if_session(&peer, [1; SESSION_ID_LEN])
            .unwrap());
        assert!(!manager.has_session(&peer));
        assert!(!manager
            .remove_if_session(&peer, [1; SESSION_ID_LEN])
            .unwrap());

        install(2);
        assert!(!manager
            .remove_if_session(&peer, [1; SESSION_ID_LEN])
            .unwrap());
        drop(manager);
        let reopened = SessionStore::open(&scratch.0, &identity).unwrap();
        assert_eq!(
            reopened.load(&peer).unwrap().unwrap().session_id(),
            [2; SESSION_ID_LEN]
        );
    }
}
