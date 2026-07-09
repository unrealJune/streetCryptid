import type { HexGrid, HexKey } from './hex';
import { HEX_NEIGHBORS, hexKeyOf, parseHexKey } from './hex';
import type { WorldPoint } from './types';

/**
 * Which hex sectors have been acquired. A plain set of axial keys — trivially
 * serializable, and exactly what real GPS acquisition will append to later.
 */
export type ExplorationState = ReadonlySet<HexKey>;

/**
 * Of `cells`, the discovered ones bordering at least one undiscovered neighbor —
 * the cells that get the amber frontier rim.
 */
export function frontierOf(
  state: ExplorationState,
  grid: HexGrid,
  cells: readonly HexKey[]
): HexKey[] {
  const frontier: HexKey[] = [];
  for (const key of cells) {
    if (!state.has(key)) continue;
    for (const neighbor of grid.neighbors(key)) {
      if (!state.has(neighbor)) {
        frontier.push(key);
        break;
      }
    }
  }
  return frontier;
}

/** Discovered fraction of `cells`, 0–1 (0 for an empty list). */
export function coverageOf(state: ExplorationState, cells: readonly HexKey[]): number {
  if (!cells.length) return 0;
  let n = 0;
  for (const key of cells) if (state.has(key)) n++;
  return n / cells.length;
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
 * A deterministic stand-in for real GPS history: the home hex plus its ring,
 * with several direction-biased random walks radiating outward. Produces the
 * organic blob-with-arms territory the design renders show.
 */
export function demoExploration(
  grid: HexGrid,
  home: WorldPoint,
  { walks = 6, steps = 26, seed = 20260707 }: DemoExplorationOptions = {}
): ExplorationState {
  const random = mulberry32(seed);
  const discovered = new Set<HexKey>();

  const homeKey = grid.keyAt(home);
  discovered.add(homeKey);
  for (const neighbor of grid.neighbors(homeKey)) discovered.add(neighbor);

  for (let w = 0; w < walks; w++) {
    let [q, r] = parseHexKey(homeKey);
    let dir = Math.floor(random() * 6);
    for (let s = 0; s < steps; s++) {
      // mostly keep heading, sometimes veer one face left/right — streets, not sprays
      const roll = random();
      if (roll > 0.85) dir = (dir + 1) % 6;
      else if (roll > 0.7) dir = (dir + 5) % 6;
      const [dq, dr] = HEX_NEIGHBORS[dir];
      q += dq;
      r += dr;
      discovered.add(hexKeyOf(q, r));
    }
  }

  return discovered;
}
