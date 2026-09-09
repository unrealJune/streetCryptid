import { scaleFor } from '../../core/camera';
import { computeRegionSpec } from '../../core/region';
import type { MapGeometry, WorldPoint } from '../../core/types';
import { packGeometry } from '../../tiles/packed-geometry';
import { buildMaskPaths } from '../mask-paths';
import { buildStructurePaths } from '../structure-paths';
import { buildTransitPaths } from '../transit-paths';

const spec = computeRegionSpec(
  { center: [0.3, 0.3], zoom: 18 },
  { width: 390, height: 780 },
  { dataZooms: { min: 0, max: 14 } }
);
const scale = scaleFor(spec.zoom);
const width = (spec.rect.maxX - spec.rect.minX) * scale;
const height = (spec.rect.maxY - spec.rect.minY) * scale;
const point = (x: number, y: number): WorldPoint => [
  spec.rect.minX + x / scale,
  spec.rect.minY + y / scale,
];
const ring = (x: number, y: number, w: number, h: number): WorldPoint[] => [
  point(x, y),
  point(x + w, y),
  point(x + w, y + h),
  point(x, y + h),
  point(x, y),
];
const geometry = (features: Partial<MapGeometry>) =>
  packGeometry({
    streets: [],
    parks: [],
    water: [],
    rivers: [],
    transit: [],
    places: [],
    ...features,
  });

describe('region path culling', () => {
  it('drops off-region streets, rivers, area fills, structures and transit', () => {
    const points = [point(-100, -100), point(-50, -50)];
    const area = { rings: [ring(-100, -100, 50, 50)] };
    const packed = geometry({
      streets: [{ roadClass: 4, points }],
      rivers: [{ points }],
      parks: [area],
      water: [area],
      buildings: [area],
      aeroAreas: [{ ...area, kind: 'apron' }],
      aeroLines: [{ kind: 'runway', points }],
      transit: [{ mode: 'subway', points }],
    });
    expect(buildMaskPaths(packed, spec)).toEqual({
      streets: ['', '', '', '', ''],
      park: '',
      water: '',
      rivers: '',
    });
    expect(buildStructurePaths(packed, spec)).toEqual({
      buildings: '',
      aeroAreas: {},
      aeroLines: {},
    });
    expect(buildTransitPaths(packed, spec)).toEqual({});
  });

  it('retains crossing lines with both endpoints outside the region', () => {
    const points = [point(-100, height / 2), point(width + 100, height / 2)];
    const packed = geometry({
      streets: [{ roadClass: 4, points }],
      rivers: [{ points }],
      aeroLines: [{ kind: 'runway', points }],
      transit: [{ mode: 'subway', points }],
    });
    expect(buildMaskPaths(packed, spec).streets[4]).toContain('L');
    expect(buildMaskPaths(packed, spec).rivers).toContain('L');
    expect(buildStructurePaths(packed, spec).aeroLines.runway).toContain('L');
    expect(buildTransitPaths(packed, spec).subway).toContain('L');
  });

  it('retains an enclosing polygon and all its holes without changing winding', () => {
    const area = {
      rings: [ring(-50, -50, width + 100, height + 100), ring(30, 30, 80, 80).reverse()],
    };
    const packed = geometry({ water: [area], parks: [area], buildings: [area] });
    expect(buildMaskPaths(packed, spec).water.match(/Z/g)).toHaveLength(2);
    expect(buildMaskPaths(packed, spec).park.match(/Z/g)).toHaveLength(2);
    expect(buildStructurePaths(packed, spec).buildings.match(/Z/g)).toHaveLength(2);
  });

  it('keeps off-edge strokes whose half-width reaches the bitmap', () => {
    const points = [point(-1, 10), point(-1, height - 10)];
    const packed = geometry({
      streets: [{ roadClass: 4, points }],
      aeroLines: [{ kind: 'runway', points }],
      transit: [{ mode: 'subway', points }],
    });
    expect(buildMaskPaths(packed, spec).streets[4]).toContain('L');
    expect(buildStructurePaths(packed, spec).aeroLines.runway).toContain('L');
    expect(buildTransitPaths(packed, spec).subway).toContain('L');
  });

  it('rejects disjoint rings of batched MultiPolygons without dropping enclosing holes', () => {
    const area = {
      rings: [
        ring(-50, -50, width + 100, height + 100),
        ring(30, 30, 80, 80).reverse(),
        ring(width + 100, 30, 80, 80),
        ring(width + 120, 50, 30, 30).reverse(),
      ],
    };
    const packed = geometry({ water: [area], buildings: [area] });
    expect(buildMaskPaths(packed, spec).water.match(/Z/g)).toHaveLength(2);
    expect(buildStructurePaths(packed, spec).buildings.match(/Z/g)).toHaveLength(2);
  });
});
