import {
  BlendMode,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkImage,
  type SkPaint,
} from '@shopify/react-native-skia';

import { ROAD_VALUES } from '../core/masks';
import { type RegionSpec } from '../core/region';
import { roadClassVisible, roadWidthFor, type RoadLayerOptions } from '../core/road-lod';
import { riverWidthFor } from '../core/water-lod';
import type { PackedGeometry } from '../tiles/packed-geometry';
import { renderPicture } from './offscreen';
import { drawTileLayers, parkPath, riverPath, streetPath, waterPath } from './tile-paths';

/**
 * Build the region's feature mask on the GPU instead of the CPU.
 *
 * The old software rasterizer stroked ~18k streets per region in a JS typed-array
 * loop (~250ms on device — the dominant load cost). Here each tile's cached
 * Skia paths (`tile-paths.ts`, built once per tile) are stroked/filled on the
 * GPU under the tile's transform, in one picture that stays a GPU texture
 * (`offscreen.ts`) for the dot field to sample. Channels match the software
 * mask exactly: R = street brightness (per road class), G = parks, B = water +
 * rivers. `BlendMode.Lighten` is max() per channel over opaque colors, which
 * reproduces the software mask's max-blend for overlapping features. The result
 * is sampled by the dot-field shader as `maskTex` — no shader change.
 *
 * Area fills use NON-ZERO winding, not even-odd. Area features genuinely overlap: neighbouring
 * MVT tiles share a clip buffer (64/4096 of a tile), and a city park routinely
 * arrives as a `park` polygon plus a `landcover` one covering the same ground.
 * Even-odd XORs those overlaps away — that is what put straight blank seams on
 * every tile boundary in the water and punched holes through parks. MVT requires
 * exterior rings clockwise and holes counter-clockwise, so non-zero unions the
 * overlaps while still cutting the holes.
 */
export function buildMaskImage(
  geometry: PackedGeometry,
  spec: RegionSpec,
  layers?: RoadLayerOptions
): SkImage | null {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  // Opaque black base: R=G=B=0 (no feature). Lighten only ever raises channels.
  canvas.drawColor(Skia.Color('black'));

  // Zoom-aware LOD: taper widths and omit the smallest classes when zoomed out;
  // the highways toggle drops motorways the same way.
  const widths = [0, 1, 2, 3, 4].map((cls) =>
    roadClassVisible(cls, layers) ? roadWidthFor(cls, spec.zoom) : null
  );
  const streetPaints = widths.map((width, cls) =>
    width === null ? null : strokePaint(`rgb(${ROAD_VALUES[cls]},0,0)`, width)
  );
  const parkPaint = fillPaint('rgb(0,255,0)');
  const waterPaint = fillPaint('rgb(0,0,255)');
  // Zoom-aware LOD, same as the streets above — see `core/water-lod.ts`.
  const riverWidth = riverWidthFor(spec.zoom);
  const riverPaint = riverWidth === null ? null : strokePaint('rgb(0,0,255)', riverWidth);

  const { origin, scale } = maskProjection(spec);
  drawTileLayers(canvas, geometry.parts, origin, scale, (tile, k) => {
    for (let cls = 0; cls < streetPaints.length; cls++) {
      const paint = streetPaints[cls];
      const path = paint && streetPath(tile, cls);
      if (path) canvas.drawPath(path, withWidth(paint, widths[cls]! / k));
    }
    const park = parkPath(tile);
    if (park) canvas.drawPath(park, parkPaint);
    const water = waterPath(tile);
    if (water) canvas.drawPath(water, waterPaint);
    const rivers = riverPaint && riverPath(tile);
    if (rivers) canvas.drawPath(rivers, withWidth(riverPaint, riverWidth! / k));
  });

  // Sampled only by the dot field's offscreen render: it never leaves the GPU.
  return renderPicture(
    recorder.finishRecordingAsPicture(),
    spec.maskWidth,
    spec.maskHeight,
    'same-thread'
  );
}

/**
 * Mask pixels per world unit, and the world point at mask (0, 0) — the affine
 * form of `regionMaskCamera`, for drawing tile paths under a transform.
 */
export function maskProjection(spec: RegionSpec): {
  origin: readonly [number, number];
  scale: number;
} {
  const scale = spec.maskWidth / (spec.rect.maxX - spec.rect.minX);
  const cy = (spec.rect.minY + spec.rect.maxY) / 2;
  return { origin: [spec.rect.minX, cy - spec.maskHeight / 2 / scale], scale };
}

/** A paint's stroke width, set for the tile transform in force (paints are reused per tile). */
function withWidth(paint: SkPaint, width: number): SkPaint {
  paint.setStrokeWidth(width);
  return paint;
}

function strokePaint(color: string, width: number): SkPaint {
  const paint = Skia.Paint();
  paint.setColor(Skia.Color(color));
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(width);
  paint.setStrokeCap(StrokeCap.Round);
  paint.setStrokeJoin(StrokeJoin.Round);
  paint.setBlendMode(BlendMode.Lighten); // max() per channel — matches software mask
  paint.setAntiAlias(true);
  return paint;
}

function fillPaint(color: string): SkPaint {
  const paint = Skia.Paint();
  paint.setColor(Skia.Color(color));
  paint.setStyle(PaintStyle.Fill);
  paint.setBlendMode(BlendMode.Lighten);
  paint.setAntiAlias(true);
  return paint;
}
