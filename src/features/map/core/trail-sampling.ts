import type { TrailPoint } from '@/features/social/net/background/trail-store';

/**
 * Bounds the geometry of a rendered trail polyline. Only OUR OWN trail is drawn now — friends
 * carry a single current fix and no history (see FORWARD-SECRECY.md §4.4) — and that trail grows
 * with every publish until the retention TTL prunes it, so the drawn path still needs a ceiling.
 *
 * This is map geometry, not location history: the retained points are untouched, only the
 * polyline is sampled.
 */

/** Sample a trail down to `maxPoints` without dropping the first or latest fix. */
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
