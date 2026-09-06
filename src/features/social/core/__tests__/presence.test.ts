import {
  FIX_STATE_LIVE,
  FIX_STATE_NO_FIX,
  FIX_STATE_PARKED,
  type Friend,
  type LocationFix,
} from '../types';
import {
  buildFriendPresence,
  describePresence,
  distanceBetweenFixes,
  formatAge,
  formatDistance,
  isPresenceNearby,
  isPresenceStale,
  NEARBY_RADIUS_M,
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
  it('carries the deliverer alongside the transport label', () => {
    const peer = 'bb'.repeat(32);
    const [presence] = buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [
        { author: 'aabb', fix: fix(1, 2, 900), receivedAt: 900, via: 'relay', viaPeer: peer },
      ],
      selfFix: null,
      now: 1000,
    });

    expect(presence.via).toBe('relay');
    expect(presence.viaPeer).toBe(peer);
  });

  it('drops both halves of the provenance when there is no fix to explain', () => {
    const [presence] = buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [],
      selfFix: null,
      now: 1000,
    });

    expect(presence.via).toBeUndefined();
    expect(presence.viaPeer).toBeUndefined();
  });

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
    expect(result[0].state).toBe('live');
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
    expect(result[1].state).toBe('unknown');
  });

  it('computes useful distance and freshness copy', () => {
    const metres = distanceBetweenFixes(fix(47.62, -122.32, 0), fix(47.621, -122.32, 0));
    expect(metres).toBeGreaterThan(100);
    expect(metres).toBeLessThan(120);
    expect(formatDistance(metres)).toBe('110 m away');
    expect(formatDistance(2400)).toBe('2.4 km away');
    expect(formatAge(30_000)).toBe('moments');
    expect(formatAge(3_600_000)).toBe('1 hr');
    expect(formatAge(50 * 60_000)).toBe('50 min');
    expect(formatAge(49 * 60 * 60_000)).toBe('2 days');
  });
});

// ---------------------------------------------------------------------------
// Parked vs offline
// ---------------------------------------------------------------------------
//
// The distinction this module exists to draw. In every case below the POSITION is equally old and
// equally frozen — that is the premise, not an accident — so any test that passes by looking at
// `fix.ts` is testing the wrong thing. What separates them is what the sender said about the
// envelope and when the sender last proved it was running.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A fix measured `positionAgeMs` ago and sealed `contactAgeMs` ago, at `now`. */
const stamped = (
  now: number,
  positionAgeMs: number,
  contactAgeMs: number,
  state?: number
): LocationFix => ({
  lat: 47.62,
  lon: -122.32,
  accuracyM: 5,
  headingDeg: 0,
  ts: now - positionAgeMs,
  ...(state !== undefined ? { state } : {}),
  publishedDeltaS: Math.round((positionAgeMs - contactAgeMs) / 1000),
});

const only = (fix: LocationFix, now: number) =>
  buildFriendPresence({
    friends: [friend('aabb', '@moth')],
    latest: [{ author: 'aabb', fix, receivedAt: now }],
    selfFix: null,
    now,
  })[0];

