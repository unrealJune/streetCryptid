import type { CellIndex, H3Grid } from './h3-grid';
import type { ExplorationIndex } from './exploration-index';
import { createExplorationRollup, type ExplorationRollup } from './exploration-rollup';
import type { WorldPoint, WorldRect } from './types';

/**
 * Everything the render layer needs to draw one exploration cell: geometry in
 * world coords plus per-cell state. Computed once per region build (CPU) —
 * H3 cells are not an analytic lattice in mercator, so the shader can no
 * longer derive cells per pixel; it samples textures baked from this instead.
 */
export interface FieldCell {
  readonly cell: CellIndex;
  /** Cell outline, lng-unwrapped world coords (from {@link H3Grid.boundaryWorld}). */
  readonly boundary: readonly WorldPoint[];
  readonly center: WorldPoint;
  /**
   * Explored occupancy, 0 or 1. At the display resolution that is the recorded
   * truth; on the coarser ladder rungs it is presence rolled up from it (see
   * `exploration-rollup.ts`), which is why it stays binary either way.
   */
  readonly fraction: number;
  /** Discovered cell bordering undiscovered ground — amber rim. */
  readonly frontier: boolean;
  /** Stable per-cell hash 0–1, drives the reveal wipe's per-cell stagger. */
  readonly jitter: number;
  /** Normalized center-out distance 0–1, the reveal wipe's base ordering. */
  readonly order: number;
}

export interface RegionCellField {
  readonly res: number;
  readonly cells: readonly FieldCell[];
}

export interface CellFieldTiming {
  readonly enumerateMs: number;
  readonly centersMs: number;
  readonly annotateMs: number;
}

/** FNV-1a of the cell index string, folded to [0, 1) — per-cell reveal jitter. */
export function cellHash(cell: CellIndex): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cell.length; i++) {
    h ^= cell.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Enumerate and annotate the exploration cells of one region.
 *
 * `rollup` supplies occupancy on the coarse ladder rungs. It is stateful (it
 * caches ancestor sets across builds), so real callers pass the ONE instance
 * their session owns; the default exists for tests and one-shot tooling, and is
 * correct but rebuilds its sets every call.
 */
export function buildCellField(
  grid: H3Grid,
  rect: WorldRect,
  res: number,
  index: ExplorationIndex,
  rollup: ExplorationRollup = createExplorationRollup(grid)
): RegionCellField {
  return buildCellFieldWithTiming(grid, rect, res, index, rollup).field;
}

export function buildCellFieldWithTiming(
  grid: H3Grid,
  rect: WorldRect,
  res: number,
  index: ExplorationIndex,
  rollup: ExplorationRollup = createExplorationRollup(grid)
): { readonly field: RegionCellField; readonly timing: CellFieldTiming } {
  const enumerateStarted = now();
  const ids = grid.cellsInRect(rect, res);
  const centersStarted = now();
  return buildFromIds(grid, rect, res, index, rollup, ids, enumerateStarted, centersStarted);
}

export async function buildCellFieldWithTimingAsync(
  grid: H3Grid,
  rect: WorldRect,
  res: number,
  index: ExplorationIndex,
  rollup: ExplorationRollup = createExplorationRollup(grid)
): Promise<{ readonly field: RegionCellField; readonly timing: CellFieldTiming }> {
  const enumerateStarted = now();
  const ids = await grid.cellsInRectAsync(rect, res);
  const centersStarted = now();
  return buildFromIds(grid, rect, res, index, rollup, ids, enumerateStarted, centersStarted);
}

function buildFromIds(
  grid: H3Grid,
  rect: WorldRect,
  res: number,
  index: ExplorationIndex,
  rollup: ExplorationRollup,
  ids: readonly CellIndex[],
  enumerateStarted: number,
  centersStarted: number
): { readonly field: RegionCellField; readonly timing: CellFieldTiming } {
  const midX = (rect.minX + rect.maxX) / 2;
  const midY = (rect.minY + rect.maxY) / 2;

  const centers = ids.map((id) => grid.centerWorld(id));
  let maxDist = 0;
  const dists = centers.map(([x, y]) => {
    const d = Math.hypot(x - midX, y - midY);
    if (d > maxDist) maxDist = d;
    return d;
  });
  const annotateStarted = now();

  const cells = ids.map((id, i): FieldCell => {
    const fraction = rollup.occupancyAt(index, id, res);
    // The rim follows the ladder: at every rung it outlines discovered ground
    // that borders undiscovered ground, so a bloomed territory keeps its edge.
    const frontier =
      fraction >= 1 && grid.neighborsOf(id).some((n) => rollup.occupancyAt(index, n, res) < 1);
    return {
      cell: id,
      boundary: grid.boundaryWorld(id),
      center: centers[i],
      fraction,
      frontier,
      jitter: cellHash(id),
      order: maxDist > 0 ? dists[i] / maxDist : 0,
    };
  });

  const finished = now();
  return {
    field: { res, cells },
    timing: {
      enumerateMs: centersStarted - enumerateStarted,
      centersMs: annotateStarted - centersStarted,
      annotateMs: finished - annotateStarted,
    },
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
