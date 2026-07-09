import { scaleFor, TILE_SIZE, visibleWorldRect } from './camera';
import type { ExplorationState } from './exploration';
import type { HexGrid } from './hex';
import { hexKeyOf, parseHexKey } from './hex';
import { clamp, ramp } from './color';
import type {
  CameraState,
  FeatureMasks,
  MapPalette,
  Viewport,
  WorldPoint,
  WorldRect,
} from './types';
import { dataZoomFor } from '../tiles/tile-math';

/**
 * A world-space data region: the patch of world the GPU dot-field shader can
 * render without any CPU help. Rebuilt only when the camera nears its edge or
 * leaves its zoom band — pans and pinches inside it are pure uniform updates.
 */
export interface RegionSpec {
  readonly rect: WorldRect;
  /** Feature-mask texture size, px. */
  readonly maskWidth: number;
  readonly maskHeight: number;
  /** Camera zoom the mask resolution was anchored to. */
  readonly zoom: number;
  /** (Overzoomed) tile zoom the geometry was fetched at — see `dataZoomFor`. */
  readonly tileZoom: number;
}

export interface RegionOptions {
  /**
   * Extra view fractions on each side (1.0 → region is 3× the viewport).
   * This is the map's pan headroom: a region must hold out for at least one
   * build latency of fast panning from rest (~1300 px/s × 300 ms ≈ one
   * viewport), or a hard drag outruns the loader into blank. Defaults to
   * {@link padFor}(zoom) — full headroom at street/hood zoom, tapered when
   * zoomed out to keep the tile count sane.
   */
  readonly pad?: number;
  /** Mask pixels per logical viewport pixel (lower = coarser/faster). */
  readonly maskScale?: number;
  readonly maxDim?: number;
}

/**
 * Region pan-headroom padding (view fractions per side), tapered by zoom. Full
 * 1.0 (region = 3× the view) at street/hood zoom, shrinking to 0.2 by city zoom:
 * a zoomed-out region spans far more world, so at full padding it would need
 * hundreds of tiles — the taper keeps each region within a sane tile budget.
 */
export function padFor(zoom: number): number {
  return clamp(1.0 - (13 - zoom) * 0.4, 0.2, 1.0);
}

export function computeRegionSpec(
  camera: CameraState,
  viewport: Viewport,
  { pad, maskScale = 0.4, maxDim = 2400 }: RegionOptions = {}
): RegionSpec {
  const padValue = pad ?? padFor(camera.zoom);
  const view = visibleWorldRect(camera, viewport);
  const w = view.maxX - view.minX;
  const h = view.maxY - view.minY;
  const rect: WorldRect = {
    minX: view.minX - w * padValue,
    minY: view.minY - h * padValue,
    maxX: view.maxX + w * padValue,
    maxY: view.maxY + h * padValue,
  };
  const factor = (1 + 2 * padValue) * maskScale;
  const shrink = Math.min(
    1,
    maxDim / (viewport.width * factor),
    maxDim / (viewport.height * factor)
  );
  return {
    rect,
    maskWidth: Math.max(1, Math.round(viewport.width * factor * shrink)),
    maskHeight: Math.max(1, Math.round(viewport.height * factor * shrink)),
    zoom: camera.zoom,
    tileZoom: dataZoomFor(camera.zoom),
  };
}

/**
 * The synthetic camera under which `buildFeatureMasks` rasterizes exactly
 * `spec.rect` onto a maskWidth×maskHeight raster.
 */
export function regionMaskCamera(spec: RegionSpec): {
  camera: CameraState;
  viewport: Viewport;
} {
  const w = spec.rect.maxX - spec.rect.minX;
  return {
    camera: {
      center: [
        (spec.rect.minX + spec.rect.maxX) / 2,
        (spec.rect.minY + spec.rect.maxY) / 2,
      ] as WorldPoint,
      zoom: Math.log2(spec.maskWidth / (w * TILE_SIZE)),
    },
    viewport: { width: spec.maskWidth, height: spec.maskHeight },
  };
}

/**
 * True when `camera`'s view is no longer comfortably served by `spec`: the
 * visible rect pokes outside the region, the mask resolution is a zoom band
 * off, or the tile data band changed.
 */
export function needsNewRegion(spec: RegionSpec, camera: CameraState, viewport: Viewport): boolean {
  if (Math.abs(camera.zoom - spec.zoom) >= 0.75) return true;
  if (dataZoomFor(camera.zoom) !== spec.tileZoom) return true;
  const view = visibleWorldRect(camera, viewport);
  return (
    view.minX < spec.rect.minX ||
    view.minY < spec.rect.minY ||
    view.maxX > spec.rect.maxX ||
    view.maxY > spec.rect.maxY
  );
}

/**
 * True when `camera`'s visible rect still lies fully inside `spec.rect`, so the
 * region bitmap can be displayed for it without blank edges (independent of zoom
 * band — a zoom change only scales the bitmap, it doesn't uncover blank).
 */
export function coversView(spec: RegionSpec, camera: CameraState, viewport: Viewport): boolean {
  const view = visibleWorldRect(camera, viewport);
  return (
    view.minX >= spec.rect.minX &&
    view.minY >= spec.rect.minY &&
    view.maxX <= spec.rect.maxX &&
    view.maxY <= spec.rect.maxY
  );
}

/** Recenter earlier than this fraction of view headroom remaining to an edge. */
export const PREFETCH_MARGIN = 0.35;

