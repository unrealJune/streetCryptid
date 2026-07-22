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
 */
export const REVEAL_MASK_SKSL = `
uniform shader image;    // the finished region bitmap (opaque)
uniform shader cell;     // cell state: B = reveal order, G = jitter
uniform float  uReveal;  // wipe front 0..~1 (see REVEAL_TARGET)
uniform float4 uPrevRect; // previously-rendered area (x, y, w, h); w<=0 = none

half4 main(float2 xy) {
  half4 px = image.eval(xy);
  half3 c  = cell.eval(xy).rgb;
  // Center-out order, nudged hard by per-cell jitter so hexes pop in
  // individually (a twinkle) rather than as a clean radial sweep.
  float order = clamp(0.85 * c.b + (c.g - 0.5) * 0.26, 0.0, 0.9);
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

/** Pack a rect (or null) into the shader's `uPrevRect` float4 — [0,0,0,0] means none. */
export function prevRectUniform(prev: RevealRect | null): [number, number, number, number] {
  return prev ? [prev.x, prev.y, prev.width, prev.height] : [0, 0, 0, 0];
}
