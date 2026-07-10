import { scaleFor } from '../../core/camera';
import type { MapPalette } from '../../core/types';
import type { MapRegion } from '../../engine/map-engine';
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
  },
  geometry: { streets: [], rivers: [], water: [], parks: [], places: [] },
  hexTable: { q0: 0, r0: 0, cols: 12, rows: 9, data: new Uint8Array(12 * 9 * 4) },
  axialOrigin: [1.5, -2.5],
  places: [],
};

const base = { region, palette, hexRadius: 5e-6, pixelRatio: 2 };

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
    expect(u[7]).toBe(5e-6); // uHexRadius
    expect(u.slice(8, 10)).toEqual([1.5, -2.5]); // uAxialOrigin
    expect(u.slice(10, 12)).toEqual([12, 9]); // uHexTableSize
    expect(u.slice(12, 15)).toEqual([10 / 255, 20 / 255, 30 / 255]); // uBg
    expect(u.slice(15, 18)).toEqual([1, 128 / 255, 0]); // uAccent
    expect(u.slice(18, 21)).toEqual([40 / 255, 80 / 255, 120 / 255]); // uStreetLabel
    expect(u[21]).toBe(1); // uReveal defaults to 1 (fully shown)
    expect(u[22]).toBe(0); // uLod: build zoom 15 → full detail
    expect(u[23]).toBe(1); // uExploration defaults to visible
  });

  it('honors a custom lattice step', () => {
    expect(packDotFieldUniforms({ ...base, step: 3 })[6]).toBe(3);
  });

  it('passes the reveal fraction through', () => {
    expect(packDotFieldUniforms({ ...base, reveal: 0.4 })[21]).toBe(0.4);
    expect(packDotFieldUniforms({ ...base, reveal: 0.4 })).toHaveLength(DOT_FIELD_UNIFORM_FLOATS);
  });

  it('derives uLod from the region build zoom, overridable', () => {
    // base region builds at zoom 15 → full detail.
    expect(packDotFieldUniforms(base)[22]).toBe(0);
    const cityRegion = { ...region, spec: { ...region.spec, zoom: 11 } };
    expect(packDotFieldUniforms({ ...base, region: cityRegion })[22]).toBe(1);
    expect(packDotFieldUniforms({ ...base, lod: 0.5 })[22]).toBe(0.5);
  });

  it('can disable explored/unexplored styling', () => {
    expect(packDotFieldUniforms({ ...base, explorationEnabled: false })[23]).toBe(0);
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
