import { ROAD_DILATE_MIN, ROAD_MASK_FLOOR } from '../core/road-lod';
import { GROUND_CODE_STEP } from '../core/terrain';
import { DOT_STEP } from '../core/dot-style';
import { DOT_ATLAS_HALO, DOT_HASH_PERIOD, type DotFieldMode } from './shader-uniforms';

/**
 * Material is evaluated at lattice points into a small atlas; the final pass
 * reconstructs area ink or composites neighbouring point features. Terrain/noise
 * must not be recalculated for every output pixel touched by the same dot.
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
 * The material pass takes five child image-shaders + numeric uniforms from
 * `packDotFieldUniforms`; the composite pass takes the first three plus the atlas:
 *   - `maskTex`    RGBA feature mask, R=street G=park B=water (nearest).
 *   - `cellTex`    RGBA cell state, R=fraction G=jitter B=reveal order (nearest).
 *   - `lut`        256×3 palette LUT, rows 0=terr 1=water 2=park (linear).
 *   - `groundTex`  R = ground-cover code, G = blurred park interior.
 *                  Codes are sampled at pixel centres so they cannot blend.
 *   - `terrainTex` R/G = absolute 16-bit elevation in metres, B = alpine weight,
 *                  sampled directly at DEM resolution (linear).
 *
 * The mask records every feature that covers a point, so a dot that is both
 * park and water has to pick one. Precedence is street > water > park > ground
 * cover > ground.
 *
 * Water and parkland follow the design note "Dot field: terrain parkland and
 * calm water": slow fbm drift instead of per-dot random tone, a full-strength
 * band along every park edge so a small city park still reads, and — where the
 * region has elevation (`uHasElev`) — hillshade, dotted contours and a treeline
 * that hands high ground to the ground ramp. Without elevation the park falls
 * back to the calmer "canopy" texture. Noise and the dot lattice are world-anchored.
 * Subpixel noise octaves fade out before aliasing instead of swimming with the camera.
 */
const UNIFORMS = `
uniform float  uPixelRatio;   // render (device) px per region-logical px
uniform float  uScale;        // region-logical px per world unit (anchor zoom)
uniform float2 uRectSize;     // region rect size (world)
uniform float2 uMaskSize;     // mask texture size (px)
uniform float  uStep;         // dot lattice step (logical px)
uniform float3 uBg;           // background rgb (0..1)
uniform float  uReveal;       // load reveal 0..1 (1 = fully shown); cell-by-cell wipe
uniform float  uLod;          // zoom LOD 0 (street detail) .. 1 (city): simplify terrain
uniform float  uExploration;  // 1 = explored/unexplored treatment, 0 = unmasked city
uniform float  uNeonGlow;     // additive road halo amount 0..1
uniform float  uScanlines;    // map-anchored CRT scanline amount 0..1

uniform float2 uNoiseOrigin;  // rect.min at the fixed material scale
uniform float  uHasElev;
uniform float  uShadeGain;    // slope normalization, per DEM pixel
uniform float  uNoiseScale;   // fixed material units per region-logical px
uniform float2 uGridOrigin;   // absolute lattice indices, wrapped in f64
uniform float2 uGridPhase;    // first lattice centre in region-logical px
uniform float2 uElevOrigin;   // DEM top-left in region-logical px
uniform float2 uElevStep;     // region-logical px per DEM pixel
uniform float2 uElevSize;
uniform float  uContourInterval; // absolute metres between detail contours
uniform float  uContourDetail;   // fade in intermediate lines, never relocate them
uniform float4 uCanopyWeights;   // sampling-filtered octave amplitudes, centred on 0.5
uniform float4 uWaterWeights;
uniform float2 uCoarseGridOrigin;
uniform float2 uCoarseGridPhase;
uniform float  uAtlasSplit;
uniform float  uDetailBlend;
`;

const SAMPLING = `
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

float3 rampLut(float t, float row) {
  float x = clamp(t, 0.0, 1.0) * 255.0 + 0.5;
  return lut.eval(float2(x, row + 0.5)).rgb;
}
`;

