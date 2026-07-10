import type { TrailPoint } from '../../net/background/trail-store';
import { sampleTrailForMap, selectFriendTrail } from '../history';

function point(author: string, seq: number, ts = seq, receivedAt = ts): TrailPoint {
  return {
    author,
    seq,
    receivedAt,
    fix: { lat: 47 + seq / 1000, lon: -122 - seq / 1000, accuracyM: 10, headingDeg: 0, ts },
  };
}

describe('selectFriendTrail', () => {
  it('filters case-insensitively, de-duplicates, validates, and sorts fixes', () => {
    const invalid = point('friend-a', 4, 400);
    invalid.fix.lat = 100;

    expect(
      selectFriendTrail(
        [
          point('other', 1, 100),
          point('FRIEND-A', 2, 300, 300),
          point('friend-a', 1, 200),
          point('friend-a', 2, 300, 500),
          invalid,
        ],
        ' friend-a '
      ).map(({ seq, receivedAt }) => [seq, receivedAt])
    ).toEqual([
      [1, 200],
      [2, 500],
    ]);
  });
});

describe('sampleTrailForMap', () => {
  it('keeps short trails intact', () => {
    const trail = [point('a', 1), point('a', 2)];
    expect(sampleTrailForMap(trail)).toEqual(trail);
    expect(sampleTrailForMap(trail)).not.toBe(trail);
  });

  it('samples long trails while preserving both endpoints', () => {
    const trail = Array.from({ length: 20 }, (_, index) => point('a', index));
    const sampled = sampleTrailForMap(trail, 6);

    expect(sampled).toHaveLength(6);
    expect(sampled[0]).toBe(trail[0]);
    expect(sampled.at(-1)).toBe(trail.at(-1));
  });

  it('rejects an unusable map-point limit', () => {
    expect(() => sampleTrailForMap([point('a', 1)], 1)).toThrow(
      'sampleTrailForMap requires at least two points.'
    );
  });
});
