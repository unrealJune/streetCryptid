import { gunzipSync } from 'fflate';

import {
  bundleTiles,
  decodeTileBundle,
  TILE_BUNDLE_FLAG_GZIP_ENTRIES,
  TILE_BUNDLE_MAX_BYTES,
  type StageListener,
  type StagePart,
  type StreamStage,
  type TileBundleEntry,
  type TileBundleRequest,
} from './tile-bundle';

export type { StageListener, StagePart, StreamStage } from './tile-bundle';

export const TILE_STREAM_MEDIA_TYPE = 'application/vnd.streetcryptid.tile-stream';
export const TILE_STREAM3_MEDIA_TYPE = 'application/vnd.streetcryptid.tile-stream3';
export const STREAM_STAGE_MAX_BYTES = TILE_BUNDLE_MAX_BYTES + 1024 * 1024;
export const STREAM_MAX_BYTES = 20 + 2 * (40 + STREAM_STAGE_MAX_BYTES);
/** SCB3 has no outer gzip, so a frame payload is bounded by the SCB1 bound itself. */
export const STREAM3_MAX_BYTES = 20 + 3 * (40 + TILE_BUNDLE_MAX_BYTES);
export type StreamFormat = 2 | 3;
export type HashBytes = (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

export class InvalidTileStream extends Error {}

/** SCB3 part codes, indexed by their wire value. */
const PART_CODES: readonly StagePart[] = ['full', 'structure', 'labels'];

/**
 * The fixed stage list for a requested zoom. It depends on nothing else, so a
 * stream can only ever reveal the z10 anchor and the requested data zoom.
 */
export function streamStages(tileZoom: number, format: StreamFormat): readonly StreamStage[] {
  if (tileZoom !== 14) return [{ tileZoom, part: 'full' }];
  return format === 3
    ? [
        { tileZoom: 13, part: 'full' },
        { tileZoom: 14, part: 'structure' },
        { tileZoom: 14, part: 'labels' },
      ]
    : [
        { tileZoom: 13, part: 'full' },
        { tileZoom: 14, part: 'full' },
      ];
}

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

/**
 * Incremental decoder for one progressive bundle stream.
 *
 * SCB2 (`format` 2): each frame is a whole-stage gzip of an SCB1 body with raw
 * MVT entries. SCB3 (`format` 3): no outer gzip; each frame names its stage
 * (zoom + part) and carries an SCB1 body whose entries are per-tile gzip
 * members. Those are delivered still compressed, so only tiles that are drawn
 * are ever inflated — natively, where a native decoder exists.
 */
export class TileStreamDecoder {
  private readonly queue = new ByteQueue();
  private header = false;
  private stage = 0;
  private frame: { compressed: number; raw: number; hash: Uint8Array } | null = null;
  private received = 0;
  private readonly stages: readonly StreamStage[];
  private readonly maxBytes: number;

  constructor(
    private readonly request: TileBundleRequest,
    private readonly hash: HashBytes,
    private readonly onStage: StageListener,
    private readonly format: StreamFormat = 2
  ) {
    bundleTiles(request); // validate the request before any external work
    this.stages = streamStages(request.tileZoom, format);
    this.maxBytes = format === 3 ? STREAM3_MAX_BYTES : STREAM_MAX_BYTES;
  }

  async push(bytes: Uint8Array) {
    this.received += bytes.length;
    if (this.received > this.maxBytes) throw new InvalidTileStream('Tile stream exceeds limit');
    this.queue.push(bytes);
    if (!this.header) {
      if (this.queue.size < 20) return;
      const h = this.queue.take(20);
      const v = new DataView(h.buffer);
      if (
        String.fromCharCode(...h.subarray(0, 4)) !== `SCB${this.format}` ||
        h[4] !== this.format ||
        h[5] !== 10 ||
        h[6] !== this.request.tileZoom ||
        h[7] !== 0 ||
        v.getUint32(8) !== this.request.anchorX ||
        v.getUint32(12) !== this.request.anchorY ||
        v.getUint32(16) !== this.stages.length
      )
        throw new InvalidTileStream('Tile stream header mismatch');
      this.header = true;
    }
    while (this.stage < this.stages.length) {
      const stage = this.stages[this.stage];
      if (!this.frame) {
        if (this.queue.size < 40) return;
        this.frame = this.readFrame(this.queue.take(40), stage);
      }
      if (this.queue.size < this.frame.compressed) return;
      const frame = this.frame;
      const payload = this.queue.take(frame.compressed);
      const request = { ...this.request, tileZoom: stage.tileZoom };
      let entries: readonly TileBundleEntry[];
      try {
        entries =
          this.format === 3
            ? await this.decodeStage3(payload, frame.hash, request)
            : await this.decodeStage2(payload, frame, request);
      } catch (error) {
        throw new InvalidTileStream(`Invalid tile stage: ${String(error)}`);
      }
      await this.onStage(request, entries, stage);
      this.stage++;
      this.frame = null;
    }
    if (this.queue.size) throw new InvalidTileStream('Tile stream has trailing bytes');
  }

  private readFrame(f: Uint8Array, stage: StreamStage) {
    const v = new DataView(f.buffer);
    if (this.format === 3) {
      const length = v.getUint32(0);
      if (length < 20 || length > TILE_BUNDLE_MAX_BYTES) {
        throw new InvalidTileStream('Invalid tile stream frame size');
      }
      if (f[4] !== stage.tileZoom || PART_CODES[f[5]] !== stage.part || v.getUint16(6) !== 0) {
        throw new InvalidTileStream('Tile stream stage out of order');
      }
      return { compressed: length, raw: length, hash: f.slice(8) };
    }
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
    return { compressed, raw, hash: f.slice(8) };
  }

  private async decodeStage2(
    compressed: Uint8Array,
    frame: { raw: number; hash: Uint8Array },
    request: TileBundleRequest
  ): Promise<readonly TileBundleEntry[]> {
    const trailer = new DataView(compressed.buffer);
    if (trailer.getUint32(compressed.length - 4, true) !== frame.raw) {
      throw new Error('Gzip size does not match frame');
    }
    // A caller-sized buffer prevents gzip metadata from allocating an unbounded output.
    const raw = gunzipSync(compressed, { out: new Uint8Array(frame.raw) });
    await this.checkHash(raw, frame.hash);
    if (raw.length !== frame.raw) throw new Error('Tile stage checksum mismatch');
    return decodeTileBundle(raw, request);
  }

  private async decodeStage3(
    payload: Uint8Array,
    expected: Uint8Array,
    request: TileBundleRequest
  ): Promise<readonly TileBundleEntry[]> {
    await this.checkHash(payload as Uint8Array<ArrayBuffer>, expected);
    return decodeTileBundle(payload, request, TILE_BUNDLE_FLAG_GZIP_ENTRIES);
  }

  private async checkHash(bytes: Uint8Array<ArrayBuffer>, expected: Uint8Array) {
    const hash = await this.hash(bytes);
    if (hash.length !== 32 || hash.some((v, i) => v !== expected[i]))
      throw new Error('Tile stage checksum mismatch');
  }

  finish() {
    if (!this.header || this.stage !== this.stages.length || this.queue.size) {
      throw new Error('Tile stream ended before all stages arrived');
    }
  }
}
