import {
  FIX_STATE_LIVE,
  FIX_STATE_NO_FIX,
  FIX_STATE_PARKED,
  type Friend,
  type LocationFix,
} from '../types';
import {
  buildFriendPresence,
  LIVE_PRESENCE_WINDOW_MS,
  MOVING_SILENCE_WINDOW_MS,
  msUntilPresenceRosterChanges,
  PRESENCE_SYNC_IDLE_MS,
  PRESENCE_SYNC_MOVING_MS,
  PRESENCE_SYNC_RECENT_MS,
  presenceSyncIntervalMs,
  STALE_CONTACT_WINDOW_MS,
} from '../presence';

const NOW = 1_800_000_000_000;

const friend = (endpointId: string, handle: string): Friend => ({
  endpointId,
  handle,
  sigil: 'sigil',
  recvPublic: `${endpointId}-recv`,
  ticket: `${endpointId}-ticket`,
});

/** A fix `ageMs` old whose envelope was sealed `sealedAgoMs` ago (defaults to "sealed on capture"). */
const fixAged = (ageMs: number, state: number, sealedAgoMs = ageMs): LocationFix => ({
  lat: 51.5,
  lon: -0.12,
  accuracyM: 5,
  headingDeg: 0,
  ts: NOW - ageMs,
  state,
  publishedDeltaS: (ageMs - sealedAgoMs) / 1000,
});

const roster = (...fixes: LocationFix[]) =>
  buildFriendPresence({
    friends: fixes.map((_, index) => friend(`aa${index}`, `@f${index}`)),
    latest: fixes.map((fix, index) => ({
      author: `aa${index}`,
      fix,
      receivedAt: NOW,
    })),
    selfFix: null,
    now: NOW,
  });

describe('msUntilPresenceRosterChanges', () => {
  it('schedules nothing for a roster that can never change on its own', () => {
    const noFriends = buildFriendPresence({ friends: [], latest: [], selfFix: null, now: NOW });
    expect(msUntilPresenceRosterChanges(noFriends)).toBeNull();

    // A friend with no fix at all is `unknown`, and stays `unknown` however long we wait.
    const noFix = buildFriendPresence({
      friends: [friend('aa', '@moth')],
      latest: [],
      selfFix: null,
      now: NOW,
    });
    expect(msUntilPresenceRosterChanges(noFix)).toBeNull();
  });

  it('wakes at the minute boundary while an age label is counting in minutes', () => {
    // 90s old: state stays `live` for another ~13 min, but "1 min" becomes "2 min" in 30s.
    const due = msUntilPresenceRosterChanges(roster(fixAged(90_000, FIX_STATE_LIVE)));
    expect(due).toBeGreaterThan(29_000);
    expect(due).toBeLessThanOrEqual(31_000);
  });

  it('wakes at the live→recent boundary when that falls before the next label change', () => {
    // Exactly 30s short of the live window, and 10s past a whole minute — the state transition is
    // the sooner of the two and must win.
    const age = LIVE_PRESENCE_WINDOW_MS - 30_000;
    const due = msUntilPresenceRosterChanges(roster(fixAged(age, FIX_STATE_LIVE)));
    expect(due).toBeGreaterThan(0);
    expect(due).toBeLessThanOrEqual(30_001);
  });

  it('holds a parked friend to the hour, not the minute', () => {
    // Parked 3h ago and still in contact: the label reads "3 hr" and the only state change left is
    // `lapsed`, a day out. Nothing should wake this roster for the best part of an hour.
    const due = msUntilPresenceRosterChanges(
      roster(fixAged(3 * 3_600_000, FIX_STATE_PARKED, 60_000))
    );
    expect(due).toBeGreaterThan(50 * 60_000);
    expect(due).toBeLessThanOrEqual(3_600_001);
  });

  it('takes the soonest deadline across the whole roster', () => {
    const parked = fixAged(3 * 3_600_000, FIX_STATE_PARKED, 60_000);
    const moving = fixAged(90_000, FIX_STATE_LIVE);
    expect(msUntilPresenceRosterChanges(roster(parked, moving))).toBe(
      msUntilPresenceRosterChanges(roster(moving))
    );
  });

  it('never returns a deadline that would spin', () => {
    // A fix stamped in the future clamps to the floor rather than scheduling a zero-delay loop.
    const due = msUntilPresenceRosterChanges(roster(fixAged(-5_000, FIX_STATE_LIVE)));
    expect(due).not.toBeNull();
    expect(due as number).toBeGreaterThanOrEqual(1_000);
  });

  it('still tracks the day counter once a friend has lapsed', () => {
    const age = STALE_CONTACT_WINDOW_MS + 3_600_000;
    const due = msUntilPresenceRosterChanges(roster(fixAged(age, FIX_STATE_LIVE)));
    // Terminal state, but "1 day" still becomes "2 days" eventually.
    expect(due).not.toBeNull();
    expect(due as number).toBeGreaterThan(3_600_000);
  });
});

describe('presenceSyncIntervalMs', () => {
  it('holds no timer for an empty roster', () => {
    expect(presenceSyncIntervalMs([])).toBeNull();
  });

  it('polls fastest when someone is moving', () => {
    expect(presenceSyncIntervalMs(roster(fixAged(30_000, FIX_STATE_LIVE)))).toBe(
      PRESENCE_SYNC_MOVING_MS
    );
  });

  it('backs off to the idle cadence for a roster of parked friends', () => {
    expect(presenceSyncIntervalMs(roster(fixAged(3 * 3_600_000, FIX_STATE_PARKED, 60_000)))).toBe(
      PRESENCE_SYNC_IDLE_MS
    );
  });

  it('sits in between for a friend heard from recently but not just now', () => {
    const age = LIVE_PRESENCE_WINDOW_MS + 60_000;
    expect(presenceSyncIntervalMs(roster(fixAged(age, FIX_STATE_LIVE)))).toBe(
      PRESENCE_SYNC_RECENT_MS
    );
  });

  it('treats a friend with no signal fix as worth the faster cadence', () => {
    expect(presenceSyncIntervalMs(roster(fixAged(60_000, FIX_STATE_NO_FIX)))).toBe(
      PRESENCE_SYNC_RECENT_MS
    );
  });

  it('lets one moving friend set the cadence for the whole roster', () => {
    const parked = fixAged(3 * 3_600_000, FIX_STATE_PARKED, 60_000);
    const lapsed = fixAged(STALE_CONTACT_WINDOW_MS + 3_600_000, FIX_STATE_LIVE);
    const moving = fixAged(30_000, FIX_STATE_LIVE);
    expect(presenceSyncIntervalMs(roster(parked, lapsed, moving))).toBe(PRESENCE_SYNC_MOVING_MS);
  });

  it('does not speed up for a friend who is merely out of contact', () => {
    const age = MOVING_SILENCE_WINDOW_MS + 60_000;
    expect(presenceSyncIntervalMs(roster(fixAged(age, FIX_STATE_LIVE)))).toBe(
      PRESENCE_SYNC_IDLE_MS
    );
  });
});
