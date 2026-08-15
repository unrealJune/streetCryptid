/**
 * The loading reveal's pure core — SkSL source, constants, and JS twins of the
 * shader math — kept Skia-free so the wipe ordering is unit-testable off-GPU
 * (the Skia effect compile lives in `reveal-mask-shader.ts`, mirroring the
 * `shader-uniforms.ts` / `dot-field-shader.ts` split).
 *
 * The reveal paints an already-built region bitmap through a per-cell alpha
 * wipe, so a fresh (cache-miss) region grows in hex by hex over the previous or
 * blank layer instead of popping. It is deliberately ORTHOGONAL to the native
 * decode seam: it samples only the CPU-baked cell-state texture
 * (`cell-state-image.ts`: B = center-out reveal order, G = per-cell jitter) —
 * never `PackedGeometry` or the SCG1 buffer — and composites the *finished*
 * bitmap rather than re-running the 45-tap dot field. So it adds no FFI call,
 * forces no copy off the native buffer, and keeps PR41's build-once raster
 * intact: the only extra work is one cheap GPU pass, and only while a cold
 * region is revealing (warm swaps keep the crossfade).
 *
 * Children (in declaration order): `image` = the region bitmap, `cell` = the
 * cell-state texture, both placed at the same rect so `xy` samples align. The
 * `uReveal` uniform animates 0 → {@link REVEAL_TARGET} on the UI thread.
 *
 * ## Where the lattice comes from
 *
 * Exploration is recorded at one fixed H3 resolution and the layer switches off
 * below `H3_MIN_RENDER_ZOOM` (res-9 cells are sub-pixel there), so the engine
 * builds an EMPTY cell field for those regions and `cell-state-image.ts` bakes a
 * flat black texture. Read straight from that texture every pixel would get
 * order 0 and jitter 0 — one uniform threshold for the whole region — so the
 * wipe degenerated into a flat cross-region fade exactly at the city-and-out
 * zooms where cold loads take longest and the hex load-in matters most.
 *
 * So the lattice is decoupled from the exploration data: when the region has no
 * baked cells the shader synthesizes one procedurally (`uHexPx > 0`). It is a
 * plain axial hex grid sized in *screen* px, which is what a loading affordance
 * wants — the animation reads identically at z4 and z16 — and it costs nothing:
 * no enumeration, no second texture, no extra CPU on the cold-load path. The
 * baked texture still wins wherever it carries real cells, so the explored /
 * unexplored reveal at street zooms is untouched.
 */
export const REVEAL_MASK_SKSL = `
uniform shader image;    // the finished region bitmap (opaque)
uniform shader cell;     // cell state: B = reveal order, G = jitter
uniform float  uReveal;  // wipe front 0..~1 (see REVEAL_TARGET)
uniform float4 uPrevRect; // previously-rendered area (x, y, w, h); w<=0 = none
uniform float4 uRegion;   // this region's rect (x, y, w, h) — procedural order basis
uniform float  uHexPx;    // >0: no baked cells, synthesize a lattice at this circumradius

// Pixel -> pointy-top axial hex index (cube-rounded). Only used for the
// procedural lattice; regions that carry real cells sample the texture instead.
float2 hexAxial(float2 p, float size) {
  float q = (0.5773502692 * p.x - 0.3333333333 * p.y) / size;
  float r = (0.6666666667 * p.y) / size;
  float cx = q, cz = r, cy = -q - r;
  float rx = floor(cx + 0.5), ry = floor(cy + 0.5), rz = floor(cz + 0.5);
  float dx = abs(rx - cx), dy = abs(ry - cy), dz = abs(rz - cz);
  if (dx > dy && dx > dz) { rx = -ry - rz; }
  else if (dy > dz) { ry = -rx - rz; }
  else { rz = -rx - ry; }
  return float2(rx, rz);
}

/** Axial index -> that hex's center, same space as the input pixel. */
float2 hexCenter(float2 axial, float size) {
  return float2(size * 1.7320508076 * (axial.x + axial.y * 0.5), size * 1.5 * axial.y);
}

/**
 * Stable per-hex hash 0..1 — the procedural twin of the baked jitter channel.
 *
 * Integer-exact on purpose. The usual fract(sin(...) * 43758.5) hash (as used
 * by the dot field) amplifies the float32/float64 gap between the GPU and the JS
 * twin below into *completely different hexes* — measured at only ~75% agreement
 * — which would make the unit tests fiction. Here every intermediate is an
 * integer well inside float32's exactly-representable range (2^24), so both
 * sides agree bit for bit (100% of hex interiors; boundary pixels may still
 * round to either neighbour).
 *
 * The a*b term is what makes it QUADRATIC in (q, r). An affine hash — including
 * any number of LCG rounds, since those are themselves affine — cannot break
 * linear structure, and one showed up on screen as diagonal stripes sweeping the
 * reveal front. The two moduli are distinct primes so the products decorrelate.
 */
float hexHash(float2 p) {
  float q = mod(p.x, 4096.0);
  float r = mod(p.y, 4096.0);
  float a = mod(q * 131.0 + r * 977.0, 2039.0);
  float b = mod(q * 419.0 + r * 283.0, 2027.0);
  float h = mod(a * b + a + b, 4096.0);
  h = mod(h * 1663.0 + 3571.0, 4096.0);
  return h / 4096.0;
}

half4 main(float2 xy) {
  half4 px = image.eval(xy);
  float base;   // center-out ordering 0..1
  float jitter; // per-cell stagger 0..1
  if (uHexPx > 0.0) {
    float2 axial = hexAxial(xy - uRegion.xy, uHexPx);
    float2 ctr = hexCenter(axial, uHexPx);
    float2 mid = uRegion.zw * 0.5;
    base = clamp(length(ctr - mid) / max(1.0, length(mid)), 0.0, 1.0);
    jitter = hexHash(axial);
  } else {
    float3 c = float3(cell.eval(xy).rgb);
    base = c.b;
    jitter = c.g;
  }
  // Center-out order, nudged hard by per-cell jitter so hexes pop in
  // individually (a twinkle) rather than as a clean radial sweep.
  float order = clamp(0.85 * base + (jitter - 0.5) * 0.26, 0.0, 0.9);
  float wipe = smoothstep(order, order + 0.12, uReveal);
  // Ground the previous layer already showed swaps in INSTANTLY (no wipe, no
  // flash) — only the newly-exposed area hex-loads in around it, so covered
  // panning stays smooth and the reveal radiates out from what's already there.
  float covered = 0.0;
  if (uPrevRect.z > 0.0) {
    float2 lo = uPrevRect.xy;
    float2 hi = uPrevRect.xy + uPrevRect.zw;
    covered = (xy.x >= lo.x && xy.x <= hi.x && xy.y >= lo.y && xy.y <= hi.y) ? 1.0 : 0.0;
  }
  float a = max(wipe, covered);
  // Wavefront flash: each newly-exposed hex flares as it crosses the front.
  // Peaks half-revealed, exactly zero when hidden or fully shown (so the settled
  // frame equals the plain image), and suppressed over already-covered ground.
  float flash = 4.0 * wipe * (1.0 - wipe) * (1.0 - covered);
  half3 rgb = px.rgb * (1.0 + 0.9 * flash);
  // Premultiplied (Skia runtime shaders return premultiplied color).
  return half4(rgb * a, px.a * a);
}
`;

