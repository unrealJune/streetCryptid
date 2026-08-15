import { RIVER_WIDTH } from '../masks';
import {
  RIVER_COARSE_ZOOM,
  RIVER_FULL_ZOOM,
  RIVER_MIN_SCALE,
  riverWidthFor,
  riverWidthScale,
} from '../water-lod';
import { ROAD_WIDTHS, roadWidthFor } from '../road-lod';

describe('riverWidthScale', () => {
  it('is 1.0 at full detail (z >= 15)', () => {
    expect(riverWidthScale(RIVER_FULL_ZOOM)).toBeCloseTo(1, 12);
    expect(riverWidthScale(16)).toBeCloseTo(1, 12);
    expect(riverWidthScale(22)).toBeCloseTo(1, 12);
  });

  it('floors at RIVER_MIN_SCALE when zoomed out (z <= 9)', () => {
    expect(riverWidthScale(RIVER_COARSE_ZOOM)).toBeCloseTo(RIVER_MIN_SCALE, 12);
    expect(riverWidthScale(4)).toBeCloseTo(RIVER_MIN_SCALE, 12);
    expect(riverWidthScale(1)).toBeCloseTo(RIVER_MIN_SCALE, 12);
    expect(riverWidthScale(0)).toBeCloseTo(RIVER_MIN_SCALE, 12);
  });

  it('hits the midpoint of the ramp at z = 12', () => {
    expect(riverWidthScale(12)).toBeCloseTo((1 + RIVER_MIN_SCALE) / 2, 12);
  });

  it('increases monotonically across the taper band', () => {
    let prev = riverWidthScale(RIVER_COARSE_ZOOM);
    for (let z = RIVER_COARSE_ZOOM; z <= RIVER_FULL_ZOOM; z += 0.25) {
      const cur = riverWidthScale(z);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('riverWidthFor', () => {
  it('equals RIVER_WIDTH * riverWidthScale(zoom)', () => {
    for (const z of [1, 6, 9, 11, 12, 13, 15, 16]) {
      expect(riverWidthFor(z)).toBeCloseTo(RIVER_WIDTH * riverWidthScale(z), 12);
    }
  });

  it('draws rivers at every zoom, tapered but positive', () => {
    for (const z of [1, 4, 8, 11, 13, 15, 18]) {
      const w = riverWidthFor(z);
      expect(w).not.toBeNull();
      expect(w).toBeGreaterThan(0);
    }
  });

  it('thins as the camera zooms out — the whole point of the taper', () => {
    // The bug this replaced: a flat 5 mask px at every zoom, so a river kept
    // its street-zoom weight while every road class thinned to 0.4×.
    let prev = riverWidthFor(15)!;
    for (const z of [14, 13, 12, 11, 10, 9, 6, 3]) {
      const cur = riverWidthFor(z)!;
      expect(cur).toBeLessThanOrEqual(prev);
      prev = cur;
    }
    expect(riverWidthFor(3)!).toBeLessThan(riverWidthFor(15)! * 0.5);
  });

  it('never draws a river wider than a motorway at the same zoom', () => {
    // The reported symptom: zoomed out, rivers were 2.5× the widest road left
    // on screen (and with the highways layer off, wider still than anything).
    for (const z of [1, 3, 6, 9, 11, 12, 13, 14, 15, 16]) {
      expect(riverWidthFor(z)!).toBeLessThanOrEqual(roadWidthFor(4, z)!);
    }
  });

  it('sits at roughly a primary road’s weight at full detail, like the mock', () => {
    expect(riverWidthFor(15)!).toBeLessThan(ROAD_WIDTHS[4]);
    expect(riverWidthFor(15)!).toBeCloseTo(ROAD_WIDTHS[3], 0);
  });
});
