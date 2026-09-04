import * as Location from 'expo-location';

import type { LocationFix } from '../core/types';
import type { LocationProvider } from './location-provider';

function toFix(pos: Location.LocationObject): LocationFix {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracyM: pos.coords.accuracy ?? 0,
    headingDeg: pos.coords.heading ?? 0,
    ts: pos.timestamp,
  };
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

  async watch(onFix: (fix: LocationFix) => void): Promise<() => void> {
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, distanceInterval: 10, timeInterval: 5000 },
      (pos) => onFix(toFix(pos))
    );
    return () => sub.remove();
  }
}
