import { Platform } from 'react-native';

/**
 * The app's one haptics entry point, wrapping `expo-better-haptics` (Core Haptics on iOS,
 * `VibrationEffect` compositions on Android 11+) behind a small semantic vocabulary.
 *
 * Why a wrapper rather than calling the library directly:
 *
 * - **It must never throw.** Haptics are decoration. A missing engine, a device in silent or
 *   battery-saver mode, or an OEM that ignores a primitive must degrade to silence — never break
 *   the flow it was decorating. Every call here is swallowed.
 * - **The library's named exports are typed `any`.** Wrapping restores type safety at one boundary
 *   instead of scattering untyped calls through the UI.
 * - **Vocabulary over primitives.** Call sites should say what happened (`tap`, `toggle`,
 *   `success`), not pick intensities. That is what keeps app-wide haptics tasteful instead of
 *   buzzy: the palette is defined once, here, and there is a `setEnabled` kill switch.
 *
 * The engine is started lazily on first use so a launch that never triggers haptics pays nothing.
 */

type HapticEvent = {
  type: string | number;
  time: number;
  parameters: { id: string | number; value: number }[];
  duration?: number;
};

interface BetterHaptics {
  isSupported: boolean;
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  selectionAsync(): Promise<void>;
  impactAsync(style: string): Promise<void>;
  notificationAsync(type: string): Promise<void>;
  playTransientAsync(intensity: number, sharpness: number): Promise<void>;
  playContinuousAsync(intensity: number, sharpness: number, duration: number): Promise<void>;
  playPatternAsync(events: HapticEvent[]): Promise<void>;
  createTransientEvent(options: {
    intensity?: number;
    sharpness?: number;
    time?: number;
  }): HapticEvent;
}

/**
 * Load the native module lazily. It is absent on web, and on a dev client built before the package
 * was added — importing at module scope would take the whole bundle down with it.
 */
let mod: BetterHaptics | null | undefined;

function haptics(): BetterHaptics | null {
  if (mod !== undefined) return mod;
  if (Platform.OS === 'web') {
    mod = null;
    return mod;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load; see above
    const loaded = require('expo-better-haptics') as { default?: BetterHaptics } & BetterHaptics;
    mod = loaded.default ?? loaded;
  } catch {
    mod = null;
  }
  return mod;
}

let enabled = true;
let engineStarted = false;

/** Turn all app haptics on/off (settings toggle, or an accessibility preference). */
export function setHapticsEnabled(next: boolean): void {
  enabled = next;
}

export function hapticsEnabled(): boolean {
  return enabled;
}

/** True when this device can actually produce haptics — for honest UI, not for guarding calls. */
export function hapticsSupported(): boolean {
  const api = haptics();
  return !!api && api.isSupported !== false;
}

async function withEngine(run: (api: BetterHaptics) => Promise<void>): Promise<void> {
  if (!enabled) return;
  const api = haptics();
  if (!api || api.isSupported === false) return;
  try {
    if (!engineStarted) {
      await api.initialize();
      engineStarted = true;
    }
    await run(api);
  } catch {
    // Decoration only — see the header. Never surfaces, never rethrows.
  }
}

/**
 * Release the haptic engine. Call when backgrounding: iOS Core Haptics holds an audio-session-like
 * resource, and leaving it running is wasteful. The next call re-initialises transparently.
 */
export async function stopHaptics(): Promise<void> {
  const api = haptics();
  if (!api || !engineStarted) return;
  engineStarted = false;
  try {
    await api.stop();
  } catch {
    // ignore
  }
}

// ── The palette ────────────────────────────────────────────────────────────────────────────
//
// Restraint is the whole point. Four everyday weights, plus the two outcome signals, plus a raw
// escape hatch for the pairing choreography. If a new call site wants something outside this, the
// question to ask first is whether that moment deserves a haptic at all.

/** A light confirmation for an ordinary tap: a button that did something. */
export function tapHaptic(): Promise<void> {
  return withEngine((api) => api.playTransientAsync(0.45, 0.5));
}

/** Moving through discrete options — a segmented control, a picker, a snap point. */
export function selectionHaptic(): Promise<void> {
  return withEngine((api) => api.selectionAsync());
}

/** A switch or toggle committing. Slightly firmer than a tap, and asymmetric by direction. */
export function toggleHaptic(on: boolean): Promise<void> {
  return withEngine((api) =>
    on ? api.playTransientAsync(0.6, 0.75) : api.playTransientAsync(0.42, 0.35)
  );
}

/** Something meaningful landed. Deliberately two beats, so it reads as an event, not a tap. */
export function successHaptic(): Promise<void> {
  return withEngine((api) => api.notificationAsync('success'));
}

/** Something needs attention or did not work. */
export function warningHaptic(): Promise<void> {
  return withEngine((api) => api.notificationAsync('warning'));
}

/**
 * One raw transient. For choreography that computes its own curve — the pairing pulse — rather
 * than for ordinary UI, which should use the named weights above.
 */
export function transientHaptic(intensity: number, sharpness: number): Promise<void> {
  const i = Math.min(1, Math.max(0, intensity));
  const s = Math.min(1, Math.max(0, sharpness));
  return withEngine((api) => api.playTransientAsync(i, s));
}

/** A composed sequence, offsets in seconds from the start of the pattern. */
export function patternHaptic(
  beats: { intensity: number; sharpness: number; atSeconds: number }[]
): Promise<void> {
  return withEngine((api) =>
    api.playPatternAsync(
      beats.map((beat) =>
        api.createTransientEvent({
          intensity: Math.min(1, Math.max(0, beat.intensity)),
          sharpness: Math.min(1, Math.max(0, beat.sharpness)),
          time: Math.max(0, beat.atSeconds),
        })
      )
    )
  );
}

/** Test seam: forget the cached module + engine state between cases. */
export function resetHapticsForTesting(): void {
  mod = undefined;
  engineStarted = false;
  enabled = true;
}
