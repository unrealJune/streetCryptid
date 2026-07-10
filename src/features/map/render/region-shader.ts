import {
  AlphaType,
  ColorType,
  drawAsImageFromPicture,
  FilterMode,
  MipmapMode,
  Skia,
  TileMode,
  type SkImage,
} from '@shopify/react-native-skia';

import { buildPaletteLut } from '../core/region';
import type { MapPalette } from '../core/types';
import type { MapRegion } from '../engine/map-engine';
import { getDotFieldEffect } from './dot-field-shader';
import { buildMaskImage } from './mask-image';
import {
  DOT_FIELD_UNIFORM_FLOATS,
  packDotFieldUniforms,
  regionLogicalSize,
} from './shader-uniforms';

/** Longest side (device px) a region bitmap may reach — bounds cost + memory. */
const MAX_IMAGE_DIM = 2400;
/** Device-pixel ceiling: 2× is indistinguishable for 1–2px dots, half the work of 3×. */
const MAX_PIXEL_RATIO = 2;

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

/** The region's hex table as a texture (R=discovered G=frontier), one texel per cell. */
export function makeHexImage(region: MapRegion): SkImage | null {
  const { cols, rows, data } = region.hexTable;
  return imageFromRgba(data, cols, rows);
}

/** The palette ramps baked into a 256×3 LUT texture (rows 0=terr 1=water 2=park). */
export function makeLutImage(palette: MapPalette): SkImage | null {
  return imageFromRgba(buildPaletteLut(palette), 256, 3);
}

export interface RegionImageInput {
  readonly region: MapRegion;
  readonly palette: MapPalette;
  readonly hexRadius: number;
  readonly maskImage: SkImage;
  readonly hexImage: SkImage;
  readonly lutImage: SkImage;
  /** Load reveal 0..1 (default 1 = fully shown); < 1 renders a hex-by-hex wipe. */
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
 * Rasterize the whole region rect into one static bitmap with the dot-field
 * shader. This runs the heavy per-pixel work (dots, fog, ramps, hex rim) **once
 * per region** — not per frame and not per settle — because the result is
 * camera-independent: the map view positions/scales this bitmap for the live
 * camera, so in-region pans/zooms and gestures are pure image transforms.
 *
 * The bitmap covers the padded region, so panning reveals pre-rendered padding
 * instead of blank tiles until the camera leaves the region entirely. Rendered
 * at device resolution (capped) for crisp dots. Returns null if Skia can't
 * compile the effect or rasterize, letting the caller fall back to a flat fill.
 */
export function renderRegionImage({
  region,
  palette,
  hexRadius,
  maskImage,
  hexImage,
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
    hexRadius,
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
    hexImage.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Nearest, MipmapMode.None),
    lutImage.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None),
  ]);

  const width = Math.max(1, Math.round(logical.width * pixelRatio));
  const height = Math.max(1, Math.round(logical.height * pixelRatio));

  const paint = Skia.Paint();
  paint.setShader(shader);
  const picture = Skia.PictureRecorder();
  const canvas = picture.beginRecording(Skia.XYWHRect(0, 0, width, height));
  canvas.drawPaint(paint);
  const recorded = picture.finishRecordingAsPicture();

  const image = drawAsImageFromPicture(recorded, { width, height });
  if (!image && __DEV__) console.warn(`[map] region raster failed (${width}×${height})`);
  return image;
}
