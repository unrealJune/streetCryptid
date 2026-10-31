import { scaleFor } from '../../core/camera';
import { computeRegionSpec } from '../../core/region';
import { MERCATOR_CIRCUMFERENCE_M, SHADE_GAIN } from '../../core/terrain';
import type { MapPalette } from '../../core/types';
import type { MapRegion } from '../../engine/map-engine';
import { EMPTY_PACKED } from '../../tiles/packed-geometry';
import {
  DOT_ATLAS_HALO,
  DOT_FIELD_UNIFORM_FLOATS,
  DOT_STEP,
  dotAtlasSize,
  lodForZoom,
  DOT_HASH_PERIOD,
  NOISE_WORLD_SCALE,
  packDotFieldUniforms,
  regionImageLayout,
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
  transit: [120, 80, 200],
  building: [20, 40, 60],
  streetLabel: [40, 80, 120],
  parkLabel: [0, 0, 0],
};

const region: MapRegion = {
  publication: 1,
  spec: {
    rect: { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.5 },
    maskWidth: 512,
    maskHeight: 768,
    zoom: 15,
    tileZoom: 13,
    cellRes: 9,
  },
  geometry: EMPTY_PACKED,
  cellField: { res: 9, cells: [] },
  places: [],
  explorationVersion: 0,
  timing: {
    tiles: 0,
    coldStart: false,
    cellFieldCacheHit: false,
    sourceMs: 0,
    mergeMs: 0,
    yieldMs: 0,
    cellFieldMs: 0,
    cellEnumerateMs: 0,
    cellCentersMs: 0,
    cellAnnotateMs: 0,
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
    expect(u[6]).toBe(DOT_STEP / base.pixelRatio); // uStep
    expect(u.slice(7, 10)).toEqual([10 / 255, 20 / 255, 30 / 255]); // uBg
    expect(u[10]).toBe(1); // uReveal defaults to 1 (fully shown)
    expect(u[11]).toBe(0); // uLod: build zoom 15 → full detail
    expect(u[12]).toBe(1); // uExploration defaults to visible
    expect(u.slice(13, 15)).toEqual([0, 0]); // renderer effects default off
    expect(u[17]).toBe(0); // uHasElev defaults off: canopy fallback
    expect(u[18]).toBe(SHADE_GAIN / MERCATOR_CIRCUMFERENCE_M); // no DEM
  });

  it('pins material noise to one world scale, not the build zoom', () => {
    const u = packDotFieldUniforms(base);
    expect(u[15]).toBeCloseTo(0.1 * NOISE_WORLD_SCALE, 6);
    expect(u[16]).toBeCloseTo(0.2 * NOISE_WORLD_SCALE, 6);
    const otherZoom = packDotFieldUniforms({
      ...base,
      region: { ...region, spec: { ...region.spec, zoom: 9.25 } },
    });
    expect(otherZoom.slice(15, 17)).toEqual(u.slice(15, 17));
    expect(otherZoom[19] * scaleFor(9.25)).toBeCloseTo(u[19] * scaleFor(15), 6);
  });

  it('keeps the lattice fixed across pans and hash wraps', () => {
    const point = [0.162, 0.35];
    const gridSample = (zoom: number, dx: number, dy: number) => {
      const spec = {
        ...region.spec,
        zoom,
        rect: { minX: point[0] + dx, minY: point[1] + dy, maxX: 0.3, maxY: 0.5 },
      };
      const u = packDotFieldUniforms({ ...base, region: { spec } });
      return [0, 1].map((axis) => {
        const origin = axis === 0 ? spec.rect.minX : spec.rect.minY;
        const local = (point[axis] - origin) * u[1];
        const phase = 22;
        const originIndex = 20;
        const step = u[6];
        const index = Math.round((local - u[phase + axis]) / step);
        const key =
          (((index + u[originIndex + axis]) % DOT_HASH_PERIOD) + DOT_HASH_PERIOD) % DOT_HASH_PERIOD;
        const world = origin + (index * step + u[phase + axis]) / u[1];
        return { key, world };
      });
    };
    for (const zoom of [10.25, 12.1, 13.16, 16.5, 19]) {
      const first = gridSample(zoom, -0.0003, -0.0002);
      for (const other of [gridSample(zoom, -0.00021, 0.00013), gridSample(zoom, -0.01, -0.02)]) {
        other.forEach((dot, axis) => {
          expect(dot.key).toBe(first[axis].key);
          expect(dot.world).toBeCloseTo(first[axis].world, 12);
        });
      }
    }
  });

  it('maps DEM pixels directly and normalizes shade by their world spacing', () => {
    const elevation = {
      width: 256,
      height: 128,
      rect: { minX: 0.1, minY: 0.2, maxX: 0.2, maxY: 0.25 },
      metres: new Float32Array(256 * 128),
    };
    const u = packDotFieldUniforms({
      ...base,
      region: { ...region, elevation },
      hasElevation: true,
    });
    expect(u.slice(24, 26)).toEqual([0, 0]);
    expect(u[26]).toBeCloseTo((0.1 / 256) * scaleFor(15));
    expect(u[27]).toBeCloseTo((0.05 / 128) * scaleFor(15));
    expect(u.slice(28, 30)).toEqual([256, 128]);
    expect(u[18]).toBeCloseTo(SHADE_GAIN / ((0.1 / 256) * MERCATOR_CIRCUMFERENCE_M));
  });

  it('fades the last noise octave instead of normalizing it back to full contrast', () => {
    const at = (zoom: number) =>
      packDotFieldUniforms({ ...base, region: { spec: { ...region.spec, zoom } } });
    const cutoff = 12 + Math.log2(((DOT_STEP / base.pixelRatio) * 2 * 0.045) / 0.5);
    expect(at(cutoff - 0.0001).slice(32, 36)).toEqual([0, 0, 0, 0]);
    expect(at(cutoff + 0.0001)[32]).toBeGreaterThan(0);
    expect(at(cutoff + 0.0001)[32]).toBeLessThan(0.000001);
    expect(
      at(18)
        .slice(32, 36)
        .reduce((sum, weight) => sum + weight, 0)
    ).toBeCloseTo(1);
  });

  it('flags elevation when the terrain texture carries it', () => {
    expect(packDotFieldUniforms({ ...base, hasElevation: true })[17]).toBe(1);
  });

  it.each([0.5, 0.65, 1.0256410256410255, 1.5, 2])(
    'sizes a single pixel-registered atlas at density %s',
    (pixelRatio) => {
      const spec = { ...region.spec, zoom: 12.5 };
      const input = { ...base, region: { spec }, pixelRatio };
      const u = packDotFieldUniforms(input);
      const logical = regionLogicalSize(input.region);
      const atlas = dotAtlasSize(spec, pixelRatio);
      expect(atlas.width).toBe((Math.ceil(logical.width / u[6]) + 2 * DOT_ATLAS_HALO + 1) * 2);
      expect(atlas.height).toBe(Math.ceil(logical.height / u[6]) + 2 * DOT_ATLAS_HALO + 1);
      expect(u[6] * pixelRatio).toBeCloseTo(2, 12);
    }
  );

  it('keeps two-bitmap-pixel dots instead of crossing two detail grids at fractional zooms', () => {
    for (const zoom of [10.15, 10.25, 12.15, 12.85, 13.16, 13.5, 15.85, 19]) {
      const spec = computeRegionSpec(
        { center: [0.162, 0.35], zoom },
        { width: 390, height: 780 },
        { dataZooms: { min: 0, max: 14 } }
      );
      const layout = regionImageLayout(spec);
      const u = packDotFieldUniforms({ ...base, region: { spec }, pixelRatio: layout.pixelRatio });
      const pitch = u[6] * layout.pixelRatio;
      expect(pitch).toBeCloseTo(Math.round(pitch), 12);
      expect(pitch).toBeCloseTo(DOT_STEP, 12);
      for (const axis of [0, 1]) {
        const offset = axis === 0 ? layout.offsetX : layout.offsetY;
        const phase = u[22 + axis] * layout.pixelRatio + offset - pitch / 2;
        expect(phase).toBeCloseTo(Math.round(phase), 6);
      }
    }
  });

  it('covers glyph neighbours outside the aligned bitmap at minimum density', () => {
    for (const zoom of [12.151, 13.16, 13.5, 14, 15.85])
      for (const pan of [0, 0.1, 1.75, 17.25]) {
        const scale = scaleFor(zoom);
        const spec = computeRegionSpec(
          { center: [0.162 + pan / scale, 0.35 + pan / 2 / scale], zoom },
          { width: 390, height: 780 },
          { dataZooms: { min: 0, max: 14 } }
        );
        const layout = regionImageLayout(spec, 0.25);
        const u = packDotFieldUniforms({
          ...base,
          region: { spec },
          pixelRatio: layout.pixelRatio,
        });
        const atlas = dotAtlasSize(spec, layout.pixelRatio);
        for (const axis of [0, 1]) {
          const phase = u[22 + axis];
          const offset = axis === 0 ? layout.offsetX : layout.offsetY;
          const extent = axis === 0 ? layout.width : layout.height;
          for (const edge of [0, extent]) {
            const frag = (edge - offset) / layout.pixelRatio;
            const nearest = Math.floor((frag - phase) / u[6] + 0.5);
            for (const index of [nearest - 1, nearest + 1]) {
              const pixel =
                axis === 0 ? (index + DOT_ATLAS_HALO) * 2 + 1.5 : index + DOT_ATLAS_HALO + 0.5;
              expect(pixel).toBeGreaterThanOrEqual(0);
              expect(pixel).toBeLessThan(axis === 0 ? atlas.width : atlas.height);
            }
          }
        }
      }
  });

  it.each([
    { width: 430, height: 932, maxMiB: 8 },
    { width: 932, height: 430, maxMiB: 8 },
    { width: 1032, height: 1376, maxMiB: 26 },
    { width: 1376, height: 1032, maxMiB: 26 },
  ])('bounds atlas storage across zooms on a $width x $height viewport', (viewport) => {
    let maxBytes = 0;
    let maxAxis = 0;
    for (let i = 100; i <= 1900; i++) {
      const spec = computeRegionSpec({ center: [0.162, 0.35], zoom: i / 100 }, viewport, {
        dataZooms: { min: 0, max: 14 },
      });
      const atlas = dotAtlasSize(spec);
      maxBytes = Math.max(maxBytes, atlas.width * atlas.height * 4);
      maxAxis = Math.max(maxAxis, atlas.width, atlas.height);
    }
    expect(maxBytes).toBeLessThan(viewport.maxMiB * 2 ** 20);
    expect(maxAxis).toBeLessThan(8192);
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

  it('packs optional renderer effects', () => {
    const effectsPalette = { ...palette, effects: { neonGlow: 0.7, scanlines: 0.3 } };
    expect(packDotFieldUniforms({ ...base, palette: effectsPalette }).slice(13, 15)).toEqual([
      0.7, 0.3,
    ]);
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

  describe('regionImageLayout', () => {
    it.each([1, 0.65])('keeps capped bitmap pixels world-aligned at quality %s', (quality) => {
      const zoom = 13.16;
      const scale = scaleFor(zoom);
      const layouts = [0, 0.1, 2.5, 17.25, 63].map((pan) => {
        const spec = computeRegionSpec(
          { center: [0.162 + pan / scale, 0.35 + pan / 2 / scale], zoom },
          { width: 390, height: 780 },
          { dataZooms: { min: 0, max: 14 } }
        );
        const layout = regionImageLayout(spec, quality);
        const pxPerWorld = scale * layout.pixelRatio;
        expect(layout.rect.minX).toBeLessThanOrEqual(spec.rect.minX);
        expect(layout.rect.minY).toBeLessThanOrEqual(spec.rect.minY);
        expect(layout.rect.maxX).toBeGreaterThanOrEqual(spec.rect.maxX);
        expect(layout.rect.maxY).toBeGreaterThanOrEqual(spec.rect.maxY);
        expect((layout.rect.maxX - layout.rect.minX) * pxPerWorld).toBeCloseTo(layout.width, 6);
        expect((layout.rect.maxY - layout.rect.minY) * pxPerWorld).toBeCloseTo(layout.height, 6);
        expect(layout.offsetX).toBeGreaterThanOrEqual(0);
        expect(layout.offsetX).toBeLessThan(1);
        expect(layout.offsetY).toBeGreaterThanOrEqual(0);
        expect(layout.offsetY).toBeLessThan(1);
        return layout;
      });
      for (const layout of layouts) {
        expect(layout.pixelRatio).toBe(layouts[0].pixelRatio);
        const x = (layout.rect.minX - layouts[0].rect.minX) * scale * layout.pixelRatio;
        const y = (layout.rect.minY - layouts[0].rect.minY) * scale * layout.pixelRatio;
        expect(x).toBeCloseTo(Math.round(x), 6);
        expect(y).toBeCloseTo(Math.round(y), 6);
      }
    });
  });
});
