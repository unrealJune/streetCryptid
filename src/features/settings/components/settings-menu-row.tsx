import { type Href, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { BrandFonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface SettingsMenuRowProps {
  readonly href: Href;
  readonly label: string;
  readonly detail?: string;
  /**
   * What is true behind this row right now, rendered as the readout under its label
   * ("MUTUAL FRIENDS", "RELAY · DIRECT · BLE", "2 FRIENDS").
   *
   * It exists so the menu still answers the question the old long scroll answered at a
   * glance — what state am I in — without having to open every page to find out. It is a
   * READOUT, not a description: say what the setting currently is, never what the page
   * behind it contains.
   */
  readonly value?: string | null;
  /** Tints the readout. Steel when omitted: a fact is not a signal. */
  readonly accent?: string;
}

/**
 * One entry in the Settings menu: a label, the state it currently holds, and a chevron.
 *
 * Two lines, in the app's two voices — the label in the condensed display face the map
 * islands use, the state under it in tracked mono, the way every readout in this app is
 * set. A single-line version of this row shipped briefly and was the reason Settings read
 * as an unfinished list: six identical labels, half of them with nothing on the right.
 *
 * Shaped to match {@link IdentityRow}, which was the first row in the app to behave this
 * way and is the reason the rest of Settings now does too.
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
        <ThemedText style={styles.label}>{label}</ThemedText>
        {value ? (
          <ThemedText
            numberOfLines={1}
            style={[styles.value, { color: accent ?? theme.textSecondary }]}
          >
            {value.toUpperCase()}
          </ThemedText>
        ) : null}
      </View>
      <SymbolView
        name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
        size={13}
        tintColor={theme.textSecondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 60,
    paddingVertical: Spacing.two,
  },
  copy: {
    flex: 1,
    gap: 1,
    minWidth: 0,
  },
  label: {
    fontFamily: BrandFonts.display,
    fontSize: 21,
    // Stated as well as named. The family alone is enough on iOS and web, but Android
    // resolves weight separately and will synthesise a bold over an already-bold face.
    fontWeight: '700',
    lineHeight: 24,
  },
  value: {
    fontFamily: BrandFonts.data,
    fontSize: 10.5,
    fontWeight: '500',
    letterSpacing: 1.3,
    lineHeight: 14,
  },
});
