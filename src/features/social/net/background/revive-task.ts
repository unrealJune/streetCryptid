import { Platform } from 'react-native';

import {
  type Attributes,
  getTelemetry,
  type SpanContext,
  withEventLogLaunchContext,
} from '@/features/dev/telemetry';
import type { LocationFix } from '../../core/types';
import { createPersistentKV } from '../persistence';
import type { PersistentKV } from './fix-outbox';

/**
 * iOS revive tripwire — a single self-recentering geofence whose only job is to get a *terminated*
 * app running again (ARCHITECTURE §9).
 *
 * ## Why this has to exist at all
 * `startLocationUpdatesAsync` uses Core Location's **standard** location service. That service keeps
 * a suspended app being woken, but it does not relaunch a terminated one: per Apple, "if your app is
 * terminated either by a user or by the system, the system doesn't automatically restart your app
 * when new location updates arrive… the only way to have your app relaunched automatically is to use
 * region monitoring or the significant-change location service."
 *
 * expo-location does not expose the significant-change service, so region monitoring is the only
 * mechanism available to us — and per the Expo docs it does work: on iOS "the system will restart the
 * terminated app when a new geofence event occurs." The other route, a silent push, was deliberately
 * given up when push-token upload was removed (a push token is the one identifier here that a third
 * party can resolve to a real person). Both require `Always` authorization, which the app already
 * requests.
 *
 * ## It earns its keep on Android too, for a completely different reason
 * The Expo docs are explicit that on Android "a terminated app will not automatically restart when a
 * location or geofencing event occurs" — so the fence is NOT a resurrection mechanism there. It is
 * armed anyway because a geofence transition is one of the documented exemptions to the Android 12+
 * ban on starting a foreground service from the background ("your app receives an event that's
 * related to geofencing or activity recognition transition").
 *
 * That matters because re-arming location updates *is* starting a foreground service, so the
 * self-heal has no legal way to run from an ordinary WorkManager wake — it throws
 * `ForegroundServiceStartNotAllowedException`. Arriving via a geofence event is a window in which it
 * is allowed. See `ensureSharingArmedHeadless`.
 *
 * Android's other recovery paths, for reference: `LocationTaskService` returns
 * `START_REDELIVER_INTENT`, so the system restarts it by itself after an ordinary process kill —
 * which is why the kill case needs no help from us there. Reboot is the genuine gap: it needs either
 * a `BOOT_COMPLETED` receiver (expo-location declares none) or the user turning off battery
 * optimisation, which is a blanket exemption. Neither is solved here.
 *
 * ## What it deliberately does NOT do
 * It does not publish, sample, or carry position data anywhere. Crossing the fence re-arms the
 * ordinary ambient location task and re-centers the fence; publishing stays governed by the engine's
 * slot grid exactly as before, so the *wire* cadence remains motion-independent even though the
 * *wake* is motion-derived. That distinction is what keeps this compatible with the constant-cadence
 * rule in `sampling-policy.ts`.
 *
 * Both native modules are lazily + individually guarded (same pattern as `backfill-task.ts`), so
 * merely importing this file is side-effect-free and it degrades gracefully without them. The one
 * static import, `../persistence`, is already in this module's graph via
 * `register-task` → `background-outbox`, and its KV is still built on first use, not at load.
 */

let taskManagerMod: typeof import('expo-task-manager') | null | undefined;
let locationMod: typeof import('expo-location') | null | undefined;

function tryTaskManager(): typeof import('expo-task-manager') | null {
  if (taskManagerMod !== undefined) return taskManagerMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load; see header
    taskManagerMod = require('expo-task-manager') as typeof import('expo-task-manager');
  } catch {
    taskManagerMod = null;
  }
  return taskManagerMod;
}

function tryLocation(): typeof import('expo-location') | null {
  if (locationMod !== undefined) return locationMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load; see header
    locationMod = require('expo-location') as typeof import('expo-location');
  } catch {
    locationMod = null;
  }
  return locationMod;
}

/** TaskManager task name for the revive fence. Must be stable across app launches. */
export const REVIVE_FENCE_TASK = 'streetcryptid.revive-fence';

/**
 * `LocationGeofencingEventType.Exit`. Inlined rather than imported so the gate in
 * {@link defineReviveTask} works on a cold headless launch without pulling expo-location in.
 * Cross-checked against the live enum when the module happens to be loaded already.
 */
const GEOFENCING_EVENT_EXIT = 2;

