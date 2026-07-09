import type { WorldPoint, WorldRect } from './types';

/** Axial hex coordinate serialized as `"q,r"` — the exploration-state key format. */
export type HexKey = string;

const SQRT3 = Math.sqrt(3);

/** The six axial neighbor offsets of a flat-top hex. */
export const HEX_NEIGHBORS: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

export function hexKeyOf(q: number, r: number): HexKey {
  return q + ',' + r;
}

export function parseHexKey(key: HexKey): readonly [number, number] {
  const i = key.indexOf(',');
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

/**
 * A flat-top hexagonal grid over world space with circumradius `radius` (world
 * units). Point→cell uses cube rounding, an exact port of the mock's `hexKey`.
 */
export interface HexGrid {
  readonly radius: number;
  keyAt(point: WorldPoint): HexKey;
  center(key: HexKey): WorldPoint;
  corners(key: HexKey): readonly WorldPoint[];
  neighbors(key: HexKey): readonly HexKey[];
  /** Keys of every cell whose center lies within `rect` grown by one cell margin. */
  cellsIn(rect: WorldRect): readonly HexKey[];
}

export function createHexGrid(radius: number): HexGrid {
  const R = radius;

  function keyAt([x, y]: WorldPoint): HexKey {
    const q = ((2 / 3) * x) / R;
    const r = ((-1 / 3) * x + (SQRT3 / 3) * y) / R;
    const s = -q - r;
    let rq = Math.round(q);
    let rr = Math.round(r);
    const rs = Math.round(s);
    const dq = Math.abs(rq - q);
    const dr = Math.abs(rr - r);
    const ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    return hexKeyOf(rq, rr);
  }

  function centerOf(q: number, r: number): WorldPoint {
    return [R * 1.5 * q, R * SQRT3 * (r + q / 2)];
  }

  function center(key: HexKey): WorldPoint {
    const [q, r] = parseHexKey(key);
    return centerOf(q, r);
  }

  function corners(key: HexKey): readonly WorldPoint[] {
    const [cx, cy] = center(key);
    const pts: WorldPoint[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
    return pts;
  }

  function neighbors(key: HexKey): readonly HexKey[] {
    const [q, r] = parseHexKey(key);
    return HEX_NEIGHBORS.map(([dq, dr]) => hexKeyOf(q + dq, r + dr));
  }

  function cellsIn(rect: WorldRect): readonly HexKey[] {
    const keys: HexKey[] = [];
    // Column pitch is 1.5R, row pitch √3·R; scan one cell beyond every edge so
    // partially visible hexes are included.
    const qMin = Math.floor((rect.minX - R) / (1.5 * R));
    const qMax = Math.ceil((rect.maxX + R) / (1.5 * R));
    for (let q = qMin; q <= qMax; q++) {
      // y = R·√3·(r + q/2)  →  r = y / (R·√3) − q/2
      const rMin = Math.floor((rect.minY - R) / (SQRT3 * R) - q / 2);
      const rMax = Math.ceil((rect.maxY + R) / (SQRT3 * R) - q / 2);
      for (let r = rMin; r <= rMax; r++) {
        keys.push(hexKeyOf(q, r));
      }
    }
    return keys;
  }

  return { radius: R, keyAt, center, corners, neighbors, cellsIn };
}
