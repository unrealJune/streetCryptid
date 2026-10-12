import {
  bandValue,
  CONTOUR_BANDS,
  elevationBands,
  encodeElevationBands,
  GROUND_CODE_STEP,
  groundCode,
  MIN_RELIEF_M,
  reliefRange,
} from '../terrain';
import { GROUND_KINDS } from '../types';

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
      encodeElevationBands({ width: 20, height: 20, metres: new Float32Array(400).fill(8) })
    ).toBeNull();
  });

  it('encodes band values as bytes', () => {
    const metres = new Float32Array(400);
    for (let i = 0; i < metres.length; i++) metres[i] = i * 2; // 0..798 m
    const encoded = encodeElevationBands({ width: 20, height: 20, metres })!;
    expect(encoded.bands.interval).toBe(100);
    expect(encoded.bytes[0]).toBe(0);
    expect(encoded.bytes[225]).toBe(Math.round((450 / 900) * 255));
  });
});
