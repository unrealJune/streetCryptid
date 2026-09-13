import { generateLocalCryptid } from '@/features/account/core/cryptid-generator';
import type { LatestLocationPoint } from '@/features/social/core/presence';
import { FIX_STATE_LIVE, FIX_STATE_PARKED } from '@/features/social/core/types';
import type { Friend, LocationFix } from '@/features/social/core/types';
import type { TrailPoint, TrailStorage } from '@/features/social/net/background/trail-store';
import { SELF_AUTHOR } from '@/features/social/net/background/trail-store';

import {
  FIXTURE_ANCHOR,
  FIXTURE_FRIENDS,
  FIXTURE_TRAIL_POINTS,
  FIXTURE_TRAIL_RADIUS_M,
  FIXTURE_TRAIL_SEED,
  FIXTURE_TRAIL_STRIDE_M,
} from './people';

/**
 * Demo state for store screenshots — friends on the map and a walked trail.
 *
 * ## Why this exists
 * The listing needs the shot that explains the product: several people on one
 * map, and enough walked ground for the exploration layer to read as anything.
 * Neither can be staged on a single device. Pairing is bilateral and in person,
 * a friend's dot only exists once their phone has published one, and coverage
 * is the residue of weeks of walking.
 *
 * ## Why it is not a runtime flag
 * `metro.config.js` resolves `@/features/dev/fixtures` to `index.noop.ts`
 * unless `EXPO_PUBLIC_SCREENSHOT_FIXTURES=1`, exactly as it already does for
 * `@/features/dev/telemetry`. So in every build that is not a screenshot run,
 * the invented people below are not disabled — they are ABSENT, along with this
 * whole module. That matters more here than it does for telemetry: a runtime
 * gate on fabricated friends is one mistyped variable away from putting
 * strangers on a real user's map, and `scripts/check-release-telemetry.mjs`
 * fails CI if a store-bound profile sets the variable at all.
 *
 * ## What it does NOT do
 * It invents inputs, never outputs. The fixtures go in as `Friend` records and
 * `LocationFix` points and are then derived by the same `buildFriendPresence`
 * the app runs — so the ages, distances, presence states and marker styling on
 * a screenshot are computed by the shipping code, from data of a plausible age.
 * Nothing here fakes a rendering. It also publishes nothing: these people have
 * no keys, no tickets and no swarm, so no envelope can be sealed for them.
 */

/** Metres per degree of latitude, near enough at this scale. */
const M_PER_DEG_LAT = 111_320;

function metresToLat(metres: number): number {
  return metres / M_PER_DEG_LAT;
}

function metresToLon(metres: number, atLat: number): number {
  return metres / (M_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180));
}

/** Where the demo is staged when the device has no position of its own yet. */
const FALLBACK_ANCHOR: LocationFix = {
  ...FIXTURE_ANCHOR,
  accuracyM: 8,
  headingDeg: 0,
  ts: 0,
};

function offsetFrom(
  anchor: LocationFix,
  bearingDeg: number,
  distanceM: number
): { lat: number; lon: number } {
  const radians = (bearingDeg * Math.PI) / 180;
  return {
    lat: anchor.lat + metresToLat(Math.cos(radians) * distanceM),
    lon: anchor.lon + metresToLon(Math.sin(radians) * distanceM, anchor.lat),
  };
}

/**
 * Build the fixture friends and their latest fixes around `anchor`.
 *
 * Ages are spread on purpose: the roster is only honest if it shows more than
 * one presence state, and `buildFriendPresence` reads both clocks
 * (`ts` and `publishedDeltaS`) to tell a parked friend from a lost one.
 */
function fixtureFriends(
  anchor: LocationFix,
  now: number
): { friends: Friend[]; latest: LatestLocationPoint[] } {
  const friends: Friend[] = [];
  const latest: LatestLocationPoint[] = [];

  FIXTURE_FRIENDS.forEach((person, index) => {
    const cryptid = generateLocalCryptid(person.description, index + 1);
    const endpointId = person.endpointId;
    friends.push({
      endpointId,
      handle: person.handle,
      sigil: cryptid.sigil,
      cryptidName: cryptid.name,
      color: person.color,
      // A fixture friend is deliberately unusable as a peer: the key and ticket
      // fields are placeholders, so nothing can be sealed for or dialled at it.
      recvPublic: person.endpointId,
      ticket: '',
      pairedAt: now - person.pairedDaysAgo * 24 * 60 * 60 * 1000,
      pairingMethod: person.pairingMethod,
    });

    const position = offsetFrom(anchor, person.bearingDeg, person.distanceM);
    const ts = now - person.positionAgeS * 1000;
    latest.push({
      author: endpointId,
      fix: {
        lat: position.lat,
        lon: position.lon,
        accuracyM: person.accuracyM,
        headingDeg: person.bearingDeg,
        ts,
        state: person.parked ? FIX_STATE_PARKED : FIX_STATE_LIVE,
        // A parked phone republishes its original position on cadence, so its
        // contact age stays small while its position age climbs. That gap is
        // what renders it at full opacity with a dashed marker rather than dim.
        publishedDeltaS: person.parked ? person.positionAgeS - person.contactAgeS : 0,
      },
      receivedAt: now - person.contactAgeS * 1000,
      via: person.via,
    });
  });

  return { friends, latest };
}