/**
 * Zoom delta at which to start prefetching, ahead of the 0.75 rebuild band. This
 * matters most zooming OUT: the view grows, so a region can stop covering before
 * the band is reached — leading the rebuild keeps the next region ready in time.
 */
export const PREFETCH_ZOOM_DELTA = 0.45;

/**
 * True when the region should be rebuilt ahead of actually needing it: it is
 * already stale (`needsNewRegion`), the zoom has drifted far enough that the
 * next band is coming, or the view has consumed most of its pan headroom and
 * sits within `PREFETCH_MARGIN` (of a view size) of an edge. Rebuilding here —
 * while the current padding still covers — is what keeps a boundary crossing
 * from ever revealing blank tiles.
 */
export function shouldPrefetchRegion(
  spec: RegionSpec,
  camera: CameraState,
  viewport: Viewport
): boolean {
  if (needsNewRegion(spec, camera, viewport)) return true;
  if (Math.abs(camera.zoom - spec.zoom) >= PREFETCH_ZOOM_DELTA) return true;
  const view = visibleWorldRect(camera, viewport);
  const vw = view.maxX - view.minX;
  const vh = view.maxY - view.minY;
  const margin = Math.min(
    (view.minX - spec.rect.minX) / vw,
    (spec.rect.maxX - view.maxX) / vw,
    (view.minY - spec.rect.minY) / vh,
    (spec.rect.maxY - view.maxY) / vh
  );
  return margin < PREFETCH_MARGIN;
}

/** Pack the three coverage masks into one RGBA texture: R=street G=park B=water. */
export function packMaskTexture(masks: FeatureMasks): Uint8Array {
  const { width, height } = masks.streets;
  const out = new Uint8Array(width * height * 4);
  const s = masks.streets.data;
  const p = masks.parks.data;
  const w = masks.water.data;
  for (let i = 0, o = 0; i < s.length; i++, o += 4) {
    out[o] = s[i];
    out[o + 1] = p[i];
    out[o + 2] = w[i];
    out[o + 3] = 0xff;
  }
  return out;
}

/**
 * Exploration data as a texture over axial hex space: one texel per hex cell,
 * R=discovered, G=frontier (discovered with an undiscovered neighbor). Axial
 * coordinates are a plain 2D lattice, so a (q−q0, r−r0) index is exact.
 */
export interface HexTable {
  readonly q0: number;
  readonly r0: number;
  readonly cols: number;
  readonly rows: number;
  /** RGBA, rows-major over (r − r0)·cols + (q − q0). */
  readonly data: Uint8Array;
}

export function buildHexTable(
  grid: HexGrid,
  rect: WorldRect,
  exploration: ExplorationState
): HexTable {
  const keys = grid.cellsIn(rect);
  let q0 = Infinity;
  let q1 = -Infinity;
  let r0 = Infinity;
  let r1 = -Infinity;
  for (const key of keys) {
    const [q, r] = parseHexKey(key);
    if (q < q0) q0 = q;
    if (q > q1) q1 = q;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
  }
  if (!keys.length) return { q0: 0, r0: 0, cols: 1, rows: 1, data: new Uint8Array(4) };

  const cols = q1 - q0 + 1;
  const rows = r1 - r0 + 1;
  const data = new Uint8Array(cols * rows * 4);
  for (let r = r0; r <= r1; r++) {
    for (let q = q0; q <= q1; q++) {
      const key = hexKeyOf(q, r);
      const o = ((r - r0) * cols + (q - q0)) * 4;
      if (exploration.has(key)) {
        data[o] = 0xff;
        let frontier = false;
        for (const neighbor of grid.neighbors(key)) {
          if (!exploration.has(neighbor)) {
            frontier = true;
            break;
          }
        }
        if (frontier) data[o + 1] = 0xff;
      }
      data[o + 3] = 0xff;
    }
  }
  return { q0, r0, cols, rows, data };
}

/** LUT texture width (t resolution) and row assignment for the shader. */
export const LUT_WIDTH = 256;
export const LUT_ROWS = 3; // 0=terr 1=water 2=park

/** Bake the palette ramps into a LUT texture (theme switches swap only this). */
export function buildPaletteLut(palette: MapPalette): Uint8Array {
  const out = new Uint8Array(LUT_WIDTH * LUT_ROWS * 4);
  const ramps = [palette.terr, palette.water, palette.park];
  for (let row = 0; row < LUT_ROWS; row++) {
    for (let i = 0; i < LUT_WIDTH; i++) {
      const [r, g, b] = ramp(ramps[row], i / (LUT_WIDTH - 1));
      const o = (row * LUT_WIDTH + i) * 4;
      out[o] = clamp(Math.round(r), 0, 255);
      out[o + 1] = clamp(Math.round(g), 0, 255);
      out[o + 2] = clamp(Math.round(b), 0, 255);
      out[o + 3] = 0xff;
    }
  }
  return out;
}

/**
 * Everything the shader needs about hex geometry relative to the region:
 * fractional axial coordinates of the region origin, offset by the table
 * anchor, so the shader works in small local numbers (float32-safe).
 */
export function axialOriginFor(
  rect: WorldRect,
  radius: number,
  table: HexTable
): readonly [number, number] {
  const q = ((2 / 3) * rect.minX) / radius;
  const r = ((-1 / 3) * rect.minX + (Math.sqrt(3) / 3) * rect.minY) / radius;
  return [q - table.q0, r - table.r0];
}

/** px per world unit at a camera zoom — re-exported for the render layer. */
export function scalePxFor(zoom: number): number {
  return scaleFor(zoom);
}
