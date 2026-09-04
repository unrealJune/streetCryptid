import type { FixTransport, Friend, LocationFix, MotionState } from './types';

export const LIVE_PRESENCE_WINDOW_MS = 15 * 60 * 1000;
export const RECENT_PRESENCE_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * How long a friend who told us she was **parked** stays at full confidence.
 *
 * Much longer than {@link RECENT_PRESENCE_WINDOW_MS}, and deliberately so: a stale dot at an anchor
 * is usually still a *correct* dot, because people stay put for hours. Fading her out after fifteen
 * minutes would be wrong nearly every time it fired, and a signal that cries wolf gets ignored —
 * which is worse than not having one.
 *
 * What it buys is that `dark` becomes rare enough to *mean* something: a parked phone is supposed to
 * keep heartbeating, so one that has said nothing for a day is a broken app, and that is worth
 * telling someone about.
 */
export const PARKED_PRESENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long a friend we lost **in motion** stays at full confidence.
 *
 * Short, because a person in motion invalidates her own position: riding towards a forty-minute-old
 * dot of someone who was cycling is the failure this app exists to prevent, and showing it at full
 * confidence is actively lying.
 */
export const MOVING_PRESENCE_WINDOW_MS = 10 * 60 * 1000;

export type PresenceFreshness = 'live' | 'recent' | 'stale' | 'unknown';

/**
 * What the friend's dot actually means right now — the two axes the UI kept conflating.
 *
 * - `live` — she is moving and we are hearing from her.
 * - `parked` — she told us she has settled. The position is *not* uncertain; it is exactly right
 *   and she simply is not moving. Renders at full strength.
 * - `dark` — we have lost contact for longer than her last known state justifies. Here the position
 *   may well be wrong, and saying so is the honest thing.
 * - `unknown` — no fix at all yet.
 */
export type PresenceState = 'live' | 'parked' | 'dark' | 'unknown';

export interface LatestLocationPoint {
  author: string;
  /**
   * The author's monotonic publish counter. Advances on **every** envelope including heartbeats,
   * so it moves while {@link LocationFix.ts} stands still — which is what makes "her phone spoke"
   * separable from "she moved".
   */
  seq: number;
  fix: LocationFix;
  receivedAt: number;
  /** How the fix reached this device. Absent on rows stored before provenance was recorded. */
  via?: FixTransport;
}

export interface FriendPresence {
  friend: Friend;
  fix: LocationFix | null;
  distanceM: number | null;
  /**
   * How old the *position* is — `now - fix.ts`. Says how long ago she was measured, which for a
   * parked friend keeps growing while nothing at all is wrong.
   */
  ageMs: number | null;
  /**
   * How long since her phone last **spoke** — `now - receivedAt`. Advances on every envelope,
   * heartbeats included, so it stands still only when we have genuinely lost her.
   *
   * Strictly this measures *our contact* rather than her aliveness: if this device is the one
   * offline, every friend's contact age grows at once. That is why {@link PresenceState} is not
   * called "alive", and why all friends going dark together should be read as a local fault.
   */
  contactAgeMs: number | null;
  /** What she said she was doing. `undefined` = could not say; never read it as moving. */
  motion?: MotionState;
  /**
   * ms since epoch when she entered {@link motion} — the answer to "since when", which
   * {@link ageMs} cannot give because a relaunch re-measures the same spot at a fresh timestamp.
   */
  motionSinceMs?: number;
  state: PresenceState;
  freshness: PresenceFreshness;
  /**
   * How {@link fix} reached this device. Since only the newest fix per friend is retained, this is
   * the sole surviving surface for transport provenance.
   */
  via?: FixTransport;
}

interface FriendPresenceInput {
  friends: readonly Friend[];
  latest: readonly LatestLocationPoint[];
  selfFix: LocationFix | null;
  now?: number;
}

function endpointKey(value: string): string {
  return value.trim().toLowerCase();
}

