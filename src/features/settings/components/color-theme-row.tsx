import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { COLOR_THEME_PREFERENCES, colorThemeLabel } from '../core/color-theme';
import { useDisplayPreferences } from '../hooks/use-display-preferences';
import { DisplayPreferencesStatus } from './display-preferences-status';

/**
 * Light / Dark / System, in that order.
 *
 * `System` sits last because it is the default: a picker reads as a spectrum, and the two ends
 * are the choices someone came here to make. Selecting one takes effect on the next frame —
 * {@link useColorScheme} reads the same store — so there is no apply step and nothing to confirm.
 */
export function ColorThemeRow() {
  const theme = useTheme();
  const { colorTheme, setColorTheme, ready, error, reload } = useDisplayPreferences();
  if (!ready) return <DisplayPreferencesStatus error={error} onRetry={reload} />;

  return (
    <View style={styles.container}>
      <View accessibilityRole="radiogroup" style={styles.options}>
        {COLOR_THEME_PREFERENCES.map((preference) => {
          const selected = colorTheme === preference;
          return (
            <Pressable
              key={preference}
              accessibilityRole="radio"
              accessibilityLabel={`${colorThemeLabel(preference)} theme`}
              accessibilityState={{ selected }}
              onPress={() => void setColorTheme(preference)}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: selected ? theme.backgroundSelected : theme.background,
                  borderColor: theme.backgroundSelected,
                  opacity: pressed ? 0.58 : 1,
                },
              ]}
            >
              <ThemedText type="code">{colorThemeLabel(preference).toUpperCase()}</ThemedText>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <ThemedText accessibilityRole="alert" type="small">
          {error}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.two },
  options: { flexDirection: 'row', gap: Spacing.two },
  option: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.three,
  },
});
