import { visibleWorldRect } from './camera';
import { H3_MIN_LADDER_ZOOM } from './cell-ladder';
import { latLonToWorld } from './mercator';
import type { CameraState, Viewport, WorldPoint, WorldRect } from './types';

/**
 * Decorative sea cryptids for the far-out map.
 *
 * Pulled all the way back the map is mostly empty: the exploration ladder has
 * run out of legible rungs (`cell-ladder.ts`), and Web Mercator's [0,1]² world
 * is a short rectangle with genuine letterbox void above and below it once the
 * viewport is taller than the world. These fill that emptiness — things in the
 * water at the edge of the chart, in the ASCII idiom the app's cryptids already
 * speak (`features/account/core/profile.ts`).
 *
 * Placement is a fixed table rather than anything derived from tile geometry:
 * a hand-picked open-ocean point is always genuinely water, costs nothing per
 * frame, and cannot drift into a lake or a river the way sampling the water
 * mask could. Pure module — no Skia, no react-native.
 */

const art = (...lines: string[]): string => lines.join('\n');

/** One ASCII figure. Kept to <= 5 lines so it never dominates the canvas. */
export interface SeaCryptid {
  readonly id: string;
  readonly art: string;
}

export const SEA_CRYPTIDS: readonly SeaCryptid[] = [
  { id: 'kraken', art: art('  .-""-.', ' / o  o \\', ' \\ ~~~~ /', '  {{{{{{', '  } } } }') },
  { id: 'serpent', art: art('   __', ' _(o )~', "'-.____)~~-.__", '    ~~~~   ~~~-') },
  { id: 'fin', art: art('    /|', '   / |', '__/__|__', '~~~~~~~~~') },
  { id: 'jelly', art: art('  .-~-.', ' ( o o )', "  '-,-'", '  | | |', "  ' ' '") },
  { id: 'many-eye', art: art(' .-.-.-.', '(o o o o)', " '-.___.-'", '  \\/ \\/') },
  { id: 'drifter', art: art('   ___', '  (o o)', ' <  .  >', '  \\___/') },
] as const;

/**
 * Wave rows drawn under a cryptid, so it reads as something IN water rather than
 * a glyph floating over it. Chosen per anchor by the same hash that seeds the
 * drift, and drifting counter to the figure — the relative motion is what sells
 * the swim; a wave that moved with the creature would just look like part of it.
 */
export const SEA_WAVES: readonly string[] = [
  '~~~   ~~~~  ~~',
  ' ~~~~~   ~~   ',
  '~~  ~~~~   ~~~',
  '  ~~~   ~~~~ ~',
] as const;

/** A cryptid parked at a fixed spot in the world. */
export interface OceanAnchor {
  readonly id: string;
  /** Index into {@link SEA_CRYPTIDS}. */
  readonly figure: number;
  readonly world: WorldPoint;
}

const ocean = (id: string, lat: number, lon: number, figure: number): OceanAnchor => ({
  id,
  figure,
  world: latLonToWorld({ lat, lon }),
});

/**
 * Off-world anchor. `y` outside [0,1] is deliberate: `clampCamera` centres the
 * world vertically once the viewport is taller than it, leaving real void past
 * the Mercator cutoff at roughly ±85° — these live in it.
 */
const voidAnchor = (id: string, x: number, y: number, figure: number): OceanAnchor => ({
  id,
  figure,
  world: [x, y],
});

/**
 * Open-water points, each comfortably clear of any coastline at the zooms this
 * layer draws at, plus the polar void. Order is the tie-break when more anchors
 * are in view than {@link DEFAULT_MAX_VISIBLE} allows, so it is stable by
 * construction.
 */
