import { ROAD_DILATE_MIN, ROAD_MASK_FLOOR } from '../core/road-lod';
import { GROUND_CODE_STEP } from '../core/terrain';
import { DOT_STEP } from '../core/dot-style';
import { DOT_ATLAS_HALO, DOT_HASH_PERIOD } from './shader-uniforms';

/**
 * Material is evaluated at lattice points into a small atlas; the final pass
 * composites neighbouring dot glyphs. Terrain/noise
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

export const DOT_MATERIAL_SKSL = `${UNIFORMS}${SAMPLING}
uniform shader groundTex;
uniform shader terrainTex;

// classic GLSL sin-fract hash (port of hash2)
float hash2(float2 p) {
  float s = sin(p.x * 12.9898 + p.y * 78.233) * 43758.5453;
  return s - floor(s);
}

// Keep site randomness away from large, quantized float32 sine arguments.
float siteHash(float2 id) {
  float2 p = mod(id, ${DOT_HASH_PERIOD}.0);
  float3 q = fract(float3(p.x, p.y, p.x) * float3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
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

float3 contourInk(float shade) { return rampLut(0.5 + 0.2 * shade, 0.0); }

float4 rockAt(float shade, float n, float line) {
  float3 color = mix(rampLut(0.30 + 0.40 * shade + 0.10 * n, 0.0), contourInk(shade), line * 0.65);
  float density = 1.0 - smoothstep(n, n + 0.08, 0.55 * (1.0 - line));
  return float4(color, density);
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

// Two opaque texels per dot: RGB ink, then radius/step, opacity and glyph jitter.
float4 materialAt(float ix, float iy, bool metrics) {
  float step = uStep;
  float2 id = uGridOrigin + float2(ix, iy);
  float2 center = float2(ix, iy) * step + uGridPhase;
  float dotScale = step / ${DOT_STEP}.0;

  // Explored occupancy of this dot's fixed-resolution cell.
  float e = uExploration > 0.5 ? cellAt(center).r : 1.0;
  float coarse = e < 0.5 ? 1.0 : 0.0;

  float3 m = maskAt(center);
  float wv = m.b * 255.0;
  float pv = m.g * 255.0;
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

  // Independent thinning: one-per-block still patterns overlaps at block edges.
  // Roads keep their connected sampling and lose opacity instead.
  if (e < 0.5 && sv <= ${ROAD_MASK_FLOOR}.0
      && siteHash(id + float2(17.0, 89.0)) >= 0.25) return float4(0.0);
  float n = siteHash(id);
  float2 np = uNoiseOrigin + center * uNoiseScale;

  // kind: 0 street 1 park 2 water 3 bg/ground cover. A branch may override the
  // kind's alpha floor/ceiling (floorA/maxA >= 0).
  float3 color; float val; float isArea; int kind;
  float floorA = -1.0; float maxA = -1.0;
  float areaGrowth = 1.0;
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
      band *= 1.0 - alp;
      areaGrowth = 1.0 - alp;
      float line = contourAt(h);
      color = rampLut(min(0.96, 0.32 + 0.42 * sh + 0.30 * canopy + 0.04 * n), 2.0);
      color = mix(color, rampLut(0.96, 2.0), line * 0.75);
      float4 rock = rockAt(sh, n, line);
      color = mix(color, rock.rgb, alp);
      val = mix(mix(0.32 + 0.20 * sh, 0.55, alp), 0.54, line);
      float density = mix(1.0, rock.a, alp);
      maxA = mix(0.72, 0.75, alp) * density;
      floorA = mix(0.34, 0.30, alp) * density;
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
    float sh = 0.5; float line = 0.0;
    float4 t = terrainAt(center);
    if (t.a > 0.5) {
      sh = shadeAt(center, t.r);
      if (gk >= 3.5) line = contourAt(t.r);
    }
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
      float4 rock = rockAt(sh, n, line);
      color = rock.rgb;
      val = mix(0.55, 0.54, line);
      maxA = 0.75 * rock.a; floorA = 0.30 * rock.a;
    } else {                     // ice: pale and even
      if (n < 0.05 * (1.0 - line)) return float4(0.0);
      color = mix(rampLut(0.85, 1.0), float3(1.0), 0.45) * (0.85 + 0.3 * sh);
      color = mix(color, contourInk(sh), line * 0.65);
      val = mix(0.34, 0.54, line); maxA = 0.75;
    }
    if (gk >= 3.5) {
      isArea = 1.0;
      areaGrowth = 0.0;
    }
  } else {
    // Background/building noise thins out as you zoom out, so the city field
    // reads calm instead of a wall of dots. Zoomed out, where parks are a small
    // share of the land, the same ground carries the relief: shaded slopes keep
    // more (and darker) dots, lit ones thin, and contours stay dotted.
    float4 t = terrainAt(center);
    float relief = t.a * max(uLod, t.g);
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
    if (kind == 0) alpha *= 0.25;
    radius = (0.55 + 0.72 * val) * 1.5;
  } else {
    radius = (0.3 + 0.85 * val) * (0.6 + 0.55 * e);
  }
  // Zoomed out, grow area (park/water) dots until they merge into readable
  // filled terrain instead of a stipple of separate dots.
  if (isArea > 0.5) radius = mix(radius, max(radius, ${DOT_STEP}.0 * 0.85), uLod * areaGrowth);
  radius *= dotScale;
  if (!metrics) return float4(fogged, 1.0);
  // Sample geometry at the unperturbed site: jittering thin roads breaks them.
  // The two nibbles carry a small non-road glyph offset; 255 means no offset.
  float code = kind == 0 ? 255.0 : floor(siteHash(id + float2(43.0, 71.0)) * 255.0);
  return float4(radius / step, alpha, code / 255.0, 1.0);
}

half4 main(float2 p) {
  float x = floor(p.x * 0.5) - ${DOT_ATLAS_HALO}.0;
  float y = floor(p.y) - ${DOT_ATLAS_HALO}.0;
  return half4(materialAt(x, y, mod(floor(p.x), 2.0) > 0.5));
}
`;

export const DOT_FIELD_SKSL = `${UNIFORMS}${SAMPLING}
uniform shader dotTex;

float2 dotPixel(float2 index) {
  return float2((index.x + ${DOT_ATLAS_HALO}.0) * 2.0 + 0.5,
    index.y + ${DOT_ATLAS_HALO}.5);
}

float4 dotAt(float ix, float iy, float2 frag) {
  float step = uStep;
  float2 p = dotPixel(float2(ix, iy));
  float3 metrics = dotTex.eval(p + float2(1.0, 0.0)).rgb;
  if (metrics.g == 0.0) return float4(0.0);
  float code = floor(metrics.b * 255.0 + 0.5);
  float2 jitter = (float2(mod(code, 16.0), floor(code / 16.0)) - 7.5) * (step * 0.2 / 15.0);
  float2 center = float2(ix, iy) * step + uGridPhase
    + jitter * (code < 254.5 ? 1.0 : 0.0);
  float dotScale = step / ${DOT_STEP}.0;
  float dist = distance(frag, center);
  float cov = clamp((metrics.r * step - dist) / max(dotScale, 1.0 / uPixelRatio) + 0.5, 0.0, 1.0);
  float alpha = cov * metrics.g;
  if (alpha == 0.0) return float4(0.0);
  return float4(dotTex.eval(p).rgb, alpha);
}

float3 fieldAt(float2 frag) {
  float3 col = uBg;

  float step = uStep;
  float2 phase = uGridPhase;
  // Two-pixel registration puts fragments a quarter-cell from a site.
  // Even the largest antialiased glyph cannot reach beyond these four sites.
  float baseIx = floor((frag.x - phase.x) / step);
  float baseIy = floor((frag.y - phase.y) / step);
  for (float dy = 0.0; dy <= 1.0; dy += 1.0) {
    for (float dx = 0.0; dx <= 1.0; dx += 1.0) {
      float4 d = dotAt(baseIx + dx, baseIy + dy, frag);
      col = mix(col, d.rgb, d.a);
    }
  }
  return col;
}

half4 main(float2 fragCoord) {
  float2 frag = fragCoord / uPixelRatio;
  float3 col = fieldAt(frag);

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
