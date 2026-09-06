import {
  FIX_STATE_NO_FIX,
  FIX_STATE_PARKED,
  type FixTransport,
  type Friend,
  type LocationFix,
} from './types';

/**
 * Presence rests on TWO clocks, and conflating them is what made this file wrong until 2026-09-05.
 *
 * - **Position age** (`now - fix.ts`) — how old the dot is.
 * - **Contact age** (`now - (fix.ts + publishedDeltaS * 1000)`) — how long since we could last
 *   prove the sender's process was running.
 *
 * They coincide only while someone is moving. A parked phone republishes its anchor on cadence and
 * deliberately preserves the ORIGINAL `ts` (see `DrainEngine::heartbeat`), so its position age
 * climbs without bound while its contact age stays small. Reading staleness off `ts` alone — which
 * is all this file used to do — therefore faded a friend who had sat down exactly like a friend
 * whose phone had died. Both froze at a stale position, and nothing on screen could separate them.
 *
 * The sender's own {@link LocationFix.state} does the rest of the work, because contact age is not
 * sufficient either: parked publishing on iOS rides on OS-granted wakes, and the measured gap
 * between contacts is p50 5 min but p90 92 min with a 17-hour tail. Any contact-age threshold low
 * enough to be useful would cry wolf nightly. A parked *declaration* survives that silence; a
 * heartbeat does not.
 */
export const LIVE_PRESENCE_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long a friend who was MOVING may go quiet before we say we have lost them.
 *
 * Deliberately shorter than the parked window. The asymmetry is the whole diagnostic value: a
 * moving phone generates deliveries, so silence from one is a real signal, while silence from a
 * parked one is Tuesday. Two hours clears the p90 gap of a healthy device with room to spare.
 */
export const MOVING_SILENCE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * How long ANY friend may go quiet before their position is stale regardless of what they claimed.
 *
 * 24h, matching `DEFAULT_T_LAPSE_MS` in `rust/src/ratchet.rs` and the `lapsed` verdict in
 * `SessionHealth` — a friend whose app has not run for about a day. The same number on purpose: a
 * card that reads "lapsed" beside a dot that still looks fine is the UI contradicting itself.
 *
 * It also has to clear the observed parked tail (17h on a working phone), or a parked declaration
 * would expire while it was still true.
 */
export const STALE_CONTACT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What we can honestly say about a friend right now.
 *
 * `parked` and `out-of-contact` are the two that used to be one thing.
 */
export type PresenceState =
  /** Heard from within {@link LIVE_PRESENCE_WINDOW_MS}, and the position is current. */
  | 'live'
  /** Heard from recently enough to be unremarkable, but not in the last few minutes. */
  | 'recent'
  /** They told us they had stopped. The position is correct and will not change; this is fine. */
  | 'parked'
  /** They are not parked and cannot get a position — indoors, a tunnel. They may be moving. */
  | 'no-fix'
  /** They were moving, or never said otherwise, and we have not heard from them since. */
  | 'out-of-contact'
  /** Nothing for {@link STALE_CONTACT_WINDOW_MS}. Their app has not run for about a day. */
  | 'lapsed'
  /** No fix from them at all. */
  | 'unknown';

export interface LatestLocationPoint {
  author: string;
  fix: LocationFix;
  receivedAt: number;
  /** How the fix reached this device. Absent on rows stored before provenance was recorded. */
  via?: FixTransport;
  /** Endpoint that performed that hop, when one was recorded. Travels with {@link via}. */
  viaPeer?: string;
}

