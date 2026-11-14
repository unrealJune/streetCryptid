import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import type { RosterView } from '../core/repeaters';
import { RemovableRow } from './removable-row';

interface RosterMachinesProps {
  readonly roster: RosterView;
  readonly accent: string;
  readonly warning: string;
  /** A change to this roster is in flight. */
  readonly busy: boolean;
  /** Removing a machine; absent on a binary without the owner's controls. */
  readonly onRemove?: (machineId: string) => void;
  /** Add another machine (the claim screen). */
  readonly onAdd?: () => void;
}

/**
 * The machines in the roster this phone owns, one row each, in the card {@link RosterPeople}
 * draws. A named machine shows its short id under the name, so two "Desktop"s can be told apart.
 */
export function RosterMachines({
  roster,
  accent,
  warning,
  busy,
  onRemove,
  onAdd,
}: RosterMachinesProps) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
      {roster.machines.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          No machines left in it.
        </ThemedText>
      ) : null}
      {roster.machines.map((machine) => {
        const detail = machine.name ? machine.short : undefined;
        if (!onRemove) {
          return (
            <View key={machine.id} style={styles.copy}>
              <ThemedText type="small">{machine.label}</ThemedText>
              {detail ? (
                <ThemedText type="code" themeColor="textSecondary">
                  {detail}
                </ThemedText>
              ) : null}
            </View>
          );
        }
        return (
          <RemovableRow
            key={machine.id}
            label={machine.label}
            detail={detail}
            accent={accent}
            warning={warning}
            busy={busy}
            removeLabel={`Remove machine ${machine.label}`}
            confirmCopy="Once it hears, it stops carrying anyone and shows a new claim code. Getting it back means claiming it again."
            onRemove={() => onRemove(machine.id)}
          />
        );
      })}
      {onAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a repeater"
          onPress={onAdd}
          style={({ pressed }) => [
            styles.add,
            { borderTopColor: theme.backgroundSelected },
            pressed && styles.pressed,
          ]}
        >
          <ThemedText type="code" style={{ color: accent }}>
            ADD A REPEATER ›
          </ThemedText>
        </Pressable>
      ) : null}
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
  copy: { gap: Spacing.one },
  add: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
  },
  pressed: { opacity: 0.58 },
});
