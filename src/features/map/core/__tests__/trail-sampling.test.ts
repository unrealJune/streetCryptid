import type { TrailPoint } from '@/features/social/net/background/trail-store';
import { SELF_AUTHOR } from '@/features/social/net/background/trail-store';
import { sampleTrailForMap } from '../trail-sampling';

function point(seq: number, ts = seq, receivedAt = ts): TrailPoint {
  return {
    author: SELF_AUTHOR,
    seq,
    receivedAt,
    fix: { lat: 47 + seq / 1000, lon: -122 - seq / 1000, accuracyM: 10, headingDeg: 0, ts },
  };
}

describe('sampleTrailForMap', () => {
  it('keeps short trails intact', () => {
    const trail = [point(1), point(2)];
    expect(sampleTrailForMap(trail)).toEqual(trail);
    expect(sampleTrailForMap(trail)).not.toBe(trail);
  });

  it('samples long trails while preserving both endpoints', () => {
    const trail = Array.from({ length: 20 }, (_, index) => point(index));
    const sampled = sampleTrailForMap(trail, 6);

    expect(sampled).toHaveLength(6);
    expect(sampled[0]).toBe(trail[0]);
    expect(sampled.at(-1)).toBe(trail.at(-1));
  });

  it('keeps historical samples stable as new fixes append', () => {
    let trail = Array.from({ length: 200 }, (_, index) => point(index + 1));
    let sampled = sampleTrailForMap(trail, 32);

    for (let sequence = 201; sequence <= 260; sequence++) {
      trail = [...trail, point(sequence)];
      const next = sampleTrailForMap(trail, 32);
      const nextSequences = new Set(next.map(({ seq }) => seq));
      const removedInterior = sampled.slice(1, -1).filter(({ seq }) => !nextSequences.has(seq));

      expect(removedInterior.length).toBeLessThanOrEqual(1);
      expect(next[0]).toBe(trail[0]);
      expect(next.at(-1)).toBe(trail.at(-1));
      sampled = next;
    }
  });

  it('rejects an unusable map-point limit', () => {
    expect(() => sampleTrailForMap([point(1)], 1)).toThrow(
      'sampleTrailForMap requires at least two points.'
    );
  });
});
