import type { WorldRect } from '../core/types';
import type { PackedAreas, PackedLines, PackedTile } from '../tiles/packed-geometry';

type Features = PackedLines | PackedAreas;

// Tile coordinates are immutable. Weak keys let these bounds leave memory with
// the decoded tile, rather than retaining a second unbounded geometry cache.
const cache = new WeakMap<Features, Float32Array>();
const ringCache = new WeakMap<PackedAreas, Float32Array>();

/** Per-feature minX/minY/maxX/maxY, in the tile's delta coordinate space. */
export function featureBounds(features: Features): Float32Array {
  const cached = cache.get(features);
  if (cached) return cached;
  const bounds = new Float32Array(features.count * 4);
  const { coords, pointOff } = features;
  for (let i = 0; i < features.count; i++) {
    // Include ALL rings: testing vertices inside the view would drop a polygon
    // enclosing it.
    const from = pointOff['ringOff' in features ? features.ringOff[i] : i];
    const to = pointOff['ringOff' in features ? features.ringOff[i + 1] : i + 1];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let p = from * 2; p < to * 2; p += 2) {
      minX = Math.min(minX, coords[p]);
      minY = Math.min(minY, coords[p + 1]);
      maxX = Math.max(maxX, coords[p]);
      maxY = Math.max(maxY, coords[p + 1]);
    }
    bounds.set([minX, minY, maxX, maxY], i * 4);
  }
  cache.set(features, bounds);
  return bounds;
}

/** OMT combines hundreds of disjoint buildings in a single MultiPolygon. */
export function ringBounds(areas: PackedAreas): Float32Array {
  const cached = ringCache.get(areas);
  if (cached) return cached;
  const bounds = featureBounds({
    count: areas.pointOff.length - 1,
    pointOff: areas.pointOff,
    coords: areas.coords,
  });
  ringCache.set(areas, bounds);
  return bounds;
}

/** Conservative reject only: crossing lines and enclosing polygons survive. */
export function intersectsBounds(bounds: Float32Array, index: number, rect: WorldRect): boolean {
  const i = index * 4;
  return (
    bounds[i] <= rect.maxX &&
    bounds[i + 1] <= rect.maxY &&
    bounds[i + 2] >= rect.minX &&
    bounds[i + 3] >= rect.minY
  );
}

/** Grow for stroke/AA coverage BEFORE rejecting a feature near the image edge. */
export function tileLocalRect(
  rect: WorldRect,
  tile: Pick<PackedTile, 'originX' | 'originY'>,
  padding: number
): WorldRect {
  return {
    minX: rect.minX - tile.originX - padding,
    minY: rect.minY - tile.originY - padding,
    maxX: rect.maxX - tile.originX + padding,
    maxY: rect.maxY - tile.originY + padding,
  };
}
