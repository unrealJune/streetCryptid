import { Platform } from 'react-native';

import type { Attributes } from './types';

/**
 * Static device/OS resource attributes stamped on EVERY span and log. They are constant for the
 * install's lifetime, so they belong on the OTLP resource (not per-span), and they let telemetry be
 * bucketed by platform, OS version, and device model — e.g. to compare iOS vs Android background
 * behaviour when debugging dropped location pings ("did this device even wake?"). Optional native
 * modules are lazily + individually guarded (same pattern as `snapshot.ts`): a missing module (web,
 * tests, an old dev client) degrades to fewer attributes, never a throw — this may run inside a
 * headless background task.
 */

type DeviceModule = typeof import('expo-device');
type ConstantsModule = typeof import('expo-constants');

function tryRequireDevice(): DeviceModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-device') as DeviceModule;
  } catch {
    return null;
  }
}

function tryRequireConstants(): ConstantsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-constants') as ConstantsModule;
  } catch {
    return null;
  }
}

/**
 * Low-cardinality OS name derived from `Platform.OS` — the reliable iOS/Android discriminator. We do
 * NOT use `expo-device`'s `osName` for the bucket key because on some Android devices it is a build
 * fingerprint; the Expo docs recommend `Platform.OS` for exactly this "is it iOS or Android" split.
 */
function osName(): string {
  switch (Platform.OS) {
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    default:
      return Platform.OS;
  }
}

/**
 * Build the static device/OS resource attributes. Best-effort: any field that cannot be determined
 * (missing native module, web) is simply omitted. `os.name` is always present (from `Platform.OS`).
 */
export function getDeviceResource(): Attributes {
  const attrs: Attributes = { 'os.name': osName() };

  // Platform.Version: iOS "16.4" (string), Android 34 (number). A native module gives a nicer value.
  if (Platform.Version !== undefined && Platform.Version !== null) {
    attrs['os.version'] = String(Platform.Version);
  }

  const device = tryRequireDevice();
  if (device) {
    if (device.osVersion) attrs['os.version'] = device.osVersion;
    if (device.modelName) attrs['device.model'] = device.modelName;
    if (device.manufacturer) attrs['device.manufacturer'] = device.manufacturer;
  }

  const version = tryRequireConstants()?.default?.expoConfig?.version;
  if (version) attrs['service.version'] = version;

  return attrs;
}
