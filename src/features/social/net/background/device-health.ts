import { Platform } from 'react-native';

import {
  DEV_TELEMETRY_ENABLED,
  getSystemSnapshot,
  getTelemetry,
  unshippedCount,
  type Attributes,
  type SpanContext,
} from '@/features/dev/telemetry';
import { tryGetIrohLocation } from 'iroh-location';
import { createPersistentKV, loadPool, loadRatchetDrops, loadSharingEnabled } from '../persistence';
import { getStorageBackend, getStorageDegradationCount } from '../storage-health';
import { BACKGROUND_REFRESH_TASK } from './refresh-task';
import { loadReviveFenceArmedAt, REVIVE_FENCE_TASK } from './revive-task';
import { loadWatermarks, stampWatermark, watermarkAges, type Watermarks } from './watermarks';

/**
 * The three watermarks the native drain owns, read from where they actually happen.
 *
 * `fix`, `publish` and `push` used to be stamped by `location-sharing.ts` on the JS publish path.
 * That path was replaced by the Rust drain, and nothing took the stamping over — so the row kept
 * whatever it last held and `device.health` reported it as fact. On 2026-08-31 an iPhone showed a
 * publish age of 672 minutes through an afternoon in which it published 37 envelopes.
 *
 * Returns only the kinds native actually answered for, so a build whose binary predates the export
 * falls through to the JS row rather than losing the attributes altogether. A `null` from native
 * means "this has never happened", which `watermarkAges` renders as an absent attribute — a
 * different diagnosis from "happened a long time ago", and deliberately not collapsed into one.
 */
async function nativeWatermarks(): Promise<Watermarks> {
  try {
    const read = tryGetIrohLocation()?.publishWatermarks;
    if (!read) return {};
    const native = await read();
    const marks: Watermarks = {};
    if (typeof native.lastAcceptedAt === 'number') marks.fix = native.lastAcceptedAt;
    if (typeof native.lastPublishedAt === 'number') marks.publish = native.lastPublishedAt;
    if (typeof native.lastPushedAt === 'number') marks.push = native.lastPushedAt;
    return marks;
  } catch {
    // A node that has never started has no gate state to read. Omitted rather than guessed.
    return {};
  }
}

/**
 * `device.health` — a periodic assertion that this phone is alive, and a record of what the OS
 * actually thinks its state is.
 *
 * ## Why this exists
 * Every other span in the pipeline describes something that *happened*. The failures that have
 * cost us the most are the ones where nothing happens: an iPhone whose location task died with a
 * terminated process, an Android install whose foreground service was never restarted, a phone
 * whose "Always" permission was quietly downgraded to "While Using". None of those produce a
 * span, by construction — so from the collector's side a broken phone and an idle one are the
 * same empty query result.
 *
 * A record emitted on a fixed schedule inverts that. Absence becomes a *measurable gap* between
 * consecutive records, which is something an alert can fire on; and each record carries enough
 * state to say why, without anybody touching the device.
 *
 * ## It reports OS truth, not our beliefs
 * The point of most of these attributes is the mismatch. `sharing.enabled` is what the user asked
 * for and what we persisted; `task.location_running` is whether the OS agrees a location task is
 * actually running. A record where the first is true and the second is false IS the bug — and it
 * is invisible to anything that only asks our own state store.
 *
 * ## Naming
 * Deliberately not "heartbeat": `location-engine.ts` already uses that word for the ambient
 * publish tick, and conflating the two would make every log search ambiguous.
 */

/**
 * Foreground records are throttled to this. The periodic refresh already runs no more often than
 * ~15 min, so it is never throttled; this only stops a user who opens and closes the app twenty
 * times from emitting twenty identical records.
 */
export const DEVICE_HEALTH_MIN_INTERVAL_MS = 15 * 60_000;

/** What prompted the record. `refresh` is the scheduled one; the others are opportunistic. */
export type DeviceHealthTrigger = 'refresh' | 'foreground' | 'manual';

type LocationModule = typeof import('expo-location');
type TaskManagerModule = typeof import('expo-task-manager');
type BackgroundTaskModule = typeof import('expo-background-task');

// Static string literals, individually guarded — the `snapshot.ts` / `resource.ts` pattern. This
// runs inside headless background tasks, where a missing native module must cost an attribute,
// never a throw.
function tryLocation(): LocationModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-location') as LocationModule;
  } catch {
    return null;
  }
}

function tryTaskManager(): TaskManagerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-task-manager') as TaskManagerModule;
  } catch {
    return null;
  }
}

function tryBackgroundTask(): BackgroundTaskModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-background-task') as BackgroundTaskModule;
  } catch {
    return null;
  }
}

