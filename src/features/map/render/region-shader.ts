import {
  AlphaType,
  ClipOp,
  ColorType,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  TileMode,
  type SkCanvas,
  type SkImage,
  type SkPaint,
  type SkPath,
} from '@shopify/react-native-skia';

import { buildPaletteLut } from '../core/region';
import { lineDotIntervals } from '../core/dot-style';
import type { RoadLayerOptions } from '../core/road-lod';
import { scaleFor } from '../core/camera';
import {
  AERO_AREA_KINDS,
  AERO_LINE_KINDS,
  TRANSIT_MODES,
  type AeroAreaKind,
  type AeroLineKind,
  type MapPalette,
  type Rgb,
} from '../core/types';
import type { MapRegion } from '../engine/map-engine';
import type { PackedGeometry } from '../tiles/packed-geometry';
import { buildCellStateImage } from './cell-state-image';
import { cellLatticePath, cellRimPath, exploredCellPath } from './cell-overlay-paths';
import { GHOST_LATTICE_WIDTH } from '../core/hex-lattice';
import { getDotFieldEffect, getDotMaterialEffect } from './dot-field-shader';
import { buildMaskImage } from './mask-image';
import { renderPicture } from './offscreen';
import { buildGroundImage, buildTerrainImage } from './terrain-image';
import { buildHatchPath } from './structure-paths';
import {
  aeroAreaPath,
  aeroLinePath,
  assembleRegionPath,
  buildingBins,
  drawTileLayers,
  transitPath,
} from './tile-paths';
import { TRANSIT_ALPHA, TRANSIT_CASING_ALPHA, transitWidthFor } from '../core/transit-lod';
import {
  AERODROME_DASH,
  AERODROME_STROKE_WIDTH,
  AERO_AREA_STYLE,
  AERO_LINE_ALPHA,
  aeroAreaVisible,
  aeroLineWidthFor,
  BUILDING_GHOST_ALPHA,
  BUILDING_HATCH_ALPHA,
  BUILDING_HATCH_WIDTH,
  BUILDING_STROKE_ALPHA,
  buildingGhostInk,
  buildingsFromTileZoom,
  buildingStyleFor,
} from '../core/structure-lod';
import {
  DOT_FIELD_UNIFORM_FLOATS,
  dotAtlasSize,
  dotFieldMode,
  lodForZoom,
  packDotFieldUniforms,
  regionImageLayout,
} from './shader-uniforms';

/** Ghost lattice / frontier rim styling (logical px + alphas from the old shader). */
const LATTICE_ALPHA = 0.09;
const RIM_WIDTH = 1.25;
const RIM_ALPHA = 0.42;

/**
 * Painter's order for the structure layer, back to front. Deliberately not the
 * `AERO_*_KINDS` declaration order — those are the wire encoding, and drawing in
 * them would put the apron fill over the aerodrome dashes and the taxiway mesh
 * over the runways.
 */
const AERO_AREA_DRAW_ORDER: readonly AeroAreaKind[] = ['apron', 'aerodrome'];
const AERO_LINE_DRAW_ORDER: readonly AeroLineKind[] = ['taxiway', 'runway'];

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

/** The textures the dot field samples for a region's features, built on GPU. */
export interface RegionTextures {
  /** R=street G=park B=water. */
  readonly mask: SkImage | null;
  /** R=ground-cover code, G=park interior/edge. */
  readonly ground: SkImage | null;
  /** R/G=absolute elevation, B=alpine weight, at DEM resolution. */
  readonly terrain: SkImage | null;
  readonly hasElevation: boolean;
}

/** The three feature textures, drawn from each tile's cached paths (`tile-paths.ts`). */
export function makeRegionTextures(region: MapRegion, layers?: RoadLayerOptions): RegionTextures {
  const geometry = drawnGeometry(region);
  const terrain = buildTerrainImage(region.elevation);
  return {
    mask: buildMaskImage(geometry, region.spec, layers),
    ground: buildGroundImage(geometry, region.spec),
    terrain: terrain.image,
    hasElevation: terrain.hasElevation,
  };
}

/** What the raster draws: labels-only stages add nothing to it (`MapRegion.rasterGeometry`). */
export function drawnGeometry(region: MapRegion): PackedGeometry {
  return region.rasterGeometry ?? region.geometry;
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
  readonly groundImage: SkImage;
  readonly terrainImage: SkImage;
  /** Whether `terrainImage` carries elevation (else the canopy fallback). */
  readonly hasElevation?: boolean;
  readonly cellImage: SkImage;
  readonly lutImage: SkImage;
  /** Load reveal 0..1 (default 1 = fully shown); < 1 renders a cell-by-cell wipe. */
  readonly reveal?: number;
  /** Show the explored/unexplored fog treatment (default true). */
  readonly explorationEnabled?: boolean;
  /** Draw dotted transit routes over the dot field (default false). */
  readonly transitEnabled?: boolean;
  /** Draw building footprints and aeroway surfaces over the dot field (default false). */
  readonly structuresEnabled?: boolean;
  /**
   * Resolution multiplier (default 1) for the final dot-compositing pass.
   */
  readonly quality?: number;
}

