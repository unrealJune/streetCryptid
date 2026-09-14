/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { chromeToColors } from '@/constants/theme';
import { useMapTheme } from '@/features/map/hooks/use-map-theme';

/**
 * The five template tokens, from the live chrome.
 *
 * This used to index a static `Colors` table, which meant Settings, the account gate and every
 * `ThemedText` in the app stayed in daybreak's steel-blue no matter which map scheme was
 * selected — the map changed and nothing around it did. It now reads the same retinted chrome the
 * islands and FABs do, so the palette is one choice for the whole app.
 *
 * The import direction (a top-level hook reaching into `features/map`) is deliberate: the map
 * scheme IS the app's theme now, and `useMapTheme` is where it is composed. Everything else keeps
 * calling `useTheme()` and needed no change.
 */
export function useTheme() {
  const theme = useMapTheme();
  return chromeToColors(theme.chrome, theme.scheme);
}