/**
 * What the OS says about our location authorization.
 *
 * `perm.background` is the one that matters and the one that silently regresses: on Android 11+
 * it cannot be prompted for at all (only granted in Settings), and on iOS a user can downgrade
 * "Always" to "While Using" from the system Settings app at any time, with no callback to us.
 * `perm.accuracy` catches the iOS 14 precise-location toggle, which degrades every fix without
 * changing any status we currently check.
 */
async function permissionAttributes(): Promise<Attributes> {
  const location = tryLocation();
  if (!location) return { 'perm.available': false };
  const attrs: Attributes = {};
  try {
    const fg = await location.getForegroundPermissionsAsync();
    attrs['perm.foreground'] = fg.status;
    const ios = (fg as { ios?: { scope?: string; accuracy?: string } }).ios;
    if (ios?.scope) attrs['perm.ios_scope'] = ios.scope;
    if (ios?.accuracy) attrs['perm.accuracy'] = ios.accuracy;
  } catch {
    attrs['perm.foreground'] = 'error';
  }
  try {
    const bg = await location.getBackgroundPermissionsAsync();
    attrs['perm.background'] = bg.status;
  } catch {
    // Some OS versions throw rather than reporting "denied" — the same asymmetry
    // `ensureBackgroundPermissions` already works around.
    attrs['perm.background'] = 'error';
  }
  return attrs;
}

/**
 * Whether the OS still has our tasks registered and running.
 *
 * `isTaskRegisteredAsync` says the handler is known to TaskManager; `task.location_running` says
 * `expo-location` is actually delivering to it. They come apart exactly in the failure we care
 * about — a task that survived as a registration but whose updates were never restarted after a
 * process kill.
 */
async function taskAttributes(): Promise<Attributes> {
  const attrs: Attributes = {};
  const taskManager = tryTaskManager();
  if (!taskManager) {
    attrs['task.manager_available'] = false;
    return attrs;
  }
  const registered = async (name: string): Promise<boolean | undefined> => {
    try {
      return await taskManager.isTaskRegisteredAsync(name);
    } catch {
      return undefined;
    }
  };
  attrs['task.refresh_registered'] = await registered(BACKGROUND_REFRESH_TASK);
  attrs['task.fence_registered'] = await registered(REVIVE_FENCE_TASK);

  // From the native runtime now. `sharing.enabled` says what the user asked for; this says
  // whether anything is actually being handed positions, and the gap between the two is the whole
  // background failure this path exists to close.
  const iroh = tryGetIrohLocation();
  attrs['task.location_running'] = iroh?.nativeBackgroundRunning?.();

  // The runtime's own account of itself, flattened under `location.*`.
  //
  // "Running" is necessary and nowhere near sufficient. A parked iPhone emits nothing by
  // construction, so on 2026-08-30 `task.location_running = true` was perfectly true of a phone
  // that had published nothing for 88 minutes — and no other span could tell that apart from a
  // phone that was simply not moving. `location.state` says which of the two it is,
  // `location.wake_reason` says what last ran it, and `location.fence_registered` says whether the
  // thing that is supposed to resurrect it actually exists.
  try {
    const native = iroh?.nativeBackgroundState?.();
    if (native) {
      for (const [key, value] of Object.entries(native)) {
        // Only scalars: an attribute that stringifies to `[object Object]` is worse than absent.
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          attrs[`location.${key}`] = value;
        }
      }
    }
  } catch {
    // A build whose binary predates the export, or a runtime that has never started. Omitted
    // rather than guessed — see the note on `outbox.pending` about the two different answers.
  }

  const backgroundTask = tryBackgroundTask();
  if (backgroundTask) {
    try {
      const status = await backgroundTask.getStatusAsync();
      // Mapped to names so a dashboard reads without a legend.
      attrs['task.refresh_status'] =
        status === backgroundTask.BackgroundTaskStatus.Available
          ? 'available'
          : status === backgroundTask.BackgroundTaskStatus.Restricted
            ? 'restricted'
            : 'unknown';
    } catch {
      attrs['task.refresh_status'] = 'error';
    }
  }
  return attrs;
}

