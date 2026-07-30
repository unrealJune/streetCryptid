import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { SHARE_INTERVAL_OPTIONS_MS } from '@/features/social/net/persistence';
import { useTheme } from '@/hooks/use-theme';

interface ShareIntervalRowProps {
  accent: string;
  intervalMs: number;
  onSelect: (intervalMs: number) => void;
}

const LABELS: Record<number, string> = {
  60_000: '1 MIN',
  300_000: '5 MIN',
  900_000: '15 MIN',
};

/**
 * Picks how often location is published. Deliberately a fixed set rather than a slider — see
 * `SHARE_INTERVAL_OPTIONS_MS`.
 *
 * The copy names the real trade-off (battery against how current friends' maps are) and says the
 * cadence is constant, because that is the property people are actually choosing: whichever they
 * pick, the rate never changes with what they're doing, so the timing of their updates can't be
 * read as a record of their movements.
 */
export function ShareIntervalRow({ accent, intervalMs, onSelect }: ShareIntervalRowProps) {
  const theme = useTheme();

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">Update frequency</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          How often your location goes out. Slower saves battery; faster keeps friends&apos; maps
          current. Whichever you pick, it stays constant — it never speeds up when you start moving.
        </ThemedText>
      </View>
      <View style={styles.options}>
        {SHARE_INTERVAL_OPTIONS_MS.map((option) => {
          const selected = option === intervalMs;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={`Update every ${LABELS[option] ?? String(option)}`}
              key={option}
              onPress={() => onSelect(option)}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: selected ? accent : 'transparent',
                  borderColor: selected ? accent : theme.backgroundSelected,
                  opacity: pressed ? 0.58 : 1,
                },
              ]}
            >
              <ThemedText
                type="code"
                style={{ color: selected ? theme.background : theme.textSecondary }}
              >
                {LABELS[option] ?? String(option)}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    padding: Spacing.three,
  },
  copy: {
    gap: Spacing.one,
  },
  options: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  option: {
    alignItems: 'center',
    borderRadius: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
});
