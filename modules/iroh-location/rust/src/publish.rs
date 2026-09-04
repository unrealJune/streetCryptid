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
use crate::{LocationFix, MotionState};

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
    ) -> impl std::future::Future<Output = Result<(), PublishError>> + Send;

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
    ) -> impl std::future::Future<Output = Result<(), PublishError>> + Send;

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
    /// Depth of the queue afterwards.
    pub pending: u32,
    /// Slots the backfill cap declined to fill ([`gate::MAX_BACKFILL_MS`]).
    pub slots_skipped: u32,
    /// Oldest fixes the queue bound discarded. Non-zero means hours of failed publishing.
    pub overflow_dropped: u32,
    /// Publishing is suspended on critical battery. Distinct from "nothing was due".
    pub suspended: bool,
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
}

/// Record the motion state the platform's state machine has moved to.
///
/// A free function rather than a [`DrainEngine`] method because it touches exactly one port: it
/// needs no counter, no outbox, no recipients and nowhere to send, and making callers assemble
/// those to write one field would be a lie about what it does.
///
/// Deliberately does NOT publish. A transition is exactly the kind of event that must not put an
/// envelope on the wire out of cadence: the interval is the one property of a sealed envelope the
/// stash can read, so an extra publish the moment someone parks would announce "she just arrived
/// somewhere" to an observer who cannot read the payload. The flag rides the next due slot instead,
/// which the parked coarse stream produces within one interval.
///
/// Idempotent, because both `enterMoving` and `enterStopped` can run on a path that has already set
/// the state, and a write here costs a durable file rewrite. Idempotence is also what keeps
/// `since_ms` meaningful: re-asserting a state the device is already in — which `start()` does on
/// every relaunch — must NOT restamp the moment it began, or a phone that dies hourly would report
/// itself freshly parked all night.
pub fn set_motion(gate: &dyn GateStateStore, motion: Option<MotionState>, since_ms: Option<u64>) {
    let state = gate.get();
    if state.motion == motion {
        return;
    }
    gate.set(GateState {
        motion,
        motion_since_ms: since_ms,
        ..state
    });
}

