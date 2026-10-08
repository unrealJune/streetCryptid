//! The drain path, expressed against ports rather than against files and a live node.
//!
//! [`DrainEngine`] is the whole of "a location arrived, decide what to do with it": gate the fix,
//! enqueue one envelope per due slot, then seal and send in capture order. It is the piece that has
//! to run when no JS context exists, and it is also the piece most worth testing — so it depends on
//! five narrow traits and knows nothing about SQLite, the filesystem, iroh, or the FFI.
//!
//! # Why ports here and not everywhere
//!
//! The same shape the JS side already uses: `fix-outbox.ts` takes a `PersistentKV` port and ships
//! an `InMemoryKV` for tests. Mirroring that keeps the two implementations comparable, and — more
//! usefully — it means the orchestration can be tested against fakes that fail on demand. "The
//! publish succeeded but the commit did not" is a real background outcome and an unreachable one
//! if the only way to reach the engine is through a live relay.
//!
//! Traits stop where the value stops. The clock and the battery are passed in as values rather than
//! hidden behind sources, because they are inputs to a decision, not collaborators with behaviour
//! worth substituting.

use crate::gate::{self, BatteryState, FixQualityConfig, GateState};
use crate::{LocationFix, StoredFix, FIX_STATE_LIVE, FIX_STATE_NO_FIX, FIX_STATE_PARKED};

/// What can go wrong reaching persisted publish state.
///
/// One enum across the four stores, because the engine's response to every one of them is the same
/// — stop, leave the queue intact, and let the next wake retry. Distinguishing them at this level
/// would be detail no caller acts on; the concrete stores keep their own richer errors for the
/// callers that do.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("publish state io: {0}")]
    Io(String),
    /// State exists but this build cannot read it. Never silently treated as "absent" — see
    /// [`crate::seq_store`] for why that distinction is load-bearing for the counter.
    #[error("publish state is malformed")]
    Malformed,
}

/// This device's monotonic publish counter.
///
/// Implementations must make a value durable **before** returning it: the caller puts it straight
/// on the wire as half of an `author/seq` docs key, and two envelopes under one key is a payload
/// lost to last-write-wins.
pub trait SeqCounter: Send + Sync {
    fn next(&self) -> Result<u64, StoreError>;
    fn current(&self) -> u64;
    /// Raise to at least `floor`; report whether it moved. Must be monotone — raising may skip
    /// values, never re-issue them.
    fn seed(&self, floor: u64) -> Result<bool, StoreError>;
}

/// What one enqueue did, so the caller can record it without re-reading the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct EnqueueOutcome {
    /// Queue depth after the append.
    pub pending: u32,
    /// How many of the oldest fixes the bound discarded to make room. Non-zero means this device
    /// has been unable to publish for hours; it is the signal, not an incidental detail.
    pub overflow_dropped: u32,
}

/// The durable queue between "the OS handed us a location" and "the envelope is on the wire".
///
/// Peek-then-commit rather than a drain callback, so the fix stays queued until the publish has
/// actually succeeded. A crash in between costs a duplicate, which is invisible under
/// last-write-wins on `(author, seq)`; the alternative costs a hole in someone's trail.
pub trait FixQueue: Send + Sync {
    fn enqueue(&self, fix: LocationFix) -> Result<EnqueueOutcome, StoreError>;
    fn peek(&self) -> Option<LocationFix>;
    /// Remove the oldest fix. Must be a no-op when empty, so a retried drain cannot remove a fix
    /// that was never published.
    fn commit(&self) -> Result<u32, StoreError>;
    fn pending(&self) -> u32;
    fn clear(&self) -> Result<(), StoreError>;
}

/// The friends this device currently seals location envelopes for, and the ones it owes a null
/// envelope to.
pub trait Recipients: Send + Sync {
    fn get(&self) -> Vec<String>;
    /// Watch-only edges. They receive no position, but they do receive our ratchet contribution on
    /// the same cadence — which is the only thing keeping the edge from lapsing at `T_lapse`.
    fn watchers(&self) -> Vec<String>;
    fn set(&self, endpoints: &[String]) -> Result<(), StoreError>;
}

/// Where the gate keeps what it learned last time.
///
/// `set` does not return a result: the in-memory copy must advance even when the write fails, or a
/// device with an unhappy disk would republish the same slot on every fix forever.
pub trait GateStateStore: Send + Sync {
    fn get(&self) -> GateState;
    fn set(&self, next: GateState);
}

