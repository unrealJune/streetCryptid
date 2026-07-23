import { scaleFor } from '../../core/camera';
import type { MapPalette } from '../../core/types';
import type { MapRegion } from '../../engine/map-engine';
import { EMPTY_PACKED } from '../../tiles/packed-geometry';
import {
  DOT_FIELD_UNIFORM_FLOATS,
  DOT_STEP,
  lodForZoom,
  packDotFieldUniforms,
  regionLogicalSize,
} from '../shader-uniforms';

const palette: MapPalette = {
  bg: [10, 20, 30],
  accent: [255, 128, 0],
  terr: [
    { t: 0, rgb: [0, 0, 0] },
    { t: 1, rgb: [255, 255, 255] },
  ],
  water: [
    { t: 0, rgb: [0, 0, 0] },
    { t: 1, rgb: [0, 0, 255] },
  ],
  park: [
    { t: 0, rgb: [0, 0, 0] },
    { t: 1, rgb: [0, 255, 0] },
  ],
  streetLabel: [40, 80, 120],
  parkLabel: [0, 0, 0],
};

const region: MapRegion = {
  spec: {
    rect: { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.5 },
    maskWidth: 512,
    maskHeight: 768,
    zoom: 15,
    tileZoom: 13,
    cellRes: 10,
  },
  geometry: EMPTY_PACKED,
  cellField: { res: 10, cells: [] },
  places: [],
  timing: {
    tiles: 0,
    coldStart: false,
    cellFieldCacheHit: false,
    sourceMs: 0,
    mergeMs: 0,
    cellFieldMs: 0,
    totalMs: 0,
    fetchMs: 0,
    buildMs: 0,
  },
};

const base = { region, palette, pixelRatio: 2 };

describe('packDotFieldUniforms', () => {
  it('emits exactly the shader-declared float count', () => {
    expect(packDotFieldUniforms(base)).toHaveLength(DOT_FIELD_UNIFORM_FLOATS);
  });

  it('packs region-anchored, camera-independent values in declaration order', () => {
    const u = packDotFieldUniforms(base);
    expect(u[0]).toBe(2); // uPixelRatio
    expect(u[1]).toBe(scaleFor(15)); // uScale = anchor-zoom scale (no camera)
    expect(u[2]).toBeCloseTo(0.2, 12); // uRectSize.x
    expect(u[3]).toBeCloseTo(0.3, 12); // uRectSize.y
    expect(u.slice(4, 6)).toEqual([512, 768]); // uMaskSize
    expect(u[6]).toBe(DOT_STEP); // uStep
    expect(u.slice(7, 10)).toEqual([10 / 255, 20 / 255, 30 / 255]); // uBg
    expect(u[10]).toBe(1); // uReveal defaults to 1 (fully shown)
    expect(u[11]).toBe(0); // uLod: build zoom 15 → full detail
    expect(u[12]).toBe(1); // uExploration defaults to visible
  });

  it('honors a custom lattice step', () => {
    expect(packDotFieldUniforms({ ...base, step: 3 })[6]).toBe(3);
  });

  it('passes the reveal fraction through', () => {
    expect(packDotFieldUniforms({ ...base, reveal: 0.4 })[10]).toBe(0.4);
    expect(packDotFieldUniforms({ ...base, reveal: 0.4 })).toHaveLength(DOT_FIELD_UNIFORM_FLOATS);
  });

  it('derives uLod from the region build zoom, overridable', () => {
    // base region builds at zoom 15 → full detail.
    expect(packDotFieldUniforms(base)[11]).toBe(0);
    const cityRegion = { ...region, spec: { ...region.spec, zoom: 11 } };
    expect(packDotFieldUniforms({ ...base, region: cityRegion })[11]).toBe(1);
    expect(packDotFieldUniforms({ ...base, lod: 0.5 })[11]).toBe(0.5);
  });

  it('can disable explored/unexplored styling', () => {
    expect(packDotFieldUniforms({ ...base, explorationEnabled: false })[12]).toBe(0);
  });
});

describe('lodForZoom', () => {
  it('is 0 at/above full-detail zoom and 1 at/below coarse zoom', () => {
    expect(lodForZoom(16)).toBe(0);
    expect(lodForZoom(14)).toBe(0);
    expect(lodForZoom(11)).toBe(1);
    expect(lodForZoom(10)).toBe(1);
  });

  it('ramps linearly between', () => {
    expect(lodForZoom(13)).toBeCloseTo(1 / 3, 12);
    expect(lodForZoom(12)).toBeCloseTo(2 / 3, 12);
  });
});

describe('regionLogicalSize', () => {
  it('is the region rect scaled by the anchor-zoom px-per-world', () => {
    const { width, height } = regionLogicalSize(region);
    expect(width).toBeCloseTo(0.2 * scaleFor(15), 6);
    expect(height).toBeCloseTo(0.3 * scaleFor(15), 6);
  });
});
