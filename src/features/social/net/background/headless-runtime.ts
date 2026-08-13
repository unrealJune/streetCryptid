import { AppState, Platform } from 'react-native';

import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import { createCryptidProfileStore } from '@/features/account/storage/profile-store';
import { LocationSharingService } from '../location-sharing';
import { createPersistentKV, loadShareIntervalMs, loadSharingEnabled } from '../persistence';
import { backgroundOutbox } from './background-outbox';
import { isBackgroundLocationRunning, startBackgroundLocation } from './background-task';
import { createBatterySource } from './battery-source';
import { cfgFromDecision } from './cadence-controller';
import { isNativeRuntimeClaimed, withNativeRuntimeSession } from './native-runtime-owner';
import { getActiveRefreshHandler } from './register-task';
import { createSamplingPolicy } from './sampling-policy';

interface HeadlessSession<T> {
  /** Cheap precondition checked BEFORE a node is spun up; `false` ⇒ skip and return `fallback`. */
  precheck?: () => Promise<boolean>;
  fallback: T;
  run: (service: LocationSharingService) => Promise<T>;
}

/**
 * Decide whether this process may build a second native node right now, and say why not when it
 * may not. Recorded on a span because a wrongly-permitted session is silent and terminal (see
 * `native-runtime-owner.ts`) and a wrongly-refused one just defers work to the next wake.
 */
function refusalReason(): string | null {
  // A mounted runtime owns the node from before its `createNode` until its shutdown. This is the
  // authoritative signal; `AppState` below is only a backstop for the window before the claim.
  if (isNativeRuntimeClaimed()) return 'runtime-claimed';
  // Foreground-ish. NOTE the explicit 'inactive': the old test here was `=== 'active'`, and iOS
  // reports 'inactive' both during a cold launch into the foreground and for as long as a system
  // permission alert is up — the two windows where the mounted runtime is most likely to be
  // building the very node we would tear down. 'background' (and an uninitialised 'unknown'/null,
  // which is what a genuine background launch can report before RCTAppState settles) still passes,
  // so the real headless pipeline is untouched.
  const appState = AppState.currentState;
  if (appState === 'active' || appState === 'inactive') return 'app-foreground';
  return null;
}

async function session<T>(opts: HeadlessSession<T>): Promise<T> {
  // Never run headless while a mounted runtime owns the node: it does this work itself. Spinning up
  // a second node would call createNode → clearRuntime and tear down the FOREGROUND node mid-flight
  // (breaking its gossip subscription and pairing poll). The batch is already persisted (senders
  // enqueue before calling us), so nothing is lost — the foreground engine flushes/syncs on its
  // next cycle.
  const refusedBefore = refusalReason();
  if (refusedBefore) {
    getTelemetry()
      .startSpan('bg.session', {
        attributes: {
          app_state: String(AppState.currentState),
          'sc.drop_reason': refusedBefore,
        },
      })
      .end();
    return opts.fallback;
  }
  if (opts.precheck && !(await opts.precheck())) return opts.fallback;

  const profile = await createCryptidProfileStore().load();
  if (!profile) {
    throw new Error('Cannot run background location work before a cryptid profile is configured.');
  }

  // Re-check immediately before `createNode`. Everything above awaited — a precheck hitting SQLite,
  // a profile load — and the app can have been foregrounded, or the mounted runtime can have staked
  // its claim, in that gap. This is the last point at which refusing is still free.
  const refusedAfter = refusalReason();
  const span = getTelemetry().startSpan('bg.session', {
    attributes: {
      app_state: String(AppState.currentState),
      ...(refusedAfter ? { 'sc.drop_reason': refusedAfter } : {}),
    },
  });
  if (refusedAfter) {
    span.end();
    return opts.fallback;
  }

  const service = new LocationSharingService();
  try {
    await service.init(profile.handle, profile.sigil, profile.cryptidName, profile.color, {
      mode: 'headless',
    });
    const result = await opts.run(service);
    span.setStatus('ok');
    return result;
  } catch (err) {
    span.recordError(err);
    throw err;
  } finally {
    // Drain telemetry before the node goes away — this short-lived context is exactly the one
    // whose batches die unexported if we skip it.
    span.end();
    await service.flushDevTelemetry();
    await service.shutdownAsync();
  }
}

