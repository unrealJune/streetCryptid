import { scaleFor } from '../../core/camera';
import { computeRegionSpec } from '../../core/region';
import {
  BUILDING_HATCH_SPACING,
  BUILDING_MIN_PX,
  BUILDING_MIN_ZOOM,
} from '../../core/structure-lod';
import type { AreaFeature, CameraState, MapGeometry, Viewport, WorldPoint } from '../../core/types';
import { packGeometry } from '../../tiles/packed-geometry';
import { buildHatchPath, buildStructurePaths } from '../structure-paths';

const viewport: Viewport = { width: 400, height: 800 };
const specAt = (zoom: number) =>
  computeRegionSpec({ center: [0.3, 0.3], zoom } as CameraState, viewport, {
    dataZooms: { min: 0, max: 14 },
  });

const spec = specAt(15);
const { minX, minY } = spec.rect;

/** A square whose projected side is exactly `px` region-logical px. */
function square(px: number, offset = 0): AreaFeature {
  const size = px / scaleFor(spec.zoom);
  const x = minX + size * (1 + offset * 3);
  const y = minY + size;
  const ring: WorldPoint[] = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
  return { rings: [ring] };
}

function geometry(parts: Partial<MapGeometry>) {
  return packGeometry({
    streets: [],
    transit: [],
    rivers: [],
    water: [],
    parks: [],
    places: [],
    ...parts,
  });
}

describe('buildStructurePaths', () => {
  it('returns nothing for empty geometry', () => {
    expect(buildStructurePaths(geometry({}), spec)).toEqual({
      buildings: '',
      aeroAreas: {},
      aeroLines: {},
    });
  });

  it('drops footprints smaller than the minimum projected size', () => {
    const paths = buildStructurePaths(geometry({ buildings: [square(BUILDING_MIN_PX - 1)] }), spec);
    expect(paths.buildings).toBe('');
  });

  it('keeps footprints at or above the minimum projected size', () => {
    const paths = buildStructurePaths(geometry({ buildings: [square(BUILDING_MIN_PX + 1)] }), spec);
    expect(paths.buildings).toMatch(/^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+Z$/);
  });

  it('filters by size independently per feature and batches the survivors', () => {
    const paths = buildStructurePaths(
      geometry({
        buildings: [
          square(BUILDING_MIN_PX + 5, 0),
          square(BUILDING_MIN_PX - 2, 1),
          square(BUILDING_MIN_PX + 5, 2),
        ],
      }),
      spec
    );
    // Two survivors, so two closed sub-paths in one batched string.
    expect(paths.buildings.match(/Z/g)).toHaveLength(2);
  });

  it('drops buildings entirely below the tileset floor zoom', () => {
    const coarse = specAt(BUILDING_MIN_ZOOM - 1);
    // Big enough to survive any size filter — the zoom gate is what rejects it.
    const paths = buildStructurePaths(geometry({ buildings: [square(500)] }), coarse);
    expect(paths.buildings).toBe('');
  });

  it('batches aeroway polygons and lines by kind', () => {
    const line = (t: number): readonly WorldPoint[] => [
      [minX + t, minY + t],
      [minX + t * 2, minY + t * 2],
    ];
    const paths = buildStructurePaths(
      geometry({
        aeroAreas: [
          { kind: 'apron', ...square(40, 0) },
          { kind: 'apron', ...square(40, 1) },
          { kind: 'aerodrome', ...square(80, 2) },
        ],
        aeroLines: [
          { kind: 'runway', points: line(0.0001) },
          { kind: 'taxiway', points: line(0.0002) },
          { kind: 'taxiway', points: line(0.0003) },
        ],
      }),
      spec
    );

    expect(paths.aeroAreas.apron?.match(/Z/g)).toHaveLength(2);
    expect(paths.aeroAreas.aerodrome?.match(/Z/g)).toHaveLength(1);
    expect(paths.aeroLines.runway?.match(/M/g)).toHaveLength(1);
    expect(paths.aeroLines.taxiway?.match(/M/g)).toHaveLength(2);
  });

  it('does not size-filter aeroway areas — a helipad is small and still real', () => {
    const paths = buildStructurePaths(
      geometry({ aeroAreas: [{ kind: 'apron', ...square(BUILDING_MIN_PX - 2) }] }),
      spec
    );
    expect(paths.aeroAreas.apron).toBeTruthy();
  });

  it('omits taxiways below their floor zoom but keeps runways', () => {
    const line: readonly WorldPoint[] = [
      [minX + 0.0001, minY + 0.0001],
      [minX + 0.0004, minY + 0.0004],
    ];
    const paths = buildStructurePaths(
      geometry({
        aeroLines: [
          { kind: 'runway', points: line },
          { kind: 'taxiway', points: line },
        ],
      }),
      specAt(11)
    );
    expect(paths.aeroLines.runway).toBeTruthy();
    expect(paths.aeroLines.taxiway).toBeUndefined();
  });
});

describe('buildHatchPath', () => {
  const logical = (s: typeof spec) => ({
    width: (s.rect.maxX - s.rect.minX) * scaleFor(s.zoom),
    height: (s.rect.maxY - s.rect.minY) * scaleFor(s.zoom),
  });

  it('covers the region rect at the configured spacing', () => {
    const { width, height } = logical(spec);
    const lines = buildHatchPath(spec).match(/M/g) ?? [];
    // c sweeps [-height, width] inclusive.
    expect(lines).toHaveLength(Math.floor((width + height) / BUILDING_HATCH_SPACING) + 1);
  });

  it('draws 45° lines — every segment moves equally in x and y', () => {
    // Sub-paths are "M{x} {y}L{x} {y}", so they contain spaces themselves —
    // match them out rather than splitting the batched string.
    const segments = [
      ...buildHatchPath(spec, 40).matchAll(/M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)/g),
    ];
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      const [x0, y0, x1, y1] = segment.slice(1).map(Number);
      expect(x1 - x0).toBeCloseTo(y1 - y0, 1);
      expect(x1 - x0).toBeGreaterThan(0);
    }
  });

  it('spans far enough left that the hatch reaches the rect corner', () => {
    const { height } = logical(spec);
    const first = buildHatchPath(spec).match(/^M(-?[\d.]+) /);
    // The top-right corner needs a line starting at -height to be covered.
    expect(Number(first![1])).toBeCloseTo(-height, 0);
  });

  it('refuses a non-positive spacing instead of looping forever', () => {
    expect(buildHatchPath(spec, 0)).toBe('');
    expect(buildHatchPath(spec, -1)).toBe('');
  });
});