/**
 * A seeded wander around the anchor — the ground a resident would have covered.
 *
 * A plain random walk diffuses: it drifts off in whatever direction it started
 * and leaves a thin smear rather than a filled-in neighbourhood. So each step
 * turns by a small random amount (which keeps the path smooth, like streets)
 * and, once past {@link FIXTURE_TRAIL_RADIUS_M}, is steered back toward home
 * with a strength that grows with the distance. The result reads as somewhere
 * lived in rather than as a route.
 *
 * The generator is a plain LCG rather than `Math.random`, so the same ground is
 * revealed on every run and a screenshot pass is reproducible.
 */
function fixtureTrail(anchor: LocationFix, now: number): TrailPoint[] {
  const points: TrailPoint[] = [];
  let lat = anchor.lat;
  let lon = anchor.lon;
  let heading = 0;
  let seed = FIXTURE_TRAIL_SEED;
  // Numerical Recipes' LCG constants; any full-period generator would do.
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  // One point a minute, walking pace, ending now.
  const stepMs = 60_000;

  for (let index = 0; index < FIXTURE_TRAIL_POINTS; index++) {
    // Wander: a gentle turn each step rather than a fresh bearing, so the path
    // has the persistence of someone following streets.
    heading += (random() - 0.5) * 70;

    const northM = (lat - anchor.lat) * M_PER_DEG_LAT;
    const eastM = (lon - anchor.lon) * M_PER_DEG_LAT * Math.cos((anchor.lat * Math.PI) / 180);
    const fromHomeM = Math.hypot(northM, eastM);
    if (fromHomeM > FIXTURE_TRAIL_RADIUS_M) {
      // Steer home, harder the further out we are. `atan2(east, north)` because
      // these are compass bearings, not mathematical angles.
      const homeward = (Math.atan2(-eastM, -northM) * 180) / Math.PI;
      const pull = Math.min(1, (fromHomeM - FIXTURE_TRAIL_RADIUS_M) / FIXTURE_TRAIL_RADIUS_M);
      const delta = ((homeward - heading + 540) % 360) - 180;
      heading += delta * pull * 0.5;
    }

    const radians = (heading * Math.PI) / 180;
    lat += metresToLat(Math.cos(radians) * FIXTURE_TRAIL_STRIDE_M);
    lon += metresToLon(Math.sin(radians) * FIXTURE_TRAIL_STRIDE_M, lat);

    const ts = now - (FIXTURE_TRAIL_POINTS - index) * stepMs;
    points.push({
      author: SELF_AUTHOR,
      seq: index + 1,
      fix: {
        lat,
        lon,
        accuracyM: 6,
        headingDeg: ((heading % 360) + 360) % 360,
        ts,
        state: FIX_STATE_LIVE,
        publishedDeltaS: 0,
      },
      receivedAt: ts,
    });
  }

  return points;
}

interface PresenceInput {
  friends: readonly Friend[];
  latest: readonly LatestLocationPoint[];
  selfFix: LocationFix | null;
}

/**
 * Add the demo friends to what `buildFriendPresence` is about to derive.
 *
 * Additive, never replacing: a screenshot run that HAS paired someone for real
 * still shows them, and they sort in by the same rules.
 */
export function withFixtureFriends<T extends PresenceInput>(input: T): T {
  const now = Date.now();
  const anchor = input.selfFix ?? FALLBACK_ANCHOR;
  const { friends, latest } = fixtureFriends(anchor, now);
  return {
    ...input,
    friends: [...input.friends, ...friends],
    latest: [...input.latest, ...latest],
  };
}

/** Add the demo walk to this device's own trail, so exploration has something to reveal. */
export function withFixtureTrail(
  trail: readonly TrailPoint[],
  selfFix: LocationFix | null
): TrailPoint[] {
  const anchor = selfFix ?? FALLBACK_ANCHOR;
  // Seq numbers continue past whatever is really stored, so the two do not collide.
  const offset = trail.reduce((highest, point) => Math.max(highest, point.seq), 0);
  const demo = fixtureTrail(anchor, Date.now()).map((point) => ({
    ...point,
    seq: point.seq + offset,
  }));
  return [...trail, ...demo];
}

/**
 * Wrap the trail storage the exploration layer backfills from.
 *
 * A third seam is needed because exploration does NOT read the trail this
 * provider hands the UI — `createLiveExplorationSource` scans persisted storage
 * directly, through `ExplorationStore.backfillFromTrail`, which is the only
 * path that survives the app being closed. Decorating `selfRange` is therefore
 * where a demo walk has to go in for any ground to be revealed; appending to
 * the React trail alone moves the drawn line and leaves the map still fogged.
 *
 * Only `selfRange` is touched. Writes go to the real storage untouched, so
 * nothing invented is ever persisted.
 */
export function withFixtureTrailStorage(storage: TrailStorage): TrailStorage {
  return {
    ...storage,
    putSelf: (point) => storage.putSelf(point),
    putFriendLatest: (point) => storage.putFriendLatest(point),
    friendLatest: () => storage.friendLatest(),
    removeFriend: (author) => storage.removeFriend(author),
    pruneSelf: (olderThanTs) => storage.pruneSelf(olderThanTs),
    async selfRange(sinceTs) {
      const stored = await storage.selfRange(sinceTs);
      const offset = stored.reduce((highest, point) => Math.max(highest, point.seq), 0);
      const demo = fixtureTrail(FALLBACK_ANCHOR, Date.now())
        .map((point) => ({ ...point, seq: point.seq + offset }))
        .filter((point) => point.fix.ts >= sinceTs);
      return [...stored, ...demo];
    },
  };
}

/** Whether fixtures are compiled into this bundle. False in the stripped build. */
export const FIXTURES_ACTIVE = true;
