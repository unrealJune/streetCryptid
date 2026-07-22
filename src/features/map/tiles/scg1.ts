/**
 * Zero-copy reader for the flat SCG1 geometry buffer produced by the native Rust
 * decoder (`modules/iroh-location/rust/src/mvt.rs`). Struct-of-arrays,
 * little-endian, 4-byte-aligned coordinate pools; coordinates are f32 deltas
 * from an f64 origin.
 *
 * {@link wrapScg1} returns a {@link PackedTile} whose coordinate/offset pools are
 * `Float32Array`/`Uint32Array` **views into the native buffer** — the millions of
 * points are never copied onto the JS heap. Only the cheap per-feature data
 * (names, the handful of places) is materialized.
 */

import type { Place } from '../core/types';
import type { PackedAreas, PackedLines, PackedStreets, PackedTile } from './packed-geometry';

const SCG1_MAGIC = 0x31474353; // "SCG1" little-endian

export function wrapScg1(input: Uint8Array): PackedTile {
  // Typed-array views require a 4-byte-aligned byteOffset; the native module's
  // Uint8Array may not be aligned, so copy into a fresh (aligned) buffer if not.
  const buf = input.byteOffset % 4 === 0 ? input : input.slice();
  const { buffer, byteOffset: base } = buf;
  const dv = new DataView(buffer, base, buf.byteLength);
  let p = 0;

  const u32 = () => {
    const v = dv.getUint32(p, true);
    p += 4;
    return v;
  };
  const f64 = () => {
    const v = dv.getFloat64(p, true);
    p += 8;
    return v;
  };
  const align4 = () => {
    p = (p + 3) & ~3;
  };
  const viewU8 = (n: number) => {
    const v = new Uint8Array(buffer, base + p, n);
    p += n;
    return v;
  };
  const viewU32 = (n: number) => {
    const v = new Uint32Array(buffer, base + p, n);
    p += n * 4;
    return v;
  };
  const viewF32 = (n: number) => {
    const v = new Float32Array(buffer, base + p, n);
    p += n * 4;
    return v;
  };
  const readI32 = (n: number) => {
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = dv.getInt32(p, true);
      p += 4;
    }
    return out;
  };

  if (u32() !== SCG1_MAGIC) throw new Error('bad SCG1 magic');
  align4();
  const originX = f64();
  const originY = f64();

  // ---- STREETS -----------------------------------------------------------
  const sCount = u32();
  const sTotal = u32();
  const roadClass = viewU8(sCount);
  align4();
  const sNameRef = readI32(sCount);
  const sPointOff = viewU32(sCount + 1);
  align4();
  const sCoords = viewF32(sTotal * 2);

  // ---- RIVERS ------------------------------------------------------------
  const rCount = u32();
  const rTotal = u32();
  const rPointOff = viewU32(rCount + 1);
  align4();
  const rCoords = viewF32(rTotal * 2);

  // ---- WATER, PARKS ------------------------------------------------------
  const water = readAreas();
  const parks = readAreas();

  function readAreas() {
    const count = u32();
    const totalRings = u32();
    const totalPoints = u32();
    const nameRef = readI32(count);
    const ringOff = viewU32(count + 1);
    const pointOff = viewU32(totalRings + 1);
    align4();
    const coords = viewF32(totalPoints * 2);
    return { count, nameRef, ringOff, pointOff, coords };
  }

  // ---- PLACES ------------------------------------------------------------
  const plCount = u32();
  const plNameRef = readI32(plCount);
  const plKindRef = readI32(plCount);
  const plRank = readI32(plCount);
  align4();
  const plX = viewF32(plCount);
  const plY = viewF32(plCount);

  // ---- STRING TABLE ------------------------------------------------------
  align4();
  const strCount = u32();
  const strings: string[] = new Array(strCount);
  const decoder = new TextDecoder();
  for (let i = 0; i < strCount; i++) {
    const len = u32();
    // slice() copies into a zero-offset buffer — a non-zero-byteOffset subarray
    // decodes to garbage on Hermes (the pbf/h3-js TextDecoder bug class).
    strings[i] = len === 0 ? '' : decoder.decode(buf.slice(p, p + len));
    p += len;
    align4();
  }
  const name = (ref: number): string | undefined => (ref >= 0 ? strings[ref] : undefined);
  const resolveNames = (refs: Int32Array) => Array.from(refs, name);

  const streets: PackedStreets = {
    count: sCount,
    roadClass,
    names: resolveNames(sNameRef),
    pointOff: sPointOff,
    coords: sCoords,
  };
  const rivers: PackedLines = { count: rCount, pointOff: rPointOff, coords: rCoords };
  const toAreas = (a: ReturnType<typeof readAreas>): PackedAreas => ({
    count: a.count,
    names: resolveNames(a.nameRef),
    ringOff: a.ringOff,
    pointOff: a.pointOff,
    coords: a.coords,
  });

  const places: Place[] = new Array(plCount);
  for (let i = 0; i < plCount; i++) {
    places[i] = {
      name: strings[plNameRef[i]] ?? '',
      world: [originX + plX[i], originY + plY[i]],
      kind: strings[plKindRef[i]] ?? '',
      rank: plRank[i] >= 0 ? plRank[i] : undefined,
    };
  }

  return {
    originX,
    originY,
    streets,
    rivers,
    water: toAreas(water),
    parks: toAreas(parks),
    places,
  };
}
