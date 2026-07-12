import * as Location from 'expo-location';

import type { LocationFix } from '../../core/types';
import type { LocationProvider } from '../location-provider';
import {
  ensureBackgroundPermissions,
  startBackgroundLocation,
  stopBackgroundLocation,
  type BackgroundStartConfig,
  type LocationPermissionResult,
} from './background-task';

function toFix(pos: Location.LocationObject): LocationFix {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracyM: pos.coords.accuracy ?? 0,
    headingDeg: pos.coords.heading ?? 0,
    ts: pos.timestamp,
  };
}

/**
 * A {@link LocationProvider} backed by real GPS that also drives OS background updates. Sibling to
 * `ManualLocationProvider` / `ExpoLocationProvider` — it satisfies the same interface so it drops
 * into `LocationSharingService`/the engine unchanged. `watch()` covers the foreground; background
 * fixes flow through `background-task.ts` into the persistent outbox (not through `watch`).
 *
 * Requires `expo-location` (already installed) + `expo-task-manager`.
 */
export class BackgroundLocationProvider implements LocationProvider {
  /** Request foreground permission (does not by itself request "Always"/background). */
  async ensurePermission(): Promise<boolean> {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === Location.PermissionStatus.GRANTED;
  }

  async getCurrent(): Promise<LocationFix> {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return toFix(pos);
  }

  async watch(onFix: (fix: LocationFix) => void): Promise<() => void> {
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, distanceInterval: 10, timeInterval: 5000 },
      (pos) => onFix(toFix(pos))
    );
    return () => sub.remove();
  }

  /** Request location permission and start OS updates. Foreground is required; background is best-effort. */
  async startBackground(cfg: BackgroundStartConfig): Promise<LocationPermissionResult> {
    const permissions = await ensureBackgroundPermissions();
    const { foreground } = permissions;
    if (!foreground) {
      throw new Error(
        'Location permission is required. Enable location access for streetCryptid and try again.'
      );
    }
    await startBackgroundLocation(cfg);
    return permissions;
  }

  /**
   * Re-program the running OS location task with a new cadence/accuracy — no permission prompt,
   * unlike {@link startBackground}. Called by the cadence controller when the sampling decision
   * changes (motion class, battery, or Low-Power Mode), so the GPS hardware actually follows the
   * policy instead of staying pinned at the cadence it was first armed with.
   */
  async reprogram(cfg: BackgroundStartConfig): Promise<void> {
    await startBackgroundLocation(cfg);
  }

  async stopBackground(): Promise<void> {
    await stopBackgroundLocation();
  }
}
