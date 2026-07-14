import { PermissionsAndroid, Platform, type Permission } from 'react-native';

// Android 17 (API 37) introduced ACCESS_LOCAL_NETWORK as the runtime gate for local-network
// access. During the Android 16 (API 36) opt-in phase the temporary gate was NEARBY_WIFI_DEVICES.
const ANDROID_17_API_LEVEL = 37;
const ACCESS_LOCAL_NETWORK = 'android.permission.ACCESS_LOCAL_NETWORK' as Permission;
const NEARBY_WIFI_DEVICES = 'android.permission.NEARBY_WIFI_DEVICES' as Permission;

/**
 * Requests the runtime permission that gates iroh's same-Wi-Fi (local network) connectivity. On
 * Android 17+ this is ACCESS_LOCAL_NETWORK; on the Android 16 opt-in phase it is
 * NEARBY_WIFI_DEVICES. Denial (or an unrecognized permission on older platforms) is non-fatal —
 * the native core still connects over the relay, just more slowly.
 */
export async function ensureLocalNetworkPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  const permission =
    Number(Platform.Version) >= ANDROID_17_API_LEVEL ? ACCESS_LOCAL_NETWORK : NEARBY_WIFI_DEVICES;

  try {
    const result = await PermissionsAndroid.request(permission);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

/**
 * Requests the foreground Bluetooth permissions required by iroh's BLE transport. Denial does not
 * block the normal IP/relay node; the native core falls back to those transports.
 */
export async function ensurePairingPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  if (Number(Platform.Version) >= 31) {
    const permissions = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ];
    const result = await PermissionsAndroid.requestMultiple(permissions);
    return permissions.every(
      (permission) => result[permission] === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Check the BLE permission set without prompting; used before the process-lifetime node starts. */
export async function hasPairingPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  if (Number(Platform.Version) >= 31) {
    const permissions = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ];
    const results = await Promise.all(
      permissions.map((permission) => PermissionsAndroid.check(permission))
    );
    return results.every(Boolean);
  }

  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
}
