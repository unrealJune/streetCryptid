import { CryptidThemes, type CryptidTheme } from '@/constants/cryptid-theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * The active cryptid theme, driven by the OS color scheme: light → daybreak
 * (the default), dark → deepsea. (nocturne stays a manual alternate for later.)
 */
export function useMapTheme(): CryptidTheme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? CryptidThemes.deepsea : CryptidThemes.daybreak;
}
