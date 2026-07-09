import { coverageOf, demoExploration, frontierOf, mulberry32 } from '../exploration';
import type { ExplorationState } from '../exploration';
import { createHexGrid } from '../hex';
import type { HexGrid } from '../hex';

const grid = createHexGrid(10);

// Home at [0,0] → grid.keyAt([0,0]) = '0,0' (center of hex (q=0,r=0))
const HOME_WORLD: [number, number] = [0, 0];
const HOME_KEY = grid.keyAt(HOME_WORLD); // '0,0'

/** BFS reachability: returns true iff every cell in `state` is reachable from
 *  `startKey` through discovered hex neighbors. */
function bfsConnected(state: ExplorationState, hexGrid: HexGrid, startKey: string): boolean {
  const visited = new Set<string>([startKey]);
  const queue = [startKey];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const n of hexGrid.neighbors(key)) {
      if (state.has(n) && !visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return visited.size === state.size;
}

// ─── coverageOf ───────────────────────────────────────────────────────────────

describe('coverageOf', () => {
  it('returns 0 for an empty cells list', () => {
    const state: ExplorationState = new Set(['0,0', '1,0']);
    expect(coverageOf(state, [])).toBe(0);
  });

  it('returns the discovered fraction of the provided cell list', () => {
    const cells = ['0,0', '1,0', '0,1', '-1,1'] as const;
    const state: ExplorationState = new Set(['0,0', '1,0']); // 2 of 4 discovered
    expect(coverageOf(state, [...cells])).toBe(0.5);
  });

  it('returns 0 when none of the cells are discovered', () => {
    const state: ExplorationState = new Set<string>();
    expect(coverageOf(state, ['0,0', '1,0', '2,0'])).toBe(0);
  });

  it('returns 1 when all cells are discovered', () => {
    const cells = ['0,0', '1,0', '2,0'];
    const state: ExplorationState = new Set(cells);
    expect(coverageOf(state, cells)).toBe(1);
  });
});

// ─── frontierOf ───────────────────────────────────────────────────────────────

describe('frontierOf', () => {
  it('excludes a fully-surrounded center cell and includes all 6 ring cells', () => {
    // state = center '0,0' + its 6 neighbors — center is fully surrounded, each
    // ring cell has undiscovered outer neighbors → all 6 are on the frontier
    const neighborKeys = grid.neighbors(HOME_KEY);
    const cells = [HOME_KEY, ...neighborKeys];
    const state: ExplorationState = new Set(cells);

    const frontier = frontierOf(state, grid, cells);

    // center is fully enclosed → NOT frontier
    expect(frontier).not.toContain(HOME_KEY);

    // all 6 ring cells border the undiscovered second ring → all ARE frontier
    for (const n of neighborKeys) {
      expect(frontier).toContain(n);
    }
    expect(frontier).toHaveLength(6);
  });

  it('returns an empty array when no cell in the list is discovered', () => {
    const cells = [HOME_KEY, ...grid.neighbors(HOME_KEY)];
    const state: ExplorationState = new Set<string>(); // nothing discovered
    expect(frontierOf(state, grid, cells)).toHaveLength(0);
  });

  it('does not report a discovered cell that is absent from the cells array', () => {
    // '2,0' is discovered but not listed in cells → must never appear in output
    const neighborKeys = grid.neighbors(HOME_KEY);
    const cells = [HOME_KEY, ...neighborKeys];
    const state: ExplorationState = new Set([...cells, '2,0']);

    const frontier = frontierOf(state, grid, cells);
    expect(frontier).not.toContain('2,0');
  });
});

// ─── mulberry32 ───────────────────────────────────────────────────────────────

describe('mulberry32', () => {
  it('produces identical sequences for the same seed', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    const n = 10;
    const seq1 = Array.from({ length: n }, rng1);
    const seq2 = Array.from({ length: n }, rng2);
    expect(seq1).toEqual(seq2);
  });

  it('produces different sequences for different seeds', () => {
    const first = (seed: number) => mulberry32(seed)();
    expect(first(1)).not.toBe(first(2));
  });

  it('returns values in [0, 1)', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ─── demoExploration ─────────────────────────────────────────────────────────

describe('demoExploration', () => {
  it('is deterministic: same arguments produce equal discovery sets', () => {
    const opts = { walks: 6, steps: 26, seed: 20260707 };
    const a = demoExploration(grid, HOME_WORLD, opts);
    const b = demoExploration(grid, HOME_WORLD, opts);
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('always contains the home hex and all 6 of its immediate neighbors', () => {
    const result = demoExploration(grid, HOME_WORLD, { seed: 42 });
    expect(result.has(HOME_KEY)).toBe(true);
    for (const n of grid.neighbors(HOME_KEY)) {
      expect(result.has(n)).toBe(true);
    }
  });

  it('produces a plausibly-sized territory (at least 7, at most home+walks×steps)', () => {
    const walks = 6;
    const steps = 26;
    const result = demoExploration(grid, HOME_WORLD, { walks, steps, seed: 99 });
    // minimum: home + 6 neighbors = 7 (walks might revisit existing cells)
    expect(result.size).toBeGreaterThanOrEqual(7);
    // maximum: 7 initial + at most walks×steps additional distinct cells
    expect(result.size).toBeLessThanOrEqual(7 + walks * steps);
  });

  it('different seeds produce different discovery sets', () => {
    const a = demoExploration(grid, HOME_WORLD, { seed: 1 });
    const b = demoExploration(grid, HOME_WORLD, { seed: 2 });
    expect([...a].sort()).not.toEqual([...b].sort());
  });

  it('every discovered cell is reachable from home through discovered neighbors (BFS)', () => {
    const result = demoExploration(grid, HOME_WORLD, { seed: 20260707 });
    expect(bfsConnected(result, grid, HOME_KEY)).toBe(true);
  });
});