export interface FriendPresence {
  friend: Friend;
  fix: LocationFix | null;
  distanceM: number | null;
  /** How old the POSITION is. What the dot on the map is showing. */
  positionAgeMs: number | null;
  /**
   * How long since we could last prove their phone was running.
   *
   * Equal to {@link positionAgeMs} when {@link contactKnown} is false — a sender that predates the
   * envelope stamps gives us no second clock, and assuming one would invent confidence we do not
   * have. That is a floor on the true contact age, never an over-estimate of liveness.
   */
  contactAgeMs: number | null;
  /** Whether {@link contactAgeMs} is a real measurement rather than a fallback to position age. */
  contactKnown: boolean;
  state: PresenceState;
  /**
   * How {@link fix} reached this device. Since only the newest fix per friend is retained, this is
   * the sole surviving surface for transport provenance.
   */
  via?: FixTransport;
  /**
   * WHO handed {@link fix} over — an endpoint id, which may be the author, a mutual friend, the
   * stash, or a device this user has never paired with. Read with {@link via}, never apart from
   * it; `describeDelivery` in `core/fix-transport.ts` is the only thing that should interpret it.
   */
  viaPeer?: string;
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

/**
 * When the sender last demonstrably had a process running, and whether that is a real answer.
 *
 * Note what is NOT used here: `receivedAt`. Arrival time looks like a free liveness signal and is a
 * trap — a phone that died at 21:00 leaves queued envelopes in the stash, and when those drain at
 * 23:00 their arrival says nothing about the sender still being alive. It would manufacture exactly
 * the false "she's fine" this whole model exists to prevent. Only a stamp the SENDER applied at
 * seal time proves the sender ran.
 */
function contactAtFor(fix: LocationFix): { at: number; known: boolean } {
  const delta = fix.publishedDeltaS;
  if (typeof delta === 'number' && Number.isFinite(delta) && delta >= 0) {
    return { at: fix.ts + delta * 1000, known: true };
  }
  return { at: fix.ts, known: false };
}

function presenceStateFor(
  fix: LocationFix,
  positionAgeMs: number,
  contactAgeMs: number
): PresenceState {
  // Past this, nothing the sender claimed is still load-bearing. A parked declaration a day old is
  // not evidence they are parked; it is evidence we have not heard from them.
  if (contactAgeMs > STALE_CONTACT_WINDOW_MS) return 'lapsed';

  switch (fix.state) {
    case FIX_STATE_PARKED:
      // The position is old ON PURPOSE and the sender said so. Not stale, not missing — parked.
      return 'parked';
    case FIX_STATE_NO_FIX:
      return contactAgeMs > MOVING_SILENCE_WINDOW_MS ? 'out-of-contact' : 'no-fix';
    default:
      // FIX_STATE_LIVE, a sender that predates the field, or a value from a newer peer we cannot
      // read. All three mean the same thing here: judge them on contact age alone. For a live fix
      // the two clocks coincide anyway, because it was sealed in the second it was measured.
      if (contactAgeMs <= LIVE_PRESENCE_WINDOW_MS && positionAgeMs <= LIVE_PRESENCE_WINDOW_MS) {
        return 'live';
      }
      if (contactAgeMs <= MOVING_SILENCE_WINDOW_MS) return 'recent';
      return 'out-of-contact';
  }
}

/** Whether the map should render this friend as diminished. Parked deliberately does not. */
export function isPresenceStale(state: PresenceState): boolean {
  return state === 'out-of-contact' || state === 'lapsed' || state === 'unknown';
}

/** Whether we believe their device is currently reachable. */
export function isPresenceOnline(state: PresenceState): boolean {
  return state === 'live' || state === 'recent' || state === 'parked' || state === 'no-fix';
}

/**
 * How close counts as NEARBY: roughly "in the same city".
 *
 * The roster header used to count every reachable friend, so someone on another continent read as
 * NEARBY — a word that means a distance, answering a question about connectivity. 25 km clears a
 * large metro from its centre without reaching the next one.
 *
 * Deliberately NOT surfaced as a caption in the UI. The number is a threshold the code uses, not a
 * fact the reader needs; "3 NEARBY" is the honest reading of a word people already understand.
 */
export const NEARBY_RADIUS_M = 25_000;

/**
 * Whether a friend is both reachable and close enough to be worth the word.
 *
 * A friend with no distance is NOT nearby — but that is a statement about what we know, not about
 * where they are, so callers that count nearby friends must not read the absence as "far away" in
 * any user-visible sentence. Unknown distance and known-far look identical here and should not
 * look identical on screen.
 */
export function isPresenceNearby(presence: FriendPresence): boolean {
  if (!isPresenceOnline(presence.state)) return false;
  return presence.distanceM !== null && presence.distanceM <= NEARBY_RADIUS_M;
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
    if (!current || point.fix.ts > current.fix.ts) newestByAuthor.set(key, point);
  }

  return input.friends
    .map((friend): FriendPresence => {
      const point = newestByAuthor.get(endpointKey(friend.endpointId));
      const fix = point?.fix ?? null;
      if (!fix) {
        return {
          friend,
          fix: null,
          positionAgeMs: null,
          contactAgeMs: null,
          contactKnown: false,
          state: 'unknown',
          distanceM: null,
        };
      }
      const contact = contactAtFor(fix);
      const positionAgeMs = Math.max(0, now - fix.ts);
      const contactAgeMs = Math.max(0, now - contact.at);
      return {
        friend,
        fix,
        positionAgeMs,
        contactAgeMs,
        contactKnown: contact.known,
        state: presenceStateFor(fix, positionAgeMs, contactAgeMs),
        via: point?.via,
        viaPeer: point?.viaPeer,
        distanceM:
          input.selfFix && isValidFix(input.selfFix)
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

/** "3 min", "2 hr", "4 days" — a bare duration, for composing into a sentence. */
export function formatAge(ageMs: number): string {
  if (ageMs < 60_000) return 'moments';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The one line the UI shows under a friend, in the terms this model exists to keep apart.
 *
 * Every branch answers "why is the dot where it is" rather than only "how old is it", because for
 * four of the seven states those are different questions with different answers.
 */
export function describePresence(presence: FriendPresence): string {
  const { state, positionAgeMs, contactAgeMs } = presence;
  switch (state) {
    case 'unknown':
      return 'Waiting for location';
    case 'live':
      return positionAgeMs !== null && positionAgeMs < 60_000
        ? 'Here now'
        : `Updated ${formatAge(positionAgeMs ?? 0)} ago`;
    case 'recent':
      return `Updated ${formatAge(positionAgeMs ?? 0)} ago`;
    case 'parked':
      // The sentence this whole change was for. It says the position is old AND that this is
      // expected, which is the difference between reassurance and worry.
      return `Parked here ${formatAge(positionAgeMs ?? 0)}`;
    case 'no-fix':
      return 'Moving, no signal fix';
    case 'out-of-contact':
      return `Out of contact ${formatAge(contactAgeMs ?? 0)}`;
    case 'lapsed':
      return `No signal for ${formatAge(contactAgeMs ?? 0)}`;
  }
}
