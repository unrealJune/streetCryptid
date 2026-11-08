import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import type { RosterView } from '../core/repeaters';

interface RosterCardProps {
  readonly roster: RosterView;
  /** Accent for the switch's on track. */
  readonly accent: string;
  /** The switch is mid-change. */
  readonly busy: boolean;
  readonly onCarryChange: (carry: boolean) => void;
}

/**
 * One roster: whose it is, its machines, and the one choice there is about it, whether it
 * carries your trail (REPEATERS.md §2.1: carrying is the only opt-in).
 */
export function RosterCard({ roster, accent, busy, onCarryChange }: RosterCardProps) {
  const theme = useTheme();
  const machines = roster.machines.length;
  const detail = [
    `${machines} ${machines === 1 ? 'machine' : 'machines'}`,
    roster.open ? 'open to anyone' : 'invite only',
    `carrying ${roster.carried} ${roster.carried === 1 ? 'person' : 'people'}`,
  ].join(' · ');

  return (
    <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.head}>
        <View style={styles.copy}>
          <ThemedText type="smallBold">{roster.ownerLabel}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {detail}
          </ThemedText>
        </View>
      </View>
      {machines > 0 ? (
        <ThemedText type="code" themeColor="textSecondary">
          {roster.machines.join('  ')}
        </ThemedText>
      ) : null}
      <View style={[styles.carry, { borderTopColor: theme.backgroundSelected }]}>
        <View style={styles.copy}>
          <ThemedText type="small">Carry my trail</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {roster.carriesMe
              ? 'Kept on these machines, sealed, for friends to pick up while your phone sleeps.'
              : 'Off. These machines do not keep your trail.'}
          </ThemedText>
        </View>
        <Switch
          accessibilityRole="switch"
          accessibilityLabel={`Carry my trail on ${roster.ownerLabel}`}
          disabled={busy}
          value={roster.carriesMe}
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
  head: {
    flexDirection: 'row',
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  carry: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    paddingTop: Spacing.two,
  },
});
