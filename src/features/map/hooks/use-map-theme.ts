import { useMemo } from 'react';

import { CryptidThemes, type CryptidTheme } from '@/constants/cryptid-theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

import { useMapColorScheme } from './use-map-color-scheme';

/**
 * The active chrome follows the OS while the selected map scheme supplies the
 * paired light/dark canvas palette.
 */
export function useMapTheme(): CryptidTheme {
  const scheme = useColorScheme();
  const mapScheme = useMapColorScheme().selected;
  const dark = scheme === 'dark';
  const base = dark ? CryptidThemes.deepsea : CryptidThemes.daybreak;
  return useMemo(
    () => ({ ...base, canvas: dark ? mapScheme.dark : mapScheme.light }),
    [base, dark, mapScheme]
  );
}
