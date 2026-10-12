import { DEFAULT_PEAK_LABEL_OPTIONS, selectMapLabels } from '../../core/map-labels';
import type { RegionSpec } from '../../core/region';
import { packGeometry } from '../../tiles/packed-geometry';
import { labelsForRegion } from '../region-labels';

const spec: RegionSpec = {
  rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  maskWidth: 512,
  maskHeight: 512,
  zoom: 15,
  tileZoom: 13,
  cellRes: 9,
};
const geometry = packGeometry({
  streets: [],
  transit: [],
  rivers: [],
  water: [],
  parks: [],
  places: [],
  peaks: Array.from({ length: 12 }, (_, index) => ({
    name: `Summit ${index}`,
    kind: 'peak',
    customaryFt: false,
    rank: 1,
    world: [0.5, 0.5 + index * 0.001] as const,
  })),
  pois: [{ name: 'Cafe', kind: 'cafe', subclass: '', rank: 1, world: [0.5, 0.5] }],
});
const region = { geometry, spec, labels: selectMapLabels(geometry, spec) };

describe('view-level peak settings', () => {
  it('reuses the built labels for default values, including reset with a new object', () => {
    expect(labelsForRegion(region)).toBe(region.labels);
    expect(labelsForRegion(region, { ...DEFAULT_PEAK_LABEL_OPTIONS })).toBe(region.labels);
  });

  it('shows more than the original cap on the same region without changing its cached labels', () => {
    expect(region.labels.filter((label) => label.kind === 'peak')).toHaveLength(8);
    expect(
      labelsForRegion(region, { ...DEFAULT_PEAK_LABEL_OPTIONS, maxLabels: 12 }).filter(
        (label) => label.kind === 'peak'
      )
    ).toHaveLength(12);
    expect(region.labels.filter((label) => label.kind === 'peak')).toHaveLength(8);
    expect(labelsForRegion(region)).toBe(region.labels);
  });

  it('re-runs all collisions so a previously suppressed POI can appear when peaks are excluded', () => {
    expect(region.labels.some((label) => label.kind === 'poi')).toBe(false);
    const labels = labelsForRegion(region, { ...DEFAULT_PEAK_LABEL_OPTIONS, maxLabels: 0 });
    expect(labels.map((label) => label.text)).toEqual(['CAFE']);
  });

  it('uses the new region zoom for automatic rank selection', () => {
    const options = { ...DEFAULT_PEAK_LABEL_OPTIONS, minZoom: 8 };
    const lower = { ...region, spec: { ...spec, zoom: 7 } };
    expect(labelsForRegion(lower, options)).toEqual([]);
    expect(labelsForRegion(region, options).filter((label) => label.kind === 'peak')).toHaveLength(
      8
    );
  });
});
