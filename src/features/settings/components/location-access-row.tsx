import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { LocationDisclosureStatus } from '@/features/social/hooks/use-location-sharing';
import { useTheme } from '@/hooks/use-theme';

interface LocationAccessRowProps {
  accent: string;
  status: LocationDisclosureStatus;
  onTurnOn: () => void;
}

/**
 * Lets a person who said "Not now" on the background-location disclosure change their mind
 * later, without hunting through the OS settings app. Android permissions can't be re-requested
 * as a simple toggle once denied by the OS, so "accepted" just links out to the app's OS settings
 * page to review/revoke — there's nothing meaningful for us to toggle on this side once granted.
 */
export function LocationAccessRow({ accent, status, onTurnOn }: LocationAccessRowProps) {
  const theme = useTheme();
  const declined = status === 'declined';

  return (
    <View style={[styles.row, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">Background location</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {declined
            ? "Off — territory exploration and friend sharing won't update while the app is closed."
            : 'Used for territory exploration and friend location sharing.'}
        </ThemedText>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={declined ? onTurnOn : () => void Linking.openSettings()}
        style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
      >
        <ThemedText type="code" style={{ color: accent }}>
          {declined ? 'TURN ON' : 'REVIEW'}
        </ThemedText>
      </Pressable>
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
