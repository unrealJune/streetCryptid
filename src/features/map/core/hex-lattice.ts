import { scaleFor, worldToScreen } from './camera';
import type { H3Grid } from './h3-grid';
import type { CameraState, Viewport, WorldPoint } from './types';

/**
 * The exploration grid, reduced to the four numbers an analytic hex lattice needs.
 *
 * H3 cells are not a lattice in mercator — that is exactly why the region layer bakes them into a
 * texture instead of deriving them per pixel (see `cell-field.ts`). But the loading skeleton has
 * no cells to bake: it is drawn over ground no tile has arrived for, before any H3 enumeration
 * has happened, and its whole job is to look like what is about to appear there.
 *
 * So it measures ONE real cell — the one under the camera — and tiles the plane with its size and
 * orientation. Two h3 calls, no enumeration. The fit is exact where the user is looking and drifts
 * with distance from it, which is the right trade for a skeleton: the alternative was a lattice
 * that matched nothing anywhere, at a size fixed in screen pixels, so the hexes slid through each
 * other as you zoomed and then snapped to a different grid entirely when the tiles landed.
 */
export interface HexLattice {
  /** The H3 resolution measured — the ladder rung the layer is drawing at. */
  readonly res: number;
  /** The reference cell's centre, world coords. One lattice point is pinned here. */
  readonly center: WorldPoint;
  /** Mean centre-to-vertex distance, world units. */
  readonly radius: number;
  /** Lattice rotation, radians, folded into [0, 60°) — the symmetry of a hex tiling. */
  readonly rotation: number;
}

/** The same lattice in anchor-space pixels, ready to hand to the shader. */
export interface ScreenHexLattice {
  readonly originX: number;
  readonly originY: number;
  readonly radius: number;
  readonly rotation: number;
  /** Outline width, anchor-space px. */
  readonly strokeWidth: number;
}

/**
 * Ghost-lattice stroke width in region-logical px. Lives here rather than in the renderer because
 * the loading skeleton and the real lattice have to be the same weight, and one of them is a
 * vector stroke baked into a bitmap while the other is a shader — two places to change a 1 is how
 * they drift apart.
 */
export const GHOST_LATTICE_WIDTH = 1.0;

/** A sixth of a turn: the rotational symmetry of a hex tiling, and of the vertex bearings in it. */
const SIXTH_TURN = Math.PI / 3;

/**
 * Measure the exploration grid at `at`, at resolution `res`.
 *
 * Null for a cell whose boundary h3 will not give us — there is nothing to match, and drawing an
 * invented lattice would be worse than drawing none.
 */
export function measureHexLattice(grid: H3Grid, at: WorldPoint, res: number): HexLattice | null {
  const cell = grid.cellAt(at, res);
  const center = grid.centerWorld(cell);
  const boundary = grid.boundaryWorld(cell);
  if (boundary.length < 3) return null;

  // Mean rather than first: h3 emits extra vertices on distorted cells (and five on the twelve
  // pentagons), and one arbitrary vertex would size the whole lattice off a deformed corner.
  let total = 0;
  for (const [x, y] of boundary) total += Math.hypot(x - center[0], y - center[1]);
  const radius = total / boundary.length;
  if (!(radius > 0)) return null;

  // The analytic lattice puts vertices at 30° + k·60°, so the rotation carrying it onto this cell
  // is the first vertex's bearing less 30°. Mercator is conformal, so the angle measured in world
  // coords is the angle that will be drawn.
  const [vx, vy] = boundary[0];
  const bearing = Math.atan2(vy - center[1], vx - center[0]) - SIXTH_TURN / 2;
  return { res, center, radius, rotation: ((bearing % SIXTH_TURN) + SIXTH_TURN) % SIXTH_TURN };
}

/**
 * Project a lattice into the anchor space every map layer is drawn in.
 *
 * The stroke is pre-divided by the committed scale because the real lattice it is matching is a
 * 1px stroke inside a bitmap that anchor space then shrinks by exactly that factor. Dividing here
 * means the two stay the same width on screen not just at rest but all the way through a pinch,
 * since from that point on the shared live transform scales both of them identically.
 */
export function projectHexLattice(
  lattice: HexLattice,
  anchor: CameraState,
  camera: CameraState,
  viewport: Viewport
): ScreenHexLattice {
  const [originX, originY] = worldToScreen(anchor, viewport, lattice.center);
  const committed = Math.pow(2, camera.zoom - anchor.zoom);
  return {
    originX,
    originY,
    radius: lattice.radius * scaleFor(anchor.zoom),
    rotation: lattice.rotation,
    strokeWidth: GHOST_LATTICE_WIDTH / committed,
  };
}
