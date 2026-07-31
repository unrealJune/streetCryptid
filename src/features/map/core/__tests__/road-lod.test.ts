import { ROAD_WIDTHS } from '../masks';
import {
  CLASS_MIN_ZOOM,
  HIGHWAY_CLASS,
  roadClassVisible,
  roadWidthFor,
  roadWidthScale,
} from '../road-lod';

describe('roadWidthScale', () => {
  it('is 1.0 at full detail (z >= 15)', () => {
    expect(roadWidthScale(15)).toBeCloseTo(1, 12);
    expect(roadWidthScale(16)).toBeCloseTo(1, 12);
  });

  it('floors at 0.4 when zoomed out (z <= 11)', () => {
    expect(roadWidthScale(11)).toBeCloseTo(0.4, 12);
    expect(roadWidthScale(8)).toBeCloseTo(0.4, 12);
  });

  it('hits 0.7 at the midpoint z = 13', () => {
    // 0.4 + 0.6 * (13 - 11) / 4 = 0.4 + 0.6 * 2 / 4 = 0.7
    expect(roadWidthScale(13)).toBeCloseTo(0.7, 12);
  });

  it('increases monotonically across the taper band', () => {
    let prev = roadWidthScale(11);
    for (let z = 11.25; z <= 15; z += 0.25) {
      const cur = roadWidthScale(z);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('roadWidthFor', () => {
  it('omits class 0 below its min zoom (15.0) and draws it above', () => {
    expect(roadWidthFor(0, 14.5)).toBeNull();
    expect(roadWidthFor(0, CLASS_MIN_ZOOM[0] - 0.01)).toBeNull();
    expect(roadWidthFor(0, 15)).not.toBeNull();
    expect(roadWidthFor(0, 15)).toBeGreaterThan(0);
  });

  it('omits class 1 below its min zoom (13.5) and draws it above', () => {
    expect(roadWidthFor(1, 13.0)).toBeNull();
    expect(roadWidthFor(1, CLASS_MIN_ZOOM[1] - 0.01)).toBeNull();
    expect(roadWidthFor(1, 15)).not.toBeNull();
    expect(roadWidthFor(1, 15)).toBeGreaterThan(0);
  });

  it('always draws motorways (class 4) at every zoom, tapered but positive', () => {
    for (const z of [1, 8, 11, 13, 15, 18]) {
      const w = roadWidthFor(4, z);
      expect(w).not.toBeNull();
      expect(w).toBeGreaterThan(0);
    }
  });

  it('bands the mid classes: 2 below z11 and 3 below z8.5 are omitted', () => {
    expect(roadWidthFor(2, 10.9)).toBeNull();
    expect(roadWidthFor(2, 11)).not.toBeNull();
    expect(roadWidthFor(3, 8.4)).toBeNull();
    expect(roadWidthFor(3, 8.5)).not.toBeNull();
  });

  it('equals ROAD_WIDTHS[class] * roadWidthScale(zoom) when not omitted', () => {
    expect(roadWidthFor(4, 12.5)).toBeCloseTo(ROAD_WIDTHS[4] * roadWidthScale(12.5), 12);
    expect(roadWidthFor(0, 15)).toBeCloseTo(ROAD_WIDTHS[0] * roadWidthScale(15), 12);
    expect(roadWidthFor(2, 11)).toBeCloseTo(ROAD_WIDTHS[2] * roadWidthScale(11), 12);
  });

  it('draws the smallest classes at high zoom (z15)', () => {
    expect(roadWidthFor(0, 15)).toBeCloseTo(ROAD_WIDTHS[0] * roadWidthScale(15), 12);
    expect(roadWidthFor(1, 15)).toBeCloseTo(ROAD_WIDTHS[1] * roadWidthScale(15), 12);
  });
});

describe('roadClassVisible', () => {
  it('shows every class when no layer toggles are given', () => {
    for (let cls = 0; cls <= HIGHWAY_CLASS; cls++) {
      expect(roadClassVisible(cls)).toBe(true);
      expect(roadClassVisible(cls, {})).toBe(true);
      expect(roadClassVisible(cls, { highways: true })).toBe(true);
    }
  });

  it('hides only the highway class when highways are off', () => {
    for (let cls = 0; cls < HIGHWAY_CLASS; cls++) {
      expect(roadClassVisible(cls, { highways: false })).toBe(true);
    }
    expect(roadClassVisible(HIGHWAY_CLASS, { highways: false })).toBe(false);
  });
});
