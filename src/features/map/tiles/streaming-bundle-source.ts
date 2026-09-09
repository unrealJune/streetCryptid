import {
  ByteQueue,
  InvalidTileStream,
  STREAM_MAX_BYTES,
  TILE_STREAM_MEDIA_TYPE,
  TileStreamDecoder,
  type HashBytes,
  type StageListener,
} from './bundle-stream';
import { sharedBundleResumeStore, type BundleResumeStore } from './bundle-resume-store';
import {
  MartinTileBundleSource,
  type TileBundleEntry,
  type TileBundleRequest,
  type TileBundleSource,
} from './tile-bundle';
import { withRequestDeadline } from './request-deadline';
import { addMapPerfMetric, captureMapPerfMetricScope, perfNow } from '../perf/map-perf';

const JOURNAL_CHUNK_BYTES = 256 * 1024;
const IDLE_TIMEOUT_MS = 45_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<() => void> {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  return () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
}

type DigestModule = {
  digest(algorithm: 'SHA-256', bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
};

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- keep the pure map pipeline native-lazy
  const crypto: DigestModule = require('expo-crypto');
  return new Uint8Array(await crypto.digest('SHA-256', bytes));
}

export class StreamingBundleSource implements TileBundleSource {
  private legacyOnly = false;
  private readonly legacy: TileBundleSource;

