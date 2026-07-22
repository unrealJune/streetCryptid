import { drawAsImageFromPicture, PaintStyle, Skia, type SkImage } from '@shopify/react-native-skia';

import type { RegionCellField } from '../core/cell-field';
import type { RegionSpec } from '../core/region';
import { cellStateFillGeometry } from './cell-overlay-paths';

/**
 * Bake the region's cell field into the cell state texture the dot-field
 * shader samples: R = explored fraction, G = per-cell jitter, B = reveal
 * order, A = opaque. Rendered at exactly maskWidth×maskHeight so the shader
 * reuses `toMaskPx` for sampling (nearest).
 *
 * Anti-aliasing is off: every texel must carry one cell's exact channel
 * values — blended edge texels would smear reveal order and jitter across
 * cell borders.
 */
export function buildCellStateImage(field: RegionCellField, spec: RegionSpec): SkImage | null {
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, spec.maskWidth, spec.maskHeight));
  // Opaque black base: fraction 0, jitter 0, order 0 for any sliver a cell
  // fill misses (cell enumeration covers the rect, so this is boundary dust).
  canvas.drawColor(Skia.Color('black'));

  // Reuse one paint + one path across all cells: at thousands of cells the
  // per-cell Paint allocation and SVG parse were the dominant texture cost.
  const paint = Skia.Paint();
  paint.setStyle(PaintStyle.Fill);
  paint.setAntiAlias(false);
  const path = Skia.Path.Make();
  for (const fill of cellStateFillGeometry(field, spec)) {
    const pts = fill.points;
    path.reset();
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.close();
    paint.setColor(Skia.Color(fill.color));
    canvas.drawPath(path, paint);
  }

  return drawAsImageFromPicture(recorder.finishRecordingAsPicture(), {
    width: spec.maskWidth,
    height: spec.maskHeight,
  });
}