export const OCEAN_ANCHORS: readonly OceanAnchor[] = [
  ocean('pacific-n', 30, -155, 0),
  ocean('pacific-ne', 12, -128, 2),
  ocean('pacific-s', -25, -125, 1),
  ocean('pacific-sw', -18, -172, 3),
  ocean('atlantic-n', 38, -42, 1),
  ocean('atlantic-ne', 20, -32, 4),
  ocean('atlantic-s', -25, -18, 0),
  ocean('indian', -12, 78, 2),
  ocean('indian-s', -35, 82, 1),
  ocean('bengal', 12, 88, 3),
  ocean('coral-sea', -18, 158, 4),
  ocean('philippine', 18, 132, 0),
  ocean('southern', -58, 40, 5),
  ocean('southern-w', -55, -95, 3),
  ocean('bering', 57, -178, 5),
  ocean('norwegian', 70, 2, 2),
  voidAnchor('void-n', 0.28, -0.055, 5),
  voidAnchor('void-ne', 0.74, -0.075, 3),
  voidAnchor('void-s', 0.4, 1.06, 5),
  voidAnchor('void-sw', 0.82, 1.08, 1),
] as const;

/**
 * Highest camera zoom that still shows cryptids. Sits just above
 * {@link H3_MIN_LADDER_ZOOM} so the two layers hand off: exploration fades out
 * as the water fills up, and the map is never both blank and empty.
 */
export const OCEAN_CRYPTID_MAX_ZOOM = H3_MIN_LADDER_ZOOM + 0.6;

/** Zoom band over which they fade in, ending fully opaque at the low end. */
const FADE_BAND = 1.2;

/** How many draw at once — a decoration, not a bestiary. */
const DEFAULT_MAX_VISIBLE = 6;

/** Extra world margin so a figure whose anchor just left the view still drifts off. */
const VIEW_MARGIN = 0.02;

/** An anchor selected for the current view, with its animation seed. */
export interface PlacedCryptid {
  readonly id: string;
  readonly world: WorldPoint;
  readonly art: string;
  /** The wave row drawn beneath it — see {@link SEA_WAVES}. */
  readonly waves: string;
  /** Stable 0–1 seed: staggers each figure's drift so they never move in lockstep. */
  readonly phase: number;
}

/**
 * Opacity for the layer at `zoom` — 0 above {@link OCEAN_CRYPTID_MAX_ZOOM},
 * ramping to 1 over {@link FADE_BAND} levels below it, so they surface rather
 * than pop in.
 */
export function oceanCryptidOpacity(zoom: number): number {
  if (zoom >= OCEAN_CRYPTID_MAX_ZOOM) return 0;
  return Math.min(1, (OCEAN_CRYPTID_MAX_ZOOM - zoom) / FADE_BAND);
}

/**
 * The cryptids to draw for `camera`. Empty above the zoom gate. Deterministic:
 * the same camera always yields the same figures in the same order, so a region
 * rebuild or a re-render never reshuffles them.
 */
export function visibleOceanCryptids(
  camera: CameraState,
  viewport: Viewport,
  { max = DEFAULT_MAX_VISIBLE }: { readonly max?: number } = {}
): readonly PlacedCryptid[] {
  if (oceanCryptidOpacity(camera.zoom) <= 0) return [];

  const view = visibleWorldRect(camera, viewport);
  const grown: WorldRect = {
    minX: view.minX - VIEW_MARGIN,
    minY: view.minY - VIEW_MARGIN,
    maxX: view.maxX + VIEW_MARGIN,
    maxY: view.maxY + VIEW_MARGIN,
  };

  const placed: PlacedCryptid[] = [];
  for (const anchor of OCEAN_ANCHORS) {
    if (placed.length >= max) break;
    const [x, y] = anchor.world;
    if (x < grown.minX || x > grown.maxX || y < grown.minY || y > grown.maxY) continue;
    const phase = anchorPhase(anchor.id);
    placed.push({
      id: anchor.id,
      world: anchor.world,
      art: SEA_CRYPTIDS[anchor.figure % SEA_CRYPTIDS.length].art,
      waves: SEA_WAVES[Math.floor(phase * SEA_WAVES.length) % SEA_WAVES.length],
      phase,
    });
  }
  return placed;
}

/** FNV-1a of the anchor id folded to [0,1) — same shape as `cellHash`. */
function anchorPhase(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}
