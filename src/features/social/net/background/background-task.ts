import * as Location from 'expo-location';

import {
  getSystemSnapshot,
  getTelemetry,
  type SpanContext,
  withEventLogLaunchContext,
} from '@/features/dev/telemetry';
import type { LocationFix } from '../../core/types';
import type { AccuracyTier, ActivityKind } from './types';

/**
 * Lazily resolve `expo-task-manager`. Its module eval calls `requireNativeModule('ExpoTaskManager')`,
 * which throws when the native module isn't in the running binary (Expo Go, or a dev client built
 * before the package was added). Requiring it inside the functions — instead of at module top —
 * keeps merely IMPORTING this file side-effect-free, so the app boots and the feature degrades
 * gracefully. Availability is cached so we probe the native module only once.
 */
let taskManagerMod: typeof import('expo-task-manager') | null | undefined;

function tryTaskManager(): typeof import('expo-task-manager') | null {
  if (taskManagerMod !== undefined) return taskManagerMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load; see above
    taskManagerMod = require('expo-task-manager') as typeof import('expo-task-manager');
  } catch {
    taskManagerMod = null;
  }
  return taskManagerMod;
}

/** True when the ExpoTaskManager native module is present (i.e. a dev client built with it). */
export function isBackgroundLocationAvailable(): boolean {
  return tryTaskManager() !== null;
}

function taskManager(): typeof import('expo-task-manager') {
  const mod = tryTaskManager();
  if (!mod) {
    throw new Error(
      'Background location needs a rebuilt dev client — the ExpoTaskManager native module is ' +
        'missing. Run `bunx expo prebuild --clean` then `expo run:android` (or run:ios). ' +
        'Expo Go and JS-only reloads cannot add a native module.'
    );
  }
  return mod;
}

/**
 * The thin, hard-to-unit-test seam between the OS and our engine: registers an
 * `expo-task-manager` background task that `expo-location` invokes with fixes while the app is
 * backgrounded (iOS `UIBackgroundModes: location`) or via the Android foreground service
 * (`FOREGROUND_SERVICE_LOCATION`). Keep ALL logic out of here — the handler must be side-effect
 * minimal and headless-safe.
 *
 * Because the task can run in a fresh headless JS context, the handler cannot
 * assume a live React tree. The globally registered dispatcher either routes
 * the batch to the mounted service or persists it before restoring a minimal
 * iroh publisher to drain the outbox. See ARCHITECTURE §9.
 *
 * Requires `expo-task-manager` (install with `bunx expo install expo-task-manager`).
 */

/** TaskManager task name. Must be stable across app launches. */
export const BACKGROUND_LOCATION_TASK = 'streetcryptid.background-location';

/**
 * TaskManager task for the stationary anchor geofence. Must be stable across app launches — the OS
 * keeps monitoring the region while the app is suspended and will relaunch us into a headless
 * context to deliver the exit event. See `cadence-controller.ts`.
 */
export const BACKGROUND_ANCHOR_TASK = 'streetcryptid.anchor-geofence';

/** Batch sink used by the globally registered TaskManager handler. */
export interface BackgroundFixSink {
  onBackgroundFixes(fixes: readonly LocationFix[], parent?: SpanContext): Promise<void>;
}

export interface BackgroundStartConfig {
  accuracy: AccuracyTier;
  timeIntervalMs: number;
  distanceIntervalM: number;
  /** Android foreground-service notification (required for FOREGROUND_SERVICE_LOCATION). */
  notificationTitle: string;
  notificationBody: string;
  /** Android foreground-service notification accent color (#RRGGBB). */
  notificationColor?: string;
  /** iOS deferred-updates batching window (ms); 0 disables. */
  deferredUpdatesIntervalMs?: number;
  /**
   * iOS activity hint. With {@link pausesUpdatesAutomatically} it lets Core Location auto-suspend
   * GPS when the device is stationary and resume on motion. Ignored on Android. Default `other`.
   */
  activityType?: ActivityKind;
  /**
   * iOS: allow the system to pause updates for battery when it detects the device is stationary.
   * Ignored on Android. Default `false`: Core Location does not reliably RESUME after an auto-pause,
   * so leaving it on silently stops background location sharing until the app is next foregrounded
   * (the "pings only arrive when the app is opened" bug). Continuous sharing keeps this off.
   */
  pausesUpdatesAutomatically?: boolean;
}

