import type { TileCoord } from './tile-math';

/**
 * The byte-level seam below {@link import('./geometry-source').GeometrySource}:
 * raw MVT protobuf per tile, before decoding. Privacy quantization and
 * persistence operate here — bytes round-trip through SQLite unchanged, while
 * decoded geometry stays a memory-only concern.
 */
export interface TileByteSource {
  /**
   * Fetch one tile's raw bytes. Resolves `null` for tiles the source doesn't
   * carry (a cacheable fact — re-probing empty tiles would leak position just
   * like re-fetching full ones). Rejects on failure.
   */
  getTileBytes(tile: TileCoord, signal?: AbortSignal): Promise<Uint8Array | null>;
}

/** A persisted tile: its bytes (`null` = known-empty) and when it was fetched. */
export interface StoredTile {
  readonly bytes: Uint8Array | null;
  readonly fetchedAt: number;
}

/**
 * Passive persistent byte store consulted before the network: SQLite in the
 * app, a Map fake in tests, and — later — pre-downloaded offline region packs.
 */
export interface TileByteStore {
  /** Look up one tile in a tileset namespace, or `null` when it has never been seen. */
  get(sourceId: string, tile: TileCoord): Promise<StoredTile | null>;
  /** Persist a batch (one privacy bundle) atomically-ish; `bytes: null` records an empty tile. */
  putMany(
    sourceId: string,
    entries: readonly { tile: TileCoord; bytes: Uint8Array | null }[],
    fetchedAt: number
  ): Promise<void>;
}