/** What the user asked for, and what we have queued but not yet sent. */
async function intentAttributes(): Promise<Attributes> {
  const kv = createPersistentKV();
  const attrs: Attributes = {
    'storage.backend': getStorageBackend(),
    'storage.degradations': getStorageDegradationCount(),
  };
  try {
    attrs['sharing.enabled'] = await loadSharingEnabled(kv);
  } catch {
    attrs['sharing.enabled'] = undefined;
  }
  try {
    const pool = await loadPool(kv);
    attrs['sharing.recipients'] = pool?.sharingWith.length ?? 0;
    attrs['sharing.friends'] = pool ? Object.keys(pool.friends).length : 0;
  } catch {
    // Pool unreadable — the counts are omitted rather than guessed.
  }
  try {
    // From the native queue now (`outbox.rs`). Requires a started node, so on a wake that has not
    // built one this is absent rather than zero — "we could not ask" and "nothing is waiting" are
    // different answers and only one of them is good news.
    attrs['outbox.pending'] = await tryGetIrohLocation()?.outboxPending?.();
  } catch {
    attrs['outbox.pending'] = undefined;
  }
  try {
    // How many recipients the last publish was sealed for and dropped anyway. Read alongside
    // `sharing.recipients`, this is the difference between "publishing to two friends" and
    // "publishing to nobody, twice" — states that are otherwise identical in every other span the
    // device emits, and which stayed indistinguishable through a day-long mutual lapse.
    const drops = await loadRatchetDrops(kv);
    if (drops) {
      attrs['ratchet.dropped'] = drops.total;
      attrs['ratchet.dropped_lapsed'] = drops.lapsed;
      attrs['ratchet.dropped_no_session'] = drops.noSession;
    }
  } catch {
    // Unreadable — omitted rather than reported as zero, which would read as "all fine".
  }
  try {
    // How much telemetry this phone is still holding. A backlog that only grows says the collector
    // is unreachable from here — which is the one explanation for missing data that looks
    // identical to a dead phone, and is the difference between "her phone broke" and "our
    // collector broke". It arrives late, with the backlog, which is exactly when it is needed.
    attrs['telemetry.queued'] = await unshippedCount();
  } catch {
    attrs['telemetry.queued'] = undefined;
  }
  try {
    const armedAt = await loadReviveFenceArmedAt(kv);
    if (armedAt !== null) attrs['fence.armed_age_ms'] = Math.max(0, Date.now() - armedAt);
  } catch {
    // No fence record — omitted, which reads correctly as "never armed".
  }
  return attrs;
}

/**
 * Emit a `device.health` record.
 *
 * Never throws and never rejects: it is called from a `finally` on the background refresh path,
 * where a failure here would turn a diagnostic into an outage. Returns whether a record was
 * actually emitted (false when throttled).
 */
export async function recordDeviceHealth(
  trigger: DeviceHealthTrigger,
  parent?: SpanContext
): Promise<boolean> {
  // Assembling a record costs several OS round-trips (two permission reads, three task-registry
  // lookups, a background-refresh status probe) plus a handful of SQLite reads. In a stripped build
  // the span itself is already a no-op, but that work would still run on every periodic wake and
  // every foreground resume, and be thrown away — battery spent to produce nothing. The rest of the
  // instrumentation is a no-op call and genuinely free; this is the one place worth a guard.
  if (!DEV_TELEMETRY_ENABLED) return false;
  try {
    const kv = createPersistentKV();
    const now = Date.now();
    const marks = await loadWatermarks(kv);

    // The scheduled trigger is already rate-limited by the OS (~15 min at best), so only the
    // opportunistic ones are throttled. `manual` is the developer button and is never refused.
    if (trigger === 'foreground' && marks.health !== undefined) {
      if (now - marks.health < DEVICE_HEALTH_MIN_INTERVAL_MS) return false;
    }

    const [permissions, tasks, intent, snapshot] = await Promise.all([
      permissionAttributes(),
      taskAttributes(),
      intentAttributes(),
      getSystemSnapshot(),
    ]);
    // Native truth wins for the three the drain owns. The JS row is still written — by the refresh
    // task, the wake path and this function — but nothing writes its `fix`/`publish`/`push` stamps
    // any more, because the callers that did were replaced by the Rust drain. Reading the row
    // alone reported a phone that had published 37 envelopes that afternoon as eleven hours dead.
    const marksWithNative = { ...marks, ...(await nativeWatermarks()) };

    getTelemetry()
      .startSpan('device.health', {
        parent,
        attributes: {
          trigger,
          platform: Platform.OS,
          ...snapshot,
          ...permissions,
          ...tasks,
          ...intent,
          ...watermarkAges(marksWithNative, now),
        },
      })
      .end();

    await stampWatermark(kv, 'health', now);
    return true;
  } catch (error) {
    // A health record that cannot be assembled is itself a signal worth one span.
    getTelemetry()
      .startSpan('device.health', {
        parent,
        attributes: {
          trigger,
          platform: Platform.OS,
          'sc.drop_reason': 'health-assembly-failed',
          'exception.message': error instanceof Error ? error.message : String(error),
        },
      })
      .end();
    return false;
  }
}
