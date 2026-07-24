import { Platform } from 'react-native';

import type { MotionState } from './types';

/**
 * Motion classification straight from the OS motion coprocessor (iOS `CMMotionActivityManager`,
 * Android Activity Recognition), behind a native-free seam so the engine stays unit-testable.
 *
 * WHY THIS EXISTS — `deriveMotion()` in `sampling-policy.ts` infers motion by comparing two GPS
 * fixes, which is circular: the policy must keep the GPS receiver running to discover that it
 * doesn't need the GPS receiver, and can never let it idle, because idling would blind the very
 * signal that detects movement resuming. The coprocessor breaks that loop — it classifies motion
 * continuously at near-zero power, with no location hardware involved at all.
 *
 * IMPORTANT LIMITATION — `watchMotionActivityAsync` is **foreground-only**: expo-location documents
 * that "updates pause when the app is backgrounded and resume when it returns to the foreground."
 * So this is a foreground accelerator, NOT a background wake signal. Backgrounded, motion readings
 * go stale and the engine must fall back to `deriveMotion`; the background wake signal for leaving a
 * stationary anchor is region monitoring (see `cadence-controller.ts`), which does wake a headless
 * context. Do not build a background state transition on this source.
 *
 * As with `battery-source.ts`, the real implementation lazily loads `expo-location` so merely
 * importing this module is side-effect-free and web / Expo Go degrade to the null source.
 */
export interface MotionSource {
  /**
   * Latest OS motion classification, or `null` when unavailable (no permission, unsupported
   * platform, or no reading yet). Null means "no opinion" — callers fall back to `deriveMotion`.
   */
  read(): MotionState | null;
  /** Subscribe to motion-class changes; returns an unsubscribe fn. */
  subscribe(onChange: (motion: MotionState) => void): () => void;
  /** Begin listening. Resolves false when the platform/permission makes the source unavailable. */
  start(): Promise<boolean>;
  /** Stop listening and drop the cached reading. */
  stop(): void;
}

/** expo-location's `MotionActivityType` values — inlined so this module stays native-free. */
export type MotionActivityKind =
  'automotive' | 'cycling' | 'running' | 'walking' | 'stationary' | 'unknown';

/** The subset of expo-location's `MotionActivityState` we consume. */
export interface MotionActivityStateLike {
  detected: boolean;
  /** `MotionActivityConfidence`: 0 = Low, 1 = Medium, 2 = High. */
  confidence: number;
}

/** The subset of expo-location's `MotionActivityObject` we consume. */
export interface MotionActivityLike {
  activities: Partial<Record<MotionActivityKind, MotionActivityStateLike>>;
  timestamp: number;
}

/**
 * Ignore Low-confidence readings. On iOS `confidence` is the reading-wide
 * `CMMotionActivityConfidence`; a Low reading is frequently wrong about stationary-vs-walking, and
 * acting on it would flap the cadence. A rejected reading returns `null` ⇒ "no opinion", so the
 * engine keeps its previous motion rather than guessing.
 */
const MIN_CONFIDENCE = 1;

/**
 * Priority order when the OS reports several activities at once (it does — e.g. `walking` and
 * `running` can both be `detected`). Fastest wins, so cadence errs toward tighter sampling rather
 * than under-sampling a moving trail.
 */
const PRIORITY: readonly MotionActivityKind[] = [
  'automotive',
  'cycling',
  'running',
  'walking',
  'stationary',
];

/**
 * Pure mapping from an OS motion-activity snapshot to our {@link MotionState}. Exported for tests.
 *
 * Collapses the OS's five classes onto our three, matching the speed thresholds `deriveMotion`
 * already uses (< ~0.5 m/s stationary, < ~3 m/s walking, else driving) so the two sources agree:
 *  - `automotive` / `cycling` ⇒ `driving` — both routinely exceed 3 m/s and want the tight,
 *    high-accuracy cadence so a fast trail stays road-accurate.
 *  - `running` / `walking` ⇒ `walking` — the on-foot ambient case; `movingAccuracy` is plenty for
 *    a res-9 (~350 m) exploration hex even at running pace.
 *  - `stationary` ⇒ `stationary`.
 *
 * Returns `null` when nothing is detected or confidence is too low, meaning "no opinion".
 */
