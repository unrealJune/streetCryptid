import { useEffect, useState } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';

import { resolveColorTheme } from '@/features/settings/core/color-theme';
import { useDisplayPreferences } from '@/features/settings/hooks/use-display-preferences';

/**
 * The web half of {@link useColorScheme}, with one extra rule: static rendering has no OS scheme
 * to read, so the pre-hydration answer is `light` regardless. The stored preference then applies
 * on the client exactly as it does on a phone.
 */
export function useColorScheme(): 'light' | 'dark' {
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    // Intentional: flip a hydration flag once on the client to support static rendering.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasHydrated(true);
  }, []);

  const system = useSystemColorScheme();
  const { colorTheme, ready } = useDisplayPreferences();

  if (!hasHydrated) return 'light';
  return resolveColorTheme(ready ? colorTheme : 'system', system);
}
