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
