import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * A setting with one switch: what it is, what its current position means, and the switch. The
 * same row the stash card and {@link RepeaterCard} draw under their hairline, for the repeater
 * pages' settings that belong to no card.
 */
export function OptionSwitch({
  title,
  text,
  value,
  accent,
  disabled = false,
  accessibilityLabel,
  onChange,
}: {
  readonly title: string;
  /** What the current position means. */
  readonly text?: string;
  readonly value: boolean;
  readonly accent: string;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly onChange: (next: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.option}>
      <View style={styles.copy}>
        <ThemedText type="small">{title}</ThemedText>
        {text ? (
          <ThemedText type="small" themeColor="textSecondary">
            {text}
          </ThemedText>
        ) : null}
      </View>
      <Switch
        accessibilityRole="switch"
        accessibilityLabel={accessibilityLabel ?? title}
        disabled={disabled}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: accent, false: theme.backgroundSelected }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  option: { alignItems: 'center', flexDirection: 'row', gap: Spacing.three },
  copy: { flex: 1, gap: Spacing.one },
});
