export const DEFAULT_SIGNAL_COLOR = '#2F9E6A';

export const SIGNAL_COLOR_OPTIONS = [
  { name: 'Fern', value: DEFAULT_SIGNAL_COLOR },
  { name: 'Tidal', value: '#337FBE' },
  { name: 'Violet', value: '#735FB5' },
  { name: 'Rose', value: '#B55270' },
  { name: 'Ember', value: '#A96822' },
  { name: 'Cyan', value: '#1D858E' },
] as const;

export function isSignalColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function resolveSignalColor(value: string | undefined, fallback: string): string {
  return isSignalColor(value) ? value.toUpperCase() : fallback;
}

export function signalColorInk(color: string): '#07131F' | '#FFFFFF' {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 145 ? '#07131F' : '#FFFFFF';
}