/**
 * uReveal endpoint. The farthest cells sit at order ≈ 0.9, so the wipe must run
 * a hair past 1.0 (0.9 + 0.12 window) for every hex to reach full opacity before
 * the view hands back to a plain image — otherwise the outer ring would settle a
 * few percent translucent.
 */
export const REVEAL_TARGET = 1.05;

/** The reveal wipe's window width (SkSL `smoothstep(order, order + REVEAL_BAND, uReveal)`). */
const REVEAL_BAND = 0.12;

/** Per-cell jitter weight — how scattered the reveal order is (must match the SkSL). */
const REVEAL_JITTER = 0.26;

/** Per-cell reveal threshold from the baked order (B) + jitter (G) channels, 0..0.9. */
export function cellRevealOrder(orderChannel: number, jitterChannel: number): number {
  return Math.min(0.9, Math.max(0, 0.85 * orderChannel + (jitterChannel - 0.5) * REVEAL_JITTER));
}

/**
 * Circumradius (SCREEN px) of the synthesized loading lattice, used for regions
 * that carry no exploration cells. 16 puts ~14 hexes across a phone screen:
 * coarse enough that each one reads as a hexagon mid-wipe (at ~22 across the
 * lattice degrades into confetti), fine enough that the jittered twinkle still
 * sweeps rather than landing in a handful of slabs (~9 across).
 *
 * Screen px, not world or anchor px, on purpose — see {@link hexLatticeSizeFor}.
 */
export const HEX_LOADING_PX = 16;

/** √3, the pointy-top lattice's horizontal spacing factor. */
const SQRT3 = 1.7320508076;

/**
 * The `uHexPx` uniform: the lattice circumradius in the reveal's own coordinate
 * space, or 0 to sample the baked cell texture instead.
 *
 * The reveal draws in ANCHOR space and the canvas group then scales it by the
 * live view transform `k`, so a constant anchor-px size would swell and shrink
 * on screen as the camera zooms away from the fixed session anchor (the same
 * reason `trailStrokeWidth` divides by `k`). Dividing here pins the hexes to a
 * constant on-screen size, which is the whole point: the loading animation
 * should look the same at every zoom.
 *
 * @param hasBakedCells whether the region's cell field produced a real texture
 * @param k             live view scale (anchor px → screen px)
 */
export function hexLatticeSizeFor(hasBakedCells: boolean, k: number): number {
  'worklet';
  if (hasBakedCells) return 0;
  return HEX_LOADING_PX / Math.max(0.001, k);
}

