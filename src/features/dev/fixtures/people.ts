import type { FixTransport, PairingMethod } from '@/features/social/core/types';

/**
 * The cast for store screenshots, and the shape of the walk behind them.
 *
 * Separated from `index.ts` so the invented people are one readable table
 * rather than something to pick out of the geometry. Every value here is
 * chosen to make the DERIVED state interesting: the roster is only honest if
 * `buildFriendPresence` has enough variety to show more than one presence
 * state, and the map only reads as a neighbourhood if the friends sit at
 * different bearings and distances rather than in a ring.
 *
 * These are not accounts. The `endpointId` values are obvious placeholders and
 * the key and ticket fields are empty, so nothing can be sealed for them or
 * dialled at them — see the module comment in `index.ts`.
 */

/**
 * Where the demo is staged when the device has no position of its own.
 *
 * `store-shots.ts` imports this for its geolocation override, so the browser's
 * reported position and the invented neighbourhood around it are the same place
 * by construction rather than by two constants that happen to agree.
 */
export const FIXTURE_ANCHOR = { lat: 47.6205, lon: -122.3212 } as const;

export interface FixturePerson {
  /** Placeholder endpoint id. Deliberately not a plausible ed25519 key. */
  readonly endpointId: string;
  readonly handle: string;
  /** Seed phrase for `generateLocalCryptid`, so the sigil is a real generated one. */
  readonly description: string;
  /** Six-digit signal colour, as the profile editor would store it. */
  readonly color: string;
  /** Where they are, relative to this device: compass bearing and metres. */
  readonly bearingDeg: number;
  readonly distanceM: number;
  readonly accuracyM: number;
  /** How old their POSITION is, in seconds. */
  readonly positionAgeS: number;
  /**
   * How long since their phone last proved it was running, in seconds.
   *
   * Equal to `positionAgeS` for someone moving. Much SMALLER for someone parked:
   * a stopped phone republishes its original position on cadence, which is what
   * separates "sat down" from "phone died" — and what renders them at full
   * opacity with a dashed marker instead of dimmed.
   */
  readonly contactAgeS: number;
  readonly parked: boolean;
  readonly via: FixTransport;
  readonly pairedDaysAgo: number;
  readonly pairingMethod: PairingMethod;
}

export const FIXTURE_FRIENDS: readonly FixturePerson[] = [
  {
    endpointId: 'fixture-0000000000000000000000000000000000000000000000000000000001',
    handle: 'wren',
    description: 'a moth that watches the bus stop',
    color: '#c6791a',
    bearingDeg: 38,
    distanceM: 210,
    accuracyM: 7,
    positionAgeS: 42,
    contactAgeS: 42,
    parked: false,
    via: 'lan',
    pairedDaysAgo: 184,
    pairingMethod: 'nearby',
  },
  {
    endpointId: 'fixture-0000000000000000000000000000000000000000000000000000000002',
    handle: 'sol',
    description: 'a lake thing with lantern eyes',
    color: '#2f9e6a',
    bearingDeg: 247,
    distanceM: 480,
    accuracyM: 11,
    // Parked at a bar for two hours, but the phone checked in a minute ago.
    positionAgeS: 2 * 60 * 60,
    contactAgeS: 74,
    parked: true,
    via: 'relay',
    pairedDaysAgo: 61,
    pairingMethod: 'nearby',
  },
  {
    endpointId: 'fixture-0000000000000000000000000000000000000000000000000000000003',
    handle: 'cass',
    description: 'a tall shape at the treeline',
    color: '#1a848e',
    bearingDeg: 152,
    distanceM: 940,
    accuracyM: 9,
    positionAgeS: 6 * 60,
    contactAgeS: 6 * 60,
    parked: false,
    via: 'direct',
    pairedDaysAgo: 12,
    pairingMethod: 'invite',
  },
  {
    endpointId: 'fixture-0000000000000000000000000000000000000000000000000000000004',
    handle: 'ode',
    description: 'a jackalope in a parking garage',
    color: '#8b5cf6',
    bearingDeg: 312,
    distanceM: 1_350,
    accuracyM: 18,
    // Recovered from the stash hours later — the offline-delivery story, shown.
    positionAgeS: 5 * 60 * 60,
    contactAgeS: 5 * 60 * 60,
    parked: false,
    via: 'stash',
    pairedDaysAgo: 3,
    pairingMethod: 'invite',
  },
];

/**
 * The demo walk.
 *
 * A single loop was not enough: forty points at walking pace covers about 900 m,
 * which lit two hexes and left the coverage readout at 3% — a screenshot that
 * says the exploration layer does nothing. What reads as a neighbourhood someone
 * lives in is months of errands, so the walk is generated as a seeded wander
 * that keeps returning home rather than a fixed path.
 *
 * `FIXTURE_TRAIL_SEED` makes it deterministic: the same ground is revealed on
 * every run, so two screenshot passes can be compared, and a change to the
 * exploration layer shows up as a change in the picture rather than as noise.
 */
export const FIXTURE_TRAIL_SEED = 0x5c0ffee;

/**
 * How many points the walk has. One per minute of walking, so this is also its duration.
 *
 * Sized for DENSITY inside a SMALL area, and both halves were learned the hard way. Exploration
 * is recorded per H3 cell and a coarse sector lights from a single explored child, so a long
 * thin walk reveals almost nothing: 900 points spread over a 1.1 km radius left the coverage
 * readout at 3%. But the fold is one awaited `recordFix` per point on the JS thread, and 3000 of
 * them starved the map so badly that no tile finished and the whole screen came out blank. This
 * fills a few blocks thoroughly and folds in well under a second.
 */
export const FIXTURE_TRAIL_POINTS = 400;

/** Metres per step. 400 × 25 m is 10 km of walking inside a few blocks. */
export const FIXTURE_TRAIL_STRIDE_M = 25;

/**
 * How far the wander is allowed to get from home before it is steered back.
 *
 * Deliberately tight. A random walk diffuses, and the same number of points spread over a
 * neighbourhood-sized radius reads as a thin smear rather than as somewhere lived in.
 */
export const FIXTURE_TRAIL_RADIUS_M = 450;
