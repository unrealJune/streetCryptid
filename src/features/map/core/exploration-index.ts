import { H3_DISPLAY_RES } from './cell-ladder';
import type { CellIndex, H3Grid } from './h3-grid';
import type { WorldPoint } from './types';

/**
 * Which res-10 cells have been acquired. A plain set of H3 indexes — trivially
 * serializable, and exactly what the GPS trail bridge appends to.
 */
export type ExplorationState = ReadonlySet<CellIndex>;

/**
 * Exploration truth plus lazily memoized parent roll-ups: `fractionAt` answers
 * "how explored is this cell" for the display res AND every coarser ladder
 * rung. The first query at a res does one pass over the res-10 set (once per
 * session); `add` then maintains every materialized rung incrementally, so
 * live GPS updates never trigger a rescan.
 */
export interface ExplorationIndex {
  readonly res10: ExplorationState;
  /** Explored fraction 0–1: membership at res 10, child-count ratio above. */
  fractionAt(cell: CellIndex): number;
  /** Record a res-10 cell; `false` if already present. Updates roll-ups. */
  add(cell: CellIndex): boolean;
}

export function createExplorationIndex(grid: H3Grid, cells: Iterable<CellIndex>): ExplorationIndex {
  const res10 = new Set(cells);
  const rollups = new Map<number, Map<CellIndex, number>>();

  function rollupFor(res: number): Map<CellIndex, number> {
    let counts = rollups.get(res);
    if (!counts) {
      counts = new Map();
      for (const cell of res10) {
        const parent = grid.parentOf(cell, res);
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
      }
      rollups.set(res, counts);
    }
    return counts;
  }

  return {
    res10,
    fractionAt(cell) {
      const res = grid.resolutionOf(cell);
      if (res === H3_DISPLAY_RES) return res10.has(cell) ? 1 : 0;
      const count = rollupFor(res).get(cell) ?? 0;
      if (count === 0) return 0;
      // childrenSize is exact per lineage (pentagons have 6-child generations),
      // so the ratio is a true fraction; min() only guards float/fake-core slack.
      return Math.min(1, count / grid.childrenSize(cell, H3_DISPLAY_RES));
    },
    add(cell) {
      if (res10.has(cell)) return false;
      res10.add(cell);
      for (const [res, counts] of rollups) {
        const parent = grid.parentOf(cell, res);
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
      }
      return true;
    },
  };
}

/**
 * Of `cells` (res 10), the discovered ones bordering at least one undiscovered
 * neighbor — the cells that get the amber frontier rim.
 */
export function frontierOf(
  state: ExplorationState,
  grid: H3Grid,
  cells: readonly CellIndex[]
): CellIndex[] {
  const frontier: CellIndex[] = [];
  for (const cell of cells) {
    if (!state.has(cell)) continue;
    for (const neighbor of grid.neighborsOf(cell)) {
      if (!state.has(neighbor)) {
        frontier.push(cell);
        break;
      }
    }
  }
  return frontier;
}

/** Deterministic 32-bit PRNG (mulberry32) so demo exploration is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoExplorationOptions {
  /** Number of random walks radiating from home. */
  readonly walks?: number;
  /** Steps per walk. */
  readonly steps?: number;
  /** PRNG seed — same seed, same territory. */
  readonly seed?: number;
}

/**
 * A deterministic stand-in for real GPS history: the home cell plus its ring,
 * with several direction-biased random walks radiating outward. H3 neighbors
 * carry no stable direction index, so each walk keeps a world-space heading
 * and steps to whichever neighbor lies closest to it — same organic
 * blob-with-arms territory as the retired axial version.
 */
export function demoExploration(
  grid: H3Grid,
  home: WorldPoint,
  { walks = 6, steps = 26, seed = 20260707 }: DemoExplorationOptions = {}
): Set<CellIndex> {
  const random = mulberry32(seed);
  const discovered = new Set<CellIndex>();

  const homeCell = grid.cellAt(home, H3_DISPLAY_RES);
  discovered.add(homeCell);
  for (const neighbor of grid.neighborsOf(homeCell)) discovered.add(neighbor);

  for (let w = 0; w < walks; w++) {
    let cell = homeCell;
    let heading = random() * 2 * Math.PI;
    for (let s = 0; s < steps; s++) {
      // mostly keep heading, sometimes veer one face left/right — streets, not sprays
      const roll = random();
      if (roll > 0.85) heading += Math.PI / 3;
      else if (roll > 0.7) heading -= Math.PI / 3;
      cell = stepToward(grid, cell, heading);
      discovered.add(cell);
    }
  }

  return discovered;
}

/** The neighbor of `cell` whose center lies most along `heading` (radians). */
function stepToward(grid: H3Grid, cell: CellIndex, heading: number): CellIndex {
  const [cx, cy] = grid.centerWorld(cell);
  const hx = Math.cos(heading);
  const hy = Math.sin(heading);
  let best = cell;
  let bestDot = -Infinity;
  for (const neighbor of grid.neighborsOf(cell)) {
    const [nx, ny] = grid.centerWorld(neighbor);
    const dx = nx - cx;
    const dy = ny - cy;
    const len = Math.hypot(dx, dy) || 1;
    const dot = (dx * hx + dy * hy) / len;
    if (dot > bestDot) {
      bestDot = dot;
      best = neighbor;
    }
  }
  return best;
}