impl<S: PublishSink> DrainEngine<'_, S> {
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
        let mut state = self.gate.get();

        // Quality first — and note it does NOT stop the clock. A refused fix falls through to the
        // slot logic below, which republishes the last accepted position, so a stretch of bad GPS
        // is indistinguishable on the wire from a stretch of sitting still.
        let rejection = gate::assess_fix(
            &fix,
            state.last_known_fix.as_ref(),
            state.last_accepted_at,
            now_ms,
            &self.quality,
        );
        if rejection.is_none() {
            state.last_known_fix = Some(fix.clone());
            state.last_accepted_at = Some(now_ms);
        }

        // A hard stop, indistinguishable from the phone dying. Deliberately not a slower cadence:
        // the interval is observable to the stash, so backing it off would put the charge level on
        // the wire. The gate state is still saved — the accepted fix is real either way.
        if gate::critically_low(&battery) {
            self.gate.set(state);
            return Ok(self.outcome(rejection, 0, 0, 0, 0, true));
        }

        let Some(mut known) = state.last_known_fix.clone() else {
            // Refused before we ever had a position. Nothing to republish, so no slot to fill; the
            // next acceptable fix anchors the grid.
            self.gate.set(state);
            return Ok(self.outcome(rejection, 0, 0, 0, 0, false));
        };
        // Stamped here, at enqueue, rather than carried in from capture: the state is the device's
        // and can change after a fix is measured. See `crate::MotionState`.
        known.motion = state.motion;
        known.motion_since_ms = state.motion_since_ms;

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

        let published = self.drain(now_ms).await?;
        Ok(self.outcome(
            rejection,
            plan.due,
            published,
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
    pub async fn heartbeat(
        &self,
        battery: BatteryState,
        interval_ms: u64,
        now_ms: u64,
    ) -> Result<IngestOutcome, PublishError> {
        let mut state = self.gate.get();

        if gate::critically_low(&battery) {
            return Ok(self.outcome(None, 0, 0, 0, 0, true));
        }
        let Some(mut known) = state.last_known_fix.clone() else {
            // Nothing has ever passed the gate, so there is no position to repeat. The first
            // acceptable fix anchors the grid.
            return Ok(self.outcome(None, 0, 0, 0, 0, false));
        };
        // The reason the state lives on `GateState` and not on the fix: this republish is the one
        // that carries `Parked`, and the position it repeats was captured while `Moving`.
        known.motion = state.motion;
        known.motion_since_ms = state.motion_since_ms;

        let plan = gate::due_slots(now_ms, interval_ms, state.last_published_slot);
        let mut overflow_dropped = 0u32;
        for _ in 0..plan.due {
            overflow_dropped += self.queue.enqueue(known.clone())?.overflow_dropped;
        }
        if plan.due > 0 {
            state.last_published_slot = Some(plan.current_slot);
            self.gate.set(state);
        }

        let published = self.drain(now_ms).await?;
        Ok(self.outcome(
            None,
            plan.due,
            published,
            plan.skipped,
            overflow_dropped,
            false,
        ))
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
    pub async fn drain(&self, now_ms: u64) -> Result<u32, PublishError> {
        let recipients = self.recipients.get();
        let watchers = self.recipients.watchers();
        let mut published = 0u32;

        while let Some(fix) = self.queue.peek() {
            // A counter that cannot persist DOES stop us: handing out a seq we failed to record
            // is the one failure that corrupts rather than delays.
            let seq = self.seq.next()?;
            let ts = fix.ts;
            if self
                .sink
                .publish(seq, fix, recipients.clone())
                .await
                .is_err()
            {
                break;
            }
            self.queue.commit()?;
            published += 1;

            // The watcher lane, on the same cadence and best-effort by design. The fix has already
            // gone out and been committed; a watch-only edge carries no position, so a failure here
            // must not retain (and re-publish) a fix that already left. Its own seq, so the two
            // lanes cannot supersede each other in one last-write-wins slot.
            if !watchers.is_empty() {
                let Ok(null_seq) = self.seq.next() else {
                    // The counter is gone; the next iteration's fix lane will stop on it too.
                    break;
                };
                let _ = self.sink.publish_null(null_seq, ts, watchers.clone()).await;
            }
        }

        // One push per drain, not one per envelope: reconciliation moves everything the namespace
        // holds, so pushing per fix would pay a dial per fix to send a superset of the same thing.
        // Guarded on `published` because a drain that sent nothing has nothing new to mirror — and
        // on a stationary phone that is most of them.
        //
        // The error is deliberately swallowed. The fixes are committed and in the replica; a failed
        // push means the next one carries them, whereas propagating would make a drain that did
        // reach the wire look like a drain that did not, and retain fixes that already went out.
        if published > 0 {
            // Stamp before the push, not after: these two answer different questions, and the gap
            // between them is the diagnosis. A phone that publishes and cannot push is a phone
            // whose fixes are sitting in its own replica — which read as perfect health for a whole
            // day on 2026-08-31, because nothing recorded either moment natively.
            self.stamp(|state| state.last_published_at = Some(now_ms));
            // Only a flush that actually reached a peer counts. `NoTargets` is a successful call
            // that pushed nothing, and stamping it would report a fresh push on a phone that has
            // never had anywhere to send.
            if matches!(self.sink.flush().await, Ok(FlushOutcome::Pushed)) {
                self.stamp(|state| state.last_pushed_at = Some(now_ms));
            }
        }
        Ok(published)
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
        published: u32,
        slots_skipped: u32,
        overflow_dropped: u32,
        suspended: bool,
    ) -> IngestOutcome {
        IngestOutcome {
            accepted: rejection.is_none(),
            rejection,
            enqueued,
            published,
            pending: self.queue.pending(),
            slots_skipped,
            overflow_dropped,
            suspended,
        }
    }
}
