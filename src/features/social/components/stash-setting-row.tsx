import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface StashSettingRowProps {
  /** Accent color for the enabled track (usually the friend-green chrome). */
  accent: string;
  /** Whether offline delivery is currently opted into. */
  optedIn: boolean;
  /** Toggle handler — persists the choice and (on) registers stash grants. */
  onToggle: (optedIn: boolean) => void;
}

/**
 * Opt-in control for offline delivery via the trail stash. Rendered only when a stash is deployed
 * (`snapshot.stash.available`). Copy is deliberately explicit that the relay is blind — it holds
 * only encrypted trails it can never read.
 */
export function StashSettingRow({ accent, optedIn, onToggle }: StashSettingRowProps) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">Offline delivery</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Keep an encrypted, blind relay in sync so friends receive your trail even when your phones
          are never online at the same time. The relay only holds sealed data it can’t read.
        </ThemedText>
      </View>
      <Switch
        accessibilityRole="switch"
        accessibilityLabel="Offline delivery via the trail stash"
        value={optedIn}
        onValueChange={onToggle}
        trackColor={{ true: accent, false: theme.backgroundSelected }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
});
