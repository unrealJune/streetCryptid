import * as Location from 'expo-location';

/**
 * Location permission, for the native background runtime.
 *
 * Extracted from `background-task.ts` when the expo-location task it wrapped was deleted. The
 * grants are unchanged and still required — our own foreground service and `CLLocationManager`
 * need exactly what expo-location's did — so this is the one part of that module that had nothing
 * to do with the task itself.
 */

export interface LocationPermissionResult {
  /** While-in-use permission — required to run the foreground-service location updates. */
  foreground: boolean;
  /** "Allow all the time" — needed for true background sampling; can't be prompted on Android 11+. */
  background: boolean;
}

/**
 * Request location permissions. Foreground prompts a dialog; background ("Allow all the time")
 * shows a dialog only on Android ≤10 / iOS — on Android 11+ it never prompts and is grantable only
 * via Settings, so we request it best-effort and report the result instead of failing on it.
 */
export async function ensureBackgroundPermissions(): Promise<LocationPermissionResult> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== Location.PermissionStatus.GRANTED) {
    return { foreground: false, background: false };
  }
  let background = false;
  try {
    const bg = await Location.requestBackgroundPermissionsAsync();
    background = bg.status === Location.PermissionStatus.GRANTED;
  } catch {
    // Some OS versions throw rather than returning "denied"; treat as not-granted.
  }
  return { foreground: true, background };
}
