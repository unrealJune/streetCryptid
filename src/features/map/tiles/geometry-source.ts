import type { TileCoord } from './tile-math';
import type { PackedGeometry } from './packed-geometry';
import { EMPTY_PACKED, mergePacked } from './packed-geometry';

/**
 * Where map geometry comes from — the seam between the pure pipeline and the
 * outside world. Implementations decode raw MVT bytes into {@link PackedGeometry}
 * (native Rust decoder, or the JS decoder packed on web/fallback).
 */
export interface GeometrySource {
  /**
   * Fetch and decode one tile. Rejects on failure; resolves to empty geometry
   * for tiles the source simply doesn't carry. Honors `signal` when provided.
   */
  getTile(tile: TileCoord, signal?: AbortSignal): Promise<PackedGeometry>;

  /**
   * Best-effort cache warm for tiles likely to be needed soon (idle prefetch of
   * neighboring regions). Fetches/decodes on a background path so a later pan is
   * a cache hit instead of a blank wait. Never throws; stops early on `signal`.
   * Optional — sources with no network (fixtures) omit it.
   */
  prefetch?(tiles: readonly TileCoord[], signal?: AbortSignal): Promise<void>;

  /**
   * True when `tile` is already decoded in cache, so `getTile` resolves
   * synchronously-fast with no network. Lets the engine tell a warm region swap
   * (crossfade) from a cold one (the loading reveal). Optional — a source that
   * can't answer is treated as always-cold. Implemented by
   * {@link CachedGeometrySource}, which every dataset wraps at the top.
   */
  has?(tile: TileCoord): boolean;
}

/** Empty region geometry (no tiles). */
export const EMPTY_GEOMETRY: PackedGeometry = EMPTY_PACKED;

/** Concatenate per-tile geometry into one drawable batch. */
export const mergeGeometry = mergePacked;
