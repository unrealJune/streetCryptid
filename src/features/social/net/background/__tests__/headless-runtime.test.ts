import { AppState } from 'react-native';

import {
  ensureSharingArmedHeadless,
  flushBackgroundOutboxHeadless,
  runBackgroundBackfillHeadless,
} from '../headless-runtime';
import { registerActiveBackfillHandler } from '../register-task';

// The headless session news up a real LocationSharingService (→ native iroh `createNode`). Mock it so
// we can assert that the periodic backfill NEVER constructs one while a mounted runtime is alive —
// the regression where a second node's createNode → clearRuntime() tore the live node down.
// jest.mock factories may only reference `mock`-prefixed outer variables.
const mockInit = jest.fn(async () => {});
const mockSyncTrail = jest.fn(async () => {});
const mockShutdownAsync = jest.fn(async () => {});
const mockFlushDevTelemetry = jest.fn(async () => {});
const mockPublishFix = jest.fn(async () => 1);
const mockPushTrail = jest.fn(async () => {});
const mockServiceCtor = jest.fn();
/** Call order across the service, so we can assert drain-before-sync/push. */
const calls: string[] = [];

jest.mock('../../location-sharing', () => ({
  LocationSharingService: jest.fn().mockImplementation(() => {
    mockServiceCtor();
    return {
      init: mockInit,
      syncTrail: mockSyncTrail,
      publishFix: mockPublishFix,
      pushTrail: mockPushTrail,
      flushDevTelemetry: mockFlushDevTelemetry,
      shutdownAsync: mockShutdownAsync,
    };
  }),
}));

jest.mock('@/features/account/storage/profile-store', () => ({
  createCryptidProfileStore: jest.fn(() => ({
    load: jest.fn(async () => ({ handle: 'h', sigil: 's', cryptidName: 'c', color: '#fff' })),
  })),
}));

jest.mock('../background-outbox', () => ({
  backgroundOutbox: {
    pending: jest.fn(async () => 0),
    drain: jest.fn(async () => 0),
  },
}));

// The self-heal touches only the OS location task — no iroh node — so it is mocked at that seam.
const mockIsRunning = jest.fn(async () => false);
const mockStartBackgroundLocation = jest.fn(async (_cfg: unknown) => {});
// Spread the real module: `register-task` is pulled in transitively and needs the rest of it
// (`isBackgroundLocationAvailable`, `defineBackgroundLocationTask`) at import time.
jest.mock('../background-task', () => ({
  ...jest.requireActual('../background-task'),
  isBackgroundLocationRunning: () => mockIsRunning(),
  startBackgroundLocation: (cfg: unknown) => mockStartBackgroundLocation(cfg),
}));

const mockLoadSharingEnabled = jest.fn(async () => true);
jest.mock('../../persistence', () => ({
  createPersistentKV: jest.fn(() => ({})),
  loadSharingEnabled: () => mockLoadSharingEnabled(),
  loadShareIntervalMs: jest.fn(async () => 300_000),
}));

jest.mock('../battery-source', () => ({
  createBatterySource: jest.fn(() => ({
    read: jest.fn(async () => ({ level: 1, charging: false, lowPower: false })),
  })),
}));

function setAppState(state: string): void {
  (AppState as unknown as { currentState: string }).currentState = state;
}

/**
 * Take over `AppState.addEventListener` and hand back a setter that drives the transition. Models a
 * cold launch, where `currentState` is seeded from `initialAppState` — captured while iOS is still
 * `.inactive` — and only becomes meaningful once the app finishes launching.
 */