  constructor(
    private readonly sourceUrl: string,
    private readonly store: () => Promise<BundleResumeStore> = sharedBundleResumeStore,
    private readonly hash: HashBytes = sha256,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args)
  ) {
    this.legacy = new MartinTileBundleSource(sourceUrl);
  }

  async getBundle(
    request: TileBundleRequest,
    onStage?: StageListener
  ): Promise<readonly TileBundleEntry[]> {
    const release = await acquire();
    try {
      if (this.legacyOnly) return await this.legacy.getBundle(request);
      return await this.download(request, onStage);
    } finally {
      release();
    }
  }

  private async download(
    request: TileBundleRequest,
    onStage?: StageListener
  ): Promise<readonly TileBundleEntry[]> {
    let result: readonly TileBundleEntry[] | undefined;
    const decoder = new TileStreamDecoder(request, this.hash, async (stage, entries) => {
      if (stage.tileZoom === request.tileZoom) result = entries;
      await onStage?.(stage, entries);
    });
    const url = `${this.sourceUrl.replace(/\/+$/, '')}/bundle/v2/${request.anchorX}/${request.anchorY}/${request.tileZoom}`;
    const store = await this.store();
    let saved = await store.state(url);
    if (saved && (!strongEtag(saved.etag) || saved.size > STREAM_MAX_BYTES)) {
      await store.remove(url);
      saved = null;
    }
    const metrics = captureMapPerfMetricScope();
    const started = metrics ? perfNow() : 0;
    try {
      return await withRequestDeadline(async (signal) => {
        const headers: Record<string, string> = { Accept: TILE_STREAM_MEDIA_TYPE };
        if (saved?.size) {
          headers.Range = `bytes=${saved.size}-`;
          headers['If-Range'] = saved.etag;
        }
        const response = await withRequestDeadline(
          () => this.fetcher(url, { headers, signal }),
          60_000,
          signal
        );
        if (response.status === 404 || response.status === 405) {
          this.legacyOnly = true;
          await store.remove(url);
          console.warn('[map] tile server has no v2 stream endpoint; using complete v1 bundles');
          return this.legacy.getBundle(request);
        }
        const etag = response.headers.get('etag');
        const range = response.headers.get('content-range');
        const alreadyComplete =
          response.status === 416 &&
          saved &&
          etag === saved.etag &&
          range === `bytes */${saved.size}`;
        if (!response.ok && !alreadyComplete) {
          throw new Error(`Tile stream request failed: ${response.status}`);
        }
        if (!strongEtag(etag)) throw new InvalidTileStream('Tile stream requires a strong ETag');
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding !== 'identity') {
          throw new InvalidTileStream('Tile stream must not use HTTP content encoding');
        }
        if (
          !alreadyComplete &&
          response.headers.get('content-type')?.split(';')[0] !== TILE_STREAM_MEDIA_TYPE
        ) {
          throw new InvalidTileStream('Unexpected tile stream content type');
        }
        let expectedTotal: number | null = null;
        if (response.status === 206) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range ?? '');
          if (
            !saved ||
            etag !== saved.etag ||
            !match ||
            Number(match[1]) !== saved.size ||
            Number(match[2]) + 1 !== Number(match[3]) ||
            Number(match[3]) > STREAM_MAX_BYTES ||
            Number(match[3]) <= saved.size
          ) {
            throw new InvalidTileStream('Invalid tile stream resume response');
          }
          expectedTotal = Number(match[3]);
        } else if (response.status === 200) {
          // If-Range mismatch or a server that ignored Range: restart, never concatenate.
          await store.remove(url);
          saved = null;
          const length = response.headers.get('content-length');
          if (length !== null) {
            expectedTotal = Number(length);
            if (
              !Number.isSafeInteger(expectedTotal) ||
              expectedTotal < 20 ||
              expectedTotal > STREAM_MAX_BYTES
            )
              throw new InvalidTileStream('Invalid tile stream length');
          }
        } else if (!alreadyComplete) throw new InvalidTileStream('Unexpected tile stream status');

        let received = 0;
        if (saved) {
          for await (const chunk of store.chunks(url)) {
            if (signal.aborted) throw new Error('Tile stream cancelled');
            received += chunk.length;
            await decoder.push(chunk);
          }
          if (received !== saved.size)
            throw new InvalidTileStream('Incomplete local resume journal');
        }
        if (alreadyComplete) {
          decoder.finish();
        } else {
          if (!response.body) throw new Error('Tile stream response has no readable body');
          const reader = response.body.getReader();
          const journal = new ByteQueue();
          let persisted = received;
          try {
            while (true) {
              const { done, value } = await withRequestDeadline(
                () => reader.read(),
                IDLE_TIMEOUT_MS,
                signal
              );
              if (signal.aborted) throw new Error('Tile stream cancelled');
              if (done) break;
              received += value.length;
              addMapPerfMetric('responseBytes', value.length, metrics);
              if (received > STREAM_MAX_BYTES)
                throw new InvalidTileStream('Tile stream exceeds limit');
              journal.push(value);
              while (journal.size >= JOURNAL_CHUNK_BYTES) {
                const bytes = journal.take(JOURNAL_CHUNK_BYTES);
                await store.append(url, etag, persisted, bytes);
                if (signal.aborted) throw new Error('Tile stream cancelled');
                persisted += bytes.length;
              }
              await decoder.push(value);
            }
            if (journal.size) {
              await store.append(url, etag, persisted, journal.take(journal.size));
            }
            if (expectedTotal !== null && received !== expectedTotal) {
              throw new Error('Tile stream body length mismatch');
            }
            decoder.finish();
          } finally {
            // Do not await native cancellation: deadline expiry must release the admission slot.
            void reader.cancel().catch((error: unknown) => {
              console.warn('[map] tile stream reader cancellation failed:', error);
            });
          }
        }
        if (!result) throw new InvalidTileStream('Tile stream omitted requested detail');
        if (signal.aborted) throw new Error('Tile stream cancelled');
        await store.remove(url);
        if (metrics) addMapPerfMetric('networkMs', perfNow() - started, metrics);
        return result;
      }, TRANSFER_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof InvalidTileStream) await store.remove(url);
      console.warn(
        error instanceof InvalidTileStream
          ? '[map] invalid tile stream; discarded resume journal:'
          : '[map] tile stream failed; incomplete bytes retained for resume:',
        error
      );
      throw error;
    }
  }
}

function strongEtag(etag: string | null): etag is string {
  return etag !== null && /^"[^"\r\n]+"$/.test(etag);
}
