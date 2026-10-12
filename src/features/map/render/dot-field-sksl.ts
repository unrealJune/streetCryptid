import { ROAD_DILATE_MIN, ROAD_MASK_FLOOR } from '../core/road-lod';
import { GROUND_CODE_STEP } from '../core/terrain';

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
 * Inputs are five child image-shaders + numeric uniforms from
 * `packDotFieldUniforms`:
 *   - `maskTex`    RGBA feature mask, R=street G=park B=water (nearest).
 *   - `cellTex`    RGBA cell state, R=fraction G=jitter B=reveal order (nearest).
 *   - `lut`        256×3 palette LUT, rows 0=terr 1=water 2=park (linear).
 *   - `groundTex`  R = ground-cover code, `GROUND_CODE_STEP` × (GROUND_KINDS
 *                  index + 1), 0 = none. Drawn without anti-aliasing so a code is
 *                  never a blend of two (nearest).
 *   - `terrainTex` R = park edge (the park fill blurred: 1 deep inside, falling
 *                  toward 0 at the boundary), G = elevation in contour bands
 *                  (`core/terrain.ts`: fract(G·9) crosses 0 on a contour) (linear).
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
 * back to the calmer "canopy" texture. Noise is fed region-logical px offset by
 * `uNoiseOrigin` (the rect's absolute position, wrapped on the CPU in f64), so
 * it stays fixed to the map within a zoom instead of swimming with the region.
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
uniform float  uNeonGlow;     // additive road halo amount 0..1
uniform float  uScanlines;    // map-anchored CRT scanline amount 0..1

uniform float2 uNoiseOrigin;  // region rect.min in region-logical px, wrapped (CPU f64)
uniform float  uHasElev;      // 1 = terrainTex.g carries elevation for this region
uniform float  uShadeGain;    // hillshade contrast per elevation-band step

uniform shader maskTex;
uniform shader cellTex;
uniform shader lut;
uniform shader groundTex;
uniform shader terrainTex;

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

float vnoise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + float2(1.0, 0.0)), u.x),
             mix(hash2(i + float2(0.0, 1.0)), hash2(i + float2(1.0, 1.0)), u.x), u.y);
}
float fbm(float2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + float2(17.1, 9.2); a *= 0.5; }
  return v / 0.9375;
}
// R = park edge, G = elevation bands (linear)
float2 terrainAt(float2 s) { return terrainTex.eval(toMaskPx(toWorld(s))).rg; }
// Ground-cover kind: 0 none, 1.. = GROUND_KINDS index + 1 (nearest, never blended)
float groundAt(float2 s) {
  return floor(groundTex.eval(toMaskPx(toWorld(s))).r * 255.0 / ${GROUND_CODE_STEP}.0 + 0.5);
}
// Hillshade 0..1 from the elevation slope, lit from the upper left.
float shadeAt(float2 s, float h) {
  float hx = terrainAt(s + float2(3.0, 0.0)).g;
  float hy = terrainAt(s + float2(0.0, 3.0)).g;
  return clamp(0.5 + ((hx - h) + (hy - h)) * uShadeGain, 0.0, 1.0);
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

  // Explored occupancy of this dot's fixed-resolution cell.
  float explored = cellAt(center).r;
  float e = mix(1.0, explored, uExploration);
  if (e < 0.5 && (mod(ix, 2.0) > 0.5 || mod(iy, 2.0) > 0.5)) return float4(0.0);
  float coarse = e < 0.5 ? 1.0 : 0.0;

  float n = hash2(float2(ix, iy));
  float3 m = maskAt(center);
  float wv = m.b * 255.0;
  float pv = m.g * 255.0;
  float2 np = uNoiseOrigin + center;   // map-fixed noise coordinates
  // street sampleMax5, gated: a road may only claim a dot it does not cover if
  // it is big enough to be worth the lie (ROAD_DILATE_MIN). Ungated, the six
  // hundred service roads in a downtown tile each grow to a full dot and the
  // network becomes a field.
  float o = uStep * 0.4;
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
  float gk = groundAt(center);
  if (sv > ${ROAD_MASK_FLOOR}.0) {
    val = clamp(sv / 255.0, 0.0, 1.0);
    color = rampLut(val, 0.0);
    isArea = 0.0; kind = 0;
  } else if (wv > 40.0) {
    // Water outranks park: protected areas routinely cover open water (marine
    // sanctuaries, marine state parks, offshore refuges) and lakes sit inside
    // national parks, so a park polygon is no evidence the ground is dry.
    // Calm: few holes, and the tone drifts slowly instead of per dot.
    if (n < 0.03 * (1.0 - uLod)) return float4(0.0);   // zoomed out: water fills solid
    float f = fbm(np * 0.03 + 2.0);
    val = 0.44 + 0.10 * sin(center.y * 0.4 + center.x * 0.2) + 0.03 * n;
    color = rampLut(0.46 + 0.30 * f + 0.14 * n, 1.0);
    isArea = 1.0; kind = 2;
    maxA = 0.86;
  } else if (pv > 40.0) {
    float2 t = terrainAt(center);
    // Full strength within ~9 px of the park's edge, so a small city park still
    // reads; its interior is the quiet part.
    float band = 1.0 - smoothstep(0.58, 0.76, t.r);
    if (uHasElev > 0.5) {
      // Terrain: hillshade tone, dotted contours, thinning above the treeline.
      float h = t.g;
      float sh = shadeAt(center, h);
      float alp = smoothstep(0.80, 0.88, h);
      float line = smoothstep(0.43, 0.47, abs(fract(h * 9.0) - 0.5));
      if (band < 0.5 && line < 0.5 && n < 0.08 + 0.40 * alp) return float4(0.0);
      color = mix(rampLut(0.32 + 0.42 * sh + 0.04 * n, 2.0), rampLut(0.08 + 0.22 * sh, 0.0), alp);
      val = mix(0.32 + 0.20 * sh, 0.54, line);
      color = mix(color, rampLut(0.96, 2.0), line * 0.75);
      maxA = 0.72; floorA = 0.34;
    } else {
      // Canopy: the same calm without elevation to shade.
      float f = fbm(np * 0.045);
      if (band < 0.5 && n < 0.22 * (1.0 - f)) return float4(0.0);
      color = rampLut(0.40 + 0.46 * f + 0.04 * n, 2.0);
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
    if (uHasElev > 0.5) sh = shadeAt(center, terrainAt(center).g);
    isArea = 0.0; kind = 3;
    floorA = 0.30; maxA = 0.72;
    if (gk < 1.5) {              // farmland: dots in rows
      if (mod(iy, 3.0) > 0.5) return float4(0.0);
      color = mix(rampLut(0.28 + 0.20 * n, 2.0), rampLut(0.42, 0.0), 0.45);
      val = 0.40;
    } else if (gk < 2.5) {       // wetland: park and water dots interleaved
      if (n < 0.30) return float4(0.0);
      color = mod(ix + iy, 2.0) > 0.5 ? rampLut(0.45 + 0.3 * n, 1.0) : rampLut(0.35 + 0.3 * n, 2.0);
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
    // reads calm instead of a wall of dots.
    if (n < 0.2 + (1.0 - e) * 0.16 + uLod * 0.35) return float4(0.0);
    val = clamp(0.24 + 0.13 * n, 0.0, 1.0);
    color = rampLut(val, 0.0);
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
    float line = 0.5 + 0.5 * sin(frag.y * 3.14159265 / 2.0);
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
