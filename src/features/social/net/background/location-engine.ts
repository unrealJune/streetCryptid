import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import { distanceBetweenFixes } from '../../core/presence';
import type { LocationFix } from '../../core/types';
import {
  assessFix,
  DEFAULT_FIX_QUALITY_CONFIG,
  type FixQualityConfig,
  type FixRejection,
} from './fix-quality';
import type { FixOutbox } from './fix-outbox';
import type { SamplingPolicy } from './sampling-policy';
import type { TrailStore } from './trail-store';
import type { BatteryState, SamplingDecision } from './types';

/**
 * The testable heart of the background service. It owns the loop:
 *
 *   fix (foreground watch OR background task)
 *     → policy.decide  (accuracy / suspend)
 *     → assessFix      (confidence gate)
 *     → if accepted: remember as lastKnownFix
 *     → for each whole interval slot that has elapsed: outbox.enqueue
 *     → if publisher.isReady: flush → for each: publisher.publishFix(fix) → trail.appendOwn(fix, seq)
 *
 * **Slot quantisation is the privacy mechanism.** Fixes arrive at whatever rate the OS feels like —
 * every few seconds from the foreground watch, in batches from the background task, not at all when
 * a phone is asleep. Publishing them as they arrive would put that rhythm on the wire, and the
 * rhythm is a readout of what the user is doing (walking/driving/still/app-open). So the engine
 * publishes on wall-clock boundaries of `policy.config.intervalMs` instead: exactly one envelope per
 * slot, whatever happened during it. Extra fixes in a slot are absorbed into `lastKnownFix`; a slot
 * with no fix at all re-publishes `lastKnownFix` verbatim as a heartbeat, so silence never means
 * "stationary". Payload timestamps are untouched, so a stale heartbeat still reads as stale to
 * friends — only the *cadence* is synthetic, and only the cadence is what an observer can see.
 *
 * Trail append happens at *publish* time (not capture) so our own trail uses the same `seq` that
 * goes on the wire — keeping it consistent with what friends receive/backfill. Offline captures
 * wait in the outbox and get their seq + trail entry when they finally drain. See ARCHITECTURE §9.
 *
 * The engine takes only the minimal slice of {@link FixPublisher} it needs, so it can be unit-tested
 * with a fake publisher + ManualLocationProvider + in-memory outbox/trail + a fake clock — no native.
 *
 * The confidence gate (`fix-quality.ts`) sits *before* `lastKnownFix`, never before the publish: a
 * junk fix is refused the right to become our position, but the slot it landed in still goes out
 * carrying the last good one. Rejection must not read as silence — see that module's header.
 */

/**
 * How far back {@link LocationEngine.heartbeat} will fill in missed slots. Gaps shorter than this
 * are the ones worth hiding — they are the difference between "sitting still" and "moving". A gap
 * longer than this means the process was frozen or killed, which is going to be visible from the
 * arrival burst no matter what we publish, so stuffing hours of duplicate points buys no privacy
 * and only floods the trail.
 */
export const MAX_BACKFILL_MS = 30 * 60_000;

/** The slice of LocationSharingService the engine depends on. */
export interface FixPublisher {
  /**
   * Seal + broadcast (gossip) + durable-write (docs) the fix; resolves with the seq assigned.
   * Must **throw** if it cannot publish (node not ready) rather than resolving a placeholder, so
   * `outbox.drain` stops and retains the fix instead of dropping it.
   */
  publishFix(fix: LocationFix, parent?: SpanContext): Promise<number>;
  /** True once the node is bound and can publish. */
  isReady(): boolean;
  /**
   * Mirror what we just published to the durable stash. `publishFix` broadcasts live and writes the
   * LOCAL docs replica only, so without this the batch reaches nobody who wasn't already online.
   * Optional (and a no-op when the stash is off) so tests and web can leave it out.
   */
  pushTrail?(parent?: SpanContext): Promise<void>;
}

export type EngineStatus = 'idle' | 'running' | 'paused' | 'error';