export function motionActivityToState(activity: MotionActivityLike): MotionState | null {
  for (const kind of PRIORITY) {
    const state = activity.activities[kind];
    if (!state?.detected || state.confidence < MIN_CONFIDENCE) continue;
    switch (kind) {
      case 'automotive':
      case 'cycling':
        return 'driving';
      case 'running':
      case 'walking':
        return 'walking';
      case 'stationary':
        return 'stationary';
    }
  }
  return null;
}

/** No opinion, ever. Used on web / Expo Go / when the motion API or its permission is absent. */
export function createNullMotionSource(): MotionSource {
  return {
    read: () => null,
    subscribe: () => () => {},
    start: async () => false,
    stop: () => {},
  };
}

type LocationModule = typeof import('expo-location');

let locationMod: LocationModule | null | undefined;

function tryLocation(): LocationModule | null {
  if (locationMod !== undefined) return locationMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load; see module header
    locationMod = require('expo-location') as LocationModule;
  } catch {
    locationMod = null;
  }
  return locationMod;
}

/**
 * How long an OS motion reading stays trustworthy. Because the stream is foreground-only, a
 * backgrounded app's last reading freezes at whatever it was when the app left the foreground —
 * typically `walking`, right before the phone goes in a pocket and sits still. Serving that stale
 * value would pin the cadence at moving rates for the whole background session, which is the exact
 * battery bug this work exists to fix. Past this window {@link MotionSource.read} returns `null` and
 * the engine falls back to GPS-derived motion.
 */
export const MOTION_STALE_AFTER_MS = 90_000;

export function createExpoMotionSource(
  mod: Pick<LocationModule, 'watchMotionActivityAsync'>,
  now: () => number = Date.now
): MotionSource {
  let sub: { remove: () => void } | null = null;
  let latest: MotionState | null = null;
  let latestAt = 0;
  const listeners = new Set<(motion: MotionState) => void>();

  return {
    read(): MotionState | null {
      if (latest === null) return null;
      return now() - latestAt <= MOTION_STALE_AFTER_MS ? latest : null;
    },

    subscribe(onChange: (motion: MotionState) => void): () => void {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },

    async start(): Promise<boolean> {
      if (sub) return true;
      try {
        sub = await mod.watchMotionActivityAsync(
          (activity) => {
            const motion = motionActivityToState(activity as MotionActivityLike);
            if (motion === null) return;
            const changed = motion !== latest;
            latest = motion;
            latestAt = now();
            // Only wake the policy on a real class change; the coprocessor re-reports the same
            // class often and each notification costs an engine re-evaluate + possible OS re-arm.
            if (changed) for (const cb of listeners) cb(motion);
          },
          () => {
            // Permission denied or the platform gave up — fall back to GPS-derived motion rather
            // than holding a reading that will never refresh.
            latest = null;
          }
        );
        return true;
      } catch {
        // Motion & Fitness permission denied, or the native module predates the motion API.
        sub = null;
        return false;
      }
    },

    stop(): void {
      sub?.remove();
      sub = null;
      latest = null;
      latestAt = 0;
    },
  };
}

/** The real coprocessor-backed source when `expo-location` exposes the motion API, else null. */
export function createMotionSource(): MotionSource {
  if (Platform.OS === 'web') return createNullMotionSource();
  const mod = tryLocation();
  // The motion API landed in expo-location 57; guard so an older native binary degrades instead
  // of throwing at start().
  if (!mod || typeof mod.watchMotionActivityAsync !== 'function') return createNullMotionSource();
  return createExpoMotionSource(mod);
}
