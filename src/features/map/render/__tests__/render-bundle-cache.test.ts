import type { MapRegion } from '../../engine/map-engine';
import type { MapGeometry } from '../../core/types';
import { EMPTY_PACKED, packGeometry } from '../../tiles/packed-geometry';
import { RegionRenderCache, sameRegionRenderInput } from '../render-bundle-cache';

const timing = {
  tiles: 0,
  coldStart: false,
  cellFieldCacheHit: false,
  sourceMs: 0,
  mergeMs: 0,
  cellFieldMs: 0,
  cellEnumerateMs: 0,
  cellCentersMs: 0,
  cellAnnotateMs: 0,
  totalMs: 0,
  fetchMs: 0,
  buildMs: 0,
};
const field = { res: 10, cells: [] };
const changedGeometry = packGeometry({
  streets: [
    {
      roadClass: 0,
      points: [
        [0.1, 0.2],
        [0.2, 0.3],
      ],
    },
  ],
  rivers: [],
  water: [],
  parks: [],
  places: [],
} satisfies MapGeometry);
const region: MapRegion = {
  spec: {
    rect: { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4 },
    maskWidth: 100,
    maskHeight: 200,
    zoom: 15,
    tileZoom: 14,
    cellRes: 9,
  },
  geometry: EMPTY_PACKED,
  cellField: field,
  places: [],
  explorationVersion: 0,
  timing,
};

describe('sameRegionRenderInput', () => {
  it('accepts a rebuilt region with the same immutable render inputs', () => {
    expect(sameRegionRenderInput(region, { ...region })).toBe(true);
  });

  describe('RegionRenderCache', () => {
    it('promotes hits and evicts the least-recent exact render input', () => {
      const cache = new RegionRenderCache<string>(2);
      const theme = {};
      const second = { ...region, spec: { ...region.spec, zoom: 14 } };
      const third = { ...region, spec: { ...region.spec, zoom: 13 } };

      cache.set(region, theme, true, 'first');
      cache.set(second, theme, true, 'second');
      expect(cache.get(region, theme, true)).toBe('first');
      cache.set(third, theme, true, 'third');

      expect(cache.get(second, theme, true)).toBeUndefined();
      expect(cache.get(region, theme, true)).toBe('first');
      expect(cache.get(third, theme, true)).toBe('third');
    });
  });

  it('rejects changed fields, geometry, or region placement', () => {
    expect(
      sameRegionRenderInput(region, {
        ...region,
        cellField: { ...field },
      })
    ).toBe(false);
    expect(
      sameRegionRenderInput(region, {
        ...region,
        geometry: changedGeometry,
      })
    ).toBe(false);
    expect(
      sameRegionRenderInput(region, {
        ...region,
        spec: { ...region.spec, zoom: 14 },
      })
    ).toBe(false);
  });
});
