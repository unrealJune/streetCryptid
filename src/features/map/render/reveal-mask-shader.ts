import { Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';

import { REVEAL_MASK_SKSL } from './reveal-mask';

let cached: SkRuntimeEffect | null | undefined;

/**
 * Compile (once) and return the loading-reveal runtime effect, or null on
 * failure. See `reveal-mask.ts` for the shader source and its pure JS twins.
 */
export function getRevealMaskEffect(): SkRuntimeEffect | null {
  if (cached === undefined) cached = Skia.RuntimeEffect.Make(REVEAL_MASK_SKSL);
  return cached;
}
