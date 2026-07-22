import { latLonToWorld, worldToLatLon } from './mercator';
import type { WorldPoint, WorldRect } from './types';

/**
 * H3 cell index in its canonical string form, e.g. "8a2830828767fff". The
 * exploration-state key format: globally unique, hierarchical (cellToParent),
 * and near-uniform in ground area — unlike the retired mercator-axial hex keys,
 * whose ground size drifted with latitude.
 */
export type CellIndex = string;

/**
 * The h3-js subset the map consumes, as an injectable port: pure modules never
 * import h3-js directly, so unit tests can substitute deterministic fakes (and
 * the ~1 MB emscripten bundle stays behind one lazy require).
 */
export interface H3Core {
  latLngToCell(lat: number, lng: number, res: number): CellIndex;
  cellToLatLng(cell: CellIndex): [number, number];
  cellToBoundary(cell: CellIndex): [number, number][];
  cellToParent(cell: CellIndex, res: number): CellIndex;
  cellToChildrenSize(cell: CellIndex, res: number): number;
  getResolution(cell: CellIndex): number;
  polygonToCells(loop: [number, number][], res: number): CellIndex[];
  gridDisk(cell: CellIndex, k: number): CellIndex[];
}

let real: H3Core | undefined;

/** The real h3-js implementation (lazy — pulls in the emscripten bundle). */
export function realH3(): H3Core {
  if (!real) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy heavyweight load, mirrors the expo-sqlite pattern
    real = require('h3-js') as H3Core;
  }
  return real;
}

/**
 * World-space adapter over {@link H3Core}: everything the map needs speaks
 * normalized Web Mercator [0,1]² world coords; lat/lng stays an internal
 * detail of this module.
 */
export interface H3Grid {
  cellAt(point: WorldPoint, res: number): CellIndex;
  centerWorld(cell: CellIndex): WorldPoint;
  /**
   * Cell outline in world coords, longitudes unwrapped relative to the cell
   * center so a cell straddling the antimeridian projects as one contiguous
   * polygon (possibly slightly outside [0,1] — harmless region-locally).
   */
  boundaryWorld(cell: CellIndex): WorldPoint[];
  /** The 5–6 adjacent cells (5 for the twelve pentagons per resolution). */
  neighborsOf(cell: CellIndex): CellIndex[];
  /**
   * Every cell at `res` overlapping `rect` (center-containment over the rect
   * grown by ~1.5 cell edges, so partially visible boundary cells count).
   */
  cellsInRect(rect: WorldRect, res: number): CellIndex[];
  parentOf(cell: CellIndex, res: number): CellIndex;
  /** Exact descendant count at `res` — 7^Δ except along pentagon lineages. */
  childrenSize(cell: CellIndex, res: number): number;
  resolutionOf(cell: CellIndex): number;
}

/**
 * Average H3 edge length in km ≈ 1108 / √7^res (each finer res shrinks edges
 * by √7). Only used to pad query rects, so the approximation is ample.
 */
function avgEdgeKm(res: number): number {
  return 1107.7 / Math.sqrt(7) ** res;
}

const EARTH_CIRCUMFERENCE_KM = 40_075;

/**
 * polygonToCells misbehaves on loops spanning ≥180° of longitude (H3 reads big
 * vertex jumps as transmeridian crossings), so wider query rects recurse into
 * halves below this world-x span (0.35 → 126°).
 */
const MAX_QUERY_SPAN_X = 0.35;

