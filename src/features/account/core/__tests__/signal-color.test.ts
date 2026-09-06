import { colorAtWheelPosition, colorWheelPosition, hexToHsv, hsvToHex } from '../signal-color';

describe('signal color picker', () => {
  it.each(['#FF0000', '#00FF00', '#0000FF', '#FFFFFF', '#000000', '#2F9E6A', '#735FB5'])(
    'round-trips %s through HSV',
    (color) => {
      expect(hsvToHex(hexToHsv(color))).toBe(color);
    }
  );

  it('maps wheel edges to hue and full saturation', () => {
    expect(colorAtWheelPosition(200, 100, 200)).toEqual({ hue: 0, saturation: 1, value: 1 });
    expect(colorAtWheelPosition(100, 200, 200)).toEqual({ hue: 90, saturation: 1, value: 1 });
  });

  it('clamps touches outside the wheel', () => {
    expect(colorAtWheelPosition(400, 100, 200).saturation).toBe(1);
  });

  it('has no brightness axis: the wheel centre is white, never grey or black', () => {
    // Brightness is locked at 100%, so every point on the wheel comes back at
    // value 1 no matter where it was touched.
    for (const [x, y] of [
      [100, 100],
      [0, 0],
      [199, 12],
      [55, 170],
    ]) {
      expect(colorAtWheelPosition(x, y, 200).value).toBe(1);
    }
    expect(hsvToHex(colorAtWheelPosition(100, 100, 200))).toBe('#FFFFFF');
  });

  it('positions a selected color on the wheel', () => {
    const position = colorWheelPosition({ hue: 180, saturation: 0.5 }, 200);
    expect(position.x).toBeCloseTo(50);
    expect(position.y).toBeCloseTo(100);
  });
});
