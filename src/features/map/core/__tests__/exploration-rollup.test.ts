import { H3_COARSEST_RES, H3_DISPLAY_RES } from '../cell-ladder';
import { createExplorationIndex } from '../exploration-index';
import { createExplorationRollup } from '../exploration-rollup';
import { createH3Grid, realH3 } from '../h3-grid';
import { latLonToWorld } from '../mercator';

const grid = createH3Grid(realH3());
const HOME = latLonToWorld({ lat: 47.6205, lon: -122.3169 });
const FAR = latLonToWorld({ lat: -33.8688, lon: 151.2093 }); // Sydney

const homeCell = grid.cellAt(HOME, H3_DISPLAY_RES);
const farCell = grid.cellAt(FAR, H3_DISPLAY_RES);

describe('createExplorationRollup', () => {
  it('passes the display resolution straight through to the index', () => {
    const index = createExplorationIndex([homeCell]);
    const rollup = createExplorationRollup(grid);
    expect(rollup.occupancyAt(index, homeCell, H3_DISPLAY_RES)).toBe(1);
    expect(rollup.occupancyAt(index, farCell, H3_DISPLAY_RES)).toBe(0);
  });

  it('blooms one explored cell into every ancestor rung', () => {
    const index = createExplorationIndex([homeCell]);
    const rollup = createExplorationRollup(grid);
    for (let res = H3_COARSEST_RES; res < H3_DISPLAY_RES; res++) {
      expect(rollup.occupancyAt(index, grid.parentOf(homeCell, res), res)).toBe(1);
      // …and only into ancestors it actually has.
      expect(rollup.occupancyAt(index, grid.parentOf(farCell, res), res)).toBe(0);
    }
  });

  it('picks up cells added after a resolution was first queried', () => {
    const index = createExplorationIndex([homeCell]);
    const rollup = createExplorationRollup(grid);
    const res = H3_DISPLAY_RES - 3;
    const farParent = grid.parentOf(farCell, res);

    expect(rollup.occupancyAt(index, farParent, res)).toBe(0); // builds the set
    index.add(farCell);
    expect(rollup.occupancyAt(index, farParent, res)).toBe(1); // extends it
  });

  it('matches a rollup built from scratch after incremental adds', () => {
    const res = H3_DISPLAY_RES - 2;
    const ring = grid.neighborsOf(homeCell);

    const incremental = createExplorationIndex([homeCell]);
    const warm = createExplorationRollup(grid);
    warm.occupancyAt(incremental, grid.parentOf(homeCell, res), res); // force an early build
    for (const cell of ring) incremental.add(cell);

    const fromScratch = createExplorationIndex([homeCell, ...ring]);
    const cold = createExplorationRollup(grid);

    for (const cell of [homeCell, ...ring, farCell]) {
      const parent = grid.parentOf(cell, res);
      expect(warm.occupancyAt(incremental, parent, res)).toBe(
        cold.occupancyAt(fromScratch, parent, res)
      );
    }
  });

  it('rebuilds when handed a different index', () => {
    const rollup = createExplorationRollup(grid);
    const res = H3_DISPLAY_RES - 3;
    const homeParent = grid.parentOf(homeCell, res);

    expect(rollup.occupancyAt(createExplorationIndex([homeCell]), homeParent, res)).toBe(1);
    // A second index (e.g. a remounted source) must not inherit the first's set.
    expect(rollup.occupancyAt(createExplorationIndex([farCell]), homeParent, res)).toBe(0);
  });
});