/**
 * Minimum spacing between two arms of the fence **that land in the same place**.
 *
 * Arming is self-triggering (see {@link defineReviveTask}), so an unthrottled re-arm inside the
 * handler is a loop by construction. The event-type gate stops the *enter* storm outright; this
 * floor covers the one case the gate cannot — a fence we keep re-centering on a position we are
 * genuinely outside of, which re-fires a real `Exit` every time.
 *
 * It is deliberately paired with the distance test below rather than applied on time alone. A plain
 * time floor would strand the tripwire for the user who needs it most: at 30 mph a 200 m radius is
 * crossed in ~15 s, so a driver's second exit would be refused and the fence left behind them.
 */
export const REVIVE_FENCE_MIN_REARM_MS = 60_000;

/**
 * How stale a cached position may be and still be trusted as a fence centre. Re-centering on a
 * long-dead fix plants the fence somewhere we are not, which is precisely the state that keeps a
 * real exit firing. Better to leave the old fence standing — it still covers the old location, so
 * the tripwire survives either way.
 */
export const REVIVE_FENCE_MAX_FIX_AGE_MS = 5 * 60_000;

/**
 * KV key holding the last successful arm as `ms:lat:lon`; survives the cold launches the fence
 * causes, which an in-process variable would not.
 */
const LAST_ARM_KEY = 'sc.social.reviveFenceArmedAt';

interface LastArm {
  at: number;
  lat: number;
  lon: number;
}

function parseLastArm(raw: string | null): LastArm | null {
  if (raw === null) return null;
  const [at, lat, lon] = raw.split(':').map(Number);
  return [at, lat, lon].every(Number.isFinite) ? { at, lat, lon } : null;
}

/**
 * When the fence was last successfully armed, or null if it never has been.
 *
 * Read by the `device.health` record. An armed-at age that keeps growing while the app believes
 * sharing is on means the tripwire is stale — on iOS that is the difference between a phone that
 * can be resurrected after a process kill and one that cannot, and it is otherwise invisible
 * until the day it fails to fire.
 */
export async function loadReviveFenceArmedAt(kv: PersistentKV): Promise<number | null> {
  const last = parseLastArm(await kv.get(LAST_ARM_KEY).catch(() => null));
  return last?.at ?? null;
}

/**
 * Great-circle distance in metres. A local copy, as in `fix-outbox.ts` / `fix-quality.ts` — the
 * alternative is exporting one of those and dragging its module into the cold-launch graph.
 */
function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Stable region id, so re-arming replaces the fence rather than accumulating fences. */
export const REVIVE_FENCE_REGION_ID = 'streetcryptid.revive';

/**
 * Fence radius in metres. A trade-off with no clean answer: too small and a stationary phone
 * thrashes on GPS jitter, waking constantly; too large and a killed app stays dead across a long
 * trip. ~200 m sits above typical urban fix noise while still tripping within a block or two of
 * leaving. iOS allows 20 simultaneous regions (Android 100) and this uses exactly one.
 */
export const REVIVE_FENCE_RADIUS_M = 200;

let armKv: PersistentKV | null | undefined;

/**
 * The persistent KV backing the arm throttle. Constructed on first use rather than at import, so
 * this module stays side-effect-free to load on a cold headless launch — but imported statically,
 * because `register-task` already pulls `../persistence` in through `background-outbox` (which
 * builds a KV at module scope), so there is nothing left to defer. Null when SQLite is unavailable,
 * which costs the throttle its memory but never the fence itself.
 */
function tryKv(): PersistentKV | null {
  if (armKv !== undefined) return armKv;
  try {
    armKv = createPersistentKV();
  } catch {
    armKv = null;
  }
  return armKv;
}

/** True when this platform + build can actually host the revive fence. */
export function isReviveFenceAvailable(): boolean {
  return Platform.OS !== 'web' && tryTaskManager() !== null && tryLocation() !== null;
}

