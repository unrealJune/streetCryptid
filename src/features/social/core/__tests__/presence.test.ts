import type { Friend, LocationFix } from '../types';
import {
  buildFriendPresence,
  distanceBetweenFixes,
  formatDistance,
  formatPresenceAge,
} from '../presence';

const friend = (endpointId: string, handle: string): Friend => ({
  endpointId,
  handle,
  sigil: 'sigil',
  recvPublic: `${endpointId}-recv`,
  ticket: `${endpointId}-ticket`,
});

const fix = (lat: number, lon: number, ts: number): LocationFix => ({
  lat,
  lon,
  accuracyM: 5,
  headingDeg: 0,
  ts,
});

describe('friend presence', () => {
  it('matches endpoint IDs case-insensitively and ignores unknown authors', () => {
    const result = buildFriendPresence({
      friends: [friend('AABB', '@moth')],
      latest: [
        { author: 'aabb', fix: fix(47.62, -122.32, 900), receivedAt: 900 },
        { author: 'stranger', fix: fix(1, 2, 950), receivedAt: 950 },
      ],
      selfFix: fix(47.621, -122.32, 1000),
      now: 1000,
    });

    expect(result).toHaveLength(1);
    expect(result[0].friend.handle).toBe('@moth');
    expect(result[0].fix?.lat).toBe(47.62);
    expect(result[0].freshness).toBe('live');
  });

  it('uses the newest point and sorts located friends before unknown locations', () => {
    const result = buildFriendPresence({
      friends: [friend('one', '@one'), friend('two', '@two')],
      latest: [
        { author: 'two', fix: fix(47, -122, 100), receivedAt: 100 },
        { author: 'two', fix: fix(48, -123, 200), receivedAt: 200 },
      ],
      selfFix: null,
      now: 300,
    });

    expect(result.map((presence) => presence.friend.endpointId)).toEqual(['two', 'one']);
    expect(result[0].fix?.lat).toBe(48);
    expect(result[1].freshness).toBe('unknown');
  });

  it('computes useful distance and freshness copy', () => {
    const metres = distanceBetweenFixes(fix(47.62, -122.32, 0), fix(47.621, -122.32, 0));
    expect(metres).toBeGreaterThan(100);
    expect(metres).toBeLessThan(120);
    expect(formatDistance(metres)).toBe('110 m away');
    expect(formatDistance(2400)).toBe('2.4 km away');
    expect(formatPresenceAge(30_000)).toBe('Updated now');
    expect(formatPresenceAge(3_600_000)).toBe('Updated 1 hr ago');
  });
});
