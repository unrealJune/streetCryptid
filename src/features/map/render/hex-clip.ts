import type { ScreenHexLattice } from '../core/hex-lattice';

/**
 * The built map's edge, cut along the hex lattice instead of a rectangle.
 *
 * A region bitmap is a rectangle, and the loading skeleton around it is a field of hexagons, so the
 * boundary between "loaded" and "still loading" used to be a straight-edged box sitting in a hex
 * field. Here a pixel of the bitmap is kept only if the hexagon it falls in lies wholly inside the
 * bitmap's rect: the map ends on cell edges, and the skeleton's cells continue right up to it.
 *
 * Pure: SkSL source and the rect/uniform arithmetic, so it is unit-tested off-GPU. The shader is
 * only ever run over a thin band along the rect's edges ({@link hexClipInner}); the interior is a
 * plain image draw, so a region whose edges are off screen costs nothing extra.
 */

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Cell radii from the rect's edge inside which no cell can be cut. */
const INSET_RADII = 2.25;

/**
 * `float hexClip(float2 pos)`: 1 where the bitmap shows, 0 where the skeleton does, with a one
 * outline-width ramp along the cut. All coordinates are anchor space. `uHexRadius <= 0` turns the
 * clip off (everything shows).
 */
export const HEX_CLIP_SKSL_FN = `
uniform float2 uHexOrigin;  // a cell centre
uniform float  uHexRadius;  // centre-to-vertex
uniform float2 uHexRot;     // lattice rotation as (cos, sin): no trig per pixel
uniform float4 uHexRect;    // the bitmap's rect: x, y, w, h
uniform float  uHexAA;      // edge ramp width

float2 hexOffset(float2 pos) {
  float c = uHexRot.x;
  float s = uHexRot.y;
  float2 d = pos - uHexOrigin;
  float2 p = float2(d.x * c + d.y * s, -d.x * s + d.y * c);
  float2 period = float2(1.7320508 * uHexRadius, 3.0 * uHexRadius);
  float2 a = mod(p, period) - period * 0.5;
  float2 b = mod(p - period * 0.5, period) - period * 0.5;
  return dot(a, a) < dot(b, b) ? a : b;  // pos relative to its cell centre, lattice space
}

float2 hexCentre(float2 pos, float2 q) {
  float c = uHexRot.x;
  float s = uHexRot.y;
  return pos - float2(q.x * c - q.y * s, q.x * s + q.y * c);
}

float hexInside(float2 centre) {
  float r = uHexRadius;
  float2 lo = uHexRect.xy + r;
  float2 hi = uHexRect.xy + uHexRect.zw - r;
  return (centre.x >= lo.x && centre.y >= lo.y && centre.x <= hi.x && centre.y <= hi.y) ? 1.0 : 0.0;
}

float hexClip(float2 pos) {
  if (uHexRadius <= 0.0) return 1.0;
  // Deep inside the rect no cell can be cut (see hexClipInner): skip the lattice entirely. This is
  // nearly every pixel of the reveal wipe, which runs this full screen.
  float2 fromEdge = min(pos - uHexRect.xy, uHexRect.xy + uHexRect.zw - pos);
  if (min(fromEdge.x, fromEdge.y) > uHexRadius * ${INSET_RADII.toFixed(2)}) return 1.0;
  float2 q = hexOffset(pos);
  float2 centre = hexCentre(pos, q);
  if (hexInside(centre) < 0.5) return 0.0;
  // A kept cell ramps out only along an edge it shares with a dropped one; between two kept
  // cells the bitmap must stay seamless.
  float2 probe = pos + normalize(pos - centre + 1e-4) * uHexAA * 2.0;
  if (hexInside(hexCentre(probe, hexOffset(probe))) > 0.5) return 1.0;
  float edge = 0.8660254 * uHexRadius - max(abs(q.x), dot(abs(q), float2(0.5, 0.8660254)));
  return smoothstep(0.0, uHexAA, edge);
}
`;

/** The bitmap, clipped by {@link HEX_CLIP_SKSL_FN}. */
export const HEX_CLIP_IMAGE_SKSL = `
uniform shader image;
${HEX_CLIP_SKSL_FN}
half4 main(float2 pos) {
  return image.eval(pos) * half(hexClip(pos));
}
`;

/**
 * The part of `rect` the clip can never touch: inset by two cell radii plus a margin (a dropped
 * cell's centre is within one radius of the edge, and its pixels reach one more). Drawn as a plain
 * image; also what the loading skeleton may safely skip shading. Null when the rect is too small to
 * have one.
 */
export function hexClipInner(rect: Box, lattice: ScreenHexLattice): Box | null {
  const inset = lattice.radius * INSET_RADII;
  const width = rect.width - 2 * inset;
  const height = rect.height - 2 * inset;
  if (width <= 0 || height <= 0) return null;
  return { x: rect.x + inset, y: rect.y + inset, width, height };
}

/**
 * The lattice to clip `rect` with, or null when the clip would cut cells inside `view` — the view
 * the region was built around, which its pad surrounds.
 *
 * The clip drops every cell that is not wholly inside the rect. A cell touching the view has its
 * centre within one radius of it and reaches one radius further, so the clip is safe only while
 * the pad between view and rect edge is at least a cell's diameter. Zoomed far in it is not: a
 * res-9 cell is ~430 px across at z18, wider than the pad, and the cells on screen whose far side
 * poked past the rect were drawn as loading skeleton over a finished map, until a pan moved them
 * inside. Without the clip the bitmap ends as a rectangle, but a full pad away from anything shown.
 */
export function clipLatticeFor(
  rect: Box,
  view: Box,
  lattice: ScreenHexLattice | null
): ScreenHexLattice | null {
  if (!lattice) return null;
  const pad = Math.min(
    view.x - rect.x,
    view.y - rect.y,
    rect.x + rect.width - (view.x + view.width),
    rect.y + rect.height - (view.y + view.height)
  );
  return pad >= 2 * lattice.radius ? lattice : null;
}

/** Uniforms for {@link HEX_CLIP_SKSL_FN}; `null` lattice turns the clip off. */
export function hexClipUniforms(rect: Box, lattice: ScreenHexLattice | null) {
  return {
    uHexOrigin: lattice ? [lattice.originX, lattice.originY] : [0, 0],
    uHexRadius: lattice ? Math.max(0.5, lattice.radius) : 0,
    uHexRot: [Math.cos(lattice?.rotation ?? 0), Math.sin(lattice?.rotation ?? 0)],
    uHexRect: [rect.x, rect.y, rect.width, rect.height],
    uHexAA: lattice ? Math.max(0.01, lattice.strokeWidth) : 1,
  };
}