/**
 * Rasterize the whole region rect into one static bitmap: shade a lattice-sized
 * atlas, composite its dots at device resolution, then draw the
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
 * Place the result at `regionImageLayout(spec, quality).rect`; the input
 * feature/cell textures still occupy `spec.rect`.
 */
export function renderRegionImage({
  region,
  palette,
  maskImage,
  groundImage,
  terrainImage,
  hasElevation = false,
  cellImage,
  lutImage,
  reveal = 1,
  explorationEnabled = true,
  transitEnabled = false,
  structuresEnabled = false,
  quality = 1,
}: RegionImageInput): SkImage | null {
  const mode = dotFieldMode(region.spec.zoom, drawnGeometry(region));
  const { filteredAreas } = mode;
  const effect = getDotFieldEffect(mode);
  const materialEffect = getDotMaterialEffect(filteredAreas);
  if (!effect || !materialEffect) {
    console.warn('[map] dot-field shader failed to compile');
    return null;
  }

  const layout = regionImageLayout(region.spec, quality);
  const { width, height, pixelRatio } = layout;

  const uniforms = packDotFieldUniforms({
    region,
    palette,
    pixelRatio,
    reveal,
    explorationEnabled,
    hasElevation,
    filteredAreas,
  });
  if (__DEV__ && uniforms.length !== DOT_FIELD_UNIFORM_FLOATS) {
    console.warn(
      `[map] uniform count ${uniforms.length} != shader's ${DOT_FIELD_UNIFORM_FLOATS} — check order`
    );
  }

  const inputs = [
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
    groundImage.makeShaderOptions(
      TileMode.Clamp,
      TileMode.Clamp,
      FilterMode.Linear,
      MipmapMode.None
    ),
    terrainImage.makeShaderOptions(
      TileMode.Clamp,
      TileMode.Clamp,
      FilterMode.Linear,
      MipmapMode.None
    ),
  ];
  // Pictures and shaders also retain their input images. Release the entire
  // temporary graph after readback, not just the atlas's JS handle.
  const owned: { dispose(): void }[] = [...inputs];
  const own = <T extends { dispose(): void }>(resource: T): T => {
    owned.push(resource);
    return resource;
  };
  try {
    const atlasSize = dotAtlasSize(region.spec, undefined, filteredAreas);
    const materialShader = own(materialEffect.makeShaderWithChildren(uniforms, inputs));
    const materialPaint = own(Skia.Paint());
    materialPaint.setShader(materialShader);
    const atlasPicture = own(Skia.PictureRecorder());
    atlasPicture
      .beginRecording(Skia.XYWHRect(0, 0, atlasSize.width, atlasSize.height))
      .drawPaint(materialPaint);
    const atlas = renderPicture(
      atlasPicture.finishRecordingAsPicture(),
      atlasSize.width,
      atlasSize.height,
      'same-thread'
    );
    if (!atlas) {
      console.warn(`[map] dot atlas raster failed (${atlasSize.width}x${atlasSize.height})`);
      return null;
    }
    own(atlas);
    const shader = own(
      effect.makeShaderWithChildren(uniforms, [
        ...inputs.slice(0, 3),
        own(
          atlas.makeShaderOptions(
            TileMode.Clamp,
            TileMode.Clamp,
            FilterMode.Nearest,
            MipmapMode.None
          )
        ),
      ])
    );

    const paint = own(Skia.Paint());
    paint.setShader(shader);
    const picture = own(Skia.PictureRecorder());
    const canvas = picture.beginRecording(Skia.XYWHRect(0, 0, width, height));
    canvas.translate(layout.offsetX, layout.offsetY);
    canvas.drawPaint(paint);
    // Structures sit directly on the dot field, under the exploration line work:
    // the ghost lattice and the amber frontier rim are navigation, and must stay
    // legible over a building footprint.
    if (structuresEnabled) {
      drawStructures(canvas, region, palette, pixelRatio, reveal, explorationEnabled);
    }
    if (explorationEnabled) {
      drawCellOverlays(canvas, region, palette, pixelRatio, reveal);
    }
    if (transitEnabled) {
      drawTransitLines(canvas, region, palette, pixelRatio, reveal);
    }
    const recorded = picture.finishRecordingAsPicture();

    const image = renderPicture(recorded, width, height, 'ui');
    if (!image) console.warn(`[map] region raster failed (${width}×${height})`);
    return image;
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) owned[i].dispose();
  }
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
      canvas.drawPath(lattice, strokePaint(palette.streetLabel, GHOST_LATTICE_WIDTH, latticeAlpha));
  }
  if (rimAlpha > 0) {
    const rim = Skia.Path.MakeFromSVGString(cellRimPath(region.cellField, region.spec));
    if (rim) canvas.drawPath(rim, strokePaint(palette.accent, RIM_WIDTH, rimAlpha));
  }
  canvas.restore();
}