function isValidFix(fix: LocationFix): boolean {
  return (
    Number.isFinite(fix.lat) &&
    Number.isFinite(fix.lon) &&
    Number.isFinite(fix.ts) &&
    fix.lat >= -90 &&
    fix.lat <= 90 &&
    fix.lon >= -180 &&
    fix.lon <= 180
  );
}

function freshnessFor(ageMs: number | null): PresenceFreshness {
  if (ageMs === null) return 'unknown';
  if (ageMs <= LIVE_PRESENCE_WINDOW_MS) return 'live';
  if (ageMs <= RECENT_PRESENCE_WINDOW_MS) return 'recent';
  return 'stale';
}

/**
 * How long silence from this friend stays forgivable, given what she last told us she was doing.
 *
 * The decay rate is hers to set, not a global constant: what makes a position stop being true is
 * her moving, so the state she was in when we lost contact is exactly the right input.
 *
 * An author who could not say gets the middle window and is **never** promoted to `parked`. It is
 * tempting to infer it — a large `receivedAt - fix.ts` frozen at last contact really is the
 * signature of a phone republishing an anchor — but the same gap is produced by a fix that simply
 * took a long time to arrive through the stash, which is the common case for exactly the peers that
 * cannot send the flag. Guessing wrong here holds a possibly-stale dot at full confidence for a
 * day, so the fallback declines to guess.
 */
function contactWindowFor(motion: MotionState | undefined): number {
  if (motion === 'parked') return PARKED_PRESENCE_WINDOW_MS;
  if (motion === 'moving') return MOVING_PRESENCE_WINDOW_MS;
  return RECENT_PRESENCE_WINDOW_MS;
}

function stateFor(
  fix: LocationFix | null,
  contactAgeMs: number | null,
  motion: MotionState | undefined
): PresenceState {
  if (!fix || contactAgeMs === null) return 'unknown';
  if (contactAgeMs > contactWindowFor(motion)) return 'dark';
  // In contact. `parked` is a full-strength state, not a degraded one: the position is not
  // uncertain, she simply is not moving.
  return motion === 'parked' ? 'parked' : 'live';
}

/** Great-circle distance between two location fixes in metres. */
export function distanceBetweenFixes(a: LocationFix, b: LocationFix): number {
  const radiusM = 6_371_000;
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const latA = radians(a.lat);
  const latB = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Joins each friend to their current fix. `input.latest` is already one point per author — the
 * store keeps a single current fix per friend and no history (FORWARD-SECRECY.md §4.4) — but the
 * newest-wins fold is kept as a cheap invariant guard rather than a trusted precondition: a
 * duplicate here would silently render a friend at a stale position.
 *
 * Unknown authors are intentionally ignored; an inbound location can only become UI presence
 * after the matching endpoint is in the friend pool.
 */
export function buildFriendPresence(input: FriendPresenceInput): FriendPresence[] {
  const now = input.now ?? Date.now();
  const newestByAuthor = new Map<string, LatestLocationPoint>();

  for (const point of input.latest) {
    if (!isValidFix(point.fix)) continue;
    const key = endpointKey(point.author);
    const current = newestByAuthor.get(key);
    // Ordered `(fix.ts, seq)`, matching `isNewer` in trail-store: a heartbeat republishes the same
    // position under a NEW seq, so comparing timestamps alone would discard it — and with it the
    // `receivedAt` that is the only evidence her phone is still speaking.
    if (
      !current ||
      point.fix.ts > current.fix.ts ||
      (point.fix.ts === current.fix.ts && point.seq > current.seq)
    ) {
      newestByAuthor.set(key, point);
    }
  }

  return input.friends
    .map((friend): FriendPresence => {
      const point = newestByAuthor.get(endpointKey(friend.endpointId));
      const fix = point?.fix ?? null;
      const ageMs = fix ? Math.max(0, now - fix.ts) : null;
      const contactAgeMs = fix && point ? Math.max(0, now - point.receivedAt) : null;
      const motion = fix ? fix.motion : undefined;
      return {
        friend,
        fix,
        ageMs,
        contactAgeMs,
        motion,
        motionSinceMs: fix ? fix.motionSinceMs : undefined,
        state: stateFor(fix, contactAgeMs, motion),
        freshness: freshnessFor(ageMs),
        via: fix ? point?.via : undefined,
        distanceM:
          fix && input.selfFix && isValidFix(input.selfFix)
            ? distanceBetweenFixes(input.selfFix, fix)
            : null,
      };
    })
    .sort((a, b) => {
      if (a.fix && !b.fix) return -1;
      if (!a.fix && b.fix) return 1;
      if (a.distanceM !== null && b.distanceM !== null && a.distanceM !== b.distanceM) {
        return a.distanceM - b.distanceM;
      }
      return a.friend.handle.localeCompare(b.friend.handle);
    });
}

export function formatDistance(distanceM: number | null): string | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null;
  if (distanceM < 1000) {
    const rounded = Math.round(distanceM / 10) * 10;
    return `${Math.max(0, rounded)} m away`;
  }
  const precision = distanceM < 10_000 ? 1 : 0;
  return `${(distanceM / 1000).toFixed(precision)} km away`;
}

