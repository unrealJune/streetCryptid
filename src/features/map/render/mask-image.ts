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

import { RIVER_WIDTH, ROAD_VALUES } from '../core/masks';
import { type RegionSpec } from '../core/region';
import { roadWidthFor } from '../core/road-lod';
import type { MapGeometry } from '../core/types';
import { buildMaskPaths } from './mask-paths';

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
 */
export function buildMaskImage(geometry: MapGeometry, spec: RegionSpec): SkImage | null {
  const paths = buildMaskPaths(geometry, spec);

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
  if (paths.rivers) {
    const rivers = Skia.Path.MakeFromSVGString(paths.rivers);
    if (rivers) canvas.drawPath(rivers, strokePaint('rgb(0,0,255)', RIVER_WIDTH));
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
  path.setFillType(FillType.EvenOdd);
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
