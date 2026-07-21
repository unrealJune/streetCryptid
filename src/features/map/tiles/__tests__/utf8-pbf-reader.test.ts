import { Utf8PbfReader } from '../utf8-pbf-reader';

describe('Utf8PbfReader', () => {
  it('decodes a non-zero-offset string without calling the host TextDecoder', () => {
    const text = 'transportation 🦋';
    const encoded = Buffer.from(text, 'utf8');
    const backing = new Uint8Array(encoded.length + 5);
    backing.set([encoded.length, ...encoded], 3);
    const bytes = backing.subarray(3, 4 + encoded.length);
    const decode = jest.spyOn(TextDecoder.prototype, 'decode').mockImplementation(() => {
      throw new Error('broken native TextDecoder');
    });

    try {
      expect(new Utf8PbfReader(bytes).readString()).toBe(text);
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it('replaces malformed UTF-8 sequences', () => {
    expect(new Utf8PbfReader(new Uint8Array([2, 0xc0, 0xaf])).readString()).toBe('\ufffd\ufffd');
  });
});
