import {
  AlphaType,
  ColorType,
  drawAsImageFromPicture,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Skia,
  StrokeJoin,
  TileMode,
  type SkCanvas,
  type SkImage,
} from '@shopify/react-native-skia';

import { buildPaletteLut } from '../core/region';
import type { MapPalette } from '../core/types';
import type { MapRegion } from '../engine/map-engine';
import { buildCellStateImage } from './cell-state-image';
import { cellLatticePath, cellRimPath } from './cell-overlay-paths';
import { getDotFieldEffect } from './dot-field-shader';
import { buildMaskImage } from './mask-image';
import {
  DOT_FIELD_UNIFORM_FLOATS,
  lodForZoom,
  packDotFieldUniforms,
  regionLogicalSize,
} from './shader-uniforms';

/** Longest side (device px) a region bitmap may reach — bounds cost + memory. */
const MAX_IMAGE_DIM = 2400;
/** Device-pixel ceiling: 2× is indistinguishable for 1–2px dots, half the work of 3×. */
const MAX_PIXEL_RATIO = 2;

/** Ghost lattice / frontier rim styling (logical px + alphas from the old shader). */
const LATTICE_WIDTH = 1.0;
const LATTICE_ALPHA = 0.09;
const RIM_WIDTH = 1.25;
const RIM_ALPHA = 0.42;

/** Wrap a tightly-packed opaque RGBA8888 buffer as an SkImage. */
function imageFromRgba(data: Uint8Array, width: number, height: number): SkImage | null {
  const bytes = Skia.Data.fromBytes(data);
  const image = Skia.Image.MakeImage(
    { width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
    bytes,
    width * 4
  );
  bytes.dispose();
  return image;
}

/** The region's feature mask as a texture (R=street G=park B=water), built on GPU. */
export function makeMaskImage(region: MapRegion): SkImage | null {
  return buildMaskImage(region.geometry, region.spec);
}

/** The region's cell field baked as a texture (R=fraction G=jitter B=reveal order). */
export function makeCellStateImage(region: MapRegion): SkImage | null {
  return buildCellStateImage(region.cellField, region.spec);
}

/** The palette ramps baked into a 256×3 LUT texture (rows 0=terr 1=water 2=park). */
export function makeLutImage(palette: MapPalette): SkImage | null {
  return imageFromRgba(buildPaletteLut(palette), 256, 3);
}

export interface RegionImageInput {
  readonly region: MapRegion;
  readonly palette: MapPalette;
  readonly maskImage: SkImage;
  readonly cellImage: SkImage;
  readonly lutImage: SkImage;
  /** Load reveal 0..1 (default 1 = fully shown); < 1 renders a cell-by-cell wipe. */
  readonly reveal?: number;
  /** Show the explored/unexplored fog treatment (default true). */
  readonly explorationEnabled?: boolean;
  /**
   * Resolution multiplier (default 1). Intermediate reveal frames pass < 1 so the
   * heavy 45-tap dot shader rasterizes fewer pixels during the ~320ms wipe; the
   * final frame renders at full quality, so the settled bitmap stays crisp.
   */
  readonly quality?: number;
}

/**
 * Rasterize the whole region rect into one static bitmap: the dot-field shader
 * pass (dots, fog, ramps — sampling the baked cell state texture), then the
 * ghost lattice and amber frontier rim stroked on top as vector paths (H3
 * cells aren't an analytic lattice, so the crisp 1px line work moved from the
 * shader to paths — see cell-overlay-paths.ts). This runs the heavy per-pixel
 * work **once per region** — not per frame and not per settle — because the
 * result is camera-independent: the map view positions/scales this bitmap for
 * the live camera, so in-region pans/zooms and gestures are pure image
 * transforms.
 *
 * The bitmap covers the padded region, so panning reveals pre-rendered padding
 * instead of blank tiles until the camera leaves the region entirely. Rendered
 * at device resolution (capped) for crisp dots. Returns null if Skia can't
 * compile the effect or rasterize, letting the caller fall back to a flat fill.
 */
export function renderRegionImage({
  region,
  palette,
  maskImage,
  cellImage,
  lutImage,
  reveal = 1,
  explorationEnabled = true,
  quality = 1,
}: RegionImageInput): SkImage | null {
  const effect = getDotFieldEffect();
  if (!effect) {
    if (__DEV__) console.warn('[map] dot-field shader failed to compile');
    return null;
  }

  const logical = regionLogicalSize(region);
  const longest = Math.max(logical.width, logical.height);
  const capped = Math.max(1, Math.min(MAX_PIXEL_RATIO, MAX_IMAGE_DIM / longest));
  const pixelRatio = Math.max(0.5, capped * quality);

  const uniforms = packDotFieldUniforms({
    region,
    palette,
    pixelRatio,
    reveal,
    explorationEnabled,
  });
  if (__DEV__ && uniforms.length !== DOT_FIELD_UNIFORM_FLOATS) {
    console.warn(
      `[map] uniform count ${uniforms.length} != shader's ${DOT_FIELD_UNIFORM_FLOATS} — check order`
    );
  }

  const shader = effect.makeShaderWithChildren(uniforms, [
    maskImage.makeShaderOptions(
      TileMode.Clamp,
      TileMode.Clamp,
      FilterMode.Nearest,
      MipmapMode.None
    ),
    cellImage.makeShaderOptions(
      TileMode.Clamp,
      TileMode.Clamp,
      FilterMode.Nearest,
      MipmapMode.None
    ),
    lutImage.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None),
  ]);

  const width = Math.max(1, Math.round(logical.width * pixelRatio));
  const height = Math.max(1, Math.round(logical.height * pixelRatio));

  const paint = Skia.Paint();
  paint.setShader(shader);
  const picture = Skia.PictureRecorder();
  const canvas = picture.beginRecording(Skia.XYWHRect(0, 0, width, height));
  canvas.drawPaint(paint);
  if (explorationEnabled) {
    drawCellOverlays(canvas, region, palette, pixelRatio, reveal);
  }
  const recorded = picture.finishRecordingAsPicture();

  const image = drawAsImageFromPicture(recorded, { width, height });
  if (!image && __DEV__) console.warn(`[map] region raster failed (${width}×${height})`);
  return image;
}

