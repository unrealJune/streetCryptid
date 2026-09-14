import type { LatestLocationPoint } from '@/features/social/core/presence';
import type { Friend, LocationFix } from '@/features/social/core/types';
import type { TrailPoint, TrailStorage } from '@/features/social/net/background/trail-store';

/**
 * The stripped build's screenshot fixtures: every export of `index.ts`, adding
 * nothing.
 *
 * ## Why a swapped module rather than a runtime flag
 * `metro.config.js` aliases `@/features/dev/fixtures` to this file unless
 * `EXPO_PUBLIC_SCREENSHOT_FIXTURES=1`. Because both consumers import the barrel,
 * that one resolver rule removes the whole graph behind it — the invented
 * people, their coordinates, the demo walk — instead of shipping them behind an
 * `if` that a typo in an env var could flip on. The stakes are the reason the
 * mechanism is worth the ceremony: a runtime gate on fabricated friends is one
 * mistake away from putting strangers on a real user's map. There is nothing
 * here to enable; the module is not in the bundle.
 *
 * This is deliberately the same shape as `@/features/dev/telemetry`, which
 * strips the same way for the same reason.
 *
 * ## The rule this file lives by
 * It must export exactly what `index.ts` exports, with the same types, and each
 * function must return its input UNCHANGED. `index-parity.test.ts` enforces
 * both, because either failure would otherwise surface only in a store build:
 * a missing name as a bundling error, and a dropped input as a map that has
 * quietly lost the user's real friends.
 */

interface PresenceInput {
  friends: readonly Friend[];
  latest: readonly LatestLocationPoint[];
  selfFix: LocationFix | null;
}

/** Identity. The real barrel appends demo friends here. */
export function withFixtureFriends<T extends PresenceInput>(input: T): T {
  return input;
}

/** Identity. The real barrel appends a demo walk here. */
export function withFixtureTrail(
  trail: readonly TrailPoint[],
  _selfFix: LocationFix | null
): TrailPoint[] {
  // A copy, matching the real barrel's return type rather than aliasing the
  // caller's array — the caller owns a `TrailPoint[]` either way.
  return [...trail];
}

/** Identity. The real barrel decorates `selfRange` with a demo walk here. */
export function withFixtureTrailStorage(storage: TrailStorage): TrailStorage {
  return storage;
}

/** Whether fixtures are compiled into this bundle. Always false here. */
export const FIXTURES_ACTIVE = false;
