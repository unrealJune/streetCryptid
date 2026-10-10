import {
  AlphaType,
  BlendMode,
  BlurStyle,
  ColorType,
  drawAsImageFromPicture,
  FillType,
  PaintStyle,
  Skia,
  type SkImage,
} from '@shopify/react-native-skia';

import { scaleFor } from '../core/camera';
import type { RegionSpec } from '../core/region';
import {
  encodeElevationBands,
  groundCode,
  PARK_EDGE_PX,
  type ElevationRaster,
} from '../core/terrain';
import type { MaskPaths } from './mask-paths';

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
 * `terrainTex` holds the park edge (R) and elevation bands (G). The edge is the
 * park fill blurred by {@link PARK_EDGE_PX}; the blur reaches past the canvas
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

export function buildGroundImage(paths: MaskPaths, spec: RegionSpec): SkImage | null {
  if (paths.ground.every((svg) => !svg)) return emptyImage();
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  canvas.drawColor(Skia.Color('black'));
  paths.ground.forEach((svg, kindIndex) => {
    if (!svg) return;
    const path = Skia.Path.MakeFromSVGString(svg);
    if (!path) return;
    path.setFillType(FillType.Winding);
    const paint = Skia.Paint();
    const code = groundCode(kindIndex);
    paint.setColor(Skia.Color(`rgb(${code},0,0)`));
    paint.setStyle(PaintStyle.Fill);
    paint.setBlendMode(BlendMode.Src);
    paint.setAntiAlias(false);
    canvas.drawPath(path, paint);
  });
  return drawAsImageFromPicture(recorder.finishRecordingAsPicture(), {
    width: spec.maskWidth,
    height: spec.maskHeight,
  });
}

export interface TerrainImage {
  readonly image: SkImage | null;
  /** True when G carries elevation bands (the shader's `uHasElev`). */
  readonly hasElevation: boolean;
}

export function buildTerrainImage(
  paths: MaskPaths,
  spec: RegionSpec,
  elevation: ElevationRaster | null | undefined
): TerrainImage {
  const encoded =
    elevation && elevation.width === spec.maskWidth && elevation.height === spec.maskHeight
      ? encodeElevationBands(elevation)
      : null;
  if (!paths.park && !encoded) return { image: emptyImage(), hasElevation: false };

  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  canvas.drawColor(Skia.Color('black'));

  if (encoded) {
    // G = band value; R stays 0 for the park edge to raise.
    const rgba = new Uint8Array(spec.maskWidth * spec.maskHeight * 4);
    for (let i = 0; i < encoded.bytes.length; i++) {
      rgba[i * 4 + 1] = encoded.bytes[i];
      rgba[i * 4 + 3] = 255;
    }
    const data = Skia.Data.fromBytes(rgba);
    const bands = Skia.Image.MakeImage(
      {
        width: spec.maskWidth,
        height: spec.maskHeight,
        colorType: ColorType.RGBA_8888,
        alphaType: AlphaType.Opaque,
      },
      data,
      spec.maskWidth * 4
    );
    data.dispose();
    if (bands) canvas.drawImage(bands, 0, 0);
  }

  const park = paths.park ? Skia.Path.MakeFromSVGString(paths.park) : null;
  if (park) {
    park.setFillType(FillType.Winding);
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
    image: drawAsImageFromPicture(recorder.finishRecordingAsPicture(), {
      width: spec.maskWidth,
      height: spec.maskHeight,
    }),
    hasElevation: encoded !== null,
  };
}