export interface EngineState {
  status: EngineStatus;
  /** ms epoch of the last fix that passed the confidence gate, or null. */
  lastFixAt: number | null;
  /**
   * The last fix that passed the confidence gate — our current position as far as the app is
   * concerned. The map's own-position dot should follow this rather than raw provider output, or a
   * rejected fix still visibly throws the user's own marker across town.
   */
  lastAcceptedFix: LocationFix | null;
  /** Why the most recent fix was refused, or null if it was accepted. Diagnostics only. */
  lastRejection: FixRejection | null;
  /** Last sampling decision applied (so the UI/provider can reflect cadence). */
  decision: SamplingDecision | null;
  /** Fixes waiting in the outbox. */
  pending: number;
  error: string | null;
}

export interface LocationEngineOptions {
  publisher: FixPublisher;
  outbox: FixOutbox;
  trail: TrailStore;
  policy: SamplingPolicy;
  /** Reads current battery; the policy backs off when low. Default: full battery, not low-power. */
  battery?: () => Promise<BatteryState>;
  /** Confidence-gate thresholds, merged over {@link DEFAULT_FIX_QUALITY_CONFIG}. */
  quality?: Partial<FixQualityConfig>;
  /** Injectable clock. Default `Date.now`. */
  now?: () => number;
}

export interface LocationEngine {
  /** Begin accepting fixes and publishing. Idempotent. */
  start(): Promise<void>;
  /** Stop accepting fixes; queued fixes remain in the outbox for the next start/flush. */
  stop(): Promise<void>;
  /**
   * Feed a fix from any source. Records it as the latest known position, publishes any interval
   * slots that have come due (see the module header), and flushes if the publisher is ready.
   * Returns the {@link SamplingDecision} used so the caller can re-program the OS location cadence.
   *
   * Safe to call at any rate: fixes arriving faster than the interval are absorbed, not published.
   */
  ingest(fix: LocationFix, parent?: SpanContext): Promise<SamplingDecision>;
  /**
   * Publish any due slots *without* a new fix, re-using the last known position. This is what keeps
   * the cadence constant while the user is stationary — without it, standing still would stop the
   * envelopes and silence would be as informative as movement. Call it on a timer at the sampling
   * interval, and on every OS background wake.
   *
   * No-op before the first fix, when suspended, or when the current slot is already published.
   * Returns the number of envelopes enqueued.
   */
  heartbeat(parent?: SpanContext): Promise<number>;
  /**
   * Re-grid to a new sampling interval (the user changed it in settings). Re-anchors the slot
   * boundary to now so the change neither double-publishes the current slot nor skips one, and
   * returns the fresh decision so the caller can re-program the OS.
   */
  setIntervalMs(intervalMs: number): Promise<SamplingDecision>;
  /**
   * Recompute the sampling decision from a *fresh* battery read, without ingesting a new fix. Call
   * this on a power event (Low Power Mode toggled, charger un/plugged) so the accuracy tier follows
   * immediately instead of waiting for the next GPS fix. Emits state so a cadence controller can
   * re-program the OS. No-op enqueue: it never publishes, and it never moves the cadence.
   */
  reevaluate(): Promise<SamplingDecision>;
  /**
   * Turn real-time live tracking on/off (a friend is actively watching). While on, the policy uses
   * its real-time `live*` cadence and fixes publish per-arrival rather than per-slot. Recomputes +
   * emits immediately so the cadence controller re-programs the OS; returns the new decision.
   */
  setLiveMode(on: boolean): Promise<SamplingDecision>;
  /** Drain the outbox through the publisher (call on resume / node-ready / connectivity regained). */
  flush(parent?: SpanContext): Promise<number>;
  onState(cb: (s: EngineState) => void): () => void;
  getState(): EngineState;
}

const DEFAULT_BATTERY: BatteryState = { level: 1, charging: false, lowPower: false };

