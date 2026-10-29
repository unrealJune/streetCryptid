import { Skia, type SkRuntimeEffect } from '@shopify/react-native-skia';

import { dotFieldSksl, DOT_MATERIAL_SKSL, DOT_POINT_MATERIAL_SKSL } from './dot-field-sksl';
import type { DotFieldMode } from './shader-uniforms';

/**
 * Re-exported so callers keep one import for the shader and its compiler. The
 * source itself lives in a Skia-free module: host-side tooling (the headless
 * screenshotter in scripts/map-shot.ts) runs the exact same SkSL through
 * CanvasKit, and importing Skia here would drag react-native into node.
 */
export { DOT_FIELD_SKSL } from './dot-field-sksl';

const cached = new Map<string, SkRuntimeEffect | null>();
const material = new Map<boolean, SkRuntimeEffect | null>();

/** Compile (once) and return the dot-field runtime effect, or null on failure. */
export function getDotFieldEffect(mode: DotFieldMode): SkRuntimeEffect | null {
  const key = `${mode.filteredAreas}/${mode.blendLevels}`;
  const previous = cached.get(key);
  if (previous !== undefined) return previous;
  const effect = Skia.RuntimeEffect.Make(dotFieldSksl(mode));
  cached.set(key, effect);
  return effect;
}

export function getDotMaterialEffect(filteredAreas = true): SkRuntimeEffect | null {
  const previous = material.get(filteredAreas);
  if (previous !== undefined) return previous;
  const effect = Skia.RuntimeEffect.Make(
    filteredAreas ? DOT_MATERIAL_SKSL : DOT_POINT_MATERIAL_SKSL
  );
  material.set(filteredAreas, effect);
  return effect;
}
