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
        <Text style={[styles.detail, { color: chrome.steel }]}>
          Bump nearby or exchange a one-time link.
        </Text>
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
    minHeight: 68,
    paddingBottom: Spacing.three,
    paddingTop: Spacing.two,
  },
  copy: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  status: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  detail: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 15,
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
