import type { Friend, LocationFix, MotionState } from '../types';
import {
  buildFriendPresence,
  distanceBetweenFixes,
  formatDistance,
  formatPresenceAge,
  MOVING_PRESENCE_WINDOW_MS,
  PARKED_PRESENCE_WINDOW_MS,
  RECENT_PRESENCE_WINDOW_MS,
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
        { author: 'aabb', seq: 900, fix: fix(47.62, -122.32, 900), receivedAt: 900 },
        { author: 'stranger', seq: 950, fix: fix(1, 2, 950), receivedAt: 950 },
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
        { author: 'two', seq: 100, fix: fix(47, -122, 100), receivedAt: 100 },
        { author: 'two', seq: 200, fix: fix(48, -123, 200), receivedAt: 200 },
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

/**
 * The two axes the UI used to conflate. Every case here is the same friend at the same coordinates
 * with the same stale position age — only what she SAID she was doing differs, and that alone
 * decides whether her dot is trustworthy.
 */
describe('aliveness versus not-moving-ness', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 10_000_000_000;

  function presenceAfter(silenceMs: number, motion: MotionState | undefined) {
    const measuredAt = now - 6 * HOUR;
    return buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [
        {
          author: 'aabb',
          seq: 42,
          fix: { ...fix(47.62, -122.32, measuredAt), ...(motion ? { motion } : {}) },
          receivedAt: now - silenceMs,
        },
      ],
      selfFix: null,
      now,
    })[0];
  }

  it('holds a friend who said she parked at full strength for a day', () => {
    // Six hours since she was measured, three since her phone last spoke. Nothing is wrong: she is
    // at home and heartbeating, and fading her out here would be the false alarm that teaches
    // people to ignore the signal.
    const parked = presenceAfter(3 * HOUR, 'parked');
    expect(parked.state).toBe('parked');
    expect(parked.motion).toBe('parked');
    expect(parked.ageMs).toBe(6 * HOUR);
    expect(parked.contactAgeMs).toBe(3 * HOUR);
  });

  it('darkens the identical friend once even a parked phone should have spoken', () => {
    // A parked phone is supposed to keep heartbeating, so a day of silence is not "still at home",
    // it is a broken app — the one thing worth telling someone about.
    expect(presenceAfter(PARKED_PRESENCE_WINDOW_MS + 1, 'parked').state).toBe('dark');
  });

  it('darkens a friend lost in motion within minutes', () => {
    // Same position, same staleness, opposite verdict: a person in motion invalidates her own
    // position, so riding towards this dot would be following a lie.
    expect(presenceAfter(MOVING_PRESENCE_WINDOW_MS + 1, 'moving').state).toBe('dark');
    expect(presenceAfter(MOVING_PRESENCE_WINDOW_MS - 1, 'moving').state).toBe('live');
  });

  it('never promotes an author who could not say to parked', () => {
    // Android has no motion state machine, and neither did any build before this field. A large
    // gap between capture and receipt really is the signature of a republished anchor — but it is
    // equally the signature of a slow stash delivery, and guessing wrong holds a stale dot at full
    // confidence for a day. The fallback declines to guess.
    const unknown = presenceAfter(3 * HOUR, undefined);
    expect(unknown.motion).toBeUndefined();
    expect(unknown.state).toBe('live');
    expect(presenceAfter(RECENT_PRESENCE_WINDOW_MS + 1, undefined).state).toBe('dark');
  });

  it('advances contact age on a heartbeat that does not move the position', () => {
    // The whole point of the seq tie-break: a heartbeat republishes the SAME fix.ts under a new
    // seq. Ordering on timestamp alone would discard it and with it the `receivedAt` that is the
    // only evidence her phone is still speaking.
    const measuredAt = now - 2 * HOUR;
    const [presence] = buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [
        {
          author: 'aabb',
          seq: 7,
          fix: fix(47.62, -122.32, measuredAt),
          receivedAt: now - 2 * HOUR,
        },
        { author: 'aabb', seq: 8, fix: fix(47.62, -122.32, measuredAt), receivedAt: now - 60_000 },
      ],
      selfFix: null,
      now,
    });

    expect(presence.ageMs).toBe(2 * HOUR);
    expect(presence.contactAgeMs).toBe(60_000);
  });
});
