/**
 * Signal colors are locked to full HSV brightness (value = 100%).
 *
 * A signal color is only ever seen as a small mark — an avatar tint, a map pin, a
 * trail — usually over a map that is itself mid-tone. Letting people dial the
 * brightness down produced signals that vanished against terrain, so the axis is
 * gone: hue and saturation are chosen, brightness is always 1. Every entry point
 * (the picker, the randomizer, the quick swatches, and anything parsed back out
 * of storage or off the wire) runs through `fullBrightnessColor`.
 */

/** Scaling RGB so the largest channel is 255 is exactly "set HSV value to 1": it
 *  divides every channel by the current value, which leaves hue and saturation
 *  (both ratios within the triple) untouched. */
export function fullBrightnessColor(color: string): string {
  if (!isSignalColor(color)) return color;
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const brightest = Math.max(red, green, blue);
  // Black has no hue to preserve; the value=1, saturation=0 corner is white.
  if (brightest === 0) return '#FFFFFF';
  if (brightest === 255) return color.toUpperCase();
  const scale = 255 / brightest;
  const channel = (component: number): string =>
    Math.min(255, Math.round(component * scale))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

export const DEFAULT_SIGNAL_COLOR = '#4CFFAB';

export const SIGNAL_COLOR_OPTIONS = [
  { name: 'Fern', value: DEFAULT_SIGNAL_COLOR },
  { name: 'Tidal', value: '#44AAFF' },
  { name: 'Violet', value: '#A286FF' },
  { name: 'Rose', value: '#FF749E' },
  { name: 'Ember', value: '#FF9D33' },
  { name: 'Cyan', value: '#34EFFF' },
] as const;

export function isSignalColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function resolveSignalColor(value: string | undefined, fallback: string): string {
  // The fallback is a theme token, not a signal, so it is handed back untouched.
  return isSignalColor(value) ? fullBrightnessColor(value.toUpperCase()) : fallback;
}

export function signalColorInk(color: string): '#07131F' | '#FFFFFF' {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 145 ? '#07131F' : '#FFFFFF';
}
