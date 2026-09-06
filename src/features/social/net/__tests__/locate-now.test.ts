/**
 * The locate button's read of "where am I".
 *
 * Reported 2026-09-05: the app opened on the user's position, but panning away and pressing locate
 * span forever. The opening camera comes from the capture pipeline's `onLocalFix`, so it proved
 * nothing about this path — `getCurrentPositionAsync` takes no timeout and offers no cancellation,
 * and a read that never settles leaves the control disabled with its spinner up for the rest of the
 * session. These pin the two ways out: answer from the platform cache when it is fresh, and stop
 * waiting on a read that does not come back.
 */

const positions: {
  current: 'resolves' | 'hangs' | 'rejects';
  lastKnown: { ts: number; lat: number } | null;
  currentCalls: number;
  lastKnownCalls: { maxAge: number | undefined }[];
} = {
  current: 'resolves',
  lastKnown: null,
  currentCalls: 0,
  lastKnownCalls: [],
};

const asPosition = (lat: number, ts: number) => ({
  coords: { latitude: lat, longitude: 2, accuracy: 5, heading: 0 },
  timestamp: ts,
});

jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
  getForegroundPermissionsAsync: async () => ({ status: 'granted' }),
  getCurrentPositionAsync: async () => {
    positions.currentCalls += 1;
    if (positions.current === 'hangs') return new Promise(() => {});
    if (positions.current === 'rejects') throw new Error('location unavailable');
    return asPosition(10, 1_000);
  },
  getLastKnownPositionAsync: async (options?: { maxAge?: number }) => {
    positions.lastKnownCalls.push({ maxAge: options?.maxAge });
    return positions.lastKnown ? asPosition(positions.lastKnown.lat, positions.lastKnown.ts) : null;
  },
}));

// eslint-disable-next-line import/first
import {
  ExpoLocationProvider,
  FOREGROUND_FIX_FRESH_MS,
  FOREGROUND_FIX_TIMEOUT_MS,
} from '../expo-location-provider';

describe('ExpoLocationProvider.getCurrentWithin', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    positions.current = 'resolves';
    positions.lastKnown = null;
    positions.currentCalls = 0;
    positions.lastKnownCalls = [];
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers from a fresh cached position without waiting on a GPS acquisition', async () => {
    positions.lastKnown = { ts: 9_000, lat: 51 };

    await expect(new ExpoLocationProvider().getCurrentWithin()).resolves.toMatchObject({ lat: 51 });
    expect(positions.currentCalls).toBe(0);
    expect(positions.lastKnownCalls).toEqual([{ maxAge: FOREGROUND_FIX_FRESH_MS }]);
  });

  it('reads the OS when the cache has nothing recent', async () => {
    await expect(new ExpoLocationProvider().getCurrentWithin()).resolves.toMatchObject({
      lat: 10,
      ts: 1_000,
    });
    expect(positions.currentCalls).toBe(1);
  });

  it('stops waiting on a read that never settles and falls back to the cache at any age', async () => {
    positions.current = 'hangs';
    const pending = new ExpoLocationProvider().getCurrentWithin();
    // The fresh check misses, so the stale fix is only reachable after the deadline.
    positions.lastKnown = { ts: 1, lat: 42 };

    await jest.advanceTimersByTimeAsync(FOREGROUND_FIX_TIMEOUT_MS + 1);

    await expect(pending).resolves.toMatchObject({ lat: 42 });
  });

  it('resolves null rather than hanging or throwing when the OS has nothing at all', async () => {
    positions.current = 'hangs';
    const pending = new ExpoLocationProvider().getCurrentWithin();
    await jest.advanceTimersByTimeAsync(FOREGROUND_FIX_TIMEOUT_MS + 1);
    await expect(pending).resolves.toBeNull();
  });

  it('treats a rejected read as an answered one, without waiting out the deadline', async () => {
    positions.current = 'rejects';
    positions.lastKnown = null;

    // No timer advance: a rejection must not be held until the timeout.
    await expect(new ExpoLocationProvider().getCurrentWithin()).resolves.toBeNull();
  });
});