/**
 * Pixel → pointy-top axial hex index, cube-rounded. The JS twin of the SkSL
 * `hexAxial`, so the synthesized lattice's ordering is testable off-GPU.
 */
export function hexAxialAt(x: number, y: number, size: number): [number, number] {
  const q = ((SQRT3 / 3) * x - y / 3) / size;
  const r = ((2 / 3) * y) / size;
  const cx = q;
  const cz = r;
  const cy = -q - r;
  let rx = Math.floor(cx + 0.5);
  let ry = Math.floor(cy + 0.5);
  let rz = Math.floor(cz + 0.5);
  const dx = Math.abs(rx - cx);
  const dy = Math.abs(ry - cy);
  const dz = Math.abs(rz - cz);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  // The `-a - b` rebalance yields -0 when both terms are 0; canonicalize so an
  // axial index is always comparable to the obvious literal.
  return [rx === 0 ? 0 : rx, rz === 0 ? 0 : rz];
}

/** Axial index → that hex's center, in the same space as {@link hexAxialAt}'s input. */
export function hexCenterOf(axial: readonly [number, number], size: number): [number, number] {
  return [size * SQRT3 * (axial[0] + axial[1] / 2), size * 1.5 * axial[1]];
}

/** GLSL `mod` semantics (result takes the divisor's sign), unlike JS `%`. */
function glslMod(a: number, m: number): number {
  return a - m * Math.floor(a / m);
}

/**
 * Stable per-hex hash 0..1 — the JS twin of the SkSL `hexHash`. Exact on both
 * sides: every intermediate is an integer inside float32's 2^24 exact range, so
 * unlike a sin-fract hash this really does predict what the GPU draws.
 */
export function hexLatticeJitter(axial: readonly [number, number]): number {
  const q = glslMod(axial[0], 4096);
  const r = glslMod(axial[1], 4096);
  const a = glslMod(q * 131 + r * 977, 2039);
  const b = glslMod(q * 419 + r * 283, 2027);
  let h = glslMod(a * b + a + b, 4096);
  h = glslMod(h * 1663 + 3571, 4096);
  return h / 4096;
}

/**
 * Reveal threshold for a pixel of a region with no baked cells — the JS twin of
 * the SkSL procedural branch. Center-out over the region rect (0 at the middle,
 * 1 at the corners, matching the baked field's `dist / maxDist`), then jittered
 * per hex by the same weight the texture path uses.
 */
export function proceduralRevealOrder(
  x: number,
  y: number,
  region: RevealRect,
  size: number
): number {
  const axial = hexAxialAt(x - region.x, y - region.y, size);
  const [cx, cy] = hexCenterOf(axial, size);
  const midX = region.width / 2;
  const midY = region.height / 2;
  const span = Math.max(1, Math.hypot(midX, midY));
  const base = Math.min(1, Math.max(0, Math.hypot(cx - midX, cy - midY) / span));
  return cellRevealOrder(base, hexLatticeJitter(axial));
}

/** A cell's opacity for a wipe front at `reveal` — the SkSL `smoothstep`, in JS. */
export function revealAlpha(order: number, reveal: number): number {
  const t = Math.min(1, Math.max(0, (reveal - order) / REVEAL_BAND));
  return t * t * (3 - 2 * t);
}

/**
 * Per-cell wavefront flash intensity 0..1 — the JS twin of the SkSL bump. Peaks
 * (1) when a hex is half-revealed and is exactly 0 when hidden or fully shown,
 * so the reveal flares as it sweeps but leaves no residual brightness at settle.
 */
export function revealEmphasis(order: number, reveal: number): number {
  const a = revealAlpha(order, reveal);
  return 4 * a * (1 - a);
}

/** A rect in the reveal's coordinate space (anchor px): x, y, width, height. */
export interface RevealRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Whether pixel (x, y) fell inside the previously-rendered area — the JS twin of
 * the SkSL `covered` test. Such pixels swap in instantly (the reveal only
 * animates the newly-exposed ground around them). A null/empty rect (first load)
 * covers nothing, so the whole region hex-loads in.
 */
export function pixelCovered(x: number, y: number, prev: RevealRect | null): boolean {
  if (!prev || prev.width <= 0 || prev.height <= 0) return false;
  return x >= prev.x && x <= prev.x + prev.width && y >= prev.y && y <= prev.y + prev.height;
}

/**
 * Pack a rect (or null) into a shader float4 — [0,0,0,0] means none. Used for
 * both `uPrevRect` (where a zero rect means "no previous layer") and `uRegion`.
 */
export function rectUniform(rect: RevealRect | null): [number, number, number, number] {
  return rect ? [rect.x, rect.y, rect.width, rect.height] : [0, 0, 0, 0];
}

/** Pack a rect (or null) into the shader's `uPrevRect` float4 — [0,0,0,0] means none. */
export function prevRectUniform(prev: RevealRect | null): [number, number, number, number] {
  return rectUniform(prev);
}
