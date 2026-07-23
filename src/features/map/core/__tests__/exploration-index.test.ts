import { H3_DISPLAY_RES } from '../cell-ladder';
import {
  createExplorationIndex,
  demoExploration,
  frontierOf,
  mulberry32,
} from '../exploration-index';
import { createH3Grid, realH3 } from '../h3-grid';
import { latLonToWorld } from '../mercator';

const grid = createH3Grid(realH3());
const HOME = latLonToWorld({ lat: 47.6205, lon: -122.3169 });

describe('createExplorationIndex', () => {
  it('answers membership at the display res', () => {
    const cell = grid.cellAt(HOME, H3_DISPLAY_RES);
    const other = grid.neighborsOf(cell)[0];
    const index = createExplorationIndex([cell]);
    expect(index.fractionAt(cell)).toBe(1);
    expect(index.fractionAt(other)).toBe(0);
  });

  it('add() updates fixed-resolution membership', () => {
    const cell = grid.cellAt(HOME, H3_DISPLAY_RES);
    const ring = grid.neighborsOf(cell);
    const incremental = createExplorationIndex([cell]);
    for (const n of ring) expect(incremental.add(n)).toBe(true);
    expect(incremental.add(cell)).toBe(false); // duplicate

    const fromScratch = createExplorationIndex([cell, ...ring]);
    expect(incremental.cells).toEqual(fromScratch.cells);
    expect(incremental.cells.size).toBe(7);
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
