import { createHash } from 'node:crypto';
import { gzipSync } from 'fflate';

import { bundleTiles, type TileBundleRequest } from '../tile-bundle';

export const streamRequest: TileBundleRequest = { anchorZoom: 10, anchorX: 164, anchorY: 357, tileZoom: 11 };
export const hashBytes = async (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());

export function scb1(request: TileBundleRequest, payload?: Uint8Array): Uint8Array {
  const tiles = bundleTiles(request);
  const bytes = new Uint8Array(20 + tiles.length * (4 + (payload?.length ?? 0)));
  bytes.set([83, 67, 66, 49, 1, 10, request.tileZoom, 0]);
  const v = new DataView(bytes.buffer);
  v.setUint32(8, request.anchorX);
  v.setUint32(12, request.anchorY);
  v.setUint32(16, tiles.length);
  let offset = 20;
  for (let i = 0; i < tiles.length; i++) {
    v.setUint32(offset, payload?.length ?? 0xffffffff);
    offset += 4;
    if (payload) { bytes.set(payload, offset); offset += payload.length; }
  }
  return bytes;
}

export function streamFixture(request = streamRequest, payload?: Uint8Array) {
  const zooms = request.tileZoom === 14 ? [13, 14] : [request.tileZoom];
  const header = new Uint8Array(20);
  header.set([83, 67, 66, 50, 2, 10, request.tileZoom, 0]);
  const view = new DataView(header.buffer);
  view.setUint32(8, request.anchorX);
  view.setUint32(12, request.anchorY);
  view.setUint32(16, zooms.length);
  const frames = zooms.map((tileZoom) => {
    const raw = scb1({ ...request, tileZoom }, payload);
    const compressed = gzipSync(raw, { mtime: 0 });
    const frame = new Uint8Array(40 + compressed.length);
    const v = new DataView(frame.buffer);
    v.setUint32(0, compressed.length);
    v.setUint32(4, raw.length);
    frame.set(createHash('sha256').update(raw).digest(), 8);
    frame.set(compressed, 40);
    return frame;
  });
  const all = new Uint8Array(20 + frames.reduce((n, f) => n + f.length, 0));
  all.set(header);
  let offset = 20;
  for (const frame of frames) { all.set(frame, offset); offset += frame.length; }
  return { header, frames, all };
}
