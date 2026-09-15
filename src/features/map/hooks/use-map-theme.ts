import { useMemo } from 'react';

import { CryptidThemes, type CryptidTheme } from '@/constants/cryptid-theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

import { deriveChrome } from '../theme/derive-chrome';
import { useMapColorScheme } from './use-map-color-scheme';

/**
 * The whole app's theme: the selected map scheme supplies the canvas palette, and the chrome is
 * retinted from that same palette (see `theme/derive-chrome.ts`).
 *
 * `daybreak`/`deepsea` are no longer the chrome — they are the BASE the retint preserves the
 * lightness of, which is why picking Kyoto now moves the islands and Settings with the map instead
 * of leaving Seattle's steel-blue chrome sitting on a lilac canvas.
 */
export function useMapTheme(): CryptidTheme {
  const scheme = useColorScheme();
  const mapScheme = useMapColorScheme().selected;
  const dark = scheme === 'dark';
  const base = dark ? CryptidThemes.deepsea : CryptidThemes.daybreak;
  return useMemo(() => {
    const canvas = dark ? mapScheme.dark : mapScheme.light;
    return { ...base, chrome: deriveChrome(base, canvas), canvas };
  }, [base, dark, mapScheme]);
}