/// Where a sealed envelope goes — the engine's only dependency on the network.
///
/// One method rather than separate live and durable calls: both lanes carry the *same sealed
/// bytes*, so splitting them here would invite an implementation that sealed twice and let
/// per-recipient revocation diverge between them.
pub trait PublishSink: Send + Sync {
    fn publish(
        &self,
        seq: u64,
        fix: LocationFix,
        recipients: Vec<String>,
    ) -> impl std::future::Future<Output = Result<Sealed, PublishError>> + Send;

    /// The watcher lane: an envelope with no position, wrapped for friends we do NOT share with
    /// (FORWARD-SECRECY.md §4.1).
    ///
    /// A distinct `seq` from the fix it accompanies — two envelopes, never the same
    /// `(author, seq)` — so the two lanes land in separate last-write-wins slots and cannot
    /// supersede each other.
    fn publish_null(
        &self,
        seq: u64,
        ts: u64,
        watchers: Vec<String>,
    ) -> impl std::future::Future<Output = Result<Sealed, PublishError>> + Send;

    /// Run §4.6 session recovery for any of `peers` whose ratchet has stopped working, once per
    /// drain.
    ///
    /// A port rather than something the platform layer does afterwards, for the same reason
    /// [`Self::flush`] is one: recovery used to be driven by the JS publish path, the native drain
    /// replaced that path, and nothing took the step over. From then on a session that lapsed
    /// stayed lapsed — each side drops the other from its wrap set, so neither can ever deliver
    /// the fresh ratchet key that would un-lapse it — and on 2026-09-29 a Pixel 9 had spent a
    /// week publishing 785 envelopes, every one of them sealed for nobody.
    ///
    /// Best-effort by contract: recovery failing must never cost the fixes this drain published.
    fn recover(
        &self,
        peers: Vec<String>,
    ) -> impl std::future::Future<Output = RecoveryOutcome> + Send;

    /// Get everything just published **off the device**, once per drain that sent anything.
    ///
    /// Not an optimisation and not a lifecycle hook: [`Self::publish`] writes the local replica and
    /// broadcasts to a live swarm that, on a background wake, is empty. iroh-docs broadcasts a
    /// local insert only for namespaces the live engine has marked as syncing, which a publish-only
    /// context never does — so until something reconciles with a peer, an "published" envelope has
    /// not left the phone.
    ///
    /// It is part of this trait rather than a call the platform layer makes afterwards because
    /// leaving it to the caller is exactly how it went missing: the JS orchestration used to do it,
    /// the native drain replaced that orchestration, and nothing took the step over. Two phones ran
    /// a full day on 2026-08-31 publishing into their own replicas while the stash received nothing
    /// from either. Making it a port means the engine's own tests assert it happens.
    ///
    /// Best-effort by contract: a failure degrades offline delivery for those fixes, it does not
    /// mean the drain failed. The entries are committed and stay in the replica for the next push.
    ///
    /// **An implementation must report the reconciliation and nothing else.** Whatever else it does
    /// alongside — uploading blobs, refreshing a cache — must not be able to turn a completed push
    /// into an `Err`. Chaining a content upload onto the push with `?` is what made a phone that
    /// was reconciling every few minutes report `last_push_age_ms` in the tens of minutes, which is
    /// precisely the instrument you reach for when you suspect it is not pushing.
    fn flush(&self)
        -> impl std::future::Future<Output = Result<FlushOutcome, PublishError>> + Send;
}

/// Whether a flush actually moved anything off the device.
///
/// Two outcomes rather than a bare `Ok`, because they were the same value and it made the push
/// watermark lie: a phone with nowhere to send returned `Ok`, the drain stamped `last_pushed_at`,
/// and `device.health` reported a fresh push forever on a device that had never pushed at all.
/// That is the same class of fault the native watermarks were introduced to end, reintroduced one
/// commit later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushOutcome {
    /// Reconciled with at least one peer. The entries have left the device.
    Pushed,
    /// Nowhere to send: the stash is not opted into and the pool is empty. A real configuration,
    /// not a failure — and emphatically not a push.
    NoTargets,
}

/// What sealing one envelope actually achieved.
///
/// Returned rather than inferred because "the call succeeded" and "someone can open this" stopped
/// being the same thing when the ratchet arrived: a recipient without a usable session is dropped
/// from the wrap set, and an envelope with an empty wrap set is never written at all. Counting
/// those as published is how a phone reached nobody for a week while `last_publish_age_ms` read
/// thirty seconds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Sealed {
    /// Recipients the envelope was wrapped for — the ones who can open it.
    pub wrapped: u32,
    /// Recipients left out, each for a reason `sessions::DropReason` names.
    pub dropped: u32,
}

