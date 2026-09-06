import {
  BlendMode,
  drawAsImageFromPicture,
  FillType,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkCanvas,
  type SkImage,
  type SkPaint,
} from '@shopify/react-native-skia';

import { ROAD_VALUES } from '../core/masks';
import { type RegionSpec } from '../core/region';
import { roadWidthFor, type RoadLayerOptions } from '../core/road-lod';
import { riverWidthFor } from '../core/water-lod';
import { rgbToHex } from '../core/color';
import { FERRY_DASH, transitColorFor, transitWidthFor } from '../core/transit-lod';
import { TRANSIT_MODES, type MapPalette } from '../core/types';
import type { PackedGeometry } from '../tiles/packed-geometry';
import { buildMaskPaths } from './mask-paths';
import { buildTransitPaths } from './transit-paths';

/**
 * Build the region's feature mask on the GPU instead of the CPU.
 *
 * The old software rasterizer stroked ~18k streets per region in a JS typed-array
 * loop (~250ms on device — the dominant load cost). Here the geometry is batched
 * into a handful of SVG paths (`mask-paths.ts`) and stroked/filled on the GPU in
 * one picture, then turned into an image with `drawAsImageFromPicture` (the same
 * proven offscreen path the dot-field bitmap uses). Channels match the software
 * mask exactly: R = street brightness (per road class), G = parks, B = water +
 * rivers. `BlendMode.Lighten` is max() per channel over opaque colors, which
 * reproduces the software mask's max-blend for overlapping features. The result
 * is sampled by the dot-field shader as `maskTex` — no shader change.
 *
 * Area fills use NON-ZERO winding, not even-odd. Every park/water ring in the
 * region is one batched path, and area features genuinely overlap: neighbouring
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
  const paths = buildMaskPaths(geometry, spec, layers);

  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  // Opaque black base: R=G=B=0 (no feature). Lighten only ever raises channels.
  canvas.drawColor(Skia.Color('black'));

  for (let cls = 0; cls < paths.streets.length; cls++) {
    const svg = paths.streets[cls];
    if (!svg) continue;
    // Zoom-aware LOD: taper widths and omit the smallest classes when zoomed out.
    const width = roadWidthFor(cls, spec.zoom);
    if (width === null) continue;
    const path = Skia.Path.MakeFromSVGString(svg);
    if (path) canvas.drawPath(path, strokePaint(`rgb(${ROAD_VALUES[cls]},0,0)`, width));
  }

  drawFill(canvas, paths.park, 'rgb(0,255,0)');
  drawFill(canvas, paths.water, 'rgb(0,0,255)');
  // Zoom-aware LOD, same as the streets above — see `core/water-lod.ts`.
  const riverWidth = riverWidthFor(spec.zoom);
  if (paths.rivers && riverWidth !== null) {
    const rivers = Skia.Path.MakeFromSVGString(paths.rivers);
    if (rivers) canvas.drawPath(rivers, strokePaint('rgb(0,0,255)', riverWidth));
  }

  return drawAsImageFromPicture(recorder.finishRecordingAsPicture(), {
    width: spec.maskWidth,
    height: spec.maskHeight,
  });
}

/** RGB = mode ink, alpha = coverage; kept separate from the street/park/water mask. */
export function buildTransitMaskImage(
  geometry: PackedGeometry,
  spec: RegionSpec,
  palette: MapPalette
): SkImage | null {
  const paths = buildTransitPaths(geometry, spec);
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  canvas.drawColor(Skia.Color('transparent'));
  for (const mode of TRANSIT_MODES) {
    const svg = paths[mode];
    const width = transitWidthFor(mode, spec.zoom);
    if (!svg || width === null) continue;
    const path = Skia.Path.MakeFromSVGString(svg);
    if (!path) continue;
    const paint = strokePaint(rgbToHex(transitColorFor(mode, palette)), width);
    // Source-over keeps a crossing's mode color intact instead of max-blending inks.
    paint.setBlendMode(BlendMode.SrcOver);
    if (mode === 'ferry') {
      const dash = Skia.PathEffect.MakeDash([...FERRY_DASH]);
      if (dash) paint.setPathEffect(dash);
    }
    canvas.drawPath(path, paint);
  }
  return drawAsImageFromPicture(recorder.finishRecordingAsPicture(), {
    width: spec.maskWidth,
    height: spec.maskHeight,
  });
}

function drawFill(canvas: SkCanvas, svg: string, color: string): void {
  if (!svg) return;
  const path = Skia.Path.MakeFromSVGString(svg);
  if (!path) return;
  path.setFillType(FillType.Winding);
  canvas.drawPath(path, fillPaint(color));
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
