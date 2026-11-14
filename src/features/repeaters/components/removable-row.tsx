import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

/**
 * One entry in a roster list (a person, a machine), with a REMOVE that asks once before it acts:
 * the first tap shows what removing means and turns REMOVE the warning colour, the second acts.
 */
export function RemovableRow({
  label,
  detail,
  accent,
  warning,
  busy,
  removeLabel,
  confirmCopy,
  onRemove,
  secondary,
}: {
  readonly label: string;
  /** A secondary line under the label (a machine's short id). */
  readonly detail?: string;
  readonly accent: string;
  readonly warning: string;
  readonly busy: boolean;
  readonly removeLabel: string;
  readonly confirmCopy: string;
  readonly onRemove: () => void;
  /** A second, reversible action beside REMOVE, taken without confirming. */
  readonly secondary?: {
    readonly label: string;
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={styles.row}>
      <View style={styles.copy}>
        <ThemedText type="small">{label}</ThemedText>
        {detail ? (
          <ThemedText type="code" themeColor="textSecondary">
            {detail}
          </ThemedText>
        ) : null}
        {confirming ? (
          <ThemedText accessibilityRole="alert" type="small" themeColor="textSecondary">
            {confirmCopy}
          </ThemedText>
        ) : null}
      </View>
      {secondary && !confirming ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={secondary.accessibilityLabel}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={secondary.onPress}
          style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
        >
          <ThemedText type="code" themeColor="textSecondary">
            {secondary.label}
          </ThemedText>
        </Pressable>
      ) : null}
      {confirming ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => setConfirming(false)}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <ThemedText type="code" themeColor="textSecondary">
            CANCEL
          </ThemedText>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={confirming ? `Confirm: ${removeLabel}` : removeLabel}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          onRemove();
        }}
        style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
      >
        <ThemedText type="code" style={{ color: confirming ? warning : accent }}>
          REMOVE
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  action: {
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.58,
  },
});
