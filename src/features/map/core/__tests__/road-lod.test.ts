import { ROAD_WIDTHS } from '../masks';
import { CLASS_MIN_ZOOM, roadWidthFor, roadWidthScale } from '../road-lod';

describe('roadWidthScale', () => {
  it('is 1.0 at full detail (z >= 14)', () => {
    expect(roadWidthScale(14)).toBeCloseTo(1, 12);
    expect(roadWidthScale(16)).toBeCloseTo(1, 12);
  });

  it('floors at 0.6 when zoomed out (z <= 11)', () => {
    expect(roadWidthScale(11)).toBeCloseTo(0.6, 12);
    expect(roadWidthScale(8)).toBeCloseTo(0.6, 12);
  });

  it('hits 0.8 at the midpoint z = 12.5', () => {
    // 0.6 + 0.4 * (12.5 - 11) / 3 = 0.6 + 0.4 * 1.5 / 3 = 0.8
    expect(roadWidthScale(12.5)).toBeCloseTo(0.8, 12);
  });

  it('increases monotonically across the taper band', () => {
    let prev = roadWidthScale(11);
    for (let z = 11.25; z <= 14; z += 0.25) {
      const cur = roadWidthScale(z);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('roadWidthFor', () => {
  it('omits class 0 below its min zoom (13.5) and draws it above', () => {
    expect(roadWidthFor(0, 13.0)).toBeNull();
    expect(roadWidthFor(0, CLASS_MIN_ZOOM[0] - 0.01)).toBeNull();
    expect(roadWidthFor(0, 15)).not.toBeNull();
    expect(roadWidthFor(0, 15)).toBeGreaterThan(0);
  });

  it('omits class 1 below its min zoom (12.0) and draws it above', () => {
    expect(roadWidthFor(1, 11.5)).toBeNull();
    expect(roadWidthFor(1, CLASS_MIN_ZOOM[1] - 0.01)).toBeNull();
    expect(roadWidthFor(1, 15)).not.toBeNull();
    expect(roadWidthFor(1, 15)).toBeGreaterThan(0);
  });

  it('always draws arterials (class 2..4) at every zoom, tapered but positive', () => {
    for (const cls of [2, 3, 4]) {
      for (const z of [1, 8, 11, 12.5, 14, 18]) {
        const w = roadWidthFor(cls, z);
        expect(w).not.toBeNull();
        expect(w).toBeGreaterThan(0);
      }
    }
  });

  it('equals ROAD_WIDTHS[class] * roadWidthScale(zoom) when not omitted', () => {
    expect(roadWidthFor(4, 12.5)).toBeCloseTo(ROAD_WIDTHS[4] * roadWidthScale(12.5), 12);
    expect(roadWidthFor(0, 15)).toBeCloseTo(ROAD_WIDTHS[0] * roadWidthScale(15), 12);
    expect(roadWidthFor(2, 9)).toBeCloseTo(ROAD_WIDTHS[2] * roadWidthScale(9), 12);
  });

  it('draws the smallest classes at high zoom (z15)', () => {
    expect(roadWidthFor(0, 15)).toBeCloseTo(ROAD_WIDTHS[0] * roadWidthScale(15), 12);
    expect(roadWidthFor(1, 15)).toBeCloseTo(ROAD_WIDTHS[1] * roadWidthScale(15), 12);
  });
});
