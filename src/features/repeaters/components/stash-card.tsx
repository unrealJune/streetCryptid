import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface StashCardProps {
  /** Whether this phone's trail goes to the stash: the delivery mode is `stash`. */
  readonly carriesMe: boolean;
  /** The longest the stash keeps anything, already in words ("48 hours"). */
  readonly retention: string;
  readonly accent: string;
  readonly busy: boolean;
  /** False on a build with no stash deployed: the switch shows, but cannot be turned on. */
  readonly available?: boolean;
  readonly onCarryChange: (carry: boolean) => void;
}

/**
 * The hosted stash, beside the repeaters because it does the same job, and apart from them because
 * it is not one: nobody owns it, it has no roster, and it forgets on a clock (REPEATERS.md §5.1).
 * Its switch is the delivery mode, the same setting Settings → Delivery shows, so the two can never
 * disagree about whether it carries you.
 */
export function StashCard({
  carriesMe,
  retention,
  accent,
  busy,
  available = true,
  onCarryChange,
}: StashCardProps) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">streetCryptid stash</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {`Hosted, owned by nobody · keeps only your latest sealed fix, for at most ${retention}, in memory`}
        </ThemedText>
      </View>
      <View style={[styles.option, { borderTopColor: theme.backgroundSelected }]}>
        <View style={styles.copy}>
          <ThemedText type="small">Carry my location</ThemedText>
          {carriesMe ? null : (
            <ThemedText type="small" themeColor="textSecondary">
              Off. Friends catch up from each other only.
            </ThemedText>
          )}
        </View>
        <Switch
          accessibilityRole="switch"
          accessibilityLabel="Carry my location on the streetCryptid stash"
          disabled={busy || !available}
          value={carriesMe && available}
          onValueChange={onCarryChange}
          trackColor={{ true: accent, false: theme.backgroundSelected }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    padding: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  option: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    paddingTop: Spacing.two,
  },
});
