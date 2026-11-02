import { createContext, useContext } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

/**
 * How far the drawer stands between `collapsed` (0) and `peek` (1), live on the UI thread.
 *
 * Derived from the drawer's animated HEIGHT, not from the detent. The detent only changes when a
 * drag is released, so a body that styled itself off it held its expanded layout for the whole
 * drag and then swapped to the one-liner in a single frame. Bodies read this instead and morph
 * under the finger: the readout slides off the bottom edge as the island shrinks over it.
 *
 * Clamped to 0–1, so above `peek` (mid, full) a body simply sees "expanded".
 */
export const DrawerProgressContext = createContext<SharedValue<number> | null>(null);

/** The drawer's live collapse progress, or a constant 1 (expanded) outside a drawer. */
export function useDrawerProgress(): SharedValue<number> {
  const fallback = useSharedValue(1);
  return useContext(DrawerProgressContext) ?? fallback;
}
