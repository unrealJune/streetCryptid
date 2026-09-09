import { gunzipSync } from 'fflate';

import {
  bundleTiles,
  decodeTileBundle,
  TILE_BUNDLE_MAX_BYTES,
  type TileBundleEntry,
  type TileBundleRequest,
} from './tile-bundle';

export const TILE_STREAM_MEDIA_TYPE = 'application/vnd.streetcryptid.tile-stream';
export const STREAM_STAGE_MAX_BYTES = TILE_BUNDLE_MAX_BYTES + 1024 * 1024;
export const STREAM_MAX_BYTES = 20 + 2 * (40 + STREAM_STAGE_MAX_BYTES);
export type StageListener = (
  request: TileBundleRequest,
  entries: readonly TileBundleEntry[]
) => Promise<void>;
export type HashBytes = (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

export class InvalidTileStream extends Error {}

/** Chunk queue avoids repeatedly copying a growing multi-megabyte response. */
export class ByteQueue {
  private chunks: Uint8Array[] = [];
  private head = 0;
  private offset = 0;
  size = 0;

  push(bytes: Uint8Array) {
    if (bytes.length) {
      this.chunks.push(bytes);
      this.size += bytes.length;
    }
  }

  take(size: number): Uint8Array {
    if (size > this.size) throw new InvalidTileStream('Truncated tile stream');
    const out = new Uint8Array(size);
    for (let written = 0; written < size;) {
      const chunk = this.chunks[this.head];
      const count = Math.min(size - written, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      if (this.offset === chunk.length) {
        this.head++;
        this.offset = 0;
      }
    }
    this.size -= size;
    if (this.head) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
    return out;
  }
}

export class TileStreamDecoder {
  private readonly queue = new ByteQueue();
  private header = false;
  private stage = 0;
  private frame: { compressed: number; raw: number; hash: Uint8Array } | null = null;
  private received = 0;
  private readonly zooms: number[];

  constructor(
    private readonly request: TileBundleRequest,
    private readonly hash: HashBytes,
    private readonly onStage: StageListener
  ) {
    bundleTiles(request); // validate the request before any external work
    this.zooms = request.tileZoom === 14 ? [13, 14] : [request.tileZoom];
  }

  async push(bytes: Uint8Array) {
    this.received += bytes.length;
    if (this.received > STREAM_MAX_BYTES) throw new InvalidTileStream('Tile stream exceeds limit');
    this.queue.push(bytes);
    if (!this.header) {
      if (this.queue.size < 20) return;
      const h = this.queue.take(20);
      const v = new DataView(h.buffer);
      if (
        String.fromCharCode(...h.subarray(0, 4)) !== 'SCB2' ||
        h[4] !== 2 ||
        h[5] !== 10 ||
        h[6] !== this.request.tileZoom ||
        h[7] !== 0 ||
        v.getUint32(8) !== this.request.anchorX ||
        v.getUint32(12) !== this.request.anchorY ||
        v.getUint32(16) !== this.zooms.length
      )
        throw new InvalidTileStream('Tile stream header mismatch');
      this.header = true;
    }
    while (this.stage < this.zooms.length) {
      if (!this.frame) {
        if (this.queue.size < 40) return;
        const f = this.queue.take(40);
        const v = new DataView(f.buffer);
        const compressed = v.getUint32(0);
        const raw = v.getUint32(4);
        if (
          compressed < 18 ||
          compressed > STREAM_STAGE_MAX_BYTES ||
          raw < 20 ||
          raw > TILE_BUNDLE_MAX_BYTES
        ) {
          throw new InvalidTileStream('Invalid tile stream frame size');
        }
        this.frame = { compressed, raw, hash: f.slice(8) };
      }
      if (this.queue.size < this.frame.compressed) return;
      const frame = this.frame;
      const compressed = this.queue.take(frame.compressed);
      let entries: readonly TileBundleEntry[];
      const request = { ...this.request, tileZoom: this.zooms[this.stage] };
      try {
        const trailer = new DataView(compressed.buffer);
        if (trailer.getUint32(compressed.length - 4, true) !== frame.raw) {
          throw new Error('Gzip size does not match frame');
        }
        // A caller-sized buffer prevents gzip metadata from allocating an unbounded output.
        const raw = gunzipSync(compressed, { out: new Uint8Array(frame.raw) });
        const hash = await this.hash(raw);
        if (
          raw.length !== frame.raw ||
          hash.length !== 32 ||
          hash.some((v, i) => v !== frame.hash[i])
        )
          throw new Error('Tile stage checksum mismatch');
        entries = decodeTileBundle(raw, request);
      } catch (error) {
        throw new InvalidTileStream(`Invalid tile stage: ${String(error)}`);
      }
      await this.onStage(request, entries);
      this.stage++;
      this.frame = null;
    }
    if (this.queue.size) throw new InvalidTileStream('Tile stream has trailing bytes');
  }

  finish() {
    if (!this.header || this.stage !== this.zooms.length || this.queue.size) {
      throw new Error('Tile stream ended before all stages arrived');
    }
  }
}
