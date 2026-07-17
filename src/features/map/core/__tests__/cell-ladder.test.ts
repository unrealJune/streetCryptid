import { H3_DISPLAY_RES, H3_MIN_RES, resForZoom } from '../cell-ladder';

describe('resForZoom', () => {
  it('matches the ladder table', () => {
    const table: [number, number][] = [
      [16, 10],
      [14, 10],
      [13.9, 9],
      [12.5, 9],
      [12.4, 8],
      [11, 8],
      [10.9, 7],
      [9.5, 7],
      [9.4, 6],
      [8, 6],
      [7.9, 5],
      [6.5, 5],
      [6.4, 4],
      [5, 4],
      [4.9, 3],
      [3.5, 3],
      [3.4, 2],
      [1, 2],
    ];
    for (const [zoom, res] of table) {
      expect({ zoom, res: resForZoom(zoom) }).toEqual({ zoom, res });
    }
  });

  it('is monotonically non-decreasing in zoom', () => {
    let prev = -Infinity;
    for (let z = 0; z <= 16.5; z += 0.05) {
      const res = resForZoom(z);
      expect(res).toBeGreaterThanOrEqual(prev);
      prev = res;
    }
  });

  it('clamps to the ladder ends', () => {
    expect(resForZoom(-5)).toBe(H3_MIN_RES);
    expect(resForZoom(0)).toBe(H3_MIN_RES);
    expect(resForZoom(22)).toBe(H3_DISPLAY_RES);
  });
});
