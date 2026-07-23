import { H3_DISPLAY_RES } from './cell-ladder';
import type { CellIndex, H3Grid } from './h3-grid';
import type { WorldPoint } from './types';

/**
 * Which res-9 cells have been acquired. A plain set of H3 indexes — trivially
 * serializable, and exactly what the GPS trail bridge appends to.
 */
export type ExplorationState = ReadonlySet<CellIndex>;

/**
 * Exploration truth at the one resolution used for both occupancy and display.
 */
export interface ExplorationIndex {
  readonly cells: ExplorationState;
  /** Explored fraction 0 or 1 at the fixed display resolution. */
  fractionAt(cell: CellIndex): number;
  /** Record a display-resolution cell; `false` if already present. */
  add(cell: CellIndex): boolean;
}

export function createExplorationIndex(cells: Iterable<CellIndex>): ExplorationIndex {
  const explored = new Set(cells);
  return {
    cells: explored,
    fractionAt: (cell) => (explored.has(cell) ? 1 : 0),
    add(cell) {
      if (explored.has(cell)) return false;
      explored.add(cell);
      return true;
    },
  };
}

/**
 * Of `cells` (res 9), the discovered ones bordering at least one undiscovered
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