/**
 * Building footprints and aeroway surfaces over the dot field, in region-logical
 * coords. Footprints keep their crisp outlines; runway dots follow their paths
 * instead of snapping to the terrain lattice.
 *
 * Drawn back to front — apron fill, aerodrome boundary, taxiways, runways, then
 * buildings (see {@link AERO_AREA_DRAW_ORDER}) — so the ground reads first and
 * the terminal sits on top of the apron it stands on. Fills use NON-ZERO winding for the reason `mask-image.ts`
 * documents: neighbouring MVT tiles share a clip buffer, so area features
 * genuinely overlap and even-odd would XOR the overlap into a hole.
 *
 * The ink is `palette.building` — its own scheme entry, because this layer has
 * to read as built *material* rather than as a label drawn over the field. Older
 * saved custom schemes that predate the field fall back to `streetLabel`.
 */
function drawStructures(
  canvas: SkCanvas,
  region: MapRegion,
  palette: MapPalette,
  pixelRatio: number,
  reveal: number,
  explorationEnabled: boolean
): void {
  if (reveal <= 0) return;
  const ink: Rgb = palette.building;
  const { zoom, rect } = region.spec;
  const origin = [rect.minX, rect.minY] as const;
  const scale = scaleFor(zoom);
  const tiles = drawnGeometry(region).parts;

  canvas.save();
  canvas.scale(pixelRatio, pixelRatio);

  // Explicit back-to-front order, not the enum's: the paved ground goes down
  // first so the property boundary's dashes stay on top of it.
  for (const kind of AERO_AREA_DRAW_ORDER) {
    if (!aeroAreaVisible(kind, zoom)) continue;
    const kindIndex = AERO_AREA_KINDS.indexOf(kind);
    const style = AERO_AREA_STYLE[kind];
    const fill = style.fillAlpha > 0 ? fillPaint(ink, style.fillAlpha * reveal) : null;
    const stroke =
      style.strokeAlpha > 0
        ? strokePaint(ink, AERODROME_STROKE_WIDTH, style.strokeAlpha * reveal)
        : null;
    drawTileLayers(canvas, tiles, origin, scale, (tile, k) => {
      const path = aeroAreaPath(tile, kindIndex);
      if (!path) return;
      if (fill) canvas.drawPath(path, fill);
      if (!stroke) return;
      stroke.setStrokeWidth(AERODROME_STROKE_WIDTH / k);
      // The aerodrome boundary is a limit, not a wall — dash it so it never
      // reads as another building edge.
      if (kind === 'aerodrome') {
        const dash = Skia.PathEffect.MakeDash([AERODROME_DASH[0] / k, AERODROME_DASH[1] / k]);
        if (dash) stroke.setPathEffect(dash);
      }
      canvas.drawPath(path, stroke);
    });
  }

  // Taxiways under runways: a runway is the landmark and must never be crossed
  // out by the taxiway network that feeds it.
  for (const kind of AERO_LINE_DRAW_ORDER) {
    const width = aeroLineWidthFor(kind, zoom);
    if (width === null) continue;
    const kindIndex = AERO_LINE_KINDS.indexOf(kind);
    // Both kinds are plain solid strokes. A runway drawn as a chain of 4px
    // round dots was the loudest mark on any region that contained an airport —
    // louder than the motorways beside it — for a surface that is, to someone
    // walking around a city, just a very long stretch of tarmac. It reads as
    // road now, because that is what it is.
    const paint = strokePaint(ink, width, AERO_LINE_ALPHA[kind] * reveal);
    paint.setStrokeCap(StrokeCap.Round);
    drawTileLayers(canvas, tiles, origin, scale, (tile, k) => {
      const path = aeroLinePath(tile, kindIndex);
      if (!path) return;
      paint.setStrokeWidth(width / k);
      canvas.drawPath(path, paint);
    });
  }

  const buildingStyle = buildingsFromTileZoom(region.spec.tileZoom) ? buildingStyleFor(zoom) : null;
  if (buildingStyle) {
    // One region path (clips need one): every footprint big enough at this zoom.
    const path = assembleRegionPath(tiles, origin, scale, (tile) =>
      buildingBins(tile)
        .filter((bin) => bin.minZoom <= zoom)
        .map((bin) => bin.path)
    );
    if (path) {
      const explored = explorationEnabled
        ? Skia.Path.MakeFromSVGString(exploredCellPath(region.cellField, region.spec))
        : null;
      if (explorationEnabled) {
        canvas.save();
        if (explored) canvas.clipPath(explored, ClipOp.Difference, true);
        const ghost = buildingGhostInk(ink, palette.bg);
        canvas.drawPath(
          path,
          fillPaint(ghost, buildingStyle.fillAlpha * BUILDING_GHOST_ALPHA * reveal)
        );
        if (buildingStyle.strokeWidth !== null) {
          canvas.drawPath(
            path,
            strokePaint(
              ghost,
              buildingStyle.strokeWidth,
              BUILDING_STROKE_ALPHA * BUILDING_GHOST_ALPHA * reveal
            )
          );
        }
        canvas.restore();
      }
      if (!explorationEnabled || explored) {
        canvas.save();
        if (explored) canvas.clipPath(explored, ClipOp.Intersect, true);
        canvas.drawPath(path, fillPaint(ink, buildingStyle.fillAlpha * reveal));
        if (buildingStyle.hatch) drawBuildingHatch(canvas, path, region, ink, reveal);
        if (buildingStyle.strokeWidth !== null) {
          canvas.drawPath(
            path,
            strokePaint(ink, buildingStyle.strokeWidth, BUILDING_STROKE_ALPHA * reveal)
          );
        }
        canvas.restore();
      }
      explored?.dispose();
    }
  }

  canvas.restore();
}