export function createLocationEngine(opts: LocationEngineOptions): LocationEngine {
  const { publisher, outbox, trail, policy } = opts;
  const battery = opts.battery ?? (async (): Promise<BatteryState> => ({ ...DEFAULT_BATTERY }));
  const quality: FixQualityConfig = { ...DEFAULT_FIX_QUALITY_CONFIG, ...opts.quality };
  const now = opts.now ?? Date.now;

  let state: EngineState = {
    status: 'idle',
    lastFixAt: null,
    lastAcceptedFix: null,
    lastRejection: null,
    decision: null,
    pending: 0,
    error: null,
  };

  /**
   * Latest position that passed the confidence gate, republished as a heartbeat for slots that
   * produce no fix — and for slots whose only fixes were rejected.
   */
  let lastKnownFix: LocationFix | null = null;
  let lastFixAt: number | null = null;
  /** When we last accepted a fix; seeded at `start()` so the starvation escape hatch can arm. */
  let lastAcceptedAt: number | null = null;
  /** Index of the last wall-clock slot we put an envelope on the wire for; null before the first. */
  let lastPublishedSlot: number | null = null;
  let live = false;
  /** The last fix live mode actually put on the wire, and when — the live gate's whole state. */
  let lastLivePublishFix: LocationFix | null = null;
  let lastLivePublishAt: number | null = null;
  const listeners = new Set<(s: EngineState) => void>();
  /**
   * Ambient fixes absorbed by the fast path since the last span. Reported on the next real
   * `engine.ingest` so the absorbed majority stays visible as a count, rather than as one span each
   * (`sc.drop_reason: slot-already-published` used to be ~99% of all spans on iOS).
   */
  let absorbed = 0;

  /**
   * `battery()` is a native bridge round-trip. Ambient `ingest` runs at the OS fix rate — ~1 Hz on a
   * moving iPhone, see the fast path in `ingest` — so reading it per fix was one native call per
   * second for a value that moves over minutes. Power *events* bypass this via `reevaluate()`.
   */
  const BATTERY_TTL_MS = 30_000;
  let batteryCache: { at: number; value: BatteryState } | null = null;

  async function batteryCached(): Promise<BatteryState> {
    const at = now();
    if (batteryCache !== null && at - batteryCache.at < BATTERY_TTL_MS) return batteryCache.value;
    const value = await battery();
    batteryCache = { at, value };
    return value;
  }

  const slotOf = (ts: number, intervalMs: number): number => Math.floor(ts / intervalMs);

  /**
   * Whether a live-mode fix earns a publish, and why not when it doesn't.
   *
   * Live mode bypasses the slot grid by design, which left it with no rate limit at all on iOS —
   * `timeInterval` is Android-only, so `liveDistanceM` was the only gate and a moving car tripped it
   * ~once a second. This is the replacement, and it lives here rather than in the OS request
   * precisely because only this side is honoured on both platforms.
   */
  function liveGate(
    fix: LocationFix,
    at: number
  ): 'publish' | 'live-rate-limited' | 'live-stationary' {
    if (lastLivePublishFix === null || lastLivePublishAt === null) return 'publish';
    const sinceMs = at - lastLivePublishAt;
    // The floor is absolute: nothing, however far it moved, publishes twice inside one window.
    if (sinceMs < policy.config.liveMinPublishMs) return 'live-rate-limited';
    if (distanceBetweenFixes(lastLivePublishFix, fix) >= policy.config.liveMinDistanceM) {
      return 'publish';
    }
    // Barely moved — but a live watcher must still see a heartbeat, or a parked friend looks dead.
    return sinceMs >= policy.config.liveMaxQuietMs ? 'publish' : 'live-stationary';
  }

  /** Record a live publish so the gate can measure the next one against it. */
  function markLivePublish(fix: LocationFix, at: number): void {
    lastLivePublishFix = fix;
    lastLivePublishAt = at;
  }

  function emit(): void {
    const snapshot = getState();
    for (const cb of listeners) cb(snapshot);
  }

  function setState(patch: Partial<EngineState>): void {
    state = { ...state, ...patch };
    emit();
  }

  /**
   * Update state without notifying listeners. For the ambient fast path only: `getState()` stays
   * accurate for anyone who reads it, but an absorbed fix — which by definition changed nothing that
   * goes on the wire — no longer drives a listener fan-out (and React re-render) at the OS fix rate.
   */
  function setStateQuiet(patch: Partial<EngineState>): void {
    state = { ...state, ...patch };
  }

  function getState(): EngineState {
    return { ...state };
  }

  // Serialize flushes: ingest() and the lifecycle onForeground handler can both call flush().
  // Two concurrent drains would each load their own copy of the outbox and double-publish the
  // same fix (with different seqs), so coalesce overlapping calls onto one in-flight promise.
  let flushing: Promise<number> | null = null;

  function flush(parent?: SpanContext): Promise<number> {
    if (flushing) return flushing;
    flushing = doFlush(parent).finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function doFlush(parent?: SpanContext): Promise<number> {
    if (!publisher.isReady()) return 0;
    try {
      const n = await outbox.drain(async (fix, drainParent) => {
        const seq = await publisher.publishFix(fix, drainParent);
        await trail.appendOwn(fix, seq);
      }, parent);
      // Get the batch off the device. Cheap to repeat — the namespace is already in the docs sync
      // engine after the first call, so this is one reconciliation round-trip with the stash.
      if (n > 0) await publisher.pushTrail?.(parent);
      const pending = await outbox.pending();
      setState({ pending, error: null });
      return n;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let pending = state.pending;
      try {
        pending = await outbox.pending();
      } catch {
        // ignore secondary failure reading pending
      }
      setState({ status: 'error', error: message, pending });
      return 0;
    }
  }

  /**
   * Enqueue one envelope per interval slot that has elapsed since the last publish, each carrying
   * `lastKnownFix`. The caller flushes. Returns how many were enqueued (0 when the current slot is
   * already covered — the common case, since fixes arrive far faster than the interval).
   */
  async function enqueueDueSlots(parent?: SpanContext): Promise<number> {
    const fix = lastKnownFix;
    if (fix === null) return 0;

    const intervalMs = policy.config.intervalMs;
    const currentSlot = slotOf(now(), intervalMs);
    // First publish of the session lands on the current slot rather than being deferred a full
    // interval — a user who just enabled sharing should appear on their friends' maps now.
    if (lastPublishedSlot === null) lastPublishedSlot = currentSlot - 1;
    if (currentSlot <= lastPublishedSlot) return 0;

    const maxSlots = Math.max(1, Math.ceil(MAX_BACKFILL_MS / intervalMs));
    const from = Math.max(lastPublishedSlot + 1, currentSlot - maxSlots + 1);
    const capped = from - (lastPublishedSlot + 1);

    for (let slot = from; slot <= currentSlot; slot += 1) {
      await outbox.enqueue(fix, parent);
    }
    lastPublishedSlot = currentSlot;

    if (capped > 0) {
      // Not a bug — see MAX_BACKFILL_MS — but it is a gap in the uniform series, so say so rather
      // than letting a dropped-ping investigation infer a fault that isn't there.
      getTelemetry().log('info', `heartbeat backfill capped: skipped ${capped} slot(s)`, {
        skipped_slots: capped,
        interval_ms: intervalMs,
        'sc.drop_reason': 'backfill-capped',
      });
    }
    return currentSlot - from + 1;
  }

  return {
    async start(): Promise<void> {
      if (state.status === 'running') return;
      // Arm the starvation escape hatch from now, so a phone that only ever sees coarse fixes
      // starts publishing something within `acceptAnythingAfterMs` instead of never.
      lastAcceptedAt ??= now();
      setState({ status: 'running', error: null });
    },

    async stop(): Promise<void> {
      setState({ status: 'idle' });
    },

    async ingest(fix: LocationFix, parent?: SpanContext): Promise<SamplingDecision> {
      const batt = await batteryCached();
      const decision = policy.decide({ battery: batt, live });
      const rejection = assessFix(
        fix,
        { lastAccepted: lastKnownFix, lastAcceptedAt, now: now() },
        quality
      );

      // ── Ambient fast path ────────────────────────────────────────────────────────────────────
      // How often the OS hands us a fix is not something we control, and on iOS it is not something
      // the policy controls either: `timeInterval` is Android-only and ambient sets
      // `distanceIntervalM: 0` on purpose (a distance filter is a motion filter — see
      // sampling-policy.ts), so Core Location delivers at the accuracy tier's natural rate, ~1 Hz
      // while moving, against a 5-minute publish interval. That is ~300 ingests per slot on iOS
      // versus one on Android, and every one of them was doing a native battery read, a span, an
      // outbox drain + pending query (two SQLite round-trips) and two listener fan-outs — to then
      // publish nothing, because the slot was already covered.
      //
      // So: when the slot is already published and nothing is waiting in the outbox, `enqueueDueSlots`
      // provably returns 0 and `flush` has nothing to drain. Absorb the fix and get out. This changes
      // no wire behaviour whatsoever — the slot grid is wall-clock, `heartbeat()` still covers slots
      // that see no fix, and `lastKnownFix` is still updated here, which is the value a heartbeat
      // republishes. It only stops us paying for work whose result is discarded.
      const slotCovered =
        !live &&
        lastPublishedSlot !== null &&
        slotOf(now(), policy.config.intervalMs) <= lastPublishedSlot;

      // A backlog is only worth breaking the fast path for if it can actually drain: when the node
      // is not ready `flush()` no-ops, so paying for a `pending` query per fix buys nothing. The
      // backlog still goes out — `flush` is called on node-ready, on resume, and every heartbeat.
      const drainable = state.pending > 0 && publisher.isReady();

      if (slotCovered && state.status === 'running' && decision.active && !drainable) {
        if (rejection === null) {
          lastKnownFix = fix;
          lastFixAt = now();
          lastAcceptedAt = now();
        }
        absorbed += 1;
        setStateQuiet({
          decision,
          lastFixAt,
          lastAcceptedFix: lastKnownFix,
          lastRejection: rejection,
        });
        return decision;
      }

      // The gate and the slot boundary are the two places a captured fix stops travelling; the span
      // says which — refused as junk, absorbed into an already-covered slot, or suspended outright.
      const span = getTelemetry().startSpan('engine.ingest', {
        parent,
        attributes: {
          live,
          'fix.accuracy_m': fix.accuracyM,
          'fix.age_ms': now() - fix.ts,
          'fix.rejection': rejection ?? 'none',
          'battery.level': Math.round(batt.level * 100) / 100,
          'battery.charging': batt.charging,
          'battery.low_power': batt.lowPower,
          'decision.active': decision.active,
          'decision.interval_ms': decision.timeIntervalMs,
          'decision.accuracy': decision.accuracy,
          'publisher.ready': publisher.isReady(),
          // Fixes the fast path above swallowed since the last span. Non-zero is normal and is the
          // headline iOS/Android difference; it replaces the per-fix spans that used to say it.
          fixes_absorbed: absorbed,
        },
      });
      absorbed = 0;

      // A rejected fix never becomes our position — but it also never stops the clock. Execution
      // falls through to the slot logic below, which republishes the last accepted position, so a
      // stretch of bad GPS is indistinguishable on the wire from a stretch of sitting still.
      if (rejection === null) {
        lastKnownFix = fix;
        lastFixAt = now();
        lastAcceptedAt = now();
      }

      try {
        if (state.status !== 'running') {
          span.setAttribute('sc.drop_reason', 'engine-not-running');
          setState({
            decision,
            lastFixAt,
            lastAcceptedFix: lastKnownFix,
            lastRejection: rejection,
          });
          return decision;
        }

        setState({ decision, lastFixAt, lastAcceptedFix: lastKnownFix, lastRejection: rejection });

        try {
          if (!decision.active) {
            span.setAttribute('sc.drop_reason', 'sampling-suspended');
          } else if (live) {
            // Real-time mode bypasses the slot grid by design: the user has explicitly traded the
            // uniform cadence for responsiveness, for a bounded window. It does NOT bypass the
            // confidence gate — a friend watching in real time least of all wants junk — and since
            // the grid is gone, `liveGate` is the only thing bounding the publish rate. Losing that
            // bound is what let a driving iPhone publish at ~1 Hz until it was killed.
            if (rejection === null) {
              const verdict = liveGate(fix, now());
              span.setAttribute('live.gate', verdict);
              if (verdict === 'publish') {
                await outbox.enqueue(fix, span.context);
                markLivePublish(fix, now());
              } else {
                span.setAttribute('sc.drop_reason', verdict);
              }
            }
          } else {
            const published = await enqueueDueSlots(span.context);
            span.setAttribute('slots_published', published);
            // Absorbed, not lost: an accepted fix updated lastKnownFix and goes out on the next slot
            // boundary. Stamped so it is distinguishable from a real drop.
            if (published === 0) span.setAttribute('sc.drop_reason', 'slot-already-published');
          }
          // Last word: why this particular fix went nowhere is more useful than the slot state,
          // which is the ordinary case and says nothing about the fix itself.
          if (rejection !== null) span.setAttribute('sc.drop_reason', `fix-${rejection}`);
          if (publisher.isReady()) await flush(span.context);
          const pending = await outbox.pending();
          span.setAttribute('pending', pending);
          setState({ pending });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.recordError(err);
          setState({ status: 'error', error: message });
        }

        return decision;
      } finally {
        span.end();
      }
    },

    async heartbeat(parent?: SpanContext): Promise<number> {
      if (state.status !== 'running') return 0;
      // Live mode must not be re-gridded by the slot heartbeat — but it still needs a heartbeat of
      // its own. With a 25 m OS distance filter a stationary phone is delivered no fixes at all, so
      // without this a parked friend would simply stop transmitting and read as a dead phone.
      if (live) {
        const decision = policy.decide({ battery: await battery(), live });
        setState({ decision });
        if (!decision.active || lastKnownFix === null) return 0;
        const at = now();
        if (lastLivePublishAt !== null && at - lastLivePublishAt < policy.config.liveMaxQuietMs) {
          return 0;
        }
        try {
          await outbox.enqueue(lastKnownFix, parent);
          markLivePublish(lastKnownFix, at);
          if (publisher.isReady()) await flush(parent);
          setState({ pending: await outbox.pending() });
          return 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setState({ status: 'error', error: message });
          return 0;
        }
      }
      const decision = policy.decide({ battery: await battery(), live });
      setState({ decision });
      if (!decision.active) return 0;
      try {
        const published = await enqueueDueSlots(parent);
        if (publisher.isReady()) await flush(parent);
        setState({ pending: await outbox.pending() });
        return published;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', error: message });
        return 0;
      }
    },

    async setIntervalMs(intervalMs: number): Promise<SamplingDecision> {
      policy.setIntervalMs(intervalMs);
      // Re-anchor to the new grid. Without this, the old slot index is meaningless against the new
      // interval: shortening it would backfill a burst of slots that never elapsed, and lengthening
      // it would stall until the old (much larger) index came around again.
      if (lastPublishedSlot !== null) {
        lastPublishedSlot = slotOf(now(), policy.config.intervalMs);
      }
      const decision = policy.decide({ battery: await battery(), live });
      setState({ decision });
      return decision;
    },

    async reevaluate(): Promise<SamplingDecision> {
      // Explicitly a power event, which is the one thing the cached read must not lag behind.
      batteryCache = null;
      const decision = policy.decide({ battery: await batteryCached(), live });
      setState({ decision });
      return decision;
    },

    async setLiveMode(on: boolean): Promise<SamplingDecision> {
      const was = live;
      live = on;
      // Leaving live mode re-anchors the grid: while live we published per fix and left
      // lastPublishedSlot behind, so resuming would otherwise backfill every slot since.
      if (was && !on) lastPublishedSlot = slotOf(now(), policy.config.intervalMs);
      // Clear the live gate on every transition. Entering, so the first fix of a session goes out
      // immediately instead of waiting out a floor measured against some previous session; leaving,
      // so stale state cannot suppress the first fix of the next one.
      if (was !== on) {
        lastLivePublishFix = null;
        lastLivePublishAt = null;
      }
      const decision = policy.decide({ battery: await battery(), live });
      setState({ decision });
      return decision;
    },

    flush,

    onState(cb: (s: EngineState) => void): () => void {
      listeners.add(cb);
      cb(getState());
      return () => {
        listeners.delete(cb);
      };
    },

    getState,
  };
}
