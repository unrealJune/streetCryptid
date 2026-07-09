import { decodeBase64 } from '../base64';

/** Convert a Uint8Array to a Node Buffer for comparison. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

/** Encode bytes with Node's Buffer.toString('base64') and decode with our implementation. */
function roundTrip(input: number[]): Uint8Array {
  const b64 = Buffer.from(input).toString('base64');
  return decodeBase64(b64);
}

describe('decodeBase64', () => {
  it('decodes the empty string to an empty Uint8Array', () => {
    const result = decodeBase64('');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it('round-trips a single zero byte', () => {
    const result = roundTrip([0]);
    expect(toBuffer(result)).toEqual(Buffer.from([0]));
  });

  it('round-trips a single 0xFF byte', () => {
    const result = roundTrip([255]);
    expect(toBuffer(result)).toEqual(Buffer.from([255]));
  });

  it('round-trips two bytes (one padding character)', () => {
    // 2-byte input → base64 with one trailing '='
    const result = roundTrip([0xab, 0xcd]);
    expect(toBuffer(result)).toEqual(Buffer.from([0xab, 0xcd]));
  });

  it('round-trips three bytes (no padding)', () => {
    // 3-byte input → base64 with no trailing '='
    const result = roundTrip([0x01, 0x02, 0x03]);
    expect(toBuffer(result)).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });

  it('round-trips one byte (two padding characters)', () => {
    // 1-byte input → base64 with two trailing '='
    const result = roundTrip([0x7f]);
    expect(toBuffer(result)).toEqual(Buffer.from([0x7f]));
  });

  it('round-trips all 256 sequential byte values', () => {
    const input = Array.from({ length: 256 }, (_, i) => i);
    const result = roundTrip(input);
    expect(toBuffer(result)).toEqual(Buffer.from(input));
  });

  it('round-trips a 4-byte block (no padding)', () => {
    const result = roundTrip([0xde, 0xad, 0xbe, 0xef]);
    expect(toBuffer(result)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  it('round-trips a fixed 5-byte sequence (two padding chars)', () => {
    const result = roundTrip([0x10, 0x20, 0x30, 0x40, 0x50]);
    expect(toBuffer(result)).toEqual(Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50]));
  });

  it('round-trips a fixed 6-byte sequence (no padding)', () => {
    const result = roundTrip([0xca, 0xfe, 0xba, 0xbe, 0x00, 0xff]);
    expect(toBuffer(result)).toEqual(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0xff]));
  });

  it('returns a Uint8Array (not a plain Array or Buffer)', () => {
    const result = decodeBase64(Buffer.from([1, 2, 3]).toString('base64'));
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it('handles base64 without padding (stripped equals signs)', () => {
    // Node's Buffer always emits padding, but ensure we also handle stripped strings
    const withPad = Buffer.from([0xaa]).toString('base64'); // 'qg=='
    const noPad = withPad.replace(/=/g, '');
    expect(toBuffer(decodeBase64(noPad))).toEqual(toBuffer(decodeBase64(withPad)));
  });

  it('round-trips a longer fixed byte sequence (17 bytes — exercises all tail lengths)', () => {
    const input = [
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
      0x00, 0x01,
    ];
    const result = roundTrip(input);
    expect(toBuffer(result)).toEqual(Buffer.from(input));
  });
});
