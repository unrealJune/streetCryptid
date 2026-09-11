import {
  CIPHER_GLYPHS,
  cipherGlyph,
  hasVerifiedProfile,
  scrambleFrame,
  settleDurationMs,
  settledCount,
} from '../persona-reveal';

describe('cipherGlyph', () => {
  it('is deterministic, so a frame can be reasoned about', () => {
    expect(cipherGlyph(3, 7)).toBe(cipherGlyph(3, 7));
  });

  it('stays inside the alphabet', () => {
    for (let index = 0; index < 40; index += 1) {
      for (let frame = 0; frame < 40; frame += 1) {
        expect(CIPHER_GLYPHS).toContain(cipherGlyph(index, frame));
      }
    }
  });

  // The whole point of hashing the index in: neighbours churning in lockstep reads as a row of
  // spinning digits, not as ciphertext.
  it('decorrelates neighbouring positions', () => {
    const row = Array.from({ length: 12 }, (_, index) => cipherGlyph(index, 5));
    expect(new Set(row).size).toBeGreaterThan(3);
  });

  it('moves a position between frames', () => {
    const column = Array.from({ length: 12 }, (_, frame) => cipherGlyph(4, frame));
    expect(new Set(column).size).toBeGreaterThan(3);
  });
});

describe('scrambleFrame', () => {
  const handle = '@a1b2c3d4';

  it('churns everything before anything has settled', () => {
    const frame = scrambleFrame(handle, 0, 1);
    expect(frame).toHaveLength(handle.length);
    expect(frame).not.toBe(handle);
  });

  it('settles left to right', () => {
    expect(scrambleFrame(handle, 5, 1).slice(0, 5)).toBe(handle.slice(0, 5));
    expect(scrambleFrame(handle, handle.length, 1)).toBe(handle);
  });

  // Churning the punctuation and spacing too would make the text change SHAPE as it resolves,
  // which reads as a layout bug rather than as decryption.
  it('never churns punctuation or spacing', () => {
    const spaced = '@moth man';
    const frame = scrambleFrame(spaced, 0, 3);
    expect(frame[0]).toBe('@');
    expect(frame[5]).toBe(' ');
    expect(frame).toHaveLength(spaced.length);
  });
});

describe('settledCount', () => {
  it('spans the whole string across the progress range', () => {
    expect(settledCount('abcdefgh', 0)).toBe(0);
    expect(settledCount('abcdefgh', 1)).toBe(8);
  });

  it('clamps rather than overrunning the string', () => {
    expect(settledCount('abcd', -1)).toBe(0);
    expect(settledCount('abcd', 2)).toBe(4);
  });
});

describe('settleDurationMs', () => {
  it('gives a long handle longer, and a tiny one a floor', () => {
    expect(settleDurationMs('@abcdefghijklmnop')).toBeGreaterThan(settleDurationMs('@ab'));
    expect(settleDurationMs('')).toBeGreaterThan(0);
  });
});

describe('hasVerifiedProfile', () => {
  // `profileEpoch` is set by `mergeProfileIntoFriend` and by nothing else, which is exactly what
  // makes it the honest marker: a placeholder friend cannot accidentally look decrypted.
  it('treats a placeholder friend as still encrypted', () => {
    expect(hasVerifiedProfile({ profileEpoch: undefined })).toBe(false);
    expect(hasVerifiedProfile({ profileEpoch: 0 })).toBe(true);
    expect(hasVerifiedProfile({ profileEpoch: 1_700_000_000_000 })).toBe(true);
  });
});