/**
 * The diagonal hatch that gives footprints a material of their own, clipped to
 * the batched building path.
 *
 * One region-wide hatch path clipped once, rather than per-footprint hatching:
 * a city region holds thousands of buildings, and they all want the same lines.
 * Drawn between the fill and the outline so the outline stays the crispest edge.
 */
function drawBuildingHatch(
  canvas: SkCanvas,
  clip: SkPath,
  region: MapRegion,
  ink: Rgb,
  reveal: number
): void {
  const hatch = Skia.Path.MakeFromSVGString(buildHatchPath(region.spec));
  if (!hatch) return;

  canvas.save();
  canvas.clipPath(clip, ClipOp.Intersect, true);
  canvas.drawPath(hatch, strokePaint(ink, BUILDING_HATCH_WIDTH, BUILDING_HATCH_ALPHA * reveal));
  canvas.restore();
}

function fillPaint(rgb: Rgb, alpha: number): SkPaint {
  const paint = Skia.Paint();
  paint.setColor(Skia.Color(`rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`));
  paint.setStyle(PaintStyle.Fill);
  paint.setAntiAlias(true);
  return paint;
}

/**
 * Transit lines over the dot field, in region-logical coords (the canvas scale
 * maps them to device px). Each mode draws twice from ONE batched path: a
 * continuous casing, then round dots over it. Still no per-dot geometry and no
 * per-frame work. Fades with `reveal` alongside the cell overlays.
 */
function drawTransitLines(
  canvas: SkCanvas,
  region: MapRegion,
  palette: MapPalette,
  pixelRatio: number,
  reveal: number
): void {
  if (reveal <= 0) return;
  const { zoom, rect } = region.spec;
  const origin = [rect.minX, rect.minY] as const;
  const scale = scaleFor(zoom);

  canvas.save();
  canvas.scale(pixelRatio, pixelRatio);
  TRANSIT_MODES.forEach((mode, modeIndex) => {
    const width = transitWidthFor(mode, zoom);
    if (width === null) return;
    const alpha = TRANSIT_ALPHA[mode] * reveal;
    // The casing goes down whether or not the dots can: a solid route is a
    // worse transit line than a dotted one, but an ABSENT one is worse still.
    const casing = strokePaint(palette.transit, width, alpha * TRANSIT_CASING_ALPHA);
    casing.setStrokeCap(StrokeCap.Round);
    const paint = strokePaint(palette.transit, width, alpha);
    paint.setStrokeCap(StrokeCap.Round);
    drawTileLayers(canvas, drawnGeometry(region).parts, origin, scale, (tile, k) => {
      const path = transitPath(tile, modeIndex);
      if (!path) return;
      casing.setStrokeWidth(width / k);
      canvas.drawPath(path, casing);
      const dots = Skia.PathEffect.MakeDash(lineDotIntervals(width).map((v) => v / k));
      if (!dots) return;
      paint.setStrokeWidth(width / k);
      paint.setPathEffect(dots);
      canvas.drawPath(path, paint);
    });
  });
  canvas.restore();
}

function strokePaint(
  rgb: readonly [number, number, number],
  width: number,
  alpha: number
): SkPaint {
  const paint = Skia.Paint();
  paint.setColor(Skia.Color(`rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`));
  paint.setStyle(PaintStyle.Stroke);
  paint.setStrokeWidth(width);
  paint.setStrokeJoin(StrokeJoin.Round);
  paint.setAntiAlias(true);
  return paint;
}
