import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';

/**
 * Settings is one sheet with a stack inside it.
 *
 * The root layout presents `settings` as a modal over the map; this stack is what
 * lets that sheet have depth — a menu that pushes to a page, with the platform's
 * own back gesture and animation, instead of a single scroll that had grown long
 * enough that nothing in it could be found.
 *
 * `headerShown: false` matches the rest of the app: there is no tab bar and no
 * header anywhere, so each page draws its own ✕ / ‹ (see `SettingsPage`).
 * `contentStyle` paints the sheet background so the push animation never flashes
 * the default white underneath in dark mode.
 *
 * The sheet measures its OWN safe area. Without this provider every page read the window's insets,
 * which describe edges a sheet never touches: on an unfolded iPhone Duo in landscape the page
 * padded its right side by the status column (~84 pt) and its top by the status bar, so the column
 * sat off-centre and clipped inside a sheet that has no inset at all.
 */
export default function SettingsLayout() {
  const theme = useTheme();

  return (
    <SafeAreaProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.background },
        }}
      />
    </SafeAreaProvider>
  );
}
