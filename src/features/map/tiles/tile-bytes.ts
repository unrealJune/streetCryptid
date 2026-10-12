import type { TileCoord } from './tile-math';
import type { StreamStage, TileBundleEntry } from './tile-bundle';

/**
 * One tile's bytes as the decoder receives them: a single buffer, or several
 * parts whose layers together make the tile (SCB3 ships a z14 tile as its
 * `structure` part and its `labels` part). Each buffer is raw MVT or one
 * complete gzip member; decoders sniff which.
 */
export type TilePayload = Uint8Array | readonly Uint8Array[];

/** Receives each complete coarse stage of a detail stream, in stream order. */
export type PreviewStageListener = (
  stage: StreamStage,
  entries: readonly TileBundleEntry[]
) => Promise<void>;

/**
 * The byte-level seam below {@link import('./geometry-source').GeometrySource}:
 * MVT protobuf per tile, before decoding. Privacy quantization and
 * persistence operate here — bytes round-trip through SQLite unchanged, while
 * decoded geometry stays a memory-only concern.
 */
export interface TileByteSource {
  /**
   * Fetch one tile's bytes. Resolves `null` for tiles the source doesn't
   * carry (a cacheable fact — re-probing empty tiles would leak position just
   * like re-fetching full ones). Rejects on failure.
   */
  getTileBytes(tile: TileCoord, signal?: AbortSignal): Promise<TilePayload | null>;
  /**
   * Streams the coarse stages of the fixed-anchor detail streams that cover
   * `tiles` — never child requests — to `onStage` as each one completes for
   * every covering bundle. Resolves once no further stage will come.
   */
  getPreviewTiles?(tiles: readonly TileCoord[], onStage: PreviewStageListener): Promise<void>;
}

/** A {@link TileByteSource} whose tiles are always one buffer: coarse XYZ, stored as one row. */
export interface SingleTileByteSource extends TileByteSource {
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
  /** Drop a whole namespace, e.g. a tileset representation that is no longer read. */
  deleteSource?(sourceId: string): Promise<void>;
}
