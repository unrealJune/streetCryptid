import { PbfReader } from 'pbf';

/**
 * PBF reader that does not use the host TextDecoder. Hermes can decode a
 * Uint8Array view from the wrong offset, which corrupts MVT layer and property
 * names on native builds.
 */
export class Utf8PbfReader extends PbfReader {
  override readString(): string {
    const end = this.readVarint() + this.pos;
    const start = this.pos;
    this.pos = end;
    return decodeUtf8(this.buf, start, end);
  }
}

function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  let result = '';

  for (let i = start; i < end;) {
    const first = bytes[i];
    let codePoint: number | undefined;
    let length = first > 0xef ? 4 : first > 0xdf ? 3 : first > 0xbf ? 2 : 1;

    if (i + length <= end) {
      if (length === 1 && first < 0x80) {
        codePoint = first;
      } else if (length === 2) {
        const second = bytes[i + 1];
        if ((second & 0xc0) === 0x80) {
          const decoded = ((first & 0x1f) << 6) | (second & 0x3f);
          if (decoded > 0x7f) codePoint = decoded;
        }
      } else if (length === 3) {
        const second = bytes[i + 1];
        const third = bytes[i + 2];
        if ((second & 0xc0) === 0x80 && (third & 0xc0) === 0x80) {
          const decoded = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
          if (decoded > 0x7ff && (decoded < 0xd800 || decoded > 0xdfff)) codePoint = decoded;
        }
      } else {
        const second = bytes[i + 1];
        const third = bytes[i + 2];
        const fourth = bytes[i + 3];
        if ((second & 0xc0) === 0x80 && (third & 0xc0) === 0x80 && (fourth & 0xc0) === 0x80) {
          const decoded =
            ((first & 0x07) << 18) |
            ((second & 0x3f) << 12) |
            ((third & 0x3f) << 6) |
            (fourth & 0x3f);
          if (decoded > 0xffff && decoded < 0x110000) codePoint = decoded;
        }
      }
    }

    if (codePoint === undefined) {
      result += '\ufffd';
      i += 1;
    } else if (codePoint > 0xffff) {
      const surrogate = codePoint - 0x10000;
      result += String.fromCharCode(
        0xd800 | ((surrogate >>> 10) & 0x3ff),
        0xdc00 | (surrogate & 0x3ff)
      );
      i += length;
    } else {
      result += String.fromCharCode(codePoint);
      i += length;
    }
  }

  return result;
}
