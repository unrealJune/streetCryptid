import { H3_COARSEST_RES, H3_DISPLAY_RES } from '../cell-ladder';
import { buildCellField, cellHash } from '../cell-field';
import { createExplorationIndex, demoExploration } from '../exploration-index';
import { createH3Grid, realH3 } from '../h3-grid';
import { latLonToWorld } from '../mercator';
import type { WorldRect } from '../types';

const grid = createH3Grid(realH3());
const HOME = latLonToWorld({ lat: 47.6205, lon: -122.3169 });

function rectAround(center: readonly [number, number], half: number): WorldRect {
  return {
    minX: center[0] - half,
    minY: center[1] - half,
    maxX: center[0] + half,
    maxY: center[1] + half,
  };
}

describe('cellHash', () => {
  it('is stable, in [0,1), and decorrelates neighbors', () => {
    expect(cellHash('8a2830828767fff')).toBe(cellHash('8a2830828767fff'));
    const cell = grid.cellAt(HOME, H3_DISPLAY_RES);
    const values = [cell, ...grid.neighborsOf(cell)].map(cellHash);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('buildCellField', () => {
  const exploration = createExplorationIndex(demoExploration(grid, HOME));
  const rect = rectAround(HOME, 6e-5);

  it('annotates display-res cells with binary fractions and a frontier', () => {
    const field = buildCellField(grid, rect, H3_DISPLAY_RES, exploration);
    expect(field.res).toBe(H3_DISPLAY_RES);
    expect(field.cells.length).toBeGreaterThan(5);

    const byId = new Map(field.cells.map((c) => [c.cell, c]));
    const home = byId.get(grid.cellAt(HOME, H3_DISPLAY_RES))!;
    expect(home.fraction).toBe(1);

    let frontiers = 0;
    for (const c of field.cells) {
      expect([0, 1]).toContain(c.fraction);
      if (c.frontier) {
        frontiers++;
        expect(c.fraction).toBe(1); // only discovered cells rim
      }
      expect(c.boundary.length).toBeGreaterThanOrEqual(5);
      expect(c.jitter).toBe(cellHash(c.cell));
      expect(c.order).toBeGreaterThanOrEqual(0);
      expect(c.order).toBeLessThanOrEqual(1);
    }
    // A demo blob inside the rect must expose an edge somewhere.
    expect(frontiers).toBeGreaterThan(0);
  });

  it('orders cells center-out', () => {
    const field = buildCellField(grid, rect, H3_DISPLAY_RES, exploration);
    const mid: [number, number] = [(rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2];
    // The cell containing the rect center has (near-)minimal order.
    const byId = new Map(field.cells.map((c) => [c.cell, c]));
    const central = byId.get(grid.cellAt(mid, H3_DISPLAY_RES))!;
    const minOrder = Math.min(...field.cells.map((c) => c.order));
    expect(central.order).toBeLessThanOrEqual(minOrder + 0.1);
    // And exactly one cell attains order 1 (the farthest).
    expect(field.cells.some((c) => c.order === 1)).toBe(true);
  });

  it('is deterministic', () => {
    const a = buildCellField(grid, rect, H3_DISPLAY_RES, exploration);
    const b = buildCellField(grid, rect, H3_DISPLAY_RES, exploration);
    expect(a).toEqual(b);
  });
});

describe('buildCellField on the coarse ladder rungs', () => {
  const homeCell = grid.cellAt(HOME, H3_DISPLAY_RES);
  const exploration = createExplorationIndex([homeCell]);

  it('blooms a single explored cell into its coarse ancestor', () => {
    const res = H3_DISPLAY_RES - 3;
    const parent = grid.parentOf(homeCell, res);
    const field = buildCellField(grid, rectAround(HOME, 4e-3), res, exploration);

    expect(field.res).toBe(res);
    const byId = new Map(field.cells.map((c) => [c.cell, c]));
    expect(byId.get(parent)?.fraction).toBe(1);
    // Occupancy stays binary on every rung — the shader and the cell texture
    // depend on that.
    for (const cell of field.cells) expect([0, 1]).toContain(cell.fraction);
  });

  it('keeps the frontier rim on the coarse rungs', () => {
    const res = H3_DISPLAY_RES - 3;
    const field = buildCellField(grid, rectAround(HOME, 4e-3), res, exploration);
    const lit = field.cells.filter((c) => c.fraction >= 1);

    expect(lit.length).toBeGreaterThan(0);
    // A lone bloomed cell borders nothing but undiscovered ground, so it is all rim.
    expect(lit.every((c) => c.frontier)).toBe(true);
    expect(field.cells.every((c) => !c.frontier || c.fraction >= 1)).toBe(true);
  });

  it('draws far fewer cells over the same ground at the coarsest rung', () => {
    const rect = rectAround(HOME, 2e-3);
    const fine = buildCellField(grid, rect, H3_DISPLAY_RES, exploration);
    const coarse = buildCellField(grid, rect, H3_COARSEST_RES, exploration);
    expect(coarse.cells.length).toBeLessThan(fine.cells.length);
  });
});
