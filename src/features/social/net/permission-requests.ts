import * as Location from 'expo-location';
import { tryGetIrohLocation } from 'iroh-location';
import { AppState, PermissionsAndroid, Platform, type Permission } from 'react-native';

import {
  ANDROID_LOCAL_NETWORK_API,
  ANDROID_NEARBY_WIFI_API,
  type PermissionContext,
  type PermissionPlatform,
  type PermissionStepId,
} from '../core/permission-steps';
import { readBackgroundAccessGranted } from './background/location-permissions';
import {
  ensureLocalNetworkPermission,
  ensurePairingPermissions,
  hasLocalNetworkPermission,
  hasPairingPermissions,
} from './pairing-permissions';

/**
 * The OS half of onboarding's permission steps: what each one asks, and what the OS says already.
 * `pendingPermissionSteps` decides which run; this only executes them.
 */

const POST_NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS' as Permission;
/** How long the battery step waits for the system dialog to hand the screen back. */
const BATTERY_DIALOG_WAIT_MS = 60_000;

export function permissionPlatform(): PermissionPlatform {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
}

/** The parts of {@link PermissionContext} that come from the OS and the binary. */
export async function readPermissionFacts(): Promise<
  Pick<PermissionContext, 'platform' | 'androidApi' | 'native' | 'granted'>
> {
  const platform = permissionPlatform();
  const androidApi = platform === 'android' ? Number(Platform.Version) : 0;
  const mod = tryGetIrohLocation();
  const native = {
    bluetooth: platform === 'android' || typeof mod?.requestBluetoothAccess === 'function',
    localNetwork: platform === 'android' || typeof mod?.requestLocalNetworkAccess === 'function',
    battery:
      typeof mod?.batteryOptimizationExempt === 'function' &&
      typeof mod.requestBatteryOptimizationExemption === 'function',
  };
  // Web has nothing to read: its only step is the disclosure, which it always shows.
  if (platform === 'web') return { platform, androidApi, native, granted: {} };

  const [location, background, bluetooth, localNetwork, notifications] = await Promise.all([
    readForegroundGranted(),
    readBackgroundAccessGranted(),
    platform === 'ios'
      ? Promise.resolve(safe(() => mod?.bluetoothAuthorization?.() === 'granted'))
      : hasPairingPermissions(),
    platform === 'android' && androidApi >= ANDROID_LOCAL_NETWORK_API
      ? hasLocalNetworkPermission()
      : Promise.resolve(undefined),
    platform === 'android' ? checkAndroid(POST_NOTIFICATIONS) : Promise.resolve(undefined),
  ]);
  return {
    platform,
    androidApi,
    native,
    granted: {
      location,
      'background-location': background,
      bluetooth,
      'local-network': localNetwork,
      notifications,
      battery: safe(() => mod?.batteryOptimizationExempt?.()),
    },
  };
}

/**
 * Show the OS prompt behind one step and resolve to the resulting grant: `undefined` when the
 * answer cannot be known (iOS local network running out of time, a dialog that never handed the
 * screen back). Never throws: a prompt that fails is a step that moves on.
 */
export async function requestPermissionStep(step: PermissionStepId): Promise<boolean | undefined> {
  const platform = permissionPlatform();
  try {
    switch (step) {
      case 'location':
        // Web shows the disclosure but nothing behind it: the browser asks when the map does.
        if (platform === 'web') return undefined;
        return (
          (await Location.requestForegroundPermissionsAsync()).status ===
          Location.PermissionStatus.GRANTED
        );
      case 'background-location':
        await Location.requestBackgroundPermissionsAsync();
        // Re-read rather than trust the request's answer: on iOS it resolves before the
        // authorization delegate settles (see `readBackgroundAccessGranted`).
        return await readBackgroundAccessGranted();
      case 'bluetooth':
        if (platform === 'ios') {
          const answer = await tryGetIrohLocation()?.requestBluetoothAccess?.();
          return answer === undefined || answer === 'undetermined'
            ? undefined
            : answer === 'granted';
        }
        return await requestAndroidBluetooth();
      case 'local-network':
        if (platform === 'ios') {
          const answer = await tryGetIrohLocation()?.requestLocalNetworkAccess?.();
          return answer === 'granted' ? true : answer === 'denied' ? false : undefined;
        }
        return await ensureLocalNetworkPermission();
      case 'notifications':
        return (
          (await PermissionsAndroid.request(POST_NOTIFICATIONS)) ===
          PermissionsAndroid.RESULTS.GRANTED
        );
      case 'battery':
        return await requestBatteryExemption();
    }
  } catch {
    return undefined;
  }
}

/**
 * Bluetooth, plus — before Android 17 — NEARBY_WIFI_DEVICES, which shares Bluetooth's "Nearby
 * devices" group: asked in the same breath it costs no second dialog, and asked anywhere else it
 * would be the unexplained prompt this flow exists to remove.
 */
async function requestAndroidBluetooth(): Promise<boolean> {
  const granted = await ensurePairingPermissions();
  const api = Number(Platform.Version);
  if (api >= ANDROID_NEARBY_WIFI_API && api < ANDROID_LOCAL_NETWORK_API) {
    await ensureLocalNetworkPermission();
  }
  return granted;
}

/** The exemption dialog is its own activity; its answer is readable once we are active again. */
async function requestBatteryExemption(): Promise<boolean | undefined> {
  const mod = tryGetIrohLocation();
  if (!mod?.requestBatteryOptimizationExemption?.()) return mod?.batteryOptimizationExempt?.();
  await new Promise<void>((resolve) => {
    let left = false;
    const timer = setTimeout(done, BATTERY_DIALOG_WAIT_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') left = true;
      else if (left) done();
    });
    function done() {
      clearTimeout(timer);
      sub.remove();
      resolve();
    }
  });
  return tryGetIrohLocation()?.batteryOptimizationExempt?.();
}

async function readForegroundGranted(): Promise<boolean | undefined> {
  try {
    return (
      (await Location.getForegroundPermissionsAsync()).status === Location.PermissionStatus.GRANTED
    );
  } catch {
    return undefined;
  }
}

async function checkAndroid(permission: Permission): Promise<boolean | undefined> {
  try {
    return await PermissionsAndroid.check(permission);
  } catch {
    return undefined;
  }
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
