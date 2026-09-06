import * as Location from 'expo-location';

import type { LocationFix } from '../core/types';
import type { LocationProvider } from './location-provider';

/**
 * How long a user-initiated "where am I" read may wait on the OS before answering with whatever
 * the platform already holds.
 *
 * `getCurrentPositionAsync` takes no timeout and offers no cancellation (SDK 57 documents only
 * `accuracy`, `distanceInterval`, `mayShowUserSettingsDialog` and `timeInterval`), and it does not
 * reliably settle: indoors, or with the capture pipeline already driving the location manager, it
 * can stay pending for the life of the process. A promise that never settles is the same class of
 * bug as the native teardown chain — the caller waits forever, which for the locate button means a
 * spinner that never stops. Never await native unbounded.
 */
export const FOREGROUND_FIX_TIMEOUT_MS = 8_000;

/**
 * A cached position this recent is simply the answer. Both platforms keep the last fix the
 * location manager saw, and while the app is in the foreground the capture pipeline is refreshing
 * it, so the common press of the locate button costs nothing and recentres instantly instead of
 * sitting behind a fresh GPS acquisition.
 */
export const FOREGROUND_FIX_FRESH_MS = 10_000;

/** Sentinel for "the OS did not answer in time", distinguishable from a fix at the type level. */
const TIMED_OUT = { timedOut: true } as const;

function toFix(pos: Location.LocationObject): LocationFix {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracyM: pos.coords.accuracy ?? 0,
    headingDeg: pos.coords.heading ?? 0,
    ts: pos.timestamp,
  };
}

async function lastKnown(maxAge?: number): Promise<LocationFix | null> {
  try {
    const pos = await Location.getLastKnownPositionAsync(maxAge === undefined ? {} : { maxAge });
    return pos ? toFix(pos) : null;
  } catch {
    return null;
  }
}

/** Real foreground GPS via expo-location. Background modes are a later phase. */
export class ExpoLocationProvider implements LocationProvider {
  async ensurePermission(): Promise<boolean> {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === Location.PermissionStatus.GRANTED;
  }

  /**
   * Whether foreground location is already granted, WITHOUT prompting.
   *
   * The distinction matters for more than politeness: Google Play requires the in-app disclosure
   * screen to precede the OS permission dialog, so anything that runs on its own — as opposed to in
   * response to the user tapping something — must be able to check without asking.
   */
  async hasPermission(): Promise<boolean> {
    const { status } = await Location.getForegroundPermissionsAsync();
    return status === Location.PermissionStatus.GRANTED;
  }

  async getCurrent(): Promise<LocationFix> {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return toFix(pos);
  }

  /**
   * The same question as {@link getCurrent}, asked on behalf of a UI that has to stop waiting.
   *
   * Answers from the platform's cached fix when that is recent enough, otherwise asks for a real
   * one but abandons the read at {@link FOREGROUND_FIX_TIMEOUT_MS} and falls back to the cache at
   * any age. Resolves to `null` only when the OS has nothing at all — it never rejects and never
   * hangs, because the caller is a map control whose only failure mode visible to the user is a
   * spinner that never stops.
   *
   * An abandoned read is left to settle on its own; the capture pipeline's `onLocalFix` is what
   * keeps the self marker current, so a late answer has nothing to add and moving the camera on it
   * would yank a map the user has since panned.
   */
  async getCurrentWithin(
    timeoutMs: number = FOREGROUND_FIX_TIMEOUT_MS
  ): Promise<LocationFix | null> {
    const fresh = await lastKnown(FOREGROUND_FIX_FRESH_MS);
    if (fresh) return fresh;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        .then(toFix)
        // A rejected read is an answered one: stop waiting and take the cache below.
        .catch(() => TIMED_OUT);
      const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });
      const first = await Promise.race([read, deadline]);
      if (!('timedOut' in first)) return first;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return lastKnown();
  }

  async watch(onFix: (fix: LocationFix) => void): Promise<() => void> {
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, distanceInterval: 10, timeInterval: 5000 },
      (pos) => onFix(toFix(pos))
    );
    return () => sub.remove();
  }
}
