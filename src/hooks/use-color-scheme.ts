import { useColorScheme as useSystemColorScheme } from 'react-native';

import { resolveColorTheme } from '@/features/settings/core/color-theme';
import { useDisplayPreferences } from '@/features/settings/hooks/use-display-preferences';

/**
 * The scheme every screen paints in — the user's CHOICE, resolved against the OS.
 *
 * This is deliberately the only colour-scheme hook the app imports: while it re-exported React
 * Native's, "follow the system" was not a setting but a hard rule, and a dark-mode toggle had
 * nowhere to take effect. Screens should keep importing this rather than `react-native`'s, or
 * they opt themselves back out of the preference without looking like they have.
 *
 * Before the preference store has loaded it reports `system`, so the first frame matches the OS
 * and then settles to the choice. That is the right way round: someone on `system` — the default,
 * and most people — never sees a change at all.
 */
export function useColorScheme(): 'light' | 'dark' {
  const system = useSystemColorScheme();
  const { colorTheme, ready } = useDisplayPreferences();
  return resolveColorTheme(ready ? colorTheme : 'system', system);
}