/**
 * Mean coverage of the existing linear-AA circles, not their optical density
 * (averaging density darkens canopy). The dense case integrates
 * 1 - product(1 - alpha * coverage) over a lattice cell. These degree-six fits
 * approximate the alpha^2, alpha^3 and alpha^4 overlap coefficients for
 * radius/step in [0.25, 0.851]; the numerical-integration render test
 * bounds the error below one RGBA8 level. At the shipped sparse opacities,
 * ignoring their tiny overlaps costs less than 0.05/255.
 */
export const DOT_AREA_COVERAGE_SKSL = `
float areaCoverage(float r, float alpha, bool sparse) {
  float area = 3.14159265 * (r * r + 1.0 / 48.0);
  if (sparse) return alpha * area * 0.25;
  float t = (r - 0.25) / 0.6;
  float3 overlap = float3(0.3116777, -3.9312626, 0.1535741);
  overlap = overlap * t + float3(-2.4392213, 12.2483635, 0.1919365);
  overlap = overlap * t + float3(4.7311483, -11.7692370, -0.5361927);
  overlap = overlap * t + float3(-1.0278164, 4.8993563, 0.3394671);
  overlap = overlap * t + float3(0.3071636, -0.9153937, -0.0832372);
  overlap = overlap * t + float3(-0.0247104, 0.0655773, 0.0073383);
  overlap = max(float3(0.0), overlap * t + float3(0.0003902, -0.0009902, -0.0001330));
  return clamp(alpha * (area - alpha * (overlap.x - alpha * (overlap.y - alpha * overlap.z))), 0.0, 1.0);
}
`;