/**
 * Register the TaskManager handler. Call once at module load (top level), passing a factory that
 * builds the persistent {@link BackgroundFixSink} — the factory runs inside the headless context,
 * so it must reconstruct the sink from persistent storage only (no closures over app state).
 */
export function defineBackgroundLocationTask(makeSink: () => BackgroundFixSink): void {
  taskManager().defineTask(BACKGROUND_LOCATION_TASK, ({ data, error }) =>
    withEventLogLaunchContext('background', async () => {
      const telemetry = getTelemetry();
      if (error) {
        console.warn('[background-location] task error', error);
        telemetry.log('error', `background task error: ${error.message}`);
        await telemetry.flush();
        return;
      }
      const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
      if (!locations || locations.length === 0) {
        return;
      }
      // One `bg.wake` span per OS delivery — THE anchor when debugging dropped pings: it says the
      // phone woke, with how many fixes, and in what network/battery/app state. Its context is passed
      // explicitly so outbox/publish/native spans form one hierarchy without AsyncLocalStorage.
      const span = telemetry.startSpan('bg.wake', { attributes: { fixes: locations.length } });
      span.setAttributes(await getSystemSnapshot());
      try {
        await makeSink().onBackgroundFixes(locations.map(toFix), span.context);
        span.setStatus('ok');
      } catch (err) {
        console.warn('[background-location] sink failed', err);
        span.recordError(err);
      } finally {
        span.end();
        // The OS may freeze this headless context the moment we return; unexported batches would
        // die with it.
        await telemetry.flush();
      }
    })
  );
}

/**
 * Register the anchor-geofence handler. Like {@link defineBackgroundLocationTask} this must run at
 * module scope so a headless relaunch can service the exit event. The callback fires when the
 * device LEAVES the stationary anchor, which is the signal to resume continuous sampling.
 *
 * Only exit transitions are acted on: we arm the region with `notifyOnEnter: false`, but the OS
 * still delivers an initial-state event on some platforms, so the type is checked here too.
 */
export function defineAnchorGeofenceTask(onExit: () => Promise<void>): void {
  taskManager().defineTask(BACKGROUND_ANCHOR_TASK, ({ data, error }) =>
    withEventLogLaunchContext('background', async () => {
      const telemetry = getTelemetry();
      if (error) {
        console.warn('[anchor-geofence] task error', error);
        telemetry.log('error', `anchor geofence task error: ${error.message}`);
        await telemetry.flush();
        return;
      }
      const payload = data as
        { eventType?: Location.GeofencingEventType; region?: Location.LocationRegion } | undefined;
      if (payload?.eventType !== Location.GeofencingEventType.Exit) return;

      // The counterpart to `bg.wake`: this span is the anchor when debugging "we went stationary and
      // never woke up again", the failure mode that makes anchoring risky.
      const span = telemetry.startSpan('anchor.exit', {
        attributes: { region: payload.region?.identifier ?? 'unknown' },
      });
      span.setAttributes(await getSystemSnapshot());
      try {
        await onExit();
        span.setStatus('ok');
      } catch (err) {
        console.warn('[anchor-geofence] exit handler failed', err);
        span.recordError(err);
      } finally {
        span.end();
        await telemetry.flush();
      }
    })
  );
}

/** The native seam the anchor controller drives; narrowed so tests can supply a fake. */
export interface AnchorGeofenceApi {
  startGeofencingAsync(taskName: string, regions: Location.LocationRegion[]): Promise<void>;
  stopGeofencingAsync(taskName: string): Promise<void>;
  hasStartedGeofencingAsync(taskName: string): Promise<boolean>;
}

