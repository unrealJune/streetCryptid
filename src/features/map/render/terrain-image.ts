import {
  AlphaType,
  BlendMode,
  BlurStyle,
  ColorType,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Skia,
  type SkImage,
} from '@shopify/react-native-skia';

import { scaleFor } from '../core/camera';
import type { RegionSpec } from '../core/region';
import {
  elevationBandsRgba,
  groundCode,
  PARK_EDGE_PX,
  rasterMaskRect,
  type ElevationRaster,
} from '../core/terrain';
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
 * `terrainTex` holds the park edge (R), elevation bands (G) and the alpine
 * weight (B). The edge is the park fill blurred by {@link PARK_EDGE_PX}; the
 * blur reaches past the canvas
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
  if (geometry.parts.every((tile) => tile.groundCover.count === 0)) return emptyImage();
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  canvas.drawColor(Skia.Color('black'));
  const { origin, scale } = maskProjection(spec);
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
  return renderPicture(
    recorder.finishRecordingAsPicture(),
    spec.maskWidth,
    spec.maskHeight,
    'same-thread'
  );
}

export interface TerrainImage {
  readonly image: SkImage | null;
  /** True when G carries elevation bands (the shader's `uHasElev`). */
  readonly hasElevation: boolean;
}

export function buildTerrainImage(
  geometry: PackedGeometry,
  spec: RegionSpec,
  elevation: ElevationRaster | null | undefined
): TerrainImage {
  // G = band value, B = alpine weight; R stays 0 for the park edge to raise.
  const rgba = elevation ? elevationBandsRgba(elevation) : null;
  const { origin, scale } = maskProjection(spec);
  // One path for the whole region, never one per tile: blurring each tile's piece
  // separately would draw a false park edge along every tile seam.
  const park = assembleRegionPath(geometry.parts, origin, scale, (tile) => [parkPath(tile)]);
  if (!park && !rgba) return { image: emptyImage(), hasElevation: false };

  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  canvas.drawColor(Skia.Color('black'));

  if (elevation && rgba) {
    const data = Skia.Data.fromBytes(rgba);
    const bands = Skia.Image.MakeImage(
      {
        width: elevation.width,
        height: elevation.height,
        colorType: ColorType.RGBA_8888,
        alphaType: AlphaType.Opaque,
      },
      data,
      elevation.width * 4
    );
    data.dispose();
    if (bands) {
      // The raster is at DEM resolution: the GPU's bilinear filter is the resample.
      const dst = rasterMaskRect(elevation, spec);
      canvas.drawImageRectOptions(
        bands,
        Skia.XYWHRect(0, 0, elevation.width, elevation.height),
        Skia.XYWHRect(dst.x, dst.y, dst.width, dst.height),
        FilterMode.Linear,
        MipmapMode.None
      );
    }
  }

  if (park) {
    const logicalPerMask =
      ((spec.rect.maxX - spec.rect.minX) * scaleFor(spec.zoom)) / spec.maskWidth;
    const sigma = PARK_EDGE_PX / logicalPerMask;
    const paint = Skia.Paint();
    paint.setColor(Skia.Color('rgb(255,0,0)'));
    paint.setStyle(PaintStyle.Fill);
    paint.setAntiAlias(true);
    // Lighten is max() per channel, so the edge raises R without touching G.
    paint.setBlendMode(BlendMode.Lighten);
    paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, sigma, false));
    canvas.drawPath(park, paint);
  }

  return {
    image: renderPicture(
      recorder.finishRecordingAsPicture(),
      spec.maskWidth,
      spec.maskHeight,
      'same-thread'
    ),
    hasElevation: rgba !== null,
  };
}
