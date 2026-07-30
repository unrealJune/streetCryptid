import { AppState } from 'react-native';

import { flushBackgroundOutboxHeadless, runBackgroundBackfillHeadless } from '../headless-runtime';
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

function setAppState(state: string): void {
  (AppState as unknown as { currentState: string }).currentState = state;
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
    jest.clearAllMocks();
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
});
