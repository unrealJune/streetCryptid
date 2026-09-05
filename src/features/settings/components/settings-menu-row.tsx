import { type Href, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface SettingsMenuRowProps {
  readonly href: Href;
  readonly label: string;
  readonly detail: string;
  /**
   * A short right-aligned status ("3 of 3 on", "On", "Unavailable"). It exists so the
   * menu still answers the question the old long scroll answered at a glance — what
   * state am I in — without having to open every page to find out.
   */
  readonly value?: string | null;
  /** Tints the value. Steel when omitted: a menu row is chrome, not a signal. */
  readonly accent?: string;
}

/**
 * One entry in the Settings menu: a label, a one-line description of what lives
 * behind it, its current state, and a chevron.
 *
 * Shaped to match {@link IdentityRow}, which was the first row in the app to behave
 * this way and is the reason the rest of Settings now does too.
 */
export function SettingsMenuRow({ href, label, detail, value, accent }: SettingsMenuRowProps) {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Pressable
      accessibilityHint={detail}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityValue={value ? { text: value } : undefined}
      onPress={() => router.push(href)}
      style={({ pressed }) => [
        styles.row,
        { borderColor: theme.backgroundSelected, opacity: pressed ? 0.58 : 1 },
      ]}
    >
      <View style={styles.copy}>
        <ThemedText type="smallBold">{label}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {detail}
        </ThemedText>
      </View>
      {value ? (
        <ThemedText
          type="code"
          style={accent ? { color: accent } : undefined}
          themeColor="textSecondary"
        >
          {value}
        </ThemedText>
      ) : null}
      <ThemedText type="code" themeColor="textSecondary">
        {'>'}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 64,
    paddingVertical: Spacing.two,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
    minWidth: 0,
  },
});