function materialSksl(filteredAreas: boolean): string {
  const halo = filteredAreas ? DOT_ATLAS_HALO : 1;
  return `${UNIFORMS}${SAMPLING}${filteredAreas ? DOT_AREA_COVERAGE_SKSL : ''}
uniform shader groundTex;
uniform shader terrainTex;

// classic GLSL sin-fract hash (port of hash2)
float hash2(float2 p) {
  float s = sin(p.x * 12.9898 + p.y * 78.233) * 43758.5453;
  return s - floor(s);
}

float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + float2(1.0, 0.0)), u.x),
             mix(hash2(i + float2(0.0, 1.0)), hash2(i + float2(1.0, 1.0)), u.x), u.y);
}
float fbm(float2 p, float4 weights) {
  if (weights.x == 0.0) return 0.5;
  float v = 0.5 + weights.x * (vnoise(p) - 0.5);
  if (weights.y == 0.0) return v;
  p = p * 2.03 + float2(17.1, 9.2);
  v += weights.y * (vnoise(p) - 0.5);
  if (weights.z == 0.0) return v;
  p = p * 2.03 + float2(17.1, 9.2);
  v += weights.z * (vnoise(p) - 0.5);
  if (weights.w == 0.0) return v;
  p = p * 2.03 + float2(17.1, 9.2);
  return v + weights.w * (vnoise(p) - 0.5);
}
// Decode AFTER interpolation, never after an intermediate RGBA8 rasterization.
float4 terrainAt(float2 s) {
  if (uHasElev < 0.5) return float4(0.0);
  float2 p = (s - uElevOrigin) / uElevStep;
  float inside = p.x >= 0.5 && p.y >= 0.5 && p.x <= uElevSize.x - 0.5 && p.y <= uElevSize.y - 0.5 ? uHasElev : 0.0;
  float3 t = terrainTex.eval(p).rgb;
  return float4(t.r * 65280.0 + t.g * 255.0, t.b, 0.0, inside);
}
// Ground-cover kind: 0 none, 1.. = GROUND_KINDS index + 1 (nearest, never blended)
float groundAt(float2 s) {
  float2 p = floor(toMaskPx(toWorld(s))) + 0.5;
  return floor(groundTex.eval(p).r * 255.0 / ${GROUND_CODE_STEP}.0 + 0.5);
}
float heightAt(float2 s) {
  float2 t = terrainTex.eval((s - uElevOrigin) / uElevStep).rg;
  return t.r * 65280.0 + t.g * 255.0;
}
// Hillshade 0..1 from the elevation slope, lit from the upper left.
float shadeAt(float2 s, float h) {
  float hx = heightAt(s + float2(uElevStep.x, 0.0));
  float hy = heightAt(s + float2(0.0, uElevStep.y));
  return clamp(0.5 + ((hx - h) + (hy - h)) * uShadeGain, 0.0, 1.0);
}

float contourAt(float h) {
  if (h < 1.0) return 0.0;
  float band = h / uContourInterval;
  float coarse = smoothstep(0.43, 0.47, abs(fract(band * 0.5) - 0.5));
  float fine = smoothstep(0.43, 0.47, abs(fract(band) - 0.5));
  return mix(coarse, fine, uContourDetail);
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

// Two opaque texels per dot: RGB ink, then radius/step, opacity and area coverage.
float4 materialAt(float ix, float iy, bool metrics, bool coarseGrid) {
  float step = coarseGrid ? uStep * 2.0 : uStep;
  float2 id = (coarseGrid ? uCoarseGridOrigin : uGridOrigin) + float2(ix, iy);
  float2 center = float2(ix, iy) * step + (coarseGrid ? uCoarseGridPhase : uGridPhase);
  float dotScale = step / ${DOT_STEP}.0;

  // Explored occupancy of this dot's fixed-resolution cell.
  float e = uExploration > 0.5 ? cellAt(center).r : 1.0;
  if (e < 0.5 && (mod(id.x, 2.0) > 0.5 || mod(id.y, 2.0) > 0.5)) return float4(0.0);
  float coarse = e < 0.5 ? 1.0 : 0.0;

  float n = hash2(mod(id, ${DOT_HASH_PERIOD}.0));
  float3 m = maskAt(center);
  float wv = m.b * 255.0;
  float pv = m.g * 255.0;
  float2 np = uNoiseOrigin + center * uNoiseScale;
  // street sampleMax5, gated: a road may only claim a dot it does not cover if
  // it is big enough to be worth the lie (ROAD_DILATE_MIN). Ungated, the six
  // hundred service roads in a downtown tile each grow to a full dot and the
  // network becomes a field.
  float o = step * 0.4;
  float here = m.r * 255.0;
  float near = max(maskAt(center + float2(o, 0.0)).r,
              max(maskAt(center + float2(-o, 0.0)).r,
              max(maskAt(center + float2(0.0, o)).r,
                  maskAt(center + float2(0.0, -o)).r))) * 255.0;
  float sv = near >= ${ROAD_DILATE_MIN}.0 ? max(here, near) : here;

  // kind: 0 street 1 park 2 water 3 bg/ground cover. A branch may override the
  // kind's alpha floor/ceiling (floorA/maxA >= 0).
  float3 color; float val; float isArea; int kind;
  float floorA = -1.0; float maxA = -1.0;
  float gk = sv <= ${ROAD_MASK_FLOOR}.0 && wv <= 40.0 && pv <= 40.0 ? groundAt(center) : 0.0;
  if (sv > ${ROAD_MASK_FLOOR}.0) {
    val = clamp(sv / 255.0, 0.0, 1.0);
    color = rampLut(val, 0.0);
    isArea = 0.0; kind = 0;
  } else if (wv > 40.0) {
    // Water outranks park: protected areas routinely cover open water (marine
    // sanctuaries, marine state parks, offshore refuges) and lakes sit inside
    // national parks, so a park polygon is no evidence the ground is dry.
    // Calm: no random holes, and the tone drifts slowly instead of per dot.
    float f = fbm(np * 0.03 + 2.0, uWaterWeights);
    val = 0.44 + 0.10 * sin(np.y * 0.4 + np.x * 0.2) / max(1.0, uNoiseScale) + 0.03 * n;
    color = rampLut(0.46 + 0.30 * f + 0.14 * n, 1.0);
    isArea = 1.0; kind = 2;
    maxA = 0.86;
  } else if (pv > 40.0) {
    // Full strength within ~9 px of the park's edge, so a small city park still
    // reads; its interior is the quiet part.
    float edge = groundTex.eval(toMaskPx(toWorld(center))).g;
    float band = 1.0 - smoothstep(0.58, 0.76, edge);
    // Clustered canopy ink, not missing dots. Stretch the noise's middle range
    // so darker patches survive at both terrain and fallback zooms.
    float f = fbm(np * 0.045, uCanopyWeights);
    float canopy = smoothstep(0.40, 0.70, f);
    float4 t = terrainAt(center);
    if (t.a > 0.5) {
      // Terrain: hillshade tone, dotted contours, thinning above the treeline.
      float h = t.r;
      float sh = shadeAt(center, h);
      float alp = t.g;
      float line = contourAt(h);
      color = mix(rampLut(min(0.96, 0.32 + 0.42 * sh + 0.30 * canopy + 0.04 * n), 2.0), rampLut(0.08 + 0.22 * sh, 0.0), alp);
      val = mix(0.32 + 0.20 * sh, 0.54, line);
      color = mix(color, rampLut(0.96, 2.0), line * 0.75);
      // Keep the alpine grain, but fade its world-anchored dots rather than
      // toggling holes as the treeline or contour detail changes.
      float density = 1.0 - smoothstep(n, n + 0.08, 0.40 * alp * (1.0 - line));
      maxA = 0.72 * density; floorA = 0.34 * density;
    } else {
      // Canopy: the same calm without elevation to shade.
      color = rampLut(min(0.96, 0.40 + 0.46 * f + 0.24 * canopy + 0.04 * n), 2.0);
      val = 0.40 + 0.24 * f;
      maxA = 0.74; floorA = 0.34;
    }
    val = mix(val, 0.62, band);
    color = mix(color, rampLut(0.88, 2.0), band);
    maxA = mix(maxA, 0.95, band);
    floorA = mix(floorA, 0.44, band);
    isArea = 1.0; kind = 1;
  } else if (gk > 0.5) {
    // Ground cover (GROUND_KINDS order): each class its own stipple, shaded by
    // the terrain where the region has elevation.
    float sh = 0.5;
    float4 t = terrainAt(center);
    if (t.a > 0.5) sh = shadeAt(center, t.r);
    isArea = 0.0; kind = 3;
    floorA = 0.30; maxA = 0.72;
    if (gk < 1.5) {              // farmland: dots in rows
      if (mod(id.y, 3.0) > 0.5) return float4(0.0);
      color = mix(rampLut(0.28 + 0.20 * n, 2.0), rampLut(0.42, 0.0), 0.45);
      val = 0.40;
    } else if (gk < 2.5) {       // wetland: park and water dots interleaved
      if (n < 0.30) return float4(0.0);
      color = mod(id.x + id.y, 2.0) > 0.5 ? rampLut(0.45 + 0.3 * n, 1.0) : rampLut(0.35 + 0.3 * n, 2.0);
      val = 0.34; maxA = 0.70;
    } else if (gk < 3.5) {       // sand: dense, small, warm
      if (n < 0.10) return float4(0.0);
      color = mix(rampLut(0.55 + 0.20 * n, 0.0), float3(0.93, 0.84, 0.60), 0.35);
      val = 0.26; maxA = 0.70;
    } else if (gk < 4.5) {       // rock: sparse, coarse, shaded
      if (n < 0.55) return float4(0.0);
      color = rampLut(0.30 + 0.40 * sh + 0.10 * n, 0.0);
      val = 0.55; maxA = 0.75;
    } else {                     // ice: pale and even
      if (n < 0.05) return float4(0.0);
      color = mix(rampLut(0.85, 1.0), float3(1.0), 0.45) * (0.85 + 0.3 * sh);
      val = 0.34; maxA = 0.75;
    }
  } else {
    // Background/building noise thins out as you zoom out, so the city field
    // reads calm instead of a wall of dots. Zoomed out, where parks are a small
    // share of the land, the same ground carries the relief: shaded slopes keep
    // more (and darker) dots, lit ones thin, and contours stay dotted.
    float4 t = terrainAt(center);
    float relief = t.a * uLod;
    float sh = 0.5; float line = 0.0;
    if (relief > 0.001) {
      float h = t.r;
      sh = shadeAt(center, h);
      line = contourAt(h);
    }
    float shade = (0.5 - sh) * relief;  // > 0 in shadow
    float thin = 0.2 + (1.0 - e) * 0.16 + uLod * 0.35 - shade * 0.9 - line * relief * 0.5;
    if (n < thin) return float4(0.0);
    val = clamp(0.24 + 0.13 * n + shade * 0.5 + line * relief * 0.18, 0.0, 1.0);
    color = rampLut(clamp(val + shade * 0.6, 0.0, 1.0), 0.0);
    isArea = 0.0; kind = 3;
  }

  float3 fogged = applyFog(color, 1.0 - e, isArea);
  float fl = kind == 0 ? 0.46 : kind == 1 ? 0.44 : kind == 2 ? 0.54 : 0.12;
  float mx = kind == 0 ? 1.00 : kind == 1 ? 0.95 : kind == 2 ? 0.90 : 0.70;
  if (floorA >= 0.0) fl = floorA;
  if (maxA >= 0.0) mx = maxA;
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
  if (isArea > 0.5) radius = mix(radius, max(radius, ${DOT_STEP}.0 * 0.85), uLod);
  radius *= dotScale;
  ${
    filteredAreas
      ? `if (!metrics) return float4(fogged, 1.0);
  float r = radius / step;
  // Match the quantized radius/opacity the point compositor reads from this atlas.
  float areaCode = 0.0;
  if (isArea > 0.5) {
    float2 footprint = floor(float2(r, alpha) * 255.0 + 0.5) / 255.0;
    float coverage = areaCoverage(footprint.x, footprint.y, coarse > 0.5);
    areaCode = (1.0 + coverage * 254.0) / 255.0;
  }
  return float4(r, alpha, areaCode, 1.0);`
      : 'return metrics ? float4(radius / step, alpha, 0.0, 1.0) : float4(fogged, 1.0);'
  }
}

half4 main(float2 p) {
  bool coarse = p.y >= uAtlasSplit;
  if ((coarse && uDetailBlend >= 1.0) || (!coarse && uDetailBlend <= 0.0)) return half4(0.0);
  float x = floor(p.x * 0.5) - ${halo}.0;
  if (coarse && x > ceil(uRectSize.x * uScale / (uStep * 2.0)) + ${halo}.0) return half4(0.0);
  float y = floor(p.y - (coarse ? uAtlasSplit : 0.0)) - ${halo}.0;
  return half4(materialAt(x, y, mod(floor(p.x), 2.0) > 0.5, coarse));
}
`;
}