export function formatPresenceAge(ageMs: number | null): string {
  if (ageMs === null) return 'Waiting for location';
  if (ageMs < 60_000) return 'Updated now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * One line for a friend's row, answering the question the dot cannot: is this position still true?
 *
 * Three shapes, because three things are worth saying and they are not degrees of one thing:
 *
 * - **parked** — "Not moving · since 18:42". The position is exactly right and she is sitting still,
 *   so this leads with the reassurance and gives the time she settled rather than an age that grows
 *   all evening for no reason.
 * - **dark** — "No contact for 6 hr". Leads with the doubt, because here the dot may genuinely be
 *   wrong and that is the only honest thing to say.
 * - **live** — the existing age copy, which is right when she is actually moving.
 *
 * `since` is rendered as a clock time, not an elapsed duration: "since 18:42" stays true and stops
 * needing re-rendering, while "parked 4 hr ago" is a number that ticks for no reason and reads as
 * decay. Falls back to elapsed when the author could not say when.
 */
export function formatPresenceState(presence: FriendPresence, now = Date.now()): string {
  if (!presence.fix) return 'Waiting for location';
  if (presence.state === 'dark') {
    return `No contact for ${coarseDuration(presence.contactAgeMs ?? 0)}`;
  }
  if (presence.state === 'parked') {
    if (presence.motionSinceMs === undefined) return 'Not moving';
    return `Not moving · since ${clockTime(presence.motionSinceMs, now)}`;
  }
  return formatPresenceAge(presence.ageMs);
}

/** `18:42`, or `Tue 18:42` once it is no longer today — a bare time would silently mislead. */
function clockTime(atMs: number, now: number): string {
  const at = new Date(atMs);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const sameDay = new Date(now).toDateString() === at.toDateString();
  if (sameDay) return hhmm;
  const day = at.toLocaleDateString(undefined, { weekday: 'short' });
  return `${day} ${hhmm}`;
}

/** Durations for the dark state: coarse on purpose, because precision here implies confidence. */
function coarseDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The roster-row variant: the same three states, said in as few characters as possible.
 *
 * A row is a glance surface rendered at `numberOfLines={1}` beside a handle and a distance, so the
 * clock time in {@link formatPresenceState} is the first thing to clip on a narrow screen — and a
 * truncated "NOT MOVING · SIN…" is worse than not showing the time at all. The full line belongs on
 * the profile sheet, where there is room for it. Mirrors {@link compactDistance}'s reasoning.
 */
export function compactPresenceState(presence: FriendPresence): string {
  if (!presence.fix) return 'Waiting for location';
  if (presence.state === 'dark') {
    return `No contact ${coarseDuration(presence.contactAgeMs ?? 0)}`;
  }
  if (presence.state === 'parked') return 'Not moving';
  return formatPresenceAge(presence.ageMs);
}
