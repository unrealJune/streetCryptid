import { DEFAULT_SIGNAL_COLOR, isSignalColor } from '@/constants/signal-colors';

export interface HsvColor {
  hue: number;
  saturation: number;
  value: number;
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

export function hsvToHex({ hue, saturation, value }: HsvColor): string {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const clampedSaturation = clampUnit(saturation);
  const clampedValue = clampUnit(value);
  const chroma = clampedValue * clampedSaturation;
  const hueSection = normalizedHue / 60;
  const intermediate = chroma * (1 - Math.abs((hueSection % 2) - 1));
  const [red, green, blue] =
    hueSection < 1
      ? [chroma, intermediate, 0]
      : hueSection < 2
        ? [intermediate, chroma, 0]
        : hueSection < 3
          ? [0, chroma, intermediate]
          : hueSection < 4
            ? [0, intermediate, chroma]
            : hueSection < 5
              ? [intermediate, 0, chroma]
              : [chroma, 0, intermediate];
  const match = clampedValue - chroma;
  const channel = (component: number): string =>
    Math.round((component + match) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();

  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

export function hexToHsv(color: string): HsvColor {
  const normalized = isSignalColor(color) ? color : DEFAULT_SIGNAL_COLOR;
  const red = Number.parseInt(normalized.slice(1, 3), 16) / 255;
  const green = Number.parseInt(normalized.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(normalized.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;

  let hue = 0;
  if (delta !== 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }

  return {
    hue: hue < 0 ? hue + 360 : hue,
    saturation: maximum === 0 ? 0 : delta / maximum,
    value: maximum,
  };
}

export function colorWheelPosition(
  { hue, saturation }: Pick<HsvColor, 'hue' | 'saturation'>,
  diameter: number
): { x: number; y: number } {
  const radius = diameter / 2;
  const angle = (hue * Math.PI) / 180;
  const distance = clampUnit(saturation) * radius;
  return {
    x: radius + Math.cos(angle) * distance,
    y: radius + Math.sin(angle) * distance,
  };
}

export function colorAtWheelPosition(
  x: number,
  y: number,
  diameter: number,
  value: number
): HsvColor {
  const radius = diameter / 2;
  const dx = x - radius;
  const dy = y - radius;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    hue: angle < 0 ? angle + 360 : angle,
    saturation: clampUnit(Math.hypot(dx, dy) / radius),
    value: clampUnit(value),
  };
}
