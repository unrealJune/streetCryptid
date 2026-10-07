import {
  Image,
  ImageShader,
  Rect,
  Shader,
  Skia,
  type SkImage,
  type SkRuntimeEffect,
} from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import type { ViewTransform } from '../core/camera';
import { LocalMapGroup, localCoverage } from './local-space';
import { prevRectUniform, type RevealRect } from './reveal-mask';

/** Both the reveal and settled image use exactly the same small, layer-local geometry. */
export function RegionLayer({
  image,
  rect,
  camera,
  cellImage,
  revealEffect,
  revealFront,
  previous = null,
  opacity,
}: {
  image: SkImage;
  rect: RevealRect;
  camera: SharedValue<ViewTransform>;
  cellImage?: SkImage | null;
  revealEffect?: SkRuntimeEffect | null;
  revealFront: SharedValue<number>;
  previous?: RevealRect | null;
  opacity?: SharedValue<number>;
}) {
  const shaderRect = useMemo(
    () => Skia.XYWHRect(0, 0, rect.width, rect.height),
    [rect.width, rect.height]
  );
  const prev = useMemo(() => prevRectUniform(localCoverage(rect, previous)), [rect, previous]);
  const uniforms = useDerivedValue(() => ({ uReveal: revealFront.value, uPrevRect: prev }));
  return (
    <LocalMapGroup origin={rect} camera={camera}>
      {revealEffect && cellImage ? (
        <Rect x={0} y={0} width={rect.width} height={rect.height}>
          <Shader source={revealEffect} uniforms={uniforms}>
            <ImageShader image={image} rect={shaderRect} fit="fill" />
            <ImageShader image={cellImage} rect={shaderRect} fit="fill" />
          </Shader>
        </Rect>
      ) : (
        <Image
          image={image}
          x={0}
          y={0}
          width={rect.width}
          height={rect.height}
          fit="fill"
          opacity={opacity}
        />
      )}
    </LocalMapGroup>
  );
}