impl Sealed {
    /// Whether anybody at all can open this envelope.
    pub fn reached_anyone(&self) -> bool {
        self.wrapped > 0
    }
}

/// What one [`PublishSink::recover`] pass found.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecoveryOutcome {
    /// At least one peer is mid-exchange: our half is published and theirs has not been applied.
    ///
    /// The drain pushes whenever this is set, even if nothing else went out, because the push is
    /// also the pull — reconciliation is what brings the peer's half INTO this replica, and a
    /// phone that only reconciles after a successful publish would never receive the record that
    /// makes its next publish succeed.
    pub in_progress: bool,
    /// Sessions restarted this pass.
    pub restored: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum PublishError {
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The envelope did not reach the wire. The fix stays queued.
    #[error("publish failed: {0}")]
    Send(String),
}

/// What one [`DrainEngine::ingest`] call did.
///
/// Every field is something a background callback could not otherwise observe, and each maps to a
/// `sc.drop_reason` or span attribute the JS path already emits — so one dashboard answers for both
/// paths rather than two that have to be reconciled.
#[derive(Debug, Clone, uniffi::Record)]
pub struct IngestOutcome {
    /// The fix passed the confidence gate and became this device's position.
    pub accepted: bool,
    /// Why it did not, when it did not. A rejection is not a dropped slot: the heartbeat still
    /// republishes the last accepted position.
    pub rejection: Option<gate::FixRejection>,
    /// Envelopes queued for this wake — one per interval slot that had come due.
    pub enqueued: u32,
    /// Envelopes that actually reached the wire. Less than `enqueued` means the wake ran out of
    /// time or the network went away; the remainder is still queued.
    pub published: u32,
    /// Of those, envelopes at least one friend can open. `published` without `reached` is every
    /// recipient dropped from the wrap set — a lapsed or missing session — and nothing left the
    /// device that anyone can read.
    pub reached: u32,
    /// Depth of the queue afterwards.
    pub pending: u32,
    /// Slots the backfill cap declined to fill ([`gate::MAX_BACKFILL_MS`]).
    pub slots_skipped: u32,
    /// Oldest fixes the queue bound discarded. Non-zero means hours of failed publishing.
    pub overflow_dropped: u32,
    /// Publishing is suspended on critical battery. Distinct from "nothing was due".
    pub suspended: bool,
}

/// What one [`DrainEngine::drain`] put on the wire.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Drained {
    /// Envelopes sealed, sent and committed.
    pub published: u32,
    /// Of those, the ones at least one friend can open.
    pub reached: u32,
}

/// Serializes every run of a [`DrainEngine`] over the same stores. One per node.
///
/// The engine is built per call and holds no state, but the stores behind it are shared, and two
/// runs interleaving over them publish the same slot twice. Both halves race:
///
/// * the gate: `get` → decide → `set` has no await in it, but UniFFI polls a foreign call's future
///   on whichever thread the host's continuation runs, so two calls from Swift can be inside that
///   block at once and both find the slot due;
/// * the drain: `peek` → `publish().await` → `commit`, so a second drain peeks the same head while
///   the first is on the wire and seals it again under a new seq.
///
/// On 2026-10-01 a parked iPhone, kept running by its `CLBackgroundActivitySession`, took its
/// coarse deliveries in clusters, each spawning a heartbeat: it sealed 3-4 envelopes per slot,
/// ~27 an hour against a cadence of 12, every extra one a `trail.push` and a `session.recover`.
pub type DrainLock = tokio::sync::Mutex<()>;

/// How long a run waits for the one before it before going ahead anyway.
///
/// Longer than any bounded run (the push budget is the long pole), so in practice a waiter always
/// gets the lock and then finds its slot already covered. The bound exists for the case where a
/// run never finishes: waiting forever behind it would turn one hung push into a phone that has
/// stopped publishing, and a duplicate envelope is a far cheaper failure than silence.
pub const DRAIN_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(90);