/**
 * Register the revive handler. Call once at module load (top level) so a **cold, headless** launch —
 * the entire point of this file — can service the event. The runner must be headless-safe and must
 * flush telemetry before returning, or the OS freezes the process with the batch unexported.
 *
 * ## Only `Exit` may run the handler, and the region flags do not enforce that on iOS
 * The fence is registered `notifyOnEnter: false`, which reads like it settles the question. It does
 * not. `startGeofencingAsync` re-registers the whole region set, and expo-location's iOS consumer
 * (`EXGeofencingTaskConsumer.startMonitoringRegionsForTask`) resets the region's cached state to
 * `CLRegionStateUnknown` and then calls `requestStateForRegion`. The resulting `didDetermineState:`
 * fires the task whenever the determined state differs from the cached one — always, after that
 * reset — and it derives the event type from the state alone, consulting neither `notifyOnEnter` nor
 * `notifyOnExit`. Those flags only filter the genuine `didEnterRegion` / `didExitRegion` transitions.
 *
 * So on iOS *every* arm delivers one synthetic event back to this handler, and the handler re-arms:
 * unbounded recursion, bounded only by how fast Core Location can answer (measured at 60–125 Hz,
 * with the OS eventually logging "Supported CoreLocation API call rate exceeded"). Because the fence
 * lives in expo-task-manager's persisted task configuration, the loop restarted on every cold launch
 * and survived force-quit — only an uninstall cleared it. Android is unaffected: its consumer builds
 * `transitionTypes` from the notify flags, so an unrequested enter is never delivered.
 *
 * Hence the gate below. It is what makes re-arming from inside the handler safe at all; the
 * {@link REVIVE_FENCE_MIN_REARM_MS} floor in {@link armReviveFence} backs it up for real exits.
 */
export function defineReviveTask(run: (parent?: SpanContext) => Promise<void>): void {
  const taskManager = tryTaskManager();
  if (!taskManager || Platform.OS === 'web') return;
  taskManager.defineTask(REVIVE_FENCE_TASK, ({ data, error }) =>
    withEventLogLaunchContext('background', async () => {
      const telemetry = getTelemetry();
      const span = telemetry.startSpan('bg.revive');
      try {
        if (error) {
          span.setAttribute('sc.drop_reason', 'geofence-error');
          span.recordError(error);
          return;
        }
        const eventType = (data as { eventType?: number } | null | undefined)?.eventType;
        const exitType = locationMod?.GeofencingEventType?.Exit ?? GEOFENCING_EVENT_EXIT;
        if (eventType !== exitType) {
          // The synthetic state-determination callback described above, or a genuine enter. Neither
          // means the phone moved, so there is nothing to revive and nothing to re-centre.
          span.setAttributes({ event_type: eventType, 'sc.drop_reason': 'geofence-not-exit' });
          return;
        }
        await run(span.context);
        span.setStatus('ok');
      } catch (err) {
        span.recordError(err);
      } finally {
        span.end();
        await telemetry.flush();
      }
    })
  );
}

