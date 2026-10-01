import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

/**
 * Whether the app is on screen right now — the gate for anything that repaints on a loop.
 *
 * ## Why this exists
 * Three Skia layers drive unbounded `withRepeat(..., -1)` animations, and none of them stopped
 * when the app left the screen. That is not merely wasteful on iOS, it is load-bearing: with
 * `UIBackgroundModes: ["location"]` and `allowsBackgroundLocationUpdates` the process is NOT
 * suspended while sharing is on, so a swiped-away app keeps its Reanimated frame callbacks and
 * Skia repaints running indefinitely. MetricKit recorded 41 CPU exceptions in 7 days — 48s of CPU
 * inside a 60s window, the `MXCPUExceptionDiagnostic` threshold — on a JS thread doing exactly
 * this, for a canvas nobody could see.
 *
 * ## Why `!== 'background'` and not `=== 'active'`
 * iOS reports `'inactive'` during a cold launch, while a permission alert is up, and in the app
 * switcher. Treating those as "not visible" would cancel animations mid-launch and on every
 * permission prompt. `native-runtime-owner.ts` records the same lesson about using
 * `AppState.currentState` as a guard at all: the only state that reliably means "off screen" is
 * `'background'`.
 *
 * Callers should thread this in beside their existing `reducedMotion` check rather than adding a
 * second branch — both answer the same question, "should this thing be moving".
 */
function subscribe(onChange: () => void): () => void {
  const sub = AppState.addEventListener('change', onChange);
  return () => sub.remove();
}

function isActive(): boolean {
  return AppState.currentState !== 'background';
}

export function useIsAppActive(): boolean {
  // `useSyncExternalStore` rather than `useState` + `useEffect`: `AppState` is exactly the external
  // store it exists for, and reading the snapshot on every render closes the window between the
  // first render and the subscription attaching — which on a cold launch is the common case, not a
  // race worth ignoring. The snapshot is a boolean, so there is nothing to memoise.
  return useSyncExternalStore(subscribe, isActive);
}
