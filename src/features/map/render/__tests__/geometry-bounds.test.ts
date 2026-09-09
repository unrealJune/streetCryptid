import { packGeometry } from '../../tiles/packed-geometry';
import type { WorldPoint } from '../../core/types';
import { featureBounds, intersectsBounds, tileLocalRect } from '../geometry-bounds';

const ring = (min: number, max: number): WorldPoint[] => [
  [min, min],
  [max, min],
  [max, max],
  [min, max],
];
const tile = packGeometry({
  streets: [
    {
      roadClass: 1,
      points: [
        [-2, 0],
        [2, 0],
      ],
    },
    {
      roadClass: 1,
      points: [
        [3, 3],
        [4, 4],
      ],
    },
    { roadClass: 1, points: [] },
  ],
  parks: [{ rings: [ring(-2, 2), ring(-0.5, 0.5).reverse()] }],
  water: [],
  rivers: [],
  transit: [],
  places: [],
}).parts[0];
const rect = { minX: -1, minY: -1, maxX: 1, maxY: 1 };

describe('featureBounds', () => {
  it('retains a crossing line even when neither endpoint is inside', () => {
    const bounds = featureBounds(tile.streets);
    expect(intersectsBounds(bounds, 0, rect)).toBe(true);
    expect(intersectsBounds(bounds, 1, rect)).toBe(false);
    expect(intersectsBounds(bounds, 2, rect)).toBe(false);
  });

  it('retains enclosing polygons with holes as a whole feature', () => {
    const bounds = featureBounds(tile.parks);
    expect([...bounds]).toEqual([-2, -2, 2, 2]);
    expect(intersectsBounds(bounds, 0, rect)).toBe(true);
  });

  it('reuses bounds for the same immutable tile section', () => {
    expect(featureBounds(tile.parks)).toBe(featureBounds(tile.parks));
    expect(featureBounds(tile.streets)).toBe(featureBounds(tile.streets));
  });

  it('keeps a touching boundary', () => {
    expect(
      intersectsBounds(featureBounds(tile.streets), 1, {
        minX: 2,
        minY: 2,
        maxX: 3,
        maxY: 3,
      })
    ).toBe(true);
  });
});

describe('tileLocalRect', () => {
  it('subtracts the tile origin without rounding world coordinates to f32', () => {
    expect(tileLocalRect(rect, { originX: 0.25, originY: 0.5 }, 0.125)).toEqual({
      minX: -1.375,
      minY: -1.625,
      maxX: 0.875,
      maxY: 0.625,
    });
  });

  it('retains geometry just outside the rect when its stroke reaches the image', () => {
    const bounds = new Float32Array([1.1, -0.5, 1.1, 0.5]);
    expect(intersectsBounds(bounds, 0, rect)).toBe(false);
    expect(intersectsBounds(bounds, 0, tileLocalRect(rect, tile, 0.2))).toBe(true);
  });
});
