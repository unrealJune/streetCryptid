import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ByteQueue, InvalidTileStream, TileStreamDecoder } from '../bundle-stream';
import { hashBytes, streamFixture, streamRequest } from '../__fixtures__/stream-fixture';

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
  expect(stages).toHaveBeenCalledWith(streamRequest, [
    { tile: { z: 11, x: 328, y: 714 }, bytes: null },
    { tile: { z: 11, x: 329, y: 714 }, bytes: null },
    { tile: { z: 11, x: 328, y: 715 }, bytes: null },
    { tile: { z: 11, x: 329, y: 715 }, bytes: null },
  ]);
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
