import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { useDisplayPreferences } from '../hooks/use-display-preferences';
import { DisplayPreferencesStatus } from './display-preferences-status';

export function FriendConnectionDetailsRow({ accent }: { readonly accent: string }) {
  const theme = useTheme();
  const { showFriendConnectionDetails, setShowFriendConnectionDetails, ready, error, reload } =
    useDisplayPreferences();
  if (!ready) return <DisplayPreferencesStatus error={error} onRetry={reload} />;
  return (
    <View style={styles.container}>
      <View style={[styles.row, { borderColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold" style={styles.label}>
          Show friend connection details
        </ThemedText>
        <Switch
          accessibilityLabel="Show friend connection details"
          accessibilityRole="switch"
          value={showFriendConnectionDetails}
          onValueChange={(enabled) => void setShowFriendConnectionDetails(enabled)}
          trackColor={{ true: accent, false: theme.backgroundSelected }}
        />
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
  row: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  label: { flex: 1 },
});
