import { buildFriendPresence, type LatestLocationPoint } from '@/features/social/core/presence';
import type { Friend, LocationFix } from '@/features/social/core/types';
import {
  SELF_AUTHOR,
  type TrailPoint,
  type TrailStorage,
} from '@/features/social/net/background/trail-store';

import * as noop from '../index.noop';
import * as real from '../index';

/**
 * The store build swaps `index.ts` for `index.noop.ts` via a Metro resolver rule, so a name
 * exported by one and not the other is a bundling error that ONLY appears in a release build —
 * the exact class of bug this mechanism must not introduce. This is the same contract
 * `features/dev/telemetry/__tests__/index-parity.test.ts` enforces, for the same reason.
 *
 * It carries one obligation telemetry's does not. Both fixture functions take the real data and
 * hand it back with demo data appended, so the stripped versions have to be IDENTITIES, not
 * no-ops: a stub that returned `[]` would compile, pass a name-parity check, and silently erase
 * the user's actual friends and trail in exactly the build nobody can debug.
 */
describe('screenshot fixtures barrel parity', () => {
  const realNames = Object.keys(real).sort();
  const noopNames = Object.keys(noop).sort();

  it('exports the same runtime names from the real and stripped barrels', () => {
    expect(noopNames).toEqual(realNames);
  });

  it('exports each name as the same kind of value', () => {
    const kinds = (mod: Record<string, unknown>): Record<string, string> =>
      Object.fromEntries(Object.keys(mod).map((key) => [key, typeof mod[key]]));
    expect(kinds(noop)).toEqual(kinds(real));
  });

  it('reports itself absent in the stripped build and present in the real one', () => {
    expect(noop.FIXTURES_ACTIVE).toBe(false);
    expect(real.FIXTURES_ACTIVE).toBe(true);
  });

  const selfFix: LocationFix = {
    lat: 47.6205,
    lon: -122.3212,
    accuracyM: 8,
    headingDeg: 0,
    ts: Date.now(),
  };

  const realFriend: Friend = {
    endpointId: 'aa'.repeat(32),
    handle: 'already-paired',
    sigil: ':)',
    recvPublic: 'bb'.repeat(32),
    ticket: 'ticket',
  };

  /** Annotated so `[]` below is an empty list of points, not `never[]`. */
  const noFixes: LatestLocationPoint[] = [];

  const realPoint: TrailPoint = {
    author: SELF_AUTHOR,
    seq: 7,
    fix: selfFix,
    receivedAt: selfFix.ts,
  };

  /** A `TrailStorage` that holds exactly `points` and records what was written. */
  function fakeStorage(points: TrailPoint[]) {
    const written: TrailPoint[] = [];
    const storage: TrailStorage = {
      putSelf: async (point) => void written.push(point),
      selfRange: async (sinceTs) => points.filter((point) => point.fix.ts >= sinceTs),
      putFriendLatest: async (point) => void written.push(point),
      friendLatest: async () => [],
      removeFriend: async () => 0,
      pruneSelf: async () => 0,
    };
    return { storage, written };
  }

  it('leaves real friends and the real trail untouched in the stripped build', async () => {
    const input = { friends: [realFriend], latest: noFixes, selfFix };
    expect(noop.withFixtureFriends(input)).toEqual(input);
    expect(noop.withFixtureTrail([realPoint], selfFix)).toEqual([realPoint]);

    const { storage } = fakeStorage([realPoint]);
    await expect(noop.withFixtureTrailStorage(storage).selfRange(0)).resolves.toEqual([realPoint]);
  });

  it('shows the exploration layer a walk without persisting any of it', async () => {
    // Exploration scans persisted storage rather than the trail the UI holds, so the demo walk
    // has to reach `selfRange` — but it must never reach `putSelf`, or a screenshot run would
    // write invented history into the user's own device.
    const { storage, written } = fakeStorage([realPoint]);
    const decorated = real.withFixtureTrailStorage(storage);

    const range = await decorated.selfRange(0);
    expect(range).toContainEqual(realPoint);
    expect(range.length).toBeGreaterThan(1);
    expect(new Set(range.map((point) => point.seq)).size).toBe(range.length);

    await decorated.putSelf(realPoint);
    expect(written).toEqual([realPoint]);
  });

  it('walks a bounded, reproducible neighbourhood rather than drifting off', () => {
    const walk = real.withFixtureTrail([], selfFix);
    const metresFromHome = (point: TrailPoint): number => {
      const north = (point.fix.lat - selfFix.lat) * 111_320;
      const east =
        (point.fix.lon - selfFix.lon) * 111_320 * Math.cos((selfFix.lat * Math.PI) / 180);
      return Math.hypot(north, east);
    };

    // Bounded: a plain random walk diffuses, which is what the steering exists to prevent.
    // The cap is the steer radius plus the overshoot the soft pull allows.
    expect(Math.max(...walk.map(metresFromHome))).toBeLessThan(1_200);
    // But it must actually cover ground, or the exploration layer has nothing to reveal.
    expect(Math.max(...walk.map(metresFromHome))).toBeGreaterThan(250);
    expect(walk.length).toBeGreaterThan(300);

    // Reproducible: the seeded generator must give the same ground every run, or two
    // screenshot passes cannot be compared and a rendering change hides in the noise.
    const again = real.withFixtureTrail([], selfFix);
    expect(again.map((point) => [point.fix.lat, point.fix.lon])).toEqual(
      walk.map((point) => [point.fix.lat, point.fix.lon])
    );
  });

  it('keeps the real friends and trail alongside the demo ones in the real build', () => {
    const { friends } = real.withFixtureFriends({
      friends: [realFriend],
      latest: noFixes,
      selfFix,
    });
    expect(friends).toContainEqual(realFriend);
    expect(friends.length).toBeGreaterThan(1);

    const trail = real.withFixtureTrail([realPoint], selfFix);
    expect(trail).toContainEqual(realPoint);
    expect(trail.length).toBeGreaterThan(1);
    // Demo points must not collide with stored ones, or the map draws one line twice.
    expect(new Set(trail.map((point) => point.seq)).size).toBe(trail.length);
  });

  it('produces demo friends the real presence builder can derive more than one state from', () => {
    // The point of the fixtures is that the SHIPPING code computes what is shown. If every demo
    // friend collapsed to the same presence state, the roster screenshot would be a lie of
    // omission about what the app can tell you.
    const input = real.withFixtureFriends({ friends: [] as Friend[], latest: noFixes, selfFix });
    const presence = buildFriendPresence(input);

    expect(presence.length).toBeGreaterThanOrEqual(3);
    expect(presence.every((entry) => entry.fix !== null)).toBe(true);
    expect(presence.every((entry) => (entry.distanceM ?? 0) > 0)).toBe(true);
    expect(new Set(presence.map((entry) => entry.state)).size).toBeGreaterThan(1);
    expect(presence.some((entry) => entry.state === 'parked')).toBe(true);
  });

  it('stages the demo around the device rather than at a fixed place', () => {
    const elsewhere: LocationFix = { ...selfFix, lat: -33.8688, lon: 151.2093 };
    const near = real.withFixtureFriends({
      friends: [] as Friend[],
      latest: noFixes,
      selfFix,
    }).latest;
    const far = real.withFixtureFriends({
      friends: [] as Friend[],
      latest: noFixes,
      selfFix: elsewhere,
    }).latest;

    expect(near[0].fix.lat).toBeCloseTo(selfFix.lat, 1);
    expect(far[0].fix.lat).toBeCloseTo(elsewhere.lat, 1);
  });
});
