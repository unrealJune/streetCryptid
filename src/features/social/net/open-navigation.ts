import { Linking, Platform } from 'react-native';

import type { LocationFix } from '../core/types';

type Destination = Pick<LocationFix, 'lat' | 'lon'>;

export function isNavigationDestination(
  destination: Destination | null
): destination is Destination {
  return (
    destination !== null &&
    Number.isFinite(destination.lat) &&
    Number.isFinite(destination.lon) &&
    destination.lat >= -90 &&
    destination.lat <= 90 &&
    destination.lon >= -180 &&
    destination.lon <= 180
  );
}

/** Hand off only the destination, never a friend's identity or our own position. */
export async function openNavigation(destination: Destination): Promise<void> {
  if (!isNavigationDestination(destination)) {
    throw new Error('This location cannot be opened in maps.');
  }

  const coordinates = encodeURIComponent(`${destination.lat},${destination.lon}`);
  const webURL =
    Platform.OS === 'ios'
      ? `https://maps.apple.com/?daddr=${coordinates}`
      : `https://www.google.com/maps/dir/?api=1&destination=${coordinates}`;
  const nativeURL =
    Platform.OS === 'ios'
      ? `geo-navigation:///directions?destination=${coordinates}`
      : Platform.OS === 'android'
        ? `geo:0,0?q=${coordinates}`
        : null;

  if (nativeURL) {
    try {
      // iOS's geo-navigation action is a PATH, not a host: keep the third slash.
      // openURL uses the OS dispatcher (ACTION_VIEW on Android), without pinning a package.
      // Try directly: canOpenURL needs scheme-query permissions and can give false negatives.
      await Linking.openURL(nativeURL);
      return;
    } catch {
      // Older iOS/regions without a navigation default, or Android without a geo handler.
      // The HTTPS fallback still opens maps; if it also fails, let the caller report it.
    }
  }

  await Linking.openURL(webURL);
}
