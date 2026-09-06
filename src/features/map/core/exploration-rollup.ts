import { H3_DISPLAY_RES } from './cell-ladder';
import type { ExplorationIndex, ExplorationState } from './exploration-index';
import type { CellIndex, H3Grid } from './h3-grid';

/**
 * Rolls res-9 exploration truth up the H3 hierarchy so the coarse rungs of the
 * ladder (`cell-ladder.ts`) have something to draw.
 *
 * The rule is PRESENCE, not fraction: a coarse cell reads explored when it
 * contains any explored res-9 cell at all. So territory blooms outward as the
 * camera pulls back — a walked neighbourhood becomes a lit res-6 cell, and a
 * lit res-4 one — rather than fading to nothing (one res-9 cell is 1/343 of its
 * res-7 ancestor, which no fractional treatment can render legibly). It claims
 * more ground than you walked, deliberately: the coarse rungs are a shape you
 * recognize, and {@link H3_COARSEST_RES} is where the claim stops being one.
 *
 * Occupancy is therefore binary at every resolution, which is why nothing
 * downstream changed — the cell state texture, the dot-field shader, the ghost
 * lattice and the frontier rim all still see a 0-or-1 `fraction`.
 *
 * Kept incremental because the index is append-only and identity-stable: each
 * resolution's ancestor set is built the first time it is asked for, then
 * extended by only the cells added since. A JS `Set` iterates in insertion
 * order, so a cursor is enough to find them.
 */
export interface ExplorationRollup {
  /**
   * 1 when `cell` (at `res`) contains an explored res-9 cell, else 0. At
   * {@link H3_DISPLAY_RES} this is exactly `index.fractionAt`.
   */
  occupancyAt(index: ExplorationIndex, cell: CellIndex, res: number): number;
}

interface ResolutionRollup {
  /** The state object these ancestors were derived from (identity, not value). */
  source: ExplorationState;
  /** How many of `source`'s cells have been folded in. */
  cursor: number;
  ancestors: Set<CellIndex>;
}

/**
 * A rollup over `grid`. Hold ONE per map session (the engine does) — a fresh
 * instance re-derives every ancestor set from scratch on first use.
 */
export function createExplorationRollup(grid: H3Grid): ExplorationRollup {
  const byRes = new Map<number, ResolutionRollup>();

  function ancestorsAt(index: ExplorationIndex, res: number): Set<CellIndex> {
    let entry = byRes.get(res);
    if (!entry || entry.source !== index.cells) {
      entry = { source: index.cells, cursor: 0, ancestors: new Set() };
      byRes.set(res, entry);
    }
    if (entry.cursor < entry.source.size) {
      let i = 0;
      for (const cell of entry.source) {
        // Insertion-ordered, append-only: everything before the cursor is folded in.
        if (i++ < entry.cursor) continue;
        entry.ancestors.add(grid.parentOf(cell, res));
      }
      entry.cursor = entry.source.size;
    }
    return entry.ancestors;
  }

  return {
    occupancyAt(index, cell, res) {
      if (res >= H3_DISPLAY_RES) return index.fractionAt(cell);
      return ancestorsAt(index, res).has(cell) ? 1 : 0;
    },
  };
}