/**
 * Ghost lattice + frontier rim over the dot field, in region-logical coords
 * (the canvas scale maps them to device px). During the reveal wipe both fade
 * globally with `reveal` — a small fidelity trade vs the old per-cell line
 * reveal, invisible at 320 ms.
 */
function drawCellOverlays(
  canvas: SkCanvas,
  region: MapRegion,
  palette: MapPalette,
  pixelRatio: number,
  reveal: number
): void {
  const lod = lodForZoom(region.spec.zoom);
  const latticeAlpha = LATTICE_ALPHA * (1 - lod * 0.7) * reveal;
  const rimAlpha = RIM_ALPHA * reveal;
  if (latticeAlpha <= 0 && rimAlpha <= 0) return;

  canvas.save();
  canvas.scale(pixelRatio, pixelRatio);
  if (latticeAlpha > 0) {
    const lattice = Skia.Path.MakeFromSVGString(cellLatticePath(region.cellField, region.spec));
    if (lattice)
      canvas.drawPath(lattice, strokePaint(palette.streetLabel, LATTICE_WIDTH, latticeAlpha));
  }
  if (rimAlpha > 0) {
    const rim = Skia.Path.MakeFromSVGString(cellRimPath(region.cellField, region.spec));
    if (rim) canvas.drawPath(rim, strokePaint(palette.accent, RIM_WIDTH, rimAlpha));
  }
  canvas.restore();
}

function strokePaint(rgb: readonly [number, number, number], width: number, alpha: number) {
  const paint = Skia.Paint();
  paint.setColor(Skia.Color(`rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`));
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(width);
  paint.setStrokeJoin(StrokeJoin.Round);
  paint.setAntiAlias(true);
  return paint;
}
