import {
  AlphaType,
  BlendMode,
  BlurStyle,
  ColorType,
  PaintStyle,
  Skia,
  type SkImage,
} from '@shopify/react-native-skia';

import { scaleFor } from '../core/camera';
import type { RegionSpec } from '../core/region';
import { elevationRgba, groundCode, PARK_EDGE_PX, type ElevationRaster } from '../core/terrain';
import { GROUND_KINDS } from '../core/types';
import type { PackedGeometry } from '../tiles/packed-geometry';
import { maskProjection } from './mask-image';
import { renderPicture } from './offscreen';
import { assembleRegionPath, drawTileLayers, groundPath, parkPath } from './tile-paths';

/**
 * The two terrain textures the dot field samples beside the feature mask (see
 * `dot-field-sksl.ts` for how each channel is read).
 *
 * `groundTex` holds one ground-cover code per pixel. It is drawn WITHOUT
 * anti-aliasing and with `Src` (last writer wins) rather than the mask's
 * Lighten: an anti-aliased edge between two classes, or between a class and
 * nothing, would be a value that decodes as a third class — the Kyoto mockup
 * read the seams between neighbouring forest polygons as farmland that way.
 *
 * `groundTex.g` holds the park edge. `terrainTex` is the DEM at its native
 * resolution: elevation in R/G, alpine weight in B. The edge is the park fill
 * blurred by {@link PARK_EDGE_PX}; the blur reaches past the canvas
 * because Skia sizes an image filter's input from the area it has to cover, so a
 * park running off the region does not grow a false boundary band at the seam.
 */

/** A 1×1 black image: what a sampler sees for "nothing here", without a full-size texture. */
function emptyImage(): SkImage | null {
  const bytes = Skia.Data.fromBytes(new Uint8Array([0, 0, 0, 255]));
  const image = Skia.Image.MakeImage(
    { width: 1, height: 1, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
    bytes,
    4
  );
  bytes.dispose();
  return image;
}

export function buildGroundImage(geometry: PackedGeometry, spec: RegionSpec): SkImage | null {
  const { origin, scale } = maskProjection(spec);
  const park = assembleRegionPath(geometry.parts, origin, scale, (tile) => [parkPath(tile)]);
  if (!park && geometry.parts.every((tile) => tile.groundCover.count === 0)) return emptyImage();
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  canvas.drawColor(Skia.Color('black'));
  // Kind by kind across every tile, so the later kind wins an overlap wherever it falls.
  GROUND_KINDS.forEach((_, kindIndex) => {
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(`rgb(${groundCode(kindIndex)},0,0)`));
    paint.setStyle(PaintStyle.Fill);
    paint.setBlendMode(BlendMode.Src);
    paint.setAntiAlias(false);
    drawTileLayers(canvas, geometry.parts, origin, scale, (tile) => {
      const path = groundPath(tile, kindIndex);
      if (path) canvas.drawPath(path, paint);
    });
  });
  if (park) {
    const logicalPerMask =
      ((spec.rect.maxX - spec.rect.minX) * scaleFor(spec.zoom)) / spec.maskWidth;
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(0,255,0)'));
    paint.setStyle(PaintStyle.Fill);
    paint.setAntiAlias(true);
    paint.setBlendMode(BlendMode.Lighten);
    paint.setMaskFilter(
      Skia.MaskFilter.MakeBlur(BlurStyle.Normal, PARK_EDGE_PX / logicalPerMask, false)
    );
    canvas.drawPath(park, paint);
  }
  return renderPicture(
    recorder.finishRecordingAsPicture(),
    spec.maskWidth,
    spec.maskHeight,
    'same-thread'
  );
}

export interface TerrainImage {
  readonly image: SkImage | null;
  /** True when R/G carry absolute elevation (the shader's `uHasElev`). */
  readonly hasElevation: boolean;
}

// Cache GC-visible pixels, not a native image that its region will dispose.
const elevationPixels = new WeakMap<ElevationRaster, Uint8Array>();

export function buildTerrainImage(elevation: ElevationRaster | null | undefined): TerrainImage {
  if (!elevation) return { image: emptyImage(), hasElevation: false };
  let pixels = elevationPixels.get(elevation);
  if (!pixels) {
    pixels = elevationRgba(elevation);
    elevationPixels.set(elevation, pixels);
  }
  const data = Skia.Data.fromBytes(pixels);
  try {
    const image = Skia.Image.MakeImage(
      {
        width: elevation.width,
        height: elevation.height,
        colorType: ColorType.RGBA_8888,
        alphaType: AlphaType.Opaque,
      },
      data,
      elevation.width * 4
    );
    if (!image) {
      console.warn(`[map] DEM image allocation failed (${elevation.width}x${elevation.height})`);
      return { image: null, hasElevation: false };
    }
    return { image, hasElevation: true };
  } finally {
    data.dispose();
  }
}