describe('a friend who stopped moving vs a friend whose phone died', () => {
  const now = 1_800_000_000_000;

  it('reads a parked friend as parked, not stale, however old the position is', () => {
    // Three hours since she moved, four minutes since her phone last spoke. Under the old
    // age-only model this was 'recent' sliding to 'stale' — indistinguishable from a dead phone.
    const presence = only(stamped(now, 3 * HOUR, 4 * MINUTE, FIX_STATE_PARKED), now);

    expect(presence.state).toBe('parked');
    expect(isPresenceStale(presence.state)).toBe(false);
    expect(presence.positionAgeMs).toBe(3 * HOUR);
    expect(presence.contactAgeMs).toBe(4 * MINUTE);
    expect(describePresence(presence)).toBe('Parked here 3 hr');
  });

  it('reads a phone that went quiet while moving as out of contact', () => {
    // Identical position age. The difference is entirely in the two fields on the envelope.
    const presence = only(stamped(now, 3 * HOUR, 3 * HOUR, FIX_STATE_LIVE), now);

    expect(presence.state).toBe('out-of-contact');
    expect(isPresenceStale(presence.state)).toBe(true);
    expect(describePresence(presence)).toBe('Out of contact 3 hr');
  });

  it('keeps believing a parked friend across a silence that would condemn a moving one', () => {
    // The measured reality of iOS: parked publishing rides on OS wakes, p90 92 min, 17-hour tail.
    // A threshold tuned to catch a dead phone quickly would flag this healthy one every night.
    const parked = only(stamped(now, 9 * HOUR, 5 * HOUR, FIX_STATE_PARKED), now);
    const moving = only(stamped(now, 9 * HOUR, 5 * HOUR, FIX_STATE_LIVE), now);

    expect(parked.state).toBe('parked');
    expect(moving.state).toBe('out-of-contact');
  });

  it('gives up on a parked declaration after a day, in step with the ratchet lapse', () => {
    const presence = only(stamped(now, 40 * HOUR, 30 * HOUR, FIX_STATE_PARKED), now);
    expect(presence.state).toBe('lapsed');
    expect(describePresence(presence)).toBe('No signal for 1 day');
  });

  it('separates "parked at the pub" from "somewhere on the Underground"', () => {
    // Byte-identical on the wire but for the state field: same frozen position, same fresh
    // contact. Only the sender knows which, and they are different sentences.
    const parked = only(stamped(now, 40 * MINUTE, 2 * MINUTE, FIX_STATE_PARKED), now);
    const noFix = only(stamped(now, 40 * MINUTE, 2 * MINUTE, FIX_STATE_NO_FIX), now);

    expect(parked.state).toBe('parked');
    expect(noFix.state).toBe('no-fix');
    expect(describePresence(noFix)).toBe('Moving, no signal fix');
  });

  it('treats a sender that predates the stamps exactly as before, claiming no extra knowledge', () => {
    const legacy: LocationFix = {
      lat: 47.62,
      lon: -122.32,
      accuracyM: 5,
      headingDeg: 0,
      ts: now - 3 * HOUR,
    };
    const presence = only(legacy, now);

    expect(presence.contactKnown).toBe(false);
    // Contact age falls back to position age — a floor on the truth, never an overstatement of
    // liveness. An old sender cannot be given the benefit of the doubt it never expressed.
    expect(presence.contactAgeMs).toBe(3 * HOUR);
    expect(presence.state).toBe('out-of-contact');
  });

  it('ignores a state value from a newer peer rather than failing on it', () => {
    const presence = only(stamped(now, 2 * MINUTE, 2 * MINUTE, 99), now);
    expect(presence.state).toBe('live');
  });

  it('does not treat late arrival from the stash as proof of life', () => {
    // The trap `receivedAt` sets: a phone that died at 21:00 leaves queued envelopes, and their
    // arrival two hours later says nothing about the sender. Only the sender's own seal stamp is
    // evidence, so a fix that arrives NOW but was sealed three hours ago is still out of contact.
    const presence = buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [
        {
          author: 'aabb',
          fix: stamped(now, 3 * HOUR, 3 * HOUR, FIX_STATE_LIVE),
          receivedAt: now,
        },
      ],
      selfFix: null,
      now,
    })[0];

    expect(presence.state).toBe('out-of-contact');
  });
});

describe('nearby is a radius, not a heartbeat', () => {
  const now = 1_000_000;
  const here = fix(47.62, -122.32, now);

  /** One friend, at a given distance north of us, freshly heard from. */
  function presenceAt(distanceM: number) {
    // ~111.32 km per degree of latitude — close enough to place a friend at a known range.
    const away = fix(47.62 + distanceM / 111_320, -122.32, now);
    const [presence] = buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [{ author: 'aabb', fix: { ...away, state: FIX_STATE_LIVE }, receivedAt: now }],
      selfFix: here,
      now,
    });
    return presence;
  }

  it('counts a friend inside the radius', () => {
    const presence = presenceAt(4_000);

    expect(presence.state).toBe('live');
    expect(isPresenceNearby(presence)).toBe(true);
  });

  it('does not count a reachable friend on the other side of the world', () => {
    const presence = presenceAt(NEARBY_RADIUS_M * 40);

    // Still online — the roster keeps them and still says so. Just not NEARBY.
    expect(presence.state).toBe('live');
    expect(isPresenceNearby(presence)).toBe(false);
  });

  it('holds the radius as an inclusive edge', () => {
    expect(isPresenceNearby(presenceAt(NEARBY_RADIUS_M - 100))).toBe(true);
    expect(isPresenceNearby(presenceAt(NEARBY_RADIUS_M + 100))).toBe(false);
  });

  it('is not nearby when we cannot say how far away they are', () => {
    const [presence] = buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [{ author: 'aabb', fix: { ...here, state: FIX_STATE_LIVE }, receivedAt: now }],
      // No fix of our own: distance is unknown, which is NOT the same as far.
      selfFix: null,
      now,
    });

    expect(presence.distanceM).toBeNull();
    expect(isPresenceNearby(presence)).toBe(false);
  });

  it('is not nearby once we have lost contact, however close the last fix was', () => {
    const stale = fix(47.62, -122.32, now - 30 * 60 * 60 * 1000);
    const [presence] = buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [{ author: 'aabb', fix: stale, receivedAt: now }],
      selfFix: here,
      now,
    });

    expect(presence.state).toBe('lapsed');
    expect(presence.distanceM).toBe(0);
    expect(isPresenceNearby(presence)).toBe(false);
  });

  it('counts a parked friend, who is exactly where they say they are', () => {
    const parked = {
      ...fix(47.625, -122.32, now - 40 * 60 * 1000),
      state: FIX_STATE_PARKED,
      publishedDeltaS: 39 * 60,
    };
    const [presence] = buildFriendPresence({
      friends: [friend('aabb', '@moth')],
      latest: [{ author: 'aabb', fix: parked, receivedAt: now }],
      selfFix: here,
      now,
    });

    expect(presence.state).toBe('parked');
    expect(isPresenceNearby(presence)).toBe(true);
  });
});