export function createH3Grid(core: H3Core): H3Grid {
  // H3 cell geometry is immutable, so cache it for the grid's lifetime. This is
  // the map's hottest reuse: `buildCellField` calls these per cell every region
  // build, and panning/zooming revisits mostly the same cells — turning the
  // expensive h3-js boundary/center/neighbor calls into Map lookups on repeat.
  // Keyed by cell index; bounded in practice by the cells a session visits.
  const centerCache = new Map<CellIndex, WorldPoint>();
  const boundaryCache = new Map<CellIndex, WorldPoint[]>();
  const neighborCache = new Map<CellIndex, CellIndex[]>();

  function cellAt(point: WorldPoint, res: number): CellIndex {
    const { lat, lon } = worldToLatLon(point);
    return core.latLngToCell(lat, lon, res);
  }

  function centerWorld(cell: CellIndex): WorldPoint {
    const hit = centerCache.get(cell);
    if (hit) return hit;
    const [lat, lng] = core.cellToLatLng(cell);
    const world = latLonToWorld({ lat, lon: lng });
    centerCache.set(cell, world);
    return world;
  }

  function boundaryWorld(cell: CellIndex): WorldPoint[] {
    const hit = boundaryCache.get(cell);
    if (hit) return hit;
    const [, centerLng] = core.cellToLatLng(cell);
    const world = core.cellToBoundary(cell).map(([lat, lng]) => {
      let lon = lng;
      while (lon - centerLng > 180) lon -= 360;
      while (lon - centerLng < -180) lon += 360;
      return latLonToWorld({ lat, lon });
    });
    boundaryCache.set(cell, world);
    return world;
  }

  function neighborsOf(cell: CellIndex): CellIndex[] {
    const hit = neighborCache.get(cell);
    if (hit) return hit;
    const neighbors = core.gridDisk(cell, 1).filter((c) => c !== cell);
    neighborCache.set(cell, neighbors);
    return neighbors;
  }

  function collectCells(rect: WorldRect, res: number, into: Set<CellIndex>): void {
    if (rect.minX >= rect.maxX || rect.minY >= rect.maxY) return;
    if (rect.maxX - rect.minX >= MAX_QUERY_SPAN_X) {
      const midX = (rect.minX + rect.maxX) / 2;
      collectCells({ ...rect, maxX: midX }, res, into);
      collectCells({ ...rect, minX: midX }, res, into);
      return;
    }
    const nw = worldToLatLon([rect.minX, rect.minY]);
    const ne = worldToLatLon([rect.maxX, rect.minY]);
    const se = worldToLatLon([rect.maxX, rect.maxY]);
    const sw = worldToLatLon([rect.minX, rect.maxY]);
    const loop: [number, number][] = [
      [nw.lat, nw.lon],
      [ne.lat, ne.lon],
      [se.lat, se.lon],
      [sw.lat, sw.lon],
    ];
    for (const cell of core.polygonToCells(loop, res)) into.add(cell);
  }

  function cellsInRect(rect: WorldRect, res: number): CellIndex[] {
    // Pad by ~1.5 cell edges so cells whose center sits just outside the rect
    // (but whose area pokes in) are included. Mercator is conformal, so one
    // margin serves both axes; the local scale comes from the rect's mid-lat.
    const midLat = worldToLatLon([0.5, (rect.minY + rect.maxY) / 2]).lat;
    const cosLat = Math.max(0.087, Math.cos((midLat * Math.PI) / 180)); // ≥ cos 85°
    const margin = Math.min(0.05, (1.5 * avgEdgeKm(res)) / (EARTH_CIRCUMFERENCE_KM * cosLat));
    const grown: WorldRect = {
      minX: Math.max(0, rect.minX - margin),
      minY: Math.max(0, rect.minY - margin),
      maxX: Math.min(1, rect.maxX + margin),
      maxY: Math.min(1, rect.maxY + margin),
    };
    const cells = new Set<CellIndex>();
    collectCells(grown, res, cells);
    return [...cells];
  }

  return {
    cellAt,
    centerWorld,
    boundaryWorld,
    neighborsOf,
    cellsInRect,
    parentOf: (cell, res) => core.cellToParent(cell, res),
    childrenSize: (cell, res) => core.cellToChildrenSize(cell, res),
    resolutionOf: (cell) => core.getResolution(cell),
  };
}
