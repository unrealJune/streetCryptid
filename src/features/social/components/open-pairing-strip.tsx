import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

interface OpenPairingStripProps {
  readonly theme: CryptidTheme;
  onOpen(): void;
}

export function OpenPairingStrip({ theme, onOpen }: OpenPairingStripProps) {
  const { chrome } = theme;

  return (
    <Pressable
      accessibilityHint="Opens the active pairing screen and starts nearby listening"
      accessibilityLabel="Open pairing"
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.strip,
        {
          borderBottomColor: chrome.islandBorder,
          opacity: pressed ? 0.62 : 1,
        },
      ]}
    >
      <View style={styles.copy}>
        <Text style={[styles.status, { color: chrome.green }]}>PAIR WITH SOMEONE</Text>
      </View>
      <View style={[styles.action, { borderColor: chrome.green }]}>
        <Text style={[styles.actionLabel, { color: chrome.green }]}>OPEN PAIRING</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    // The button is the tallest thing in here at 36; the strip lost its second
    // line of copy and kept 68px of room for it, which read as a gap in the
    // roster rather than as a row.
    minHeight: 52,
    paddingVertical: Spacing.two,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  status: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  action: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: Spacing.three,
  },
  actionLabel: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
  },
});