export interface ArmReviveFenceOptions {
  /**
   * Skip the {@link REVIVE_FENCE_MIN_REARM_MS} floor. For the one caller that must not be throttled:
   * `startBackground`, where there may be no fence at all yet and "keep the existing one" is not a
   * safe outcome. Re-centering callers must never set this — the floor is what bounds them.
   */
  force?: boolean;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Every way {@link armReviveFence} can end.
 *
 * `armed` is the only one that leaves a working tripwire behind. The rest are the reason this span
 * exists: on iOS the fence is the sole mechanism that can bring a terminated app back, so an arm
 * that quietly did not happen is indistinguishable, from every other signal the device emits, from
 * a phone whose owner simply has not moved.
 */
export type ReviveArmOutcome =
  /** The fence is registered and standing. */
  | 'armed'
  /** Refused by the re-arm floor; the previous fence still stands, which is a working tripwire. */
  | 'throttled'
  /**
   * The OS has no handler registered for the fence task, so arming would succeed and deliver
   * nothing. The one outcome that looks identical to success from the call site.
   */
  | 'task-undefined'
  /** Web, or a build without the native modules. Not a fault. */
  | 'unavailable'
  /** `startGeofencingAsync` threw — usually a missing `Always` authorization. */
  | 'failed';

/**
 * Record what an arm attempt actually did, and return whether the fence is now standing.
 *
 * One span per call rather than one per failure mode, because the question this answers is "is the
 * tripwire armed?" and that is a property of the call, not of the branch it happened to take. It
 * replaces the old `revive.arm.throttled` span, which covered exactly one of five outcomes and left
 * the other four — including a silently unregistered task — emitting nothing at all.
 *
 * `infra/otel/README.md` has documented this span since the fence was written; it was never
 * implemented, which is how an iPhone spent nineteen hours unable to revive without anything
 * saying so.
 */
function recordArm(
  outcome: ReviveArmOutcome,
  options: ArmReviveFenceOptions,
  extra: Attributes = {}
): boolean {
  const armed = outcome === 'armed';
  getTelemetry()
    .startSpan('revive.arm', {
      attributes: {
        outcome,
        armed,
        forced: options.force === true,
        radius_m: REVIVE_FENCE_RADIUS_M,
        platform: Platform.OS,
        // Absent when armed, so the drop queries show only the attempts that left no tripwire.
        ...(armed ? {} : { 'sc.drop_reason': `revive-${outcome}` }),
        ...extra,
      },
    })
    .end();
  return armed;
}

/**
 * Arm (or re-center) the fence on `fix`. Idempotent: `startGeofencingAsync` replaces the task's
 * whole region set, so repeated calls move the one fence rather than stacking them.
 *
 * Rate-limited to one arm per {@link REVIVE_FENCE_MIN_REARM_MS} unless `force` is set, because each
 * arm feeds one event back into {@link defineReviveTask} — see the loop described there. A throttled
 * call resolves `false` and leaves the standing fence untouched, which is a working tripwire either
 * way.
 *
 * Best-effort by design — a phone that has not granted `Always` simply cannot host this, and that
 * must not be an error at the call site.
 */
export async function armReviveFence(
  fix: LocationFix,
  options: ArmReviveFenceOptions = {}
): Promise<boolean> {
  if (!isReviveFenceAvailable()) return recordArm('unavailable', options);
  const location = tryLocation();
  const taskManager = tryTaskManager();
  if (!location || !taskManager) return recordArm('unavailable', options);
  // Registering a geofence for a task the OS cannot deliver to is a silent no-op that looks armed.
  // The single most valuable thing this span reports: "armed" and "believed armed" diverge here,
  // and until now nothing said so.
  if (!taskManager.isTaskDefined(REVIVE_FENCE_TASK)) return recordArm('task-undefined', options);
  const now = options.now ?? Date.now;
  const armedAt = now();
  // Persisted, not in-memory: every arm can wake a fresh process, so an in-process timestamp would
  // reset exactly when the throttle is needed most.
  const kv = tryKv();
  if (!options.force && kv) {
    const last = parseLastArm(await kv.get(LAST_ARM_KEY).catch(() => null));
    if (last !== null && armedAt - last.at < REVIVE_FENCE_MIN_REARM_MS) {
      // Only refuse a re-arm that would put the fence back where it already is. A centre that has
      // moved clear of the standing fence is a real crossing, and refusing it would leave the
      // tripwire behind the user — the exact failure the fence exists to prevent.
      const moved = metresBetween(last.lat, last.lon, fix.lat, fix.lon);
      if (moved < REVIVE_FENCE_RADIUS_M) {
        return recordArm('throttled', options, {
          since_last_ms: armedAt - last.at,
          moved_m: Math.round(moved),
        });
      }
    }
  }
  try {
    await location.startGeofencingAsync(REVIVE_FENCE_TASK, [
      {
        identifier: REVIVE_FENCE_REGION_ID,
        latitude: fix.lat,
        longitude: fix.lon,
        radius: REVIVE_FENCE_RADIUS_M,
        // Exit only. Entry would fire every time the user came home, waking the app to do nothing.
        //
        // On iOS this is necessary but NOT sufficient: the flags are ignored by the state-
        // determination callback that every arm triggers, which is what made the handler recurse.
        // The authoritative filter is the event-type gate in `defineReviveTask` — do not remove it
        // on the strength of this line.
        notifyOnEnter: false,
        notifyOnExit: true,
      },
    ]);
    // Only a real arm advances the floor, so a failed attempt can be retried immediately.
    await kv?.set(LAST_ARM_KEY, `${armedAt}:${fix.lat}:${fix.lon}`).catch(() => undefined);
    return recordArm('armed', options);
  } catch (err) {
    console.warn('[revive-fence] arm failed', err);
    return recordArm('failed', options, {
      'exception.message': err instanceof Error ? err.message : String(err),
    });
  }
}

/** Remove the fence. Idempotent; safe when it was never armed. */
export async function disarmReviveFence(): Promise<void> {
  if (Platform.OS === 'web') return;
  const location = tryLocation();
  const taskManager = tryTaskManager();
  if (!location || !taskManager) return;
  try {
    if (await taskManager.isTaskRegisteredAsync(REVIVE_FENCE_TASK)) {
      await location.stopGeofencingAsync(REVIVE_FENCE_TASK);
    }
  } catch {
    // best-effort — an un-armed fence is the desired end state either way
  }
}
