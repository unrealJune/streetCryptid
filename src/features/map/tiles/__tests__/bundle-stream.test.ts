import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ByteQueue, InvalidTileStream, TileStreamDecoder } from '../bundle-stream';
import type { StreamStage, TileBundleEntry, TileBundleRequest } from '../tile-bundle';
import {
  hashBytes,
  stream3Fixture,
  streamFixture,
  streamRequest,
} from '../__fixtures__/stream-fixture';

it('decodes the exact Go encoder golden without relying on the JS fixture encoder', async () => {
  const bytes = new Uint8Array(
    readFileSync(join(__dirname, '..', '__fixtures__', 'scb2-z11-empty.scb2'))
  );
  expect(bytes.length).toBe(107);
  const stages = jest.fn(async () => {});
  const decoder = new TileStreamDecoder(streamRequest, hashBytes, stages);
  for (let offset = 0; offset < bytes.length; offset += 7) {
    await decoder.push(bytes.slice(offset, offset + 7));
  }
  decoder.finish();
  expect(stages).toHaveBeenCalledWith(
    streamRequest,
    [
      { tile: { z: 11, x: 328, y: 714 }, bytes: null },
      { tile: { z: 11, x: 329, y: 714 }, bytes: null },
      { tile: { z: 11, x: 328, y: 715 }, bytes: null },
      { tile: { z: 11, x: 329, y: 715 }, bytes: null },
    ],
    { tileZoom: 11, part: 'full' }
  );
});

describe('SCB3', () => {
  const golden = (name: string) =>
    new Uint8Array(readFileSync(join(__dirname, '..', '__fixtures__', name)));

  function recorder() {
    const seen: { stage: StreamStage; zoom: number; count: number }[] = [];
    const listener = async (
      request: TileBundleRequest,
      entries: readonly TileBundleEntry[],
      stage: StreamStage
    ) => {
      seen.push({ stage, zoom: request.tileZoom, count: entries.length });
    };
    return { seen, listener };
  }

  it.each([1, 7, 20, 40, Infinity])(
    'decodes the Go encoder goldens at fragment size %d',
    async (size) => {
      for (const [name, tileZoom, expected] of [
        [
          'scb3-z11-empty.scb3',
          11,
          [{ stage: { tileZoom: 11, part: 'full' }, zoom: 11, count: 4 }],
        ],
        [
          'scb3-z14-empty.scb3',
          14,
          [
            { stage: { tileZoom: 13, part: 'full' }, zoom: 13, count: 64 },
            { stage: { tileZoom: 14, part: 'structure' }, zoom: 14, count: 256 },
            { stage: { tileZoom: 14, part: 'labels' }, zoom: 14, count: 256 },
          ],
        ],
      ] as const) {
        const bytes = golden(name);
        const { seen, listener } = recorder();
        const decoder = new TileStreamDecoder(
          { ...streamRequest, tileZoom },
          hashBytes,
          listener,
          3
        );
        const step = Number.isFinite(size) ? size : bytes.length;
        for (let offset = 0; offset < bytes.length; offset += step) {
          await decoder.push(bytes.slice(offset, offset + step));
        }
        decoder.finish();
        expect(seen).toEqual(expected);
      }
    }
  );

  it('delivers compressed entries and never inflates them', async () => {
    const request = { ...streamRequest, tileZoom: 14 };
    const { all } = stream3Fixture(request, new Uint8Array([0x1a, 0]));
    let first: Uint8Array | null = null;
    const decoder = new TileStreamDecoder(
      request,
      hashBytes,
      async (_r, entries) => {
        first ??= entries[0].bytes;
      },
      3
    );
    await decoder.push(all);
    decoder.finish();
    expect([...first!.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
  });

  it('rejects a v2 stream, a wrong part order, a corrupt hash and raw-entry flags', async () => {
    const request = { ...streamRequest, tileZoom: 14 };
    const decode = (bytes: Uint8Array) =>
      new TileStreamDecoder(request, hashBytes, jest.fn(), 3).push(bytes);

    await expect(decode(streamFixture(request).all)).rejects.toThrow('header');

    const { header, frames } = stream3Fixture(request);
    const concat = (...parts: Uint8Array[]) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
      }
      return out;
    };
    await expect(decode(concat(header, frames[0], frames[2], frames[1]))).rejects.toThrow(
      'out of order'
    );

    const corrupt = concat(header, frames[0]);
    corrupt[20 + 8] ^= 1;
    await expect(decode(corrupt)).rejects.toThrow('checksum');

    // Flags 0 under a matching hash: the payload claims raw entries, which SCB3 forbids.
    const raw = frames[0].slice();
    raw[40 + 7] = 0;
    raw.set(await hashBytes(raw.subarray(40)), 8);
    await expect(decode(concat(header, raw))).rejects.toThrow('flags');
  });
});

it('publishes the complete coarse stage before receiving detail and accepts fragmented frames', async () => {
  const request = { ...streamRequest, tileZoom: 14 };
  const { header, frames } = streamFixture(request);
  const stages: { zoom: number; count: number }[] = [];
  const decoder = new TileStreamDecoder(request, hashBytes, async (r, entries) => {
    stages.push({ zoom: r.tileZoom, count: entries.length });
  });
  await decoder.push(header);
  for (const byte of frames[0]) await decoder.push(new Uint8Array([byte]));
  expect(stages).toEqual([{ zoom: 13, count: 64 }]);
  expect(() => decoder.finish()).toThrow('before all stages');
  for (const byte of frames[1]) await decoder.push(new Uint8Array([byte]));
  decoder.finish();
  expect(stages).toEqual([
    { zoom: 13, count: 64 },
    { zoom: 14, count: 256 },
  ]);
});

it.each([0, 4, 5, 6, 7, 8, 12, 16, 28])(
  'rejects corrupt header/hash at byte %i',
  async (offset) => {
    const { all } = streamFixture();
    all[offset] ^= 1;
    const stage = jest.fn();
    const decoder = new TileStreamDecoder(streamRequest, hashBytes, stage);
    await expect(decoder.push(all)).rejects.toBeInstanceOf(InvalidTileStream);
    expect(stage).not.toHaveBeenCalled();
  }
);

it('bounds compressed and decompressed allocations before consuming a payload', async () => {
  for (const offset of [20, 24]) {
    const { all } = streamFixture();
    new DataView(all.buffer).setUint32(offset, 0xffffffff);
    await expect(
      new TileStreamDecoder(streamRequest, hashBytes, jest.fn()).push(all)
    ).rejects.toThrow('size');
  }
});

it('rejects extra data after a complete stream', async () => {
  const { all } = streamFixture();
  const decoder = new TileStreamDecoder(streamRequest, hashBytes, jest.fn());
  await decoder.push(all);
  await expect(decoder.push(new Uint8Array([1]))).rejects.toThrow('trailing');
});

it('drains chunk queues exactly across empty chunks and boundaries', () => {
  const q = new ByteQueue();
  q.push(new Uint8Array());
  q.push(new Uint8Array([1, 2]));
  q.push(new Uint8Array([3, 4, 5]));
  expect([...q.take(3)]).toEqual([1, 2, 3]);
  expect([...q.take(2)]).toEqual([4, 5]);
  expect(q.size).toBe(0);
});
