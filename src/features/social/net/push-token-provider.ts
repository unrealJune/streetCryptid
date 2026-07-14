/**
 * Acquires this device's **native** push token (APNs on iOS / FCM on Android) for the trail stash,
 * and registers a handler that runs a trail sync when a silent `trail-sync` push arrives. We use
 * the *device* token (not an Expo push token) because the stash talks directly to APNs/FCM.
 *
 * expo-notifications is loaded lazily and every call is guarded, so web / Expo Go / a build without
 * the native module degrades to a no-op instead of crashing — the same lazy-native pattern as
 * `persistence.ts` and `secure-keys.ts`. Offline catch-up via reconciliation still works without a
 * token; the token only enables the *wake* that makes catch-up prompt.
 */

import { Platform } from 'react-native';

import type { StashPlatform } from './stash-client';

/** A device's native push destination, normalised to the stash's platform vocabulary. */
export interface DevicePushToken {
  token: string;
  platform: StashPlatform;
}

/**
 * The interesting fields of a received `trail-sync` push: which namespace changed and, on dev
 * telemetry builds, the stash's `traceparent` so the wake span links back to the exact push send.
 */
export interface TrailSyncPush {
  ns?: string;
  traceparent?: string;
}

export interface PushTokenProvider {
  /** Request permission + return this device's native push token, or null if unavailable/denied. */
  acquire(): Promise<DevicePushToken | null>;
  /** Run `onSync` whenever a `trail-sync` push is received. Best-effort; no-op when unavailable. */
  registerBackgroundSync(onSync: (push?: TrailSyncPush) => void): void;
}

/** Map an expo-notifications device-token `type` to our stash platform. Pure + tested. */
export function mapDeviceTokenType(type: string): StashPlatform | null {
  if (type === 'ios') return 'apns';
  if (type === 'android') return 'fcm';
  return null;
}

/** True when a received notification carries our silent trail-sync data payload. Pure + tested. */
export function isTrailSyncNotification(notification: unknown): boolean {
  const data = (
    notification as { request?: { content?: { data?: Record<string, unknown> } } } | null
  )?.request?.content?.data;
  return !!data && data.type === 'trail-sync';
}

/** Extract the {@link TrailSyncPush} fields from a trail-sync notification. Pure + tested. */
export function trailSyncPushData(notification: unknown): TrailSyncPush {
  const data = (
    notification as { request?: { content?: { data?: Record<string, unknown> } } } | null
  )?.request?.content?.data;
  return {
    ...(typeof data?.ns === 'string' ? { ns: data.ns } : {}),
    ...(typeof data?.traceparent === 'string' ? { traceparent: data.traceparent } : {}),
  };
}

interface ExpoNotificationsModule {
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  getDevicePushTokenAsync(): Promise<{ type: string; data: string }>;
  addNotificationReceivedListener(cb: (notification: unknown) => void): { remove(): void };
}

let expoNotifications: ExpoNotificationsModule | null | undefined;

function tryExpoNotifications(): ExpoNotificationsModule | null {
  if (expoNotifications !== undefined) return expoNotifications;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native load; see header
    expoNotifications = require('expo-notifications') as ExpoNotificationsModule;
  } catch {
    expoNotifications = null;
  }
  return expoNotifications;
}

/** expo-notifications–backed provider; no-ops when the native module is unavailable. */
export class ExpoPushTokenProvider implements PushTokenProvider {
  async acquire(): Promise<DevicePushToken | null> {
    if (Platform.OS === 'web') return null;
    const mod = tryExpoNotifications();
    if (!mod) return null;
    try {
      const permission = await mod.requestPermissionsAsync();
      if (!permission.granted) return null;
      const device = await mod.getDevicePushTokenAsync();
      const platform = mapDeviceTokenType(device.type);
      if (!platform || !device.data) return null;
      return { token: device.data, platform };
    } catch {
      return null;
    }
  }

  registerBackgroundSync(onSync: (push?: TrailSyncPush) => void): void {
    const mod = tryExpoNotifications();
    if (!mod) return;
    try {
      // Foreground + delivered data pushes nudge a reconciliation. Waking a fully-suspended app
      // from a silent data push additionally needs a TaskManager background task registered at
      // module load — tracked in https://github.com/unrealJune/trail-stash (PLAN.md); this
      // listener covers the common case.
      mod.addNotificationReceivedListener((notification) => {
        if (isTrailSyncNotification(notification)) onSync(trailSyncPushData(notification));
      });
    } catch {
      /* best-effort */
    }
  }
}

/** No-op provider for web / unavailable builds. */
export class NoopPushTokenProvider implements PushTokenProvider {
  async acquire(): Promise<DevicePushToken | null> {
    return null;
  }
  registerBackgroundSync(_onSync: (push?: TrailSyncPush) => void): void {}
}

/** Build the default provider: native on device, no-op on web. */
export function createDefaultPushTokenProvider(): PushTokenProvider {
  return Platform.OS === 'web' ? new NoopPushTokenProvider() : new ExpoPushTokenProvider();
}