export function dotFieldSksl({ filteredAreas, blendLevels }: DotFieldMode): string {
  const halo = filteredAreas ? DOT_ATLAS_HALO : 1;
  return `${UNIFORMS}${SAMPLING}
uniform shader dotTex;
const bool FILTER_AREAS = ${filteredAreas};

float2 dotPixel(float2 index, bool coarse) {
  return float2((index.x + ${halo}.0) * 2.0 + 0.5,
    index.y + ${halo}.5 + (coarse ? uAtlasSplit : 0.0));
}

float4 dotAt(float ix, float iy, float2 frag, bool coarse) {
  float step = coarse ? uStep * 2.0 : uStep;
  float2 center = float2(ix, iy) * step + (coarse ? uCoarseGridPhase : uGridPhase);
  float dotScale = step / ${DOT_STEP}.0;
  float dist = distance(frag, center);
  if (dist > 2.5 * dotScale) return float4(0.0);
  float2 p = dotPixel(float2(ix, iy), coarse);
  float2 metrics = dotTex.eval(p + float2(1.0, 0.0)).rg;
  float cov = clamp((metrics.r * step - dist) / dotScale + 0.5, 0.0, 1.0);
  float alpha = cov * metrics.g;
  if (alpha == 0.0) return float4(0.0);
  return float4(dotTex.eval(p).rgb, alpha);
}

float4 areaAt(float2 frag, bool coarse, bool unexplored) {
  float step = coarse ? uStep * 2.0 : uStep;
  float2 phase = coarse ? uCoarseGridPhase : uGridPhase;
  float stride = unexplored ? 2.0 : 1.0;
  float2 parity = mod(coarse ? uCoarseGridOrigin : uGridOrigin, stride);
  float2 q = ((frag - phase) / step + parity) / stride;
  float2 lo = floor(q) * stride - parity;
  float2 t = fract(q);
  float3 col = uBg;
  for (float y = 0.0; y <= 1.0; y += 1.0) {
    for (float x = 0.0; x <= 1.0; x += 1.0) {
      float2 p = dotPixel(lo + float2(x, y) * stride, coarse);
      float code = dotTex.eval(p + float2(1.0, 0.0)).b;
      // Mixed feature edges retain the original dot coverage.
      if (code == 0.0) return float4(0.0);
      float alpha = (code * 255.0 - 1.0) / 254.0;
      float weight = (x == 0.0 ? 1.0 - t.x : t.x) * (y == 0.0 ? 1.0 - t.y : t.y);
      col += (dotTex.eval(p).rgb - uBg) * (alpha * weight);
    }
  }
  return float4(col, 1.0);
}

float3 fieldAt(float2 frag, bool coarse, bool unexplored) {
  float3 col = uBg;

  float step = coarse ? uStep * 2.0 : uStep;
  float2 phase = coarse ? uCoarseGridPhase : uGridPhase;
  float baseIx = floor((frag.x - phase.x) / step + 0.5);
  float baseIy = floor((frag.y - phase.y) / step + 0.5);
  if (FILTER_AREAS) {
    float2 probe = float2(baseIx, baseIy);
    if (unexplored) {
      float2 origin = coarse ? uCoarseGridOrigin : uGridOrigin;
      probe -= mod(probe + origin, 2.0);
    }
    if (dotTex.eval(dotPixel(probe, coarse) + float2(1.0, 0.0)).b > 0.0) {
      float4 ink = areaAt(frag, coarse, unexplored);
      if (ink.a > 0.0) return ink.rgb;
    }
  }
  for (float dy = -1.0; dy <= 1.0; dy += 1.0) {
    for (float dx = -1.0; dx <= 1.0; dx += 1.0) {
      float4 d = dotAt(baseIx + dx, baseIy + dy, frag, coarse);
      col = mix(col, d.rgb, d.a);
    }
  }
  return col;
}

half4 main(float2 fragCoord) {
  float2 frag = fragCoord / uPixelRatio;
  bool unexplored = FILTER_AREAS && uExploration > 0.5 && cellAt(frag).r < 0.5;
  float3 col = ${
    blendLevels
      ? 'mix(fieldAt(frag, true, unexplored), fieldAt(frag, false, unexplored), uDetailBlend)'
      : 'fieldAt(frag, false, unexplored)'
  };

  if (uNeonGlow > 0.001) {
    float street = maskAt(frag).r;
    float nearStreet = max(
      max(maskAt(frag + float2(3.0, 0.0)).r, maskAt(frag + float2(-3.0, 0.0)).r),
      max(maskAt(frag + float2(0.0, 3.0)).r, maskAt(frag + float2(0.0, -3.0)).r)
    );
    nearStreet = max(nearStreet, max(
      max(maskAt(frag + float2(6.0, 0.0)).r, maskAt(frag + float2(-6.0, 0.0)).r),
      max(maskAt(frag + float2(0.0, 6.0)).r, maskAt(frag + float2(0.0, -6.0)).r)
    ));
    float halo = clamp(nearStreet - street * 0.72, 0.0, 1.0) * uNeonGlow;
    float3 glow = rampLut(nearStreet, 0.0);
    col = 1.0 - (1.0 - col) * (1.0 - glow * halo * 0.28);
  }

  if (uScanlines > 0.001) {
    float line = 0.5 + 0.5 * sin((uNoiseOrigin.y + frag.y * uNoiseScale) * 3.14159265 / 2.0);
    col *= 1.0 - uScanlines * (0.018 + line * 0.045);
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
}

export const DOT_FIELD_SKSL = dotFieldSksl({ filteredAreas: true, blendLevels: true });
export const DOT_MATERIAL_SKSL = materialSksl(true);
export const DOT_POINT_MATERIAL_SKSL = materialSksl(false);
