import { Canvas, Group, Path, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { View } from 'react-native';
import { toQR } from 'toqr';

interface PairingQrProps {
  /** The pairing link to encode. One-time and short-lived — see `core/pair-link.ts`. */
  readonly value: string;
  readonly size: number;
  /** Module colour. The quiet zone and background use `background`. */
  readonly color: string;
  readonly background: string;
}

/** Quiet zone, in modules. The spec asks for four; QR readers cope with two at this size. */
const QUIET_MODULES = 2;

/**
 * A real pairing link runs to roughly 140 characters, which needs a 41-to-49 module symbol.
 * Below about 2pt per module a phone camera has to be held uncomfortably close to lock on, so
 * anything smaller than this is a preview that must be tappable to enlarge, not a thing to scan.
 */
export const MIN_SCANNABLE_MODULE_PT = 2;

/**
 * A scannable pairing link, drawn on the Skia canvas the rest of this screen already uses.
 *
 * Two phones in the same room do not need a link they can both read aloud — they need one
 * phone to point its camera at the other. This is the offline half of `pair-link.ts`: the
 * same one-time token the COPY and SHARE actions hand out, in the form that needs no network
 * and no messaging app in between.
 */
export function PairingQr({ value, size, color, background }: PairingQrProps) {
  const matrix = useMemo(() => {
    if (!value) return null;
    try {
      const modules = toQR(value);
      const side = Math.round(Math.sqrt(modules.length));
      if (side <= 0 || side * side !== modules.length) return null;
      return { modules, side };
    } catch (error: unknown) {
      // A link too long for a QR symbol is still copyable and shareable; do not take the screen down.
      console.warn('[pairing] could not encode the pairing link as a QR code', error);
      return null;
    }
  }, [value]);

  const path = useMemo(() => {
    if (!matrix) return null;
    const { modules, side } = matrix;
    const cell = size / (side + QUIET_MODULES * 2);
    const built = Skia.Path.Make();
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        if (!modules[y * side + x]) continue;
        built.addRect(
          Skia.XYWHRect(
            (x + QUIET_MODULES) * cell,
            (y + QUIET_MODULES) * cell,
            // Overdraw by a hair so neighbouring modules meet without a seam on fractional cells.
            cell + 0.5,
            cell + 0.5
          )
        );
      }
    }
    return built;
  }, [matrix, size]);

  if (!path) return null;

  return (
    <View
      accessibilityLabel="Pairing link as a scannable QR code"
      accessibilityRole="image"
      style={{ backgroundColor: background, borderRadius: 4, height: size, width: size }}
    >
      <Canvas style={{ height: size, width: size }}>
        <Group>
          <Path color={color} path={path} />
        </Group>
      </Canvas>
    </View>
  );
}