/**
 * Arm a single exit-only geofence at `lat`/`lon`. Replaces any region already armed for the task —
 * expo-location's `startGeofencingAsync` overwrites the task's whole region set, so there is never
 * more than one anchor and no need to stop first.
 */
export async function startAnchorGeofence(
  api: AnchorGeofenceApi,
  lat: number,
  lon: number,
  radiusM: number
): Promise<void> {
  await api.startGeofencingAsync(BACKGROUND_ANCHOR_TASK, [
    {
      identifier: 'stationary-anchor',
      latitude: lat,
      longitude: lon,
      radius: radiusM,
      // We only care about leaving. Entry would fire immediately on arming (we are, by
      // construction, inside the region) and re-trigger the state machine for no reason.
      notifyOnEnter: false,
      notifyOnExit: true,
    },
  ]);
}

/** Tear the anchor down. Idempotent — safe when nothing is armed. */
export async function stopAnchorGeofence(api: AnchorGeofenceApi): Promise<void> {
  if (await api.hasStartedGeofencingAsync(BACKGROUND_ANCHOR_TASK)) {
    await api.stopGeofencingAsync(BACKGROUND_ANCHOR_TASK);
  }
}

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

interface BackgroundLocationTaskApi {
  hasStartedLocationUpdatesAsync(taskName: string): Promise<boolean>;
  stopLocationUpdatesAsync(taskName: string): Promise<void>;
  startLocationUpdatesAsync(taskName: string, options: Location.LocationTaskOptions): Promise<void>;
}

/** Re-arm OS background location updates with the current cadence on every app launch. */
export async function rearmBackgroundLocationTask(
  api: BackgroundLocationTaskApi,
  cfg: BackgroundStartConfig
): Promise<void> {
  if (await api.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
    await api.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  await api.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: mapAccuracy(cfg.accuracy),
    timeInterval: cfg.timeIntervalMs,
    distanceInterval: cfg.distanceIntervalM,
    deferredUpdatesInterval: cfg.deferredUpdatesIntervalMs ?? 0,
    activityType: mapActivity(cfg.activityType ?? 'other'),
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: cfg.pausesUpdatesAutomatically ?? false,
    foregroundService: {
      notificationTitle: cfg.notificationTitle,
      notificationBody: cfg.notificationBody,
      ...(cfg.notificationColor ? { notificationColor: cfg.notificationColor } : {}),
    },
  });
}

export function startBackgroundLocation(cfg: BackgroundStartConfig): Promise<void> {
  return rearmBackgroundLocationTask(Location, cfg);
}

/** Stop OS background location updates (and the Android foreground service). Idempotent. */
export async function stopBackgroundLocation(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}

export function isBackgroundLocationRunning(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
}

function toFix(pos: Location.LocationObject): LocationFix {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracyM: pos.coords.accuracy ?? 0,
    headingDeg: pos.coords.heading ?? 0,
    ts: pos.timestamp,
  };
}

function mapAccuracy(tier: AccuracyTier): Location.Accuracy {
  switch (tier) {
    case 'lowest':
      return Location.Accuracy.Lowest;
    case 'low':
      return Location.Accuracy.Low;
    case 'balanced':
      return Location.Accuracy.Balanced;
    case 'high':
      return Location.Accuracy.High;
    case 'highest':
      return Location.Accuracy.Highest;
  }
}

function mapActivity(kind: ActivityKind): Location.ActivityType {
  switch (kind) {
    case 'fitness':
      return Location.ActivityType.Fitness;
    case 'automotive':
      return Location.ActivityType.AutomotiveNavigation;
    case 'navigation':
      return Location.ActivityType.OtherNavigation;
    case 'other':
      return Location.ActivityType.Other;
  }
}
