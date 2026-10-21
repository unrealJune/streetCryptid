import { latLonToWorld } from '../mercator';
import {
  ALPINE_FADE_M,
  alpineWeight,
  bandValue,
  CONTOUR_BANDS,
  elevationBands,
  elevationBandsRgba,
  encodeElevationBands,
  GROUND_CODE_STEP,
  groundCode,
  MIN_RELIEF_M,
  rasterMaskRect,
  reliefRange,
  treelineMetres,
} from '../terrain';
import { GROUND_KINDS } from '../types';
const UNIT_RECT = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

describe('groundCode', () => {
  it('gives every ground kind a distinct non-zero code that fits a byte', () => {
    const codes = GROUND_KINDS.map((_, i) => groundCode(i));
    expect(new Set(codes).size).toBe(GROUND_KINDS.length);
    expect(Math.min(...codes)).toBe(GROUND_CODE_STEP);
    expect(Math.max(...codes)).toBeLessThanOrEqual(255);
  });
});

describe('elevationBands', () => {
  it('treats a floodplain as flat', () => {
    expect(elevationBands(3, 3 + MIN_RELIEF_M - 1)).toBeNull();
  });

  it('picks the smallest interval whose bands span the range, on a multiple of it', () => {
    // Kyoto's basin and hills: ~40..850 m wants 100 m contours from 0 m.
    expect(elevationBands(40, 850)).toEqual({ base: 0, interval: 100 });
    // A single hillside: 120..230 m fits 9 × 20 m from 120 m.
    expect(elevationBands(120, 230)).toEqual({ base: 120, interval: 20 });
  });

  it('always contains the whole range', () => {
    for (const [lo, hi] of [
      [0, 20],
      [999, 1100],
      [1234, 4321],
      [0, 8848],
    ] as const) {
      const bands = elevationBands(lo, hi)!;
      expect(bands.base).toBeLessThanOrEqual(lo);
      expect(bands.base % bands.interval).toBe(0);
      expect(hi - bands.base).toBeLessThanOrEqual(CONTOUR_BANDS * bands.interval);
    }
  });

  it('puts contours at absolute elevations, so overlapping regions agree', () => {
    // Two regions over the same hills with slightly different extents choose
    // the same interval, and a contour (band value × 9 an integer) is the same
    // elevation in both.
    const a = elevationBands(60, 820)!;
    const b = elevationBands(45, 790)!;
    expect(a.interval).toBe(b.interval);
    const contourA = (k: number) => a.base + k * a.interval;
    const contourB = (k: number) => b.base + k * b.interval;
    expect(contourA(3) % a.interval).toBe(contourB(3) % b.interval);
    expect(bandValue(300, a) * CONTOUR_BANDS).toBeCloseTo((300 - a.base) / a.interval, 9);
  });
});

describe('bandValue', () => {
  it('clamps and reads the sea as 0 m', () => {
    const bands = { base: 0, interval: 100 };
    expect(bandValue(-40, bands)).toBe(0);
    expect(bandValue(450, bands)).toBeCloseTo(0.5, 9);
    expect(bandValue(5000, bands)).toBe(1);
  });
});

describe('reliefRange / encodeElevationBands', () => {
  it('ignores the sea and a single spike', () => {
    const metres = new Float32Array(10000);
    for (let i = 0; i < metres.length; i++) metres[i] = i < 3000 ? -12 : 100 + (i % 500);
    metres[9999] = 9000; // one bad pixel
    const [lo, hi] = reliefRange(metres)!;
    expect(lo).toBeGreaterThanOrEqual(100);
    expect(hi).toBeLessThan(700);
  });

  it('returns null for an all-sea or flat region', () => {
    expect(reliefRange(new Float32Array(400).fill(-5))).toBeNull();
    expect(
      encodeElevationBands({
        width: 20,
        height: 20,
        metres: new Float32Array(400).fill(8),
        rect: UNIT_RECT,
      })
    ).toBeNull();
  });

  it('encodes band values as bytes', () => {
    const metres = new Float32Array(400);
    for (let i = 0; i < metres.length; i++) metres[i] = i * 2; // 0..798 m
    const encoded = encodeElevationBands({ width: 20, height: 20, metres, rect: UNIT_RECT })!;
    expect(encoded.bands.interval).toBe(100);
    expect(encoded.bytes[0]).toBe(0);
    expect(encoded.bytes[225]).toBe(Math.round((450 / 900) * 255));
  });

  it('lays the bands into G of opaque RGBA, leaving R for the park edge', () => {
    const metres = new Float32Array(400);
    for (let i = 0; i < metres.length; i++) metres[i] = i * 2;
    const rgba = elevationBandsRgba({ width: 20, height: 20, metres, rect: UNIT_RECT })!;
    expect(Array.from(rgba.slice(225 * 4, 226 * 4))).toEqual([
      0,
      Math.round((450 / 900) * 255),
      0,
      255,
    ]);
  });
});

describe('treeline', () => {
  it('falls poleward from the subtropics and never goes below sea level', () => {
    expect(treelineMetres(10)).toBe(treelineMetres(-25));
    expect(treelineMetres(47)).toBeGreaterThan(1500);
    expect(treelineMetres(47)).toBeLessThan(2500);
    expect(treelineMetres(-47)).toBe(treelineMetres(47));
    expect(treelineMetres(80)).toBe(0);
  });

  it('fades from forest to alpine across the band around it', () => {
    expect(alpineWeight(1000 - ALPINE_FADE_M / 2, 1000)).toBe(0);
    expect(alpineWeight(1000, 1000)).toBeCloseTo(0.5);
    expect(alpineWeight(1000 + ALPINE_FADE_M / 2, 1000)).toBe(1);
  });

  it('writes the alpine weight into B by absolute elevation, whatever the relief', () => {
    // The same 2600 m summit is alpine in a raster spanning 0–2600 m and in one
    // spanning 2400–2600 m; the 300 m valley floor never is. A treeline keyed to
    // the band would flip the low raster's hilltops to alpine.
    const [x, y] = latLonToWorld({ lat: 47.8, lon: -123.7 });
    const rect = { minX: x - 0.001, minY: y - 0.001, maxX: x + 0.001, maxY: y + 0.001 };
    const blue = (metres: Float32Array, i: number) =>
      elevationBandsRgba({ width: 20, height: 20, metres, rect })![i * 4 + 2];
    const wide = new Float32Array(400).map((_, i) => (i / 399) * 2600);
    const high = new Float32Array(400).map((_, i) => 2400 + (i / 399) * 200);
    const low = new Float32Array(400).map((_, i) => (i / 399) * 300);
    expect(blue(wide, 399)).toBe(255);
    expect(blue(high, 399)).toBe(255);
    expect(blue(wide, 0)).toBe(0);
    expect(blue(low, 399)).toBe(0);
  });
});

describe('rasterMaskRect', () => {
  it('maps the raster rect into mask pixels, overhang included', () => {
    const spec = {
      rect: { minX: 0.5, minY: 0.25, maxX: 0.75, maxY: 0.5 },
      maskWidth: 100,
      maskHeight: 50,
    };
    const raster = {
      width: 2,
      height: 2,
      metres: new Float32Array(4),
      rect: { minX: 0.49, minY: 0.25, maxX: 0.76, maxY: 0.5 },
    };
    const r = rasterMaskRect(raster, spec);
    expect(r.x).toBeCloseTo(-4, 9);
    expect(r.y).toBeCloseTo(0, 9);
    expect(r.width).toBeCloseTo(108, 9);
    expect(r.height).toBeCloseTo(50, 9);
  });
});
