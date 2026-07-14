import { applyFog, clamp, luminance, mix, packRgba, ramp, rgbToHex, unpackRgba } from '../color';
import { CryptidThemes } from '@/constants/cryptid-theme';

const daybreakTerr = CryptidThemes.daybreak.canvas.terr;

describe('clamp', () => {
  it('clamps below, inside, and above', () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(2, 0, 1)).toBe(1);
  });
});

describe('ramp', () => {
  it('returns the first stop at t=0 and the last at t=1', () => {
    expect(ramp(daybreakTerr, 0)).toEqual([176, 190, 200]);
    expect(ramp(daybreakTerr, 1)).toEqual([20, 44, 64]);
  });

  it('clamps t outside [0,1]', () => {
    expect(ramp(daybreakTerr, -5)).toEqual(ramp(daybreakTerr, 0));
    expect(ramp(daybreakTerr, 7)).toEqual(ramp(daybreakTerr, 1));
  });

  it('interpolates linearly between stops', () => {
    // Halfway between stop 0 (t=0, [176,190,200]) and stop 1 (t=0.4, [108,132,148]).
    const [r, g, b] = ramp(daybreakTerr, 0.2);
    expect(r).toBeCloseTo((176 + 108) / 2, 6);
    expect(g).toBeCloseTo((190 + 132) / 2, 6);
    expect(b).toBeCloseTo((200 + 148) / 2, 6);
  });

  it('hits interior stops exactly', () => {
    expect(ramp(daybreakTerr, 0.4)).toEqual([108, 132, 148]);
  });
});

describe('mix / luminance', () => {
  it('mix interpolates channelwise', () => {
    expect(mix([0, 0, 0], [255, 100, 50], 0.5)).toEqual([127.5, 50, 25]);
  });

  it('luminance uses Rec. 601 weights', () => {
    expect(luminance([255, 255, 255])).toBeCloseTo(255, 6);
    expect(luminance([100, 200, 50])).toBeCloseTo(0.299 * 100 + 0.587 * 200 + 0.114 * 50, 9);
  });
});

describe('rgbToHex', () => {
  it('rounds, clamps, and zero-pads channels', () => {
    expect(rgbToHex([0, 15.6, 255])).toBe('#0010ff');
    expect(rgbToHex([-1, 128, 300])).toBe('#0080ff');
  });
});

describe('applyFog', () => {
  const color = [52, 84, 106] as const;
  const bg = [236, 240, 244] as const;

  it('is the identity when explored (fog=0)', () => {
    expect(applyFog(color, bg, 0, false)).toEqual([...color]);
  });

  it('desaturates 74% toward luma then mixes 24% toward bg at full fog', () => {
    const lum = luminance(color);
    const expected = mix(mix(color, [lum, lum, lum], 0.74), bg, 0.24);
    expect(applyFog(color, bg, 1, false)).toEqual(expected);
  });

  it('caps fog at 0.5 for area features (water/park always read)', () => {
    expect(applyFog(color, bg, 1, true)).toEqual(applyFog(color, bg, 0.5, false));
  });
});

describe('packRgba / unpackRgba', () => {
  it('packs into unsigned 0xRRGGBBAA', () => {
    expect(packRgba([255, 0, 0], 1)).toBe(0xff0000ff);
    expect(packRgba([255, 0, 0], 1)).toBeGreaterThan(0); // no signed overflow
    expect(packRgba([0, 0, 0], 0)).toBe(0);
  });

  it('rounds channels and clamps out-of-range input', () => {
    expect(packRgba([255.4, -3, 300], 2)).toBe(0xff00ffff);
  });

  it('round-trips through unpack', () => {
    const packed = packRgba([12, 200, 99], 0.5);
    const [r, g, b, a] = unpackRgba(packed);
    expect([r, g, b]).toEqual([12, 200, 99]);
    expect(a).toBeCloseTo(0.5, 2);
  });
});
