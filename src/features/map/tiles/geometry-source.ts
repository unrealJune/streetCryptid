import type { MapGeometry } from '../core/types';
import type { TileCoord } from './tile-math';

/**
 * Where map geometry comes from — the seam between the pure pipeline and the
 * outside world. Implementations: `MartinGeometrySource` (self-hosted tile
 * server), `FixtureGeometrySource` (bundled sample tiles), fakes in tests.
 */
export interface GeometrySource {
  /**
   * Fetch and decode one tile. Rejects on failure; resolves to empty geometry
   * for tiles the source simply doesn't carry. Honors `signal` when provided.
   */
  getTile(tile: TileCoord, signal?: AbortSignal): Promise<MapGeometry>;
}

export const EMPTY_GEOMETRY: MapGeometry = {
  streets: [],
  rivers: [],
  water: [],
  parks: [],
  places: [],
};

/** Concatenate per-tile geometry into one drawable batch. */
export function mergeGeometry(parts: readonly MapGeometry[]): MapGeometry {
  if (parts.length === 1) return parts[0];
  return {
    streets: parts.flatMap((p) => p.streets),
    rivers: parts.flatMap((p) => p.rivers),
    water: parts.flatMap((p) => p.water),
    parks: parts.flatMap((p) => p.parks),
    places: parts.flatMap((p) => p.places),
  };
}
