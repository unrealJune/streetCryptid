import type { Friend, LocationFix } from './types';

export const LIVE_PRESENCE_WINDOW_MS = 15 * 60 * 1000;
export const RECENT_PRESENCE_WINDOW_MS = 6 * 60 * 60 * 1000;

export type PresenceFreshness = 'live' | 'recent' | 'stale' | 'unknown';

export interface LatestLocationPoint {
  author: string;
  fix: LocationFix;
  receivedAt: number;
}

export interface FriendPresence {
  friend: Friend;
  fix: LocationFix | null;
  distanceM: number | null;
  ageMs: number | null;
  freshness: PresenceFreshness;
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
 * Joins decrypted trail authors to verified friends. Unknown authors are
 * intentionally ignored; an inbound location can only become UI presence after
 * the matching endpoint is in the friend pool.
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
      const ageMs = fix ? Math.max(0, now - fix.ts) : null;
      return {
        friend,
        fix,
        ageMs,
        freshness: freshnessFor(ageMs),
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
