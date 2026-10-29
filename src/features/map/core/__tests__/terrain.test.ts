import { latLonToWorld } from '../mercator';
import {
  ALPINE_FADE_M,
  alpineWeight,
  contourLod,
  elevationRgba,
  GROUND_CODE_STEP,
  groundCode,
  rasterMaskRect,
  treelineMetres,
  type ElevationRaster,
} from '../terrain';
import { GROUND_KINDS } from '../types';

const UNIT_RECT = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
const raster = (metres: readonly number[]): ElevationRaster => ({
  width: metres.length,
  height: 1,
  metres: new Float32Array(metres),
  rect: UNIT_RECT,
});

describe('groundCode', () => {
  it('gives every ground kind a distinct non-zero byte', () => {
    const codes = GROUND_KINDS.map((_, i) => groundCode(i));
    expect(new Set(codes).size).toBe(GROUND_KINDS.length);
    expect(Math.min(...codes)).toBe(GROUND_CODE_STEP);
    expect(Math.max(...codes)).toBeLessThanOrEqual(255);
  });
});

describe('absolute elevation', () => {
  it('encodes metres in R/G without changing the range or clipping summits', () => {
    const rgba = elevationRgba(raster([-40, 0, 255, 256, 450, 4392, 8848]));
    const decoded = Array.from({ length: 7 }, (_, i) => rgba[i * 4] * 256 + rgba[i * 4 + 1]);
    expect(decoded).toEqual([0, 0, 255, 256, 450, 4392, 8848]);
    expect(Array.from(rgba).filter((_, i) => i % 4 === 3)).toEqual(Array(7).fill(255));
  });

  it('interpolates continuously across high-byte carries', () => {
    const rgba = elevationRgba(raster([255, 256]));
    const bilinearHeight = ((rgba[0] + rgba[4]) / 2) * 256 + (rgba[1] + rgba[5]) / 2;
    expect(bilinearHeight).toBe(255.5);
  });

  it('does not change a mountain when other relief enters or leaves the crop', () => {
    const wide = elevationRgba(raster([0, 250, 1800, 2300, 9000]));
    const narrow = elevationRgba(raster([1800, 2300]));
    expect(wide.slice(8, 16)).toEqual(narrow);
    // Flat high ground is still high ground, not a canopy fallback.
    expect(elevationRgba(raster([2300])).slice(0, 4)).toEqual(narrow.slice(4, 8));
  });

  it('uses each DEM row latitude, not the crop centre, for the alpine transition', () => {
    const [x, y] = latLonToWorld({ lat: 47.8, lon: -123.7 });
    const whole: ElevationRaster = {
      width: 4,
      height: 4,
      metres: new Float32Array(16).fill(1800),
      rect: { minX: x, minY: y, maxX: x + 0.002, maxY: y + 0.002 },
    };
    const crop = {
      ...whole,
      height: 2,
      metres: whole.metres.slice(4, 12),
      rect: { ...whole.rect, minY: y + 0.0005, maxY: y + 0.0015 },
    };
    expect(elevationRgba(crop)).toEqual(elevationRgba(whole).slice(16, 48));
  });
});

describe('contour detail', () => {
  it('keeps intervals nested and transitions continuous at integer zooms', () => {
    for (let zoom = 2; zoom <= 14; zoom++) {
      const before = contourLod(zoom - 1e-6);
      const after = contourLod(zoom);
      expect(before.detail).toBeCloseTo(1, 5);
      expect(after.detail).toBe(0);
      expect(before.interval).toBe(after.interval * 2);
    }
    expect(contourLod(15)).toEqual({ interval: 25, detail: 1 });
    expect(contourLod(18)).toEqual(contourLod(15));
  });

  it('never chooses an interval or a contour origin from the visible relief', () => {
    expect(contourLod(10.25)).toEqual({ interval: 400, detail: 0.25 });
    expect(contourLod(12.5)).toEqual({ interval: 100, detail: 0.5 });
  });
});

describe('treeline', () => {
  it('falls poleward from the subtropics and never below sea level', () => {
    expect(treelineMetres(10)).toBe(treelineMetres(-25));
    expect(treelineMetres(47)).toBeGreaterThan(1500);
    expect(treelineMetres(47)).toBeLessThan(2500);
    expect(treelineMetres(-47)).toBe(treelineMetres(47));
    expect(treelineMetres(80)).toBe(0);
  });

  it('fades from forest to alpine around the treeline', () => {
    expect(alpineWeight(1000 - ALPINE_FADE_M / 2, 1000)).toBe(0);
    expect(alpineWeight(1000, 1000)).toBeCloseTo(0.5);
    expect(alpineWeight(1000 + ALPINE_FADE_M / 2, 1000)).toBe(1);
  });
});

describe('rasterMaskRect', () => {
  it('maps the native DEM rect into mask pixels, overhang included', () => {
    const spec = {
      rect: { minX: 0.5, minY: 0.25, maxX: 0.75, maxY: 0.5 },
      maskWidth: 100,
      maskHeight: 50,
    };
    const r = rasterMaskRect(
      { ...raster([0, 1]), rect: { minX: 0.49, minY: 0.25, maxX: 0.76, maxY: 0.5 } },
      spec
    );
    expect(r.x).toBeCloseTo(-4, 9);
    expect(r.y).toBeCloseTo(0, 9);
    expect(r.width).toBeCloseTo(108, 9);
    expect(r.height).toBeCloseTo(50, 9);
  });
});