/// What the caller of [`DrainEngine::heartbeat`] knows about whether the phone has settled.
///
/// A heartbeat used to mean "parked" by definition, on the reasoning that it was only reached from
/// a phone that had stopped. It is not. The mounted app's five-minute timer runs whatever the motion
/// state, and so does a wake that has just LEFT a stop; on 2026-10-02 an iPhone whose own state
/// machine read `moving` (no anchor, no fence) published four hours of `parked` on that timer's
/// exact 5:00 grid, so a friend's map showed a confident "parked here" at a stale spot. Only the
/// caller knows which of these it is, so it says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Motion {
    /// The phone has stopped and the caller can prove it: a confirmed dwell, a visit arrival, a tick
    /// of the parked coarse stream, Android's no-delivery ticker. Stamps `FIX_STATE_PARKED`.
    Parked,
    /// The phone has just left a stop and no fix has placed it yet: a fence exit, a coarse
    /// departure, a visit departure. A `parked` stamp still standing is now false, so it becomes
    /// `FIX_STATE_NO_FIX` — "moving, no fix yet" is exactly what is true.
    Moving,
    /// A clock with no motion evidence at all: the JS timer, a refresh while still moving. The
    /// stamp the last real evidence left is kept as it is.
    Unknown,
}

impl Motion {
    /// The foreign-call spelling: `Some(true)` parked, `Some(false)` moving, `None` no claim.
    pub fn from_parked(parked: Option<bool>) -> Self {
        match parked {
            Some(true) => Motion::Parked,
            Some(false) => Motion::Moving,
            None => Motion::Unknown,
        }
    }

    fn stamp(self, previous: Option<u8>) -> Option<u8> {
        match self {
            Motion::Parked => Some(FIX_STATE_PARKED),
            Motion::Moving if previous == Some(FIX_STATE_PARKED) => Some(FIX_STATE_NO_FIX),
            Motion::Moving | Motion::Unknown => previous,
        }
    }
}

/// Ties the gate, the queue and the sink together. Holds no state of its own — everything durable
/// lives behind a port, so an engine is cheap to build per wake and impossible to leave stale.
pub struct DrainEngine<'a, S: PublishSink> {
    pub seq: &'a dyn SeqCounter,
    pub queue: &'a dyn FixQueue,
    pub recipients: &'a dyn Recipients,
    pub gate: &'a dyn GateStateStore,
    pub sink: &'a S,
    pub quality: FixQualityConfig,
    /// Shared by every engine over these stores. See [`DrainLock`].
    pub lock: &'a DrainLock,
}

