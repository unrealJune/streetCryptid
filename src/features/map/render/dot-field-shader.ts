import { Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';

/**
 * The GPU dot-field shader — a faithful port of the CPU `buildDotField` +
 * background fill (see the retired `core/scene.ts` / `core/dot-raster.ts`),
 * evaluated per pixel instead of stamped per dot.
 *
 * It is **camera-independent**: it renders the whole region rect into a bitmap
 * once, in region-local logical coordinates (0 at rect.min). The map view then
 * positions/scales that one bitmap per camera, so panning and zooming inside a
 * region are pure image transforms — the shader never re-runs mid-gesture. All
 * map math stays in region-local world coords (world − rect.min), which keeps it
 * clear of the float32 cancellation that ~0.16 normalized-mercator numbers cause.
 *
 * Exploration cells are H3 hexagons, which are NOT an analytic lattice in
 * mercator — so unlike the retired axial grid the shader derives nothing per
 * pixel. It samples `cellTex`, a region-anchored texture baked on the CPU from
 * the region's cell field (`cell-state-image.ts`): R = explored occupancy
 * (binary at the fixed display resolution), G = per-cell jitter,
 * B = center-out reveal order. The
 * ghost lattice and frontier rim are drawn as vector paths over this bitmap
 * (`cell-overlay-paths.ts`), no longer in-shader.
 *
 * Inputs are three child image-shaders + numeric uniforms from
 * `packDotFieldUniforms`:
 *   - `maskTex`  RGBA feature mask, R=street G=park B=water (nearest).
 *   - `cellTex`  RGBA cell state, R=fraction G=jitter B=reveal order (nearest).
 *   - `lut`      256×3 palette LUT, rows 0=terr 1=water 2=park (linear).
 */
export const DOT_FIELD_SKSL = `
uniform float  uPixelRatio;   // render (device) px per region-logical px
uniform float  uScale;        // region-logical px per world unit (anchor zoom)
uniform float2 uRectSize;     // region rect size (world)
uniform float2 uMaskSize;     // mask texture size (px)
uniform float  uStep;         // dot lattice step (logical px)
uniform float3 uBg;           // background rgb (0..1)
uniform float  uReveal;       // load reveal 0..1 (1 = fully shown); cell-by-cell wipe
uniform float  uLod;          // zoom LOD 0 (street detail) .. 1 (city): simplify terrain
uniform float  uExploration;  // 1 = explored/unexplored treatment, 0 = unmasked city

uniform shader maskTex;
uniform shader cellTex;
uniform shader lut;

// region-logical px -> region-local world (0 at rect.min)
float2 toWorld(float2 s) { return s / uScale; }
// region-local world -> mask pixel coord
float2 toMaskPx(float2 w) { return w / uRectSize * uMaskSize; }
float3 maskAt(float2 s) { return maskTex.eval(toMaskPx(toWorld(s))).rgb; }
// cell state (fraction, jitter, reveal order) at a region-logical point
float3 cellAt(float2 s) { return cellTex.eval(toMaskPx(toWorld(s))).rgb; }

// classic GLSL sin-fract hash (port of hash2)
float hash2(float2 p) {
  float s = sin(p.x * 12.9898 + p.y * 78.233) * 43758.5453;
  return s - floor(s);
}

float3 rampLut(float t, float row) {
  float x = clamp(t, 0.0, 1.0) * 255.0 + 0.5;
  return lut.eval(float2(x, row + 0.5)).rgb;
}

float lum(float3 c) { return dot(c, float3(0.299, 0.587, 0.114)); }

// Fog-of-war muting of undiscovered dots. Lower = the hidden world keeps more of
// its color (DESAT) and stays brighter instead of sinking toward the bg (DIM);
// the discovered/undiscovered read still holds via alpha, dot size, the ghost
// lattice and the amber frontier rim.
const float FOG_DESAT = 0.40;  // pull toward gray  (was 0.74 — too washed out)
const float FOG_DIM   = 0.12;  // pull toward bg    (was 0.24 — too obscured)

float3 applyFog(float3 color, float fog, float isArea) {
  float fg = isArea > 0.5 ? min(fog, 0.5) : fog;
  float l = lum(color);
  return mix(mix(color, float3(l), fg * FOG_DESAT), uBg, fg * FOG_DIM);
}

// One lattice dot's contribution at frag: rgb + source-over alpha (0 = none).
float4 dotAt(float ix, float iy, float2 frag) {
  if (ix < -0.5 || iy < -0.5) return float4(0.0);
  float2 center = (float2(ix, iy) + 0.5) * uStep;
  float dist = distance(frag, center);
  if (dist > 2.5) return float4(0.0);                 // no dot reaches this far

  // Explored fraction of this dot's cell — binary at the display res, a
  // continuous 0..1 shade at aggregated (coarse-rung) resolutions.
  float explored = cellAt(center).r;
  float e = mix(1.0, explored, uExploration);
  if (e < 0.5 && (mod(ix, 2.0) > 0.5 || mod(iy, 2.0) > 0.5)) return float4(0.0);
  float coarse = e < 0.5 ? 1.0 : 0.0;

  float n = hash2(float2(ix, iy));
  float3 m = maskAt(center);
  float wv = m.b * 255.0;
  float pv = m.g * 255.0;
  float o = uStep * 0.4;                               // street sampleMax5
  float sv = max(m.r,
             max(maskAt(center + float2(o, 0.0)).r,
             max(maskAt(center + float2(-o, 0.0)).r,
             max(maskAt(center + float2(0.0, o)).r,
                 maskAt(center + float2(0.0, -o)).r)))) * 255.0;

  float3 color; float val; float isArea; int kind;    // 0 street 1 park 2 water 3 bg
  if (wv > 40.0) {
    if (n < 0.08 * (1.0 - uLod)) return float4(0.0);   // zoomed out: water fills solid, no holes
    val = 0.44 + 0.12 * sin(center.y * 0.4 + center.x * 0.2);
    color = rampLut(0.42 + 0.5 * n, 1.0);
    isArea = 1.0; kind = 2;
  } else if (pv > 40.0) {
    val = 0.58 + 0.28 * n;
    color = rampLut(0.48 + 0.5 * n, 2.0);
    isArea = 1.0; kind = 1;
  } else if (sv > 28.0) {
    val = clamp(sv / 255.0, 0.0, 1.0);
    color = rampLut(val, 0.0);
    isArea = 0.0; kind = 0;
  } else {
    // Background/building noise thins out as you zoom out, so the city field
    // reads calm instead of a wall of dots.
    if (n < 0.2 + (1.0 - e) * 0.16 + uLod * 0.35) return float4(0.0);
    val = clamp(0.24 + 0.13 * n, 0.0, 1.0);
    color = rampLut(val, 0.0);
    isArea = 0.0; kind = 3;
  }

  float3 fogged = applyFog(color, 1.0 - e, isArea);
  float fl = kind == 0 ? 0.46 : kind == 1 ? 0.44 : kind == 2 ? 0.54 : 0.12;
  float mx = kind == 0 ? 1.00 : kind == 1 ? 0.95 : kind == 2 ? 0.90 : 0.70;
  float alpha = fl + (mx - fl) * e;
  float radius;
  if (coarse > 0.5) {
    alpha *= isArea > 0.5 ? 0.72 : 0.5;
    radius = (0.55 + 0.72 * val) * 1.5;
  } else {
    radius = (0.3 + 0.85 * val) * (0.6 + 0.55 * e);
  }
  // Zoomed out, grow area (park/water) dots until they merge into readable
  // filled terrain instead of a stipple of separate dots.
  if (isArea > 0.5) radius = mix(radius, max(radius, uStep * 0.85), uLod);
  float cov = clamp(radius + 0.5 - dist, 0.0, 1.0);
  return float4(fogged, cov * alpha);
}

half4 main(float2 fragCoord) {
  float2 frag = fragCoord / uPixelRatio;              // -> region-logical px
  float3 col = uBg;

  float baseIx = floor(frag.x / uStep);
  float baseIy = floor(frag.y / uStep);
  for (float dy = -1.0; dy <= 1.0; dy += 1.0) {
    for (float dx = -1.0; dx <= 1.0; dx += 1.0) {
      float4 d = dotAt(baseIx + dx, baseIy + dy, frag);
      col = mix(col, d.rgb, d.a);
    }
  }

  // Cell-by-cell load reveal: cells reveal center-out (baked order channel,
  // staggered by the baked per-cell jitter) so a fresh region grows in cell by
  // cell over the previous one — its not-yet-revealed cells stay fully
  // transparent. uReveal=1 → everything shown.
  float3 cell = cellAt(frag);
  float order = clamp(0.85 * cell.b + (cell.g - 0.5) * 0.06, 0.0, 0.9);
  float revealA = smoothstep(order, order + 0.12, uReveal);

  // Premultiplied output (Skia runtime shaders return premultiplied color).
  return half4(col.r * revealA, col.g * revealA, col.b * revealA, revealA);
}
`;

let cached: SkRuntimeEffect | null | undefined;

/** Compile (once) and return the dot-field runtime effect, or null on failure. */
export function getDotFieldEffect(): SkRuntimeEffect | null {
  if (cached === undefined) cached = Skia.RuntimeEffect.Make(DOT_FIELD_SKSL);
  return cached;
}