function captureAppStateTransition(): (next: string) => void {
  let listener: ((next: string) => void) | null = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    handler: (next: string) => void
  ) => {
    listener = handler;
    return { remove: jest.fn() };
  }) as unknown as typeof AppState.addEventListener);
  return (next: string) => {
    setAppState(next);
    listener?.(next);
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- mocked module, needs the handle
const { backgroundOutbox } = require('../background-outbox') as {
  backgroundOutbox: { pending: jest.Mock; drain: jest.Mock };
};

/** Arm the mocked outbox with `count` queued fixes that drain successfully. */
function queueFixes(count: number): void {
  let remaining = count;
  backgroundOutbox.pending.mockImplementation(async () => remaining);
  backgroundOutbox.drain.mockImplementation(async (publish: (fix: unknown) => Promise<void>) => {
    calls.push('drain');
    const n = remaining;
    for (let i = 0; i < n; i += 1)
      await publish({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: i });
    remaining = 0;
    return n;
  });
}

describe('headless-runtime', () => {
  let unregister: (() => void) | null = null;
  const originalAppState = AppState.currentState;

  beforeEach(() => {
    calls.length = 0;
    mockSyncTrail.mockImplementation(async () => {
      calls.push('syncTrail');
    });
    mockPushTrail.mockImplementation(async () => {
      calls.push('pushTrail');
    });
    backgroundOutbox.pending.mockImplementation(async () => 0);
    backgroundOutbox.drain.mockImplementation(async () => 0);
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
    setAppState(originalAppState);
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  // The force-quit-then-relaunch freeze. `EXTaskService` restores the location task in
  // `didFinishLaunchingWithOptions` and replays the events queued before `defineTask` ran as soon as
  // JS starts observing — module-eval time, before React mounts. At that point `activeHandler` is
  // null AND `AppState.currentState` is `'inactive'` (RN seeds it from `initialAppState`, captured
  // while iOS is still `.inactive`), so a point sample of either signal concludes "headless" while
  // the app is really booting into the foreground. The session that used to start here tore down the
  // node `LocationSharingProvider` was concurrently building, leaving the app on its blank gate.
  describe('cold launch', () => {
    it('does not spin up a headless node when the launch settles into the foreground', async () => {
      setAppState('inactive');
      const transitionTo = captureAppStateTransition();
      queueFixes(2);

      const pending = flushBackgroundOutboxHeadless();
      await Promise.resolve();
      transitionTo('active');

      await expect(pending).resolves.toBe(0);
      expect(mockServiceCtor).not.toHaveBeenCalled();
      // Nothing is lost: the fixes stay durable in the outbox and the mounted runtime drains them.
      expect(backgroundOutbox.drain).not.toHaveBeenCalled();
    });

    it('still runs when the launch settles into the background (a real OS wake)', async () => {
      setAppState('inactive');
      const transitionTo = captureAppStateTransition();
      queueFixes(2);

      const pending = flushBackgroundOutboxHeadless();
      await Promise.resolve();
      transitionTo('background');

      await expect(pending).resolves.toBe(2);
      expect(mockServiceCtor).toHaveBeenCalledTimes(1);
    });

    // Fail safe: a delayed publish costs a ping, tearing down the foreground node costs the app.
    it('assumes foreground when the app state never settles', async () => {
      jest.useFakeTimers();
      try {
        setAppState('inactive');
        captureAppStateTransition();
        queueFixes(1);

        const pending = flushBackgroundOutboxHeadless();
        await Promise.resolve();
        jest.runOnlyPendingTimers();

        await expect(pending).resolves.toBe(0);
        expect(mockServiceCtor).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('runBackgroundBackfillHeadless', () => {
    it('routes to the mounted runtime and never spins up a headless node when one is registered', async () => {
      // A backgrounded Android runtime is alive but NOT 'active' (the location foreground service).
      setAppState('background');
      const mountedBackfill = jest.fn(async () => {});
      unregister = registerActiveBackfillHandler(mountedBackfill);
      const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

      await runBackgroundBackfillHeadless(parent);

      expect(mountedBackfill).toHaveBeenCalledTimes(1);
      expect(mountedBackfill).toHaveBeenCalledWith(parent);
      // The critical guarantee: no second native node was created (which would clearRuntime() the
      // live one), so send + live receive keep working.
      expect(mockServiceCtor).not.toHaveBeenCalled();
      expect(mockInit).not.toHaveBeenCalled();
    });

    it('falls back to a headless session when no mounted runtime is registered', async () => {
      setAppState('background');
      const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

      await runBackgroundBackfillHeadless(parent);

      expect(mockServiceCtor).toHaveBeenCalledTimes(1);
      expect(mockInit).toHaveBeenCalledTimes(1);
      expect(mockSyncTrail).toHaveBeenCalledWith(0, parent);
      expect(mockShutdownAsync).toHaveBeenCalledTimes(1);
    });

    it('does not run a headless session while the app is active', async () => {
      setAppState('active');

      await runBackgroundBackfillHeadless();

      expect(mockServiceCtor).not.toHaveBeenCalled();
    });

    // syncTrail is bidirectional AND the only thing that pushes our own namespace to the stash.
    // Syncing before the drain stranded everything this wake published until the next OS wake.
    it('drains the outbox BEFORE syncing so freshly published fixes are pushed in the same wake', async () => {
      setAppState('background');
      queueFixes(2);

      await runBackgroundBackfillHeadless();

      expect(calls).toEqual(['drain', 'syncTrail']);
    });
  });

  describe('flushBackgroundOutboxHeadless', () => {
    it('is a no-op while the app is active (the mounted runtime drains its own outbox)', async () => {
      setAppState('active');

      const published = await flushBackgroundOutboxHeadless();

      expect(published).toBe(0);
      expect(mockServiceCtor).not.toHaveBeenCalled();
    });

    // publishFix broadcasts live and writes the LOCAL docs replica only. Without the push the
    // envelopes never leave the phone, so an offline friend has nothing to reconcile from.
    it('pushes the durable trail to the stash after draining, before the node shuts down', async () => {
      setAppState('background');
      queueFixes(3);
      const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

      const published = await flushBackgroundOutboxHeadless(parent);

      expect(published).toBe(3);
      expect(mockPublishFix).toHaveBeenCalledTimes(3);
      expect(mockPushTrail).toHaveBeenCalledWith(parent);
      expect(calls).toEqual(['drain', 'pushTrail']);
      // The node must still be alive for the push — shutdown is the session's `finally`.
      expect(mockPushTrail.mock.invocationCallOrder[0]).toBeLessThan(
        mockShutdownAsync.mock.invocationCallOrder[0]
      );
    });

    it('skips the push when nothing was published', async () => {
      setAppState('background');
      queueFixes(0);

      await flushBackgroundOutboxHeadless();

      expect(mockPushTrail).not.toHaveBeenCalled();
    });
  });

  // The self-heal is what turns a woken-but-dark phone back on. Its failure mode is silent by
  // nature — nothing publishes and nothing throws — so the guards are worth pinning down.
  describe('ensureSharingArmedHeadless', () => {
    beforeEach(() => {
      mockLoadSharingEnabled.mockImplementation(async () => true);
      mockIsRunning.mockImplementation(async () => false);
      mockStartBackgroundLocation.mockImplementation(async (_cfg: unknown) => {});
    });

    it('re-arms when sharing is enabled but the OS task is not running', async () => {
      await expect(ensureSharingArmedHeadless('geofence')).resolves.toBe(true);
      expect(mockStartBackgroundLocation).toHaveBeenCalledTimes(1);
      // Ambient cadence, never live: resurrecting a 4s cadence unattended is how the original
      // failure compounds instead of ending.
      expect(mockStartBackgroundLocation.mock.calls[0][0]).toMatchObject({
        timeIntervalMs: 300_000,
        distanceIntervalM: 0,
      });
    });

    it('does nothing when the user has sharing switched off', async () => {
      mockLoadSharingEnabled.mockImplementation(async () => false);

      await expect(ensureSharingArmedHeadless('backfill')).resolves.toBe(false);
      expect(mockStartBackgroundLocation).not.toHaveBeenCalled();
    });

    it('does nothing when the platform already restored the task itself', async () => {
      // Android's BOOT_COMPLETED receiver and START_REDELIVER_INTENT both land here.
      mockIsRunning.mockImplementation(async () => true);

      await expect(ensureSharingArmedHeadless('backfill')).resolves.toBe(false);
      expect(mockStartBackgroundLocation).not.toHaveBeenCalled();
    });

    it('swallows the Android background-FGS refusal instead of failing its caller', async () => {
      mockStartBackgroundLocation.mockImplementation(async (_cfg: unknown) => {
        throw new Error('ForegroundServiceStartNotAllowedException: startForegroundService()');
      });

      // Expected on a backfill wake, and must not reject — the caller still has real work to do.
      await expect(ensureSharingArmedHeadless('backfill')).resolves.toBe(false);
    });

    it('swallows an unexpected failure too', async () => {
      mockStartBackgroundLocation.mockImplementation(async (_cfg: unknown) => {
        throw new Error('location provider unavailable');
      });

      await expect(ensureSharingArmedHeadless('geofence')).resolves.toBe(false);
    });
  });
});
