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

  const interiorLimit = maxPoints - 2;
  const ranked = trail.slice(1, -1).map((point, offset) => ({
    index: offset + 1,
    level: hierarchyLevel(point.seq),
    tie: stableSequenceHash(point.seq),
    seq: point.seq,
  }));
  ranked.sort((a, b) => b.level - a.level || b.tie - a.tie || a.seq - b.seq);
  const selected = new Set(ranked.slice(0, interiorLimit).map(({ index }) => index));

  return trail.filter(
    (_, index) => index === 0 || index === trail.length - 1 || selected.has(index)
  );
}

/** Binary hierarchy keeps a uniformly bounded backbone as a trail grows. */
function hierarchyLevel(sequence: number): number {
  let value = Math.abs(Math.trunc(sequence));
  if (value === 0) return 53;
  let level = 0;
  while (value % 2 === 0 && level < 52) {
    value /= 2;
    level++;
  }
  return level;
}

/** Stable tie-breaker within one hierarchy level; appends cannot reorder old fixes. */
function stableSequenceHash(sequence: number): number {
  let value = Math.trunc(sequence) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}
