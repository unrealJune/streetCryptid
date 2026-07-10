import type { TrailPoint } from '../net/background/trail-store';

function endpointKey(value: string): string {
  return value.trim().toLowerCase();
}

function hasValidCoordinates(point: TrailPoint): boolean {
  const { lat, lon, ts } = point.fix;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Number.isFinite(ts) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** A friend's retained fixes in chronological order, de-duplicated by publish sequence. */
export function selectFriendTrail(trail: readonly TrailPoint[], endpointId: string): TrailPoint[] {
  const author = endpointKey(endpointId);
  const bySequence = new Map<number, TrailPoint>();

  for (const point of trail) {
    if (endpointKey(point.author) !== author || !hasValidCoordinates(point)) continue;
    const current = bySequence.get(point.seq);
    if (!current || point.receivedAt >= current.receivedAt) bySequence.set(point.seq, point);
  }

  return [...bySequence.values()].sort((a, b) => a.fix.ts - b.fix.ts || a.seq - b.seq);
}

/**
 * Bound map geometry without dropping the first or latest fix. The retained text
 * history stays complete; only the rendered polyline is sampled.
 */
export function sampleTrailForMap(trail: readonly TrailPoint[], maxPoints = 96): TrailPoint[] {
  if (maxPoints < 2) throw new Error('sampleTrailForMap requires at least two points.');
  if (trail.length <= maxPoints) return [...trail];

  const sampled = [trail[0]];
  const interior = maxPoints - 2;
  const stride = (trail.length - 1) / (interior + 1);
  for (let index = 1; index <= interior; index += 1) {
    sampled.push(trail[Math.round(index * stride)]);
  }
  sampled.push(trail[trail.length - 1]);
  return sampled;
}
