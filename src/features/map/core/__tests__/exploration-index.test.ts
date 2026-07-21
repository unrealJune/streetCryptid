import { H3_DISPLAY_RES } from '../cell-ladder';
import {
  createExplorationIndex,
  demoExploration,
  frontierOf,
  mulberry32,
} from '../exploration-index';
import { createH3Grid, realH3, type H3Grid } from '../h3-grid';
import { latLonToWorld } from '../mercator';

const grid = createH3Grid(realH3());
const HOME = latLonToWorld({ lat: 47.6205, lon: -122.3169 });

describe('createExplorationIndex', () => {
  it('answers membership at the display res', () => {
    const cell = grid.cellAt(HOME, H3_DISPLAY_RES);
    const other = grid.neighborsOf(cell)[0];
    const index = createExplorationIndex(grid, [cell]);
    expect(index.fractionAt(cell)).toBe(1);
    expect(index.fractionAt(other)).toBe(0);
  });

  it('rolls up to parent fractions with exact denominators', () => {
    const cell = grid.cellAt(HOME, H3_DISPLAY_RES);
    const disk = [cell, ...grid.neighborsOf(cell)];
    const index = createExplorationIndex(grid, disk);
    // Aperture-7 children aren't neighbor-closed, so the disk may straddle
    // several res-8 parents — group first, then check each parent's ratio.
    const byParent = new Map<string, number>();
    for (const c of disk) {
      const p = grid.parentOf(c, 8);
      byParent.set(p, (byParent.get(p) ?? 0) + 1);
    }
    for (const [parent, count] of byParent) {
      const expected = count / grid.childrenSize(parent, H3_DISPLAY_RES);
      expect(index.fractionAt(parent)).toBeCloseTo(expected, 10);
    }
    expect(index.fractionAt(grid.parentOf(cell, 2))).toBeGreaterThan(0);
    expect(index.fractionAt(grid.parentOf(cell, 2))).toBeLessThan(1e-5); // 7 / 7^8
  });

  it('add() maintains materialized roll-ups incrementally', () => {
    const cell = grid.cellAt(HOME, H3_DISPLAY_RES);
    const ring = grid.neighborsOf(cell);
    const incremental = createExplorationIndex(grid, [cell]);
    const parent = grid.parentOf(cell, 7);
    incremental.fractionAt(parent); // materialize res 7 before the adds
    for (const n of ring) expect(incremental.add(n)).toBe(true);
    expect(incremental.add(cell)).toBe(false); // duplicate

    const fromScratch = createExplorationIndex(grid, [cell, ...ring]);
    expect(incremental.fractionAt(parent)).toBe(fromScratch.fractionAt(parent));
    expect(incremental.res10.size).toBe(7);
  });

  it('uses exact child counts on pentagon lineages', () => {
    // A fake grid where the parent is a pentagon: 6-child first generation.
    const fake = {
      parentOf: () => 'pentagon',
      resolutionOf: (c: string) => (c === 'pentagon' ? 9 : 10),
      childrenSize: () => 6,
      neighborsOf: () => [],
    } as unknown as H3Grid;
    const index = createExplorationIndex(fake, ['a', 'b', 'c']);
    expect(index.fractionAt('pentagon')).toBe(3 / 6); // not 3/7
  });
});

describe('frontierOf', () => {
  it('marks discovered cells with undiscovered neighbors, and only those', () => {
    const cell = grid.cellAt(HOME, H3_DISPLAY_RES);
    const ring = grid.neighborsOf(cell);
    const state = new Set([cell, ...ring]);
    const frontier = new Set(frontierOf(state, grid, [cell, ...ring]));
    expect(frontier.has(cell)).toBe(false); // fully enclosed
    for (const n of ring) expect(frontier.has(n)).toBe(true);
  });
});

describe('demoExploration', () => {
  it('is deterministic per seed and varies across seeds', () => {
    const a = demoExploration(grid, HOME, { seed: 7 });
    const b = demoExploration(grid, HOME, { seed: 7 });
    const c = demoExploration(grid, HOME, { seed: 8 });
    expect([...a].sort()).toEqual([...b].sort());
    expect([...a].sort()).not.toEqual([...c].sort());
  });

  it('contains the home disk and grows arms of bounded size', () => {
    const state = demoExploration(grid, HOME);
    const home = grid.cellAt(HOME, H3_DISPLAY_RES);
    expect(state.has(home)).toBe(true);
    for (const n of grid.neighborsOf(home)) expect(state.has(n)).toBe(true);
    // 7 home cells + 6 walks × 26 steps, minus revisits.
    expect(state.size).toBeGreaterThan(60);
    expect(state.size).toBeLessThanOrEqual(7 + 6 * 26);
  });

  it('walks step to adjacent cells only', () => {
    const home = grid.cellAt(HOME, H3_DISPLAY_RES);
    const random = mulberry32(1);
    void random;
    const state = demoExploration(grid, HOME, { walks: 1, steps: 5, seed: 1 });
    // Every discovered cell is reachable: it neighbors another discovered cell.
    for (const cell of state) {
      if (cell === home) continue;
      const touches = grid.neighborsOf(cell).some((n) => state.has(n));
      expect(touches).toBe(true);
    }
  });
});
