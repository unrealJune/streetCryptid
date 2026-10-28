import { Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';

import { DOT_FIELD_SKSL, DOT_MATERIAL_SKSL } from './dot-field-sksl';

/**
 * Re-exported so callers keep one import for the shader and its compiler. The
 * source itself lives in a Skia-free module: host-side tooling (the headless
 * screenshotter in scripts/map-shot.ts) runs the exact same SkSL through
 * CanvasKit, and importing Skia here would drag react-native into node.
 */
export { DOT_FIELD_SKSL };

let cached: SkRuntimeEffect | null | undefined;
let material: SkRuntimeEffect | null | undefined;

/** Compile (once) and return the dot-field runtime effect, or null on failure. */
export function getDotFieldEffect(): SkRuntimeEffect | null {
  if (cached === undefined) cached = Skia.RuntimeEffect.Make(DOT_FIELD_SKSL);
  return cached;
}

export function getDotMaterialEffect(): SkRuntimeEffect | null {
  if (material === undefined) material = Skia.RuntimeEffect.Make(DOT_MATERIAL_SKSL);
  return material;
}
