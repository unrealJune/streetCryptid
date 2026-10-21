import {
  Group,
  Image as SkiaImage,
  ImageShader,
  Rect,
  Shader,
  Skia,
  type SkImage,
} from '@shopify/react-native-skia';
import { useMemo } from 'react';
import type { SharedValue } from 'react-native-reanimated';

import type { ScreenHexLattice } from '../core/hex-lattice';
import { HEX_CLIP_IMAGE_SKSL, hexClipInner, hexClipUniforms } from './hex-clip';
import { punchRect } from './loading-hex-grid';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

let effect: ReturnType<typeof Skia.RuntimeEffect.Make> | undefined;
function getEffect() {
  if (effect === undefined) effect = Skia.RuntimeEffect.Make(HEX_CLIP_IMAGE_SKSL);
  return effect;
}

/**
 * A region bitmap whose edges follow the hex lattice (see `hex-clip.ts`). The interior is an
 * ordinary image draw; only the band along the edges goes through the clip shader, in up to four
 * rectangles Skia culls whenever they are off screen — which, for a region three viewports a side,
 * is nearly always. Without a lattice it is a plain image.
 */
export function HexClippedImage({
  image,
  rect,
  lattice,
  opacity,
}: {
  image: SkImage;
  /** Anchor-space rect the bitmap is drawn at. */
  rect: Box;
  lattice: ScreenHexLattice | null;
  opacity?: SharedValue<number> | number;
}) {
  const compiled = lattice ? getEffect() : null;
  const inner = useMemo(() => (lattice ? hexClipInner(rect, lattice) : null), [rect, lattice]);
  const band = useMemo(() => {
    if (!compiled) return [];
    // `punchRect` answers relative to `rect`'s corner; the shader works in anchor space.
    return punchRect(rect, inner).map((piece) => ({
      ...piece,
      x: piece.x + rect.x,
      y: piece.y + rect.y,
    }));
  }, [compiled, rect, inner]);
  const uniforms = useMemo(() => hexClipUniforms(rect, lattice), [rect, lattice]);
  const imageRect = useMemo(() => Skia.XYWHRect(rect.x, rect.y, rect.width, rect.height), [rect]);
  const innerClip = useMemo(
    () => (inner ? Skia.XYWHRect(inner.x, inner.y, inner.width, inner.height) : null),
    [inner]
  );

  if (!compiled) {
    return (
      <SkiaImage
        image={image}
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        fit="fill"
        opacity={opacity}
      />
    );
  }

  return (
    <Group opacity={opacity}>
      {innerClip && (
        // The source rect is the same `rect`, so the interior lines up with the band exactly.
        <Group clip={innerClip}>
          <SkiaImage
            image={image}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            fit="fill"
          />
        </Group>
      )}
      {band.map((piece, index) => (
        <Rect key={index} x={piece.x} y={piece.y} width={piece.width} height={piece.height}>
          <Shader source={compiled} uniforms={uniforms}>
            <ImageShader image={image} rect={imageRect} fit="fill" />
          </Shader>
        </Rect>
      ))}
    </Group>
  );
}