impl<S: PublishSink> DrainEngine<'_, S> {
    /// Take the run lock, or give up waiting after [`DRAIN_LOCK_WAIT`] and run unserialized.
    async fn serialize(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        match tokio::time::timeout(DRAIN_LOCK_WAIT, self.lock.lock()).await {
            Ok(guard) => Some(guard),
            Err(_) => {
                tracing::warn!(
                    wait_ms = DRAIN_LOCK_WAIT.as_millis() as u64,
                    "drain run still held by an earlier one; proceeding unserialized"
                );
                None
            }
        }
    }

    /// Take one captured location as far towards the wire as this wake allows.
    ///
    /// The order is deliberately the one `location-sharing.ts` runs, because the two must agree: a
    /// phone that gated differently depending on whether the app happened to be open would publish
    /// an irregular series, and the cadence is the one property of a sealed envelope the stash can
    /// read.
    pub async fn ingest(
        &self,
        fix: LocationFix,
        battery: BatteryState,
        interval_ms: u64,
        now_ms: u64,
    ) -> Result<IngestOutcome, PublishError> {
        let _run = self.serialize().await;
        let outcome = self
            .ingest_untraced(fix, battery, interval_ms, now_ms)
            .await?;
        trace_outcome("engine.ingest", &outcome);
        Ok(outcome)
    }

    async fn ingest_untraced(
        &self,
        fix: LocationFix,
        battery: BatteryState,
        interval_ms: u64,
        now_ms: u64,
    ) -> Result<IngestOutcome, PublishError> {
        let mut state = self.gate.get();

        // Quality first — and note it does NOT stop the clock. A refused fix falls through to the
        // slot logic below, which republishes the last accepted position, so a stretch of bad GPS
        // is indistinguishable on the wire from a stretch of sitting still.
        let last_known = state.last_known_fix.as_ref().map(LocationFix::from);
        let rejection = gate::assess_fix(
            &fix,
            last_known.as_ref(),
            state.last_accepted_at,
            now_ms,
            &self.quality,
        );

        // Record WHY the position about to go out is the position it is. A rejected fix still
        // fills its slot with the last accepted one, so from the wire a stretch of bad GPS and a
        // stretch of sitting still are byte-identical — which is correct for privacy and useless
        // for the UI. This is the one bit that separates them, and only the sender has it.
        //
        // A standing `parked` survives a fix that proves nothing about motion: one accepted at the
        // stop (see `gate::still_parked` for the incident), or one the gate refused. Only a fix
        // that has left the stop, or a caller's `Motion::Moving`, ends it.
        let parked = state.last_state == Some(FIX_STATE_PARKED);
        let anchor = state
            .parked_at
            .take()
            .or_else(|| state.last_known_fix.clone());
        let (stamp, parked_at) = match (&rejection, anchor) {
            (None, Some(at)) if parked && gate::still_parked(&fix, &LocationFix::from(&at)) => {
                (FIX_STATE_PARKED, Some(at))
            }
            (None, _) => (FIX_STATE_LIVE, None),
            (Some(_), at) if parked => (FIX_STATE_PARKED, at),
            (Some(_), _) => (FIX_STATE_NO_FIX, None),
        };
        state.last_state = Some(stamp);
        state.parked_at = parked_at;
        if rejection.is_none() {
            state.last_known_fix = Some(StoredFix::from(&fix));
            state.last_accepted_at = Some(now_ms);
        }

        // A hard stop, indistinguishable from the phone dying. Deliberately not a slower cadence:
        // the interval is observable to the stash, so backing it off would put the charge level on
        // the wire. The gate state is still saved — the accepted fix is real either way.
        if gate::critically_low(&battery) {
            self.gate.set(state);
            return Ok(self.outcome(rejection, 0, Drained::default(), 0, 0, true));
        }

        let Some(known) = state.last_known_fix.as_ref().map(LocationFix::from) else {
            // Refused before we ever had a position. Nothing to republish, so no slot to fill; the
            // next acceptable fix anchors the grid.
            self.gate.set(state);
            return Ok(self.outcome(rejection, 0, Drained::default(), 0, 0, false));
        };

        gate::regrid(&mut state, interval_ms);
        let plan = gate::due_slots(now_ms, interval_ms, state.last_published_slot);
        let mut overflow_dropped = 0u32;
        for _ in 0..plan.due {
            overflow_dropped += self.queue.enqueue(known.clone())?.overflow_dropped;
        }
        if plan.due > 0 {
            state.last_published_slot = Some(plan.current_slot);
        }
        // Saved before the drain, not after: the drain reaches the network and can be killed
        // half-way, and re-running these slots on the next wake would double-publish them.
        self.gate.set(state);

        let drained = self.drain_held(now_ms).await?;
        Ok(self.outcome(
            rejection,
            plan.due,
            drained,
            plan.skipped,
            overflow_dropped,
            false,
        ))
    }

    /// Publish the slots that have come due without a new fix, reusing the last known position.
    ///
    /// The counterpart to [`ingest`](Self::ingest), and not an optimisation: the cadence is the one
    /// property of a sealed envelope the stash can read, so it has to be uniform whether or not the
    /// phone is moving. `ingest` only runs when the OS delivers a location, which on a stationary
    /// phone can be never — and a series that stops when its owner sits still is a series that
    /// leaks when its owner sits still.
    ///
    /// No quality gate here, deliberately: there is no new fix to judge. The position being
    /// republished already passed the gate when it arrived, and its ORIGINAL timestamp rides along
    /// with it, so a heartbeat is honest about how old the position is rather than pretending it is
    /// current.
    ///
    /// Returns `enqueued: 0` when the current slot is already covered, which is the common case.
    ///
    /// `motion` decides the `fix_state` the envelopes carry — see [`Motion`] for why the caller,
    /// and not this function, is the one that knows.
    pub async fn heartbeat(
        &self,
        motion: Motion,
        battery: BatteryState,
        interval_ms: u64,
        now_ms: u64,
    ) -> Result<IngestOutcome, PublishError> {
        let _run = self.serialize().await;
        let outcome = self
            .heartbeat_untraced(motion, battery, interval_ms, now_ms)
            .await?;
        trace_outcome("engine.heartbeat", &outcome);
        Ok(outcome)
    }

    async fn heartbeat_untraced(
        &self,
        motion: Motion,
        battery: BatteryState,
        interval_ms: u64,
        now_ms: u64,
    ) -> Result<IngestOutcome, PublishError> {
        let mut state = self.gate.get();

        if gate::critically_low(&battery) {
            return Ok(self.outcome(None, 0, Drained::default(), 0, 0, true));
        }
        let Some(known) = state.last_known_fix.as_ref().map(LocationFix::from) else {
            // Nothing has ever passed the gate, so there is no position to repeat. The first
            // acceptable fix anchors the grid.
            return Ok(self.outcome(None, 0, Drained::default(), 0, 0, false));
        };

        // The declaration this whole field exists for, when the caller can make it. A parked
        // phone's envelopes say so, and whichever of them turns out to be the last before a
        // silence is then self-describing — which matters because the silence is not bounded:
        // parked publishing rides on OS wakes, and p90 between contacts on iOS is 92 minutes with
        // a 17-hour tail. A caller that cannot prove a stop leaves the last real evidence standing.
        state.last_state = motion.stamp(state.last_state);
        // The stop is anchored where it was first declared; later parked ticks do not move it.
        state.parked_at = match state.last_state {
            Some(FIX_STATE_PARKED) => state
                .parked_at
                .take()
                .or_else(|| state.last_known_fix.clone()),
            _ => None,
        };

        gate::regrid(&mut state, interval_ms);
        let plan = gate::due_slots(now_ms, interval_ms, state.last_published_slot);
        let mut overflow_dropped = 0u32;
        for _ in 0..plan.due {
            overflow_dropped += self.queue.enqueue(known.clone())?.overflow_dropped;
        }
        if plan.due > 0 {
            state.last_published_slot = Some(plan.current_slot);
        }
        // Saved unconditionally, unlike the slot index it carries. `plan.due == 0` — the current
        // slot is already covered — is the COMMON case on a parked phone, and the declaration is
        // the whole point of a parked tick: a wake that had no slot to fill has still
        // learned that the device has settled. Gating the write on `due` would leave the stamp
        // unsaved through exactly the ticks that prove it, and any envelope left over from an
        // earlier failed drain would then go out stamped `live` from a phone that is parked.
        self.gate.set(state);

        let drained = self.drain_held(now_ms).await?;
        Ok(self.outcome(
            None,
            plan.due,
            drained,
            plan.skipped,
            overflow_dropped,
            false,
        ))
    }

    /// Seal the last known position once, because the recipient set has just grown.
    ///
    /// A sealed envelope is readable only by the recipients it was sealed FOR, so a friend who
    /// pairs at 14:00 cannot open anything published at 13:59. Their first sight of you is
    /// therefore your next scheduled publish — and on a parked iPhone that rides on `BGProcessing`
    /// wakes measured at p50 5 min, p90 92 min, with a 17-hour tail. A pairing that ends in a
    /// blank dot for an hour and a half reads as a pairing that did not work.
    ///
    /// Three deliberate differences from [`heartbeat`](Self::heartbeat), which otherwise does the
    /// same job:
    ///
    /// * **`last_published_slot` is not advanced.** The cadence is the one property of a sealed
    ///   envelope the stash can read, and it has to stay uniform. This envelope is extra, not
    ///   early: it fills no slot and must not persuade the next heartbeat that one is covered.
    /// * **`last_state` is not written.** Pairing says nothing about whether the phone has
    ///   settled. `drain` stamps whatever is currently true, which is the honest answer.
    /// * **No battery suspension.** `critically_low` exists to stop periodic work; this is one
    ///   envelope, at a moment the user chose, and a dying phone is when someone most wants to
    ///   know where you are.
    ///
    /// No quality gate, for the same reason as `heartbeat`: there is no new fix to judge, and the
    /// position being republished already passed the gate when it arrived. Its ORIGINAL timestamp
    /// rides along, so a new friend sees an honest "here, as of twenty minutes ago" rather than a
    /// fresh-looking lie.
    ///
    /// `enqueued: 0` means this device has never had a position to share — a fresh install that
    /// has not captured yet. There is nothing to introduce and the first capture will do it.
    pub async fn publish_introduction(&self, now_ms: u64) -> Result<IngestOutcome, PublishError> {
        let _run = self.serialize().await;
        let state = self.gate.get();
        let Some(known) = state.last_known_fix.as_ref().map(LocationFix::from) else {
            return Ok(self.outcome(None, 0, Drained::default(), 0, 0, false));
        };
        let overflow_dropped = self.queue.enqueue(known)?.overflow_dropped;
        let drained = self.drain_held(now_ms).await?;
        Ok(self.outcome(None, 1, drained, 0, overflow_dropped, false))
    }

    /// Publish queued fixes in capture order, stopping at the first failure.
    ///
    /// Order matters because `seq` is assigned here, at publish time: draining out of order would
    /// file a later capture under an earlier sequence number and a receiver rebuilding a trail
    /// would watch the device walk backwards. Stopping rather than skipping means a transient
    /// failure retries the same fix instead of stranding it behind newer ones.
    ///
    /// Returns how many reached the wire. A send failure is **not** an error here — a wake that
    /// published three of five envelopes did useful work, and the remainder is still queued.
    pub async fn drain(&self, now_ms: u64) -> Result<Drained, PublishError> {
        let _run = self.serialize().await;
        self.drain_held(now_ms).await
    }

    /// [`drain`](Self::drain) for a caller that already holds the run lock.
    async fn drain_held(&self, now_ms: u64) -> Result<Drained, PublishError> {
        let recipients = self.recipients.get();
        let watchers = self.recipients.watchers();
        let mut published = 0u32;
        let mut reached = 0u32;

        // Read once for the whole drain: every envelope this wake seals is minted under the same
        // circumstances, whether it fills the current slot or backfills five that came due while
        // the process was suspended.
        let state_stamp = self.gate.get().last_state;

        while let Some(mut fix) = self.queue.peek() {
            // A counter that cannot persist DOES stop us: handing out a seq we failed to record
            // is the one failure that corrupts rather than delays.
            let seq = self.seq.next()?;
            let ts = fix.ts;

            // Stamp the envelope, here and nowhere earlier. `fix.ts` says when the POSITION was
            // measured and deliberately does not move on a heartbeat; this says when the envelope
            // was SEALED, which is the only moment we can prove the sending process was alive.
            // Two clocks, and the gap between them is exactly "parked" — a fresh envelope carrying
            // an hours-old position. One clock is what made a parked friend and a dead one render
            // identically.
            fix.state = state_stamp;
            fix.published_delta_s = Some(
                now_ms
                    .saturating_sub(ts)
                    .saturating_div(1000)
                    .min(u32::MAX as u64) as u32,
            );
            let Ok(sealed) = self.sink.publish(seq, fix, recipients.clone()).await else {
                break;
            };
            // Committed whether or not anyone could open it. A fix sealed for nobody is not worth
            // retrying — the next slot will be sealed under the same sessions — and retaining it
            // would back the queue up behind a condition only recovery can clear.
            self.queue.commit()?;
            published += 1;
            let mut delivered = sealed.reached_anyone();

            // The watcher lane, on the same cadence and best-effort by design. The fix has already
            // gone out and been committed; a watch-only edge carries no position, so a failure here
            // must not retain (and re-publish) a fix that already left. Its own seq, so the two
            // lanes cannot supersede each other in one last-write-wins slot.
            if !watchers.is_empty() {
                let Ok(null_seq) = self.seq.next() else {
                    // The counter is gone; the next iteration's fix lane will stop on it too.
                    if delivered {
                        reached += 1;
                    }
                    break;
                };
                if let Ok(sealed) = self.sink.publish_null(null_seq, ts, watchers.clone()).await {
                    // A null envelope a watcher can open is a real delivery: it carries our
                    // ratchet contribution, which is what keeps their edge from lapsing.
                    delivered |= sealed.reached_anyone();
                }
            }
            if delivered {
                reached += 1;
            }
        }

        // After the fixes, so a slow recovery pass never delays them — and so a session it
        // restores is used from the next drain rather than half-way through this one. Every
        // friend, sharing and watch-only alike: a watcher edge is a session like any other.
        let mut peers = recipients.clone();
        peers.extend(watchers.iter().cloned());
        let recovery = if peers.is_empty() {
            RecoveryOutcome::default()
        } else {
            self.sink.recover(peers).await
        };

        // One push per drain, not one per envelope: reconciliation moves everything the namespace
        // holds, so pushing per fix would pay a dial per fix to send a superset of the same thing.
        // Guarded on `published` because a drain that sent nothing has nothing new to mirror — and
        // on a stationary phone that is most of them.
        //
        // The error is deliberately swallowed. The fixes are committed and in the replica; a failed
        // push means the next one carries them, whereas propagating would make a drain that did
        // reach the wire look like a drain that did not, and retain fixes that already went out.
        //
        // Guarded on `reached`, not `published`: an envelope sealed for nobody is never written, so
        // a drain whose every recipient was dropped has put nothing in the replica to push — and
        // stamping `last_published_at` for it is how a phone reached nobody for a week while its
        // health record said it had published thirty seconds ago. `recovery.in_progress` pushes
        // anyway, because the push is also the pull that brings the peer's half of a resync in.
        if reached > 0 || recovery.in_progress {
            // Stamp before the push, not after: these two answer different questions, and the gap
            // between them is the diagnosis. A phone that publishes and cannot push is a phone
            // whose fixes are sitting in its own replica — which read as perfect health for a whole
            // day on 2026-08-31, because nothing recorded either moment natively.
            if reached > 0 {
                self.stamp(|state| state.last_published_at = Some(now_ms));
            }
            // Only a flush that actually reached a peer counts. `NoTargets` is a successful call
            // that pushed nothing, and stamping it would report a fresh push on a phone that has
            // never had anywhere to send.
            if matches!(self.sink.flush().await, Ok(FlushOutcome::Pushed)) {
                self.stamp(|state| state.last_pushed_at = Some(now_ms));
            }
        }
        Ok(Drained { published, reached })
    }

    /// Read-modify-write one field of the gate state. The store is last-write-wins and every field
    /// is a cache, so a lost stamp costs a stale age on one health record and nothing else.
    fn stamp(&self, apply: impl FnOnce(&mut GateState)) {
        let mut state = self.gate.get();
        apply(&mut state);
        self.gate.set(state);
    }

    fn outcome(
        &self,
        rejection: Option<gate::FixRejection>,
        enqueued: u32,
        drained: Drained,
        slots_skipped: u32,
        overflow_dropped: u32,
        suspended: bool,
    ) -> IngestOutcome {
        IngestOutcome {
            accepted: rejection.is_none(),
            rejection,
            enqueued,
            published: drained.published,
            reached: drained.reached,
            pending: self.queue.pending(),
            slots_skipped,
            overflow_dropped,
            suspended,
        }
    }
}

