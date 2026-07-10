import { Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';

/**
 * The GPU dot-field shader — a faithful port of the CPU `buildDotField` +
 * `buildHexOverlay` + background fill (see the retired `core/scene.ts` /
 * `core/dot-raster.ts`), evaluated per pixel instead of stamped per dot.
 *
 * It is **camera-independent**: it renders the whole region rect into a bitmap
 * once, in region-local logical coordinates (0 at rect.min). The map view then
 * positions/scales that one bitmap per camera, so panning and zooming inside a
 * region are pure image transforms — the shader never re-runs mid-gesture. All
 * map math stays in region-local world coords (world − rect.min), which keeps it
 * clear of the float32 cancellation that ~0.16 normalized-mercator numbers cause.
 *
 * Inputs are three child image-shaders + numeric uniforms from
 * `packDotFieldUniforms`:
 *   - `maskTex`  RGBA feature mask, R=street G=park B=water (nearest).
 *   - `hexTex`   RGBA hex table, R=discovered G=frontier (nearest).
 *   - `lut`      256×3 palette LUT, rows 0=terr 1=water 2=park (linear).
 */
export const DOT_FIELD_SKSL = `
uniform float  uPixelRatio;   // render (device) px per region-logical px
uniform float  uScale;        // region-logical px per world unit (anchor zoom)
uniform float2 uRectSize;     // region rect size (world)
uniform float2 uMaskSize;     // mask texture size (px)
uniform float  uStep;         // dot lattice step (logical px)
uniform float  uHexRadius;    // hex circumradius (world)
uniform float2 uAxialOrigin;  // region-local axial coord of rect.min
uniform float2 uHexTableSize; // hex table (cols, rows)
uniform float3 uBg;           // background rgb (0..1)
uniform float3 uAccent;       // frontier rim rgb (0..1)
uniform float3 uStreetLabel;  // ghost lattice ink rgb (0..1)
uniform float  uReveal;       // load reveal 0..1 (1 = fully shown); hex-by-hex wipe
uniform float  uLod;          // zoom LOD 0 (street detail) .. 1 (city): simplify terrain
uniform float  uExploration;  // 1 = explored/unexplored treatment, 0 = unmasked city

uniform shader maskTex;
uniform shader hexTex;
uniform shader lut;

const float SQRT3 = 1.7320508;

// region-logical px -> region-local world (0 at rect.min)
float2 toWorld(float2 s) { return s / uScale; }
// region-local world -> mask pixel coord
float2 toMaskPx(float2 w) { return w / uRectSize * uMaskSize; }
float3 maskAt(float2 s) { return maskTex.eval(toMaskPx(toWorld(s))).rgb; }

// region-local world -> fractional local axial (q, r)
float2 axialFrac(float2 w) {
  float dx = w.x / uHexRadius;
  float dy = w.y / uHexRadius;
  float q = uAxialOrigin.x + (2.0 / 3.0) * dx;
  float r = uAxialOrigin.y + (-1.0 / 3.0) * dx + (SQRT3 / 3.0) * dy;
  return float2(q, r);
}
// cube rounding, an exact port of HexGrid.keyAt
float2 axialRound(float2 qr) {
  float q = qr.x; float r = qr.y; float s = -q - r;
  float rq = floor(q + 0.5); float rr = floor(r + 0.5); float rs = floor(s + 0.5);
  float dq = abs(rq - q); float dr = abs(rr - r); float ds = abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return float2(rq, rr);
}
// hex table (discovered, frontier) for a rounded local axial cell
float2 hexFlags(float2 cell) {
  float2 uv = clamp(cell + 0.5, float2(0.5), uHexTableSize - 0.5);
  return hexTex.eval(uv).rg;
}

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

  float2 w = toWorld(center);
  float explored = hexFlags(axialRound(axialFrac(w))).r > 0.5 ? 1.0 : 0.0;
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

  // Hex fog overlay: ghost lattice on undiscovered cells + amber frontier rim.
  float2 fa = axialFrac(toWorld(frag));
  float2 ra = axialRound(fa);
  float2 da = fa - ra;
  float2 offPx = (da.x * float2(1.5, 0.8660254) + da.y * float2(0.0, SQRT3)) * uHexRadius * uScale;
  float apothemPx = uHexRadius * uScale * 0.8660254;
  float md = max(abs(dot(offPx, float2(0.8660254, 0.5))),
            max(abs(dot(offPx, float2(0.0, 1.0))),
                abs(dot(offPx, float2(-0.8660254, 0.5)))));
  float dEdge = apothemPx - md;
  float2 flags = hexFlags(ra);
  if (uExploration > 0.5 && flags.r < 0.5)
    col = mix(col, uStreetLabel, clamp(1.0 - dEdge, 0.0, 1.0) * 0.09 * (1.0 - uLod * 0.7));
  if (uExploration > 0.5 && flags.g > 0.5)
    col = mix(col, uAccent, clamp(1.25 - dEdge, 0.0, 1.0) * 0.42);

  // Hex-by-hex load reveal: cells reveal center-out (with a little per-hex jitter)
  // so a fresh region grows in hexagon by hexagon over the previous one — its
  // not-yet-revealed cells stay fully transparent. uReveal=1 → everything shown.
  float2 centerAxial = axialRound(axialFrac(uRectSize * 0.5));
  float2 dc = ra - centerAxial;
  float hexDist = (abs(dc.x) + abs(dc.y) + abs(dc.x + dc.y)) * 0.5;
  float maxDist = length(uHexTableSize) * 0.5 + 1.0;
  float order = clamp(0.85 * (hexDist / maxDist) + (hash2(ra) - 0.5) * 0.06, 0.0, 0.9);
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
