import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { useDisplayPreferences } from '../hooks/use-display-preferences';
import { DisplayPreferencesStatus } from './display-preferences-status';

export function DistanceUnitsRow() {
  const theme = useTheme();
  const { distanceUnit, setDistanceUnit, ready, error, reload } = useDisplayPreferences();
  if (!ready) return <DisplayPreferencesStatus error={error} onRetry={reload} />;
  return (
    <View style={styles.container}>
      <View accessibilityRole="radiogroup" style={styles.options}>
        {(['km', 'mi'] as const).map((unit) => (
          <Pressable
            key={unit}
            accessibilityRole="radio"
            accessibilityLabel={unit === 'km' ? 'Kilometers' : 'Miles'}
            accessibilityState={{ selected: distanceUnit === unit }}
            onPress={() => void setDistanceUnit(unit)}
            style={({ pressed }) => [
              styles.option,
              {
                backgroundColor:
                  distanceUnit === unit ? theme.backgroundSelected : theme.background,
                borderColor: theme.backgroundSelected,
                opacity: pressed ? 0.58 : 1,
              },
            ]}
          >
            <ThemedText type="code">{unit === 'km' ? 'KM' : 'Mi'}</ThemedText>
          </Pressable>
        ))}
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
    padding: Spacing.three,
  },
});