/** Chain onto the shared lock so send-drain and refresh never spin up two native nodes at once. */
function runHeadless<T>(opts: HeadlessSession<T>): Promise<T> {
  return withNativeRuntimeSession(() => session(opts));
}

/** What woke us. Recorded on the span, because the trigger decides whether we are even allowed. */
export type SelfHealTrigger = 'refresh' | 'geofence';

/**
 * Re-arm OS background location updates if the user wants sharing on but the OS task is not running.
 *
 * This is the self-heal, and it exists because the ordinary re-arm path is unreachable from here:
 * `rearmBackgroundLocationTask` is only called via `startBackground`, which is driven by a React
 * hook, so it needs the UI to mount. A phone that was terminated can therefore be woken repeatedly —
 * for a refresh, for a geofence exit — sync happily, and still never restart its own location
 * reporting. That is exactly what kept an iPhone dark for hours after a live-mode test killed it.
 *
 * ## It is a safety net, not the primary mechanism — especially on Android
 * Both platforms already restore sharing on their own in the common cases, and this must not be
 * mistaken for what is holding them up:
 *  - **Android reboot** is handled by expo-task-manager's `TaskBroadcastReceiver`, which is
 *    registered for `BOOT_COMPLETED`; constructing its `TaskService` calls `restoreTasks()`, which
 *    re-registers the persisted location task, and `LocationTaskConsumer.didRegister` restarts
 *    location updates. `RECEIVE_BOOT_COMPLETED` is declared in `app.json`, and `location` is not one
 *    of the FGS types Android 15 bars from a `BOOT_COMPLETED` receiver. This path needs nothing
 *    from us.
 *  - **Android process kill** is handled by `LocationTaskService` returning `START_REDELIVER_INTENT`
 *    — the system restarts the service unaided.
 *  - **iOS** has no equivalent of either, which is why the geofence tripwire exists there.
 *
 * So on Android this only covers the residue: sharing enabled in our own persisted state while the
 * OS task is somehow not running. It is still worth attempting — if the user has turned off battery
 * optimisation it simply succeeds — but a `fgs-start-blocked` here is an expected outcome on a
 * `refresh` trigger, not an alarm. From a `geofence` trigger it should succeed, because a geofence
 * transition is on Android's exemption list for starting a foreground service from the background.
 *
 * Deliberately NOT wrapped in {@link runHeadless}: it touches only the OS location task, needs no
 * iroh node, and so cannot trip the `createNode → clearRuntime` singleton hazard described above.
 * That also makes it safe to call while a mounted runtime is alive.
 *
 * @returns true when it actually re-armed (for telemetry/tests), false when nothing was needed.
 */
export async function ensureSharingArmedHeadless(
  trigger: SelfHealTrigger,
  parent?: SpanContext
): Promise<boolean> {
  const kv = createPersistentKV();
  if (!(await loadSharingEnabled(kv))) return false;
  // Not a fallback for the platform's own restore — if the OS already brought the task back (boot
  // receiver, START_REDELIVER_INTENT), there is nothing to do and nothing to report.
  if (await isBackgroundLocationRunning()) return false;

  const span = getTelemetry().startSpan('bg.selfheal', {
    parent,
    attributes: { trigger, platform: Platform.OS },
  });
  try {
    const policy = createSamplingPolicy({ intervalMs: await loadShareIntervalMs(kv) });
    // Ambient cadence only. A self-heal never restores live mode: the watcher's window has almost
    // certainly lapsed by now, and resurrecting a 4-second cadence unattended is how this failure
    // mode compounds instead of ending.
    const decision = policy.decide({ battery: await createBatterySource().read() });
    span.setAttribute('decision.interval_ms', decision.timeIntervalMs);
    await startBackgroundLocation(
      cfgFromDecision(decision, {
        title: 'streetCryptid',
        body: "Keeping your friends' map current.",
        color: '#C6791A',
      })
    );
    span.setStatus('ok');
    return true;
  } catch (err) {
    // Android 12+ forbids starting a foreground service from the background, and
    // `startLocationUpdatesAsync` starts one. Distinguish it from a genuine failure: on a `refresh`
    // trigger this is the documented, expected outcome and the platform's own restore paths (boot
    // receiver, START_REDELIVER_INTENT) are what actually cover that case. On a `geofence` trigger
    // it is NOT expected — a geofence transition is on Android's exemption list — so seeing it there
    // means the exemption is not applying and is worth investigating. Never rethrow: a failed
    // self-heal must not fail its caller, which is usually a refresh with real work still to do.
    const message = err instanceof Error ? err.message : String(err);
    const blocked = /ForegroundServiceStartNotAllowed|not allowed to start service/i.test(message);
    span.setAttribute('sc.drop_reason', blocked ? 'fgs-start-blocked' : 'selfheal-failed');
    span.recordError(err);
    if (!blocked || trigger === 'geofence') {
      console.warn('[background-location] self-heal re-arm failed', err);
    }
    return false;
  } finally {
    span.end();
  }
}