/// Why an ingest or heartbeat put nothing — or less than it owed — on the wire, in the
/// `sc.drop_reason` spellings the JS engine used, so the same queries answer for both paths.
///
/// `None` for the ordinary outcomes: a slot published, or a fix absorbed into a slot that was
/// already covered (the common case by far, and not a drop).
pub fn drop_reason(outcome: &IngestOutcome) -> Option<&'static str> {
    if let Some(rejection) = outcome.rejection {
        return Some(rejection.as_str());
    }
    if outcome.suspended {
        return Some("sampling-suspended");
    }
    if outcome.overflow_dropped > 0 {
        return Some("outbox-overflow");
    }
    if outcome.published > 0 && outcome.reached == 0 {
        return Some("no-recipient-reached");
    }
    if outcome.enqueued > outcome.published {
        return Some("publish-incomplete");
    }
    if outcome.slots_skipped > 0 {
        return Some("backfill-capped");
    }
    None
}

/// One span per ingest or heartbeat that did something worth seeing.
///
/// The JS engine emitted `engine.ingest` for every fix, with the gate's verdict, the slot outcome
/// and the queue depth on it. Publishing moved into this engine and those spans went with the JS
/// that emitted them: a phone whose GPS only produced fixes the gate refused, or whose queue was
/// overflowing, or whose envelopes reached nobody, said so only in a device log. Same names, same
/// `sc.drop_reason` values, now from wherever the pipeline runs — JS-free wakes included.
///
/// Absorbed fixes are not traced: they are most deliveries, and they are not an outcome.
fn trace_outcome(name: &'static str, outcome: &IngestOutcome) {
    let reason = drop_reason(outcome);
    if reason.is_none() && outcome.enqueued == 0 && outcome.published == 0 {
        return;
    }
    let span = if name == "engine.ingest" {
        tracing::info_span!(
            "engine.ingest",
            lane = "native",
            accepted = outcome.accepted,
            enqueued = outcome.enqueued,
            published = outcome.published,
            reached = outcome.reached,
            pending = outcome.pending,
            slots_skipped = outcome.slots_skipped,
            overflow_dropped = outcome.overflow_dropped,
            suspended = outcome.suspended,
            sc.drop_reason = reason.unwrap_or(""),
        )
    } else {
        tracing::info_span!(
            "engine.heartbeat",
            lane = "native",
            enqueued = outcome.enqueued,
            published = outcome.published,
            reached = outcome.reached,
            pending = outcome.pending,
            slots_skipped = outcome.slots_skipped,
            overflow_dropped = outcome.overflow_dropped,
            suspended = outcome.suspended,
            sc.drop_reason = reason.unwrap_or(""),
        )
    };
    drop(span.entered());
}
