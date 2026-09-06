import {
  DEFAULT_SIGNAL_COLOR,
  fullBrightnessColor,
  resolveSignalColor,
  SIGNAL_COLOR_OPTIONS,
} from '../signal-colors';

/** HSV value, the axis that is locked: the largest channel over 255. */
function brightness(color: string): number {
  return (
    Math.max(
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16)
    ) / 255
  );
}

describe('signal colors', () => {
  it('ships every quick color at 100% brightness', () => {
    for (const option of SIGNAL_COLOR_OPTIONS) {
      expect(brightness(option.value)).toBe(1);
    }
    expect(brightness(DEFAULT_SIGNAL_COLOR)).toBe(1);
  });

  it('raises a dimmed color to full brightness without shifting its hue', () => {
    // #2F9E6A is the pre-lock Fern; scaling it up is what produced the new one.
    expect(fullBrightnessColor('#2F9E6A')).toBe('#4CFFAB');
    expect(fullBrightnessColor('#337FBE')).toBe('#44AAFF');
    expect(fullBrightnessColor('#a96822')).toBe('#FF9D33');
  });

  it('leaves a color that is already at full brightness alone', () => {
    for (const option of SIGNAL_COLOR_OPTIONS) {
      expect(fullBrightnessColor(option.value)).toBe(option.value);
    }
  });

  it('sends black to the one color at value 1 and saturation 0', () => {
    expect(fullBrightnessColor('#000000')).toBe('#FFFFFF');
  });

  it('lifts a stored or received color but hands back theme fallbacks untouched', () => {
    expect(resolveSignalColor('#2f9e6a', '#123456')).toBe('#4CFFAB');
    // The fallback is a theme token, not somebody's signal.
    expect(resolveSignalColor(undefined, '#2F9E6A')).toBe('#2F9E6A');
    expect(resolveSignalColor('not a color', '#2F9E6A')).toBe('#2F9E6A');
  });
});