/**
 * Publish queued fixes from a fresh headless context — the SEND path when the app is backgrounded or
 * killed. Called by the location TaskManager handler after it persists a batch. No-op while active
 * (the mounted runtime drains the outbox itself) or when nothing is queued.
 */
export function flushBackgroundOutboxHeadless(parent?: SpanContext): Promise<number> {
  return runHeadless({
    precheck: async () => (await backgroundOutbox.pending()) > 0,
    fallback: 0,
    run: async (service) => {
      const published = await backgroundOutbox.drain(async (fix, drainParent) => {
        await service.publishFix(fix, drainParent);
      }, parent);
      // `publishFix` only broadcasts live (to a swarm that is usually empty out here) and writes
      // the LOCAL docs replica. Without this push the envelopes never leave the phone, so a friend
      // who wasn't online at this exact moment never sees them — the whole reason the stash exists.
      // Must happen before the `finally` in `session()` shuts the node down.
      if (published > 0) await service.pushTrail(parent);
      return published;
    },
  });
}

/**
 * Periodic refresh path: heartbeat, drain the outbox, and reconcile each friend's CURRENT fix
 * (from the trail-stash + peers),
 * then publish anything still queued. Driven by the `expo-background-task` scheduler — see
 * `refresh-task.ts`. No-op while the app is active (the foreground lifecycle already syncs).
 */
export function runBackgroundRefreshHeadless(parent?: SpanContext): Promise<void> {
  // If a mounted runtime is alive it owns the process-wide native node. On Android that runtime
  // stays alive while backgrounded (the location foreground service), so `AppState` is NOT 'active'
  // and the `session()` guard alone would let us spin up a SECOND node here — whose `createNode`
  // calls `clearRuntime()` and tears the live node's subscriptions down, silently killing outgoing
  // publishes and live receive until relaunch. Route the refresh to the live runtime instead.
  // Self-heal BEFORE anything else, and regardless of whether a runtime is mounted. On iOS this
  // periodic wake is a regular opportunity to notice that the location task died with a previous
  // process. On Android it is only a backstop — boot and process-kill are already covered by the
  // platform (see `ensureSharingArmedHeadless`) — and is expected to be refused when it does fire.
  void ensureSharingArmedHeadless('refresh', parent);

  const runMounted = getActiveRefreshHandler();
  if (runMounted) return runMounted(parent);
  return runHeadless<void>({
    fallback: undefined,
    run: async (service) => {
      // Drain FIRST, then sync. `syncTrail` is bidirectional, so the one call both pushes what we
      // just published and pulls what friends left at the stash. Syncing first (as this did) meant
      // every fix published here waited for the *next* OS wake to be pushed — ~15 min at best on
      // Android, and on iOS potentially never.
      if ((await backgroundOutbox.pending()) > 0) {
        await backgroundOutbox.drain(async (fix, drainParent) => {
          await service.publishFix(fix, drainParent);
        }, parent);
      }
      await service.syncTrail(0, parent);
    },
  });
}
