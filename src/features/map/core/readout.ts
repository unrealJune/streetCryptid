import { visibleWorldRect } from './camera';
import { H3_DISPLAY_RES, resForZoom } from './cell-ladder';
import type { ExplorationIndex } from './exploration-index';
import type { H3Grid } from './h3-grid';
import { latLonToWorld } from './mercator';
import type {
  CameraState,
  LatLon,
  MapReadout,
  Place,
  Viewport,
  WorldPoint,
  WorldRect,
} from './types';

/** Withhold a locality while the selected location's own tiles are still loading. */
export function placeNameInRegion(
  places: readonly Place[],
  bounds: WorldRect,
  location: LatLon
): string | null {
  const point = latLonToWorld(location);
  if (
    point[0] < bounds.minX ||
    point[0] > bounds.maxX ||
    point[1] < bounds.minY ||
    point[1] > bounds.maxY
  )
    return null;
  return nearestPlaceName(places, point);
}

/** Selection and fix can change before the map's next readout effect runs. */
export function friendPlaceName(
  place: MapReadout['friendPlace'],
  id: string,
  location: LatLon | null
): string | null {
  return location &&
    place?.id === id &&
    place.location.lat === location.lat &&
    place.location.lon === location.lon
    ? place.name
    : null;
}

/**
 * What the headline NAMES, by how far back the camera is.
 *
 * A locality is the right answer only while the map is showing one. Pulled back to a whole state
 * the nearest neighbourhood is a place you cannot see and did not ask about — the answer to "where
 * am I" is "Washington", which is what the mock's region view says and what the hex ladder is
 * drawing by then (`cell-ladder.ts` is still on a coarse rung at this zoom; it does not hide until
 * ~z5.9).
 *
 * The bands are camera zooms, not tile zooms: this is a question about what the user is looking at.
 */
export const LOCALITY_HEADLINE_MIN_ZOOM = 10.5;
export const CITY_HEADLINE_MIN_ZOOM = 8;
export const STATE_HEADLINE_MIN_ZOOM = 3.5;

/** Kinds that make sense as a "where you are" headline, most local first. */
const LOCALITY_KINDS = new Set(['neighbourhood', 'suburb', 'quarter', 'village', 'town', 'city']);
/** The county/metro band: the nearest real settlement, not the nearest hamlet. */
const CITY_KINDS = new Set(['city', 'town']);
/** OMT calls this `state`; some bakes of the schema also emit `province` / `region`. */
const STATE_KINDS = new Set(['state', 'province', 'region']);
const COUNTRY_KINDS = new Set(['country']);

/**
 * The headline tiers at `zoom`, most specific first. A cascade rather than one set, because a
 * tier can legitimately be empty — a small country has no `state` place at all, and an ocean view
 * has nothing but the country on its far shore. Falling through beats rendering an em dash.
 */
function headlineTiers(zoom: number): readonly ReadonlySet<string>[] {
  if (zoom >= LOCALITY_HEADLINE_MIN_ZOOM)
    return [LOCALITY_KINDS, CITY_KINDS, STATE_KINDS, COUNTRY_KINDS];
  if (zoom >= CITY_HEADLINE_MIN_ZOOM) return [CITY_KINDS, STATE_KINDS, COUNTRY_KINDS];
  if (zoom >= STATE_HEADLINE_MIN_ZOOM) return [STATE_KINDS, COUNTRY_KINDS, CITY_KINDS];
  return [COUNTRY_KINDS, STATE_KINDS];
}

/**
 * Nearest prominent place to `center`, for the island headline. Ignores kinds that aren't places
 * of the tier `zoom` calls for (roads, POIs, …) and compares in squared world space.
 *
 * `zoom` defaults to the locality tier, which is the right answer for the callers that are asking
 * about a POINT rather than about the camera — a friend's dot is in a neighbourhood no matter how
 * far back you are looking at it from.
 *
 * **The state tier is a Voronoi cell, not a containment test.** OMT gives a state one label POINT,
 * so "which state is this" is answered by whichever label point is nearest — which is right across
 * the body of a state and wrong within roughly 50 km of a border (standing in Vancouver WA, the
 * Oregon label point is the closer of the two). Making it exact needs real admin polygons; the
 * cheapest source is a bundled low-res Natural Earth admin-1 set, NOT the `boundary` tile layer,
 * which is lines that would have to be stitched into rings first.
 */
export function nearestPlaceName(
  places: readonly Place[],
  center: WorldPoint,
  zoom: number = LOCALITY_HEADLINE_MIN_ZOOM
): string | null {
  for (const kinds of headlineTiers(zoom)) {
    let best: Place | null = null;
    let bestDist = Infinity;
    for (const place of places) {
      // A place the bake left unclassed is admitted only by the locality tier — that is where the
      // old flat filter let it through, and letting it answer "which state" would put a nameless
      // point in the region headline.
      if (place.kind ? !kinds.has(place.kind) : kinds !== LOCALITY_KINDS) continue;
      const dx = place.world[0] - center[0];
      const dy = place.world[1] - center[1];
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = place;
      }
    }
    if (best) return best.name;
  }
  return null;
}

/**
 * Explored fraction (0–1) of DISPLAY-resolution cells currently in view.
 *
 * Deliberately narrower than the render ladder: the coarse rungs carry presence
 * rolled up from res 9 (`exploration-rollup.ts`), so measuring them would report
 * a city walk as most of a county. Below the res-9 band the layer keeps drawing
 * and this returns zero — `sectorsVisible` is what tells the chrome to hide the
 * readout rather than render a meaningless number.
 */
export function coverageInView(
  exploration: ExplorationIndex,
  grid: H3Grid,
  camera: CameraState,
  viewport: Viewport
): number {
  if (!coverageMeasurable(camera.zoom)) return 0;
  const cells = grid.cellsInRect(visibleWorldRect(camera, viewport), H3_DISPLAY_RES);
  if (!cells.length) return 0;
  let total = 0;
  for (const cell of cells) total += exploration.fractionAt(cell);
  return total / cells.length;
}

/**
 * Whether a coverage percentage means anything at `zoom` — i.e. whether the
 * ladder is on its display-resolution rung. The chrome hides the sector readout
 * when this is false; the map layer itself keeps drawing well past it.
 */
export function coverageMeasurable(zoom: number): boolean {
  return resForZoom(zoom) === H3_DISPLAY_RES;
}
