import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface RelayOnlyRowProps {
  /** Accent color for the enabled track (usually the amber "you" chrome). */
  accent: string;
  /** Whether relay-only is currently forced. */
  relayOnly: boolean;
  /**
   * Whether relay-only is actually enforced at the native endpoint yet. Until the native change
   * ships (Phase 2), the switch records the preference but local radios keep running; the copy is
   * honest about that so the toggle never over-promises.
   */
  enforced: boolean;
  /** Toggle handler — persists the choice. */
  onToggle: (relayOnly: boolean) => void;
}

/**
 * Force-relay-only control. When on (and enforced), the node routes only through the encrypted
 * relay and disables BLE, Wi-Fi Aware/Multipeer, hole-punched direct, and LAN discovery — useful
 * for a hostile or metered network where you don't want the phone advertising nearby at all.
 */
export function RelayOnlyRow({ accent, relayOnly, enforced, onToggle }: RelayOnlyRowProps) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">Force relay only</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Route all traffic through the encrypted relay and turn off Bluetooth, Wi-Fi Aware, direct,
          and LAN discovery — nothing is advertised nearby.
          {relayOnly && !enforced ? ' Saved — takes effect the next time the node restarts.' : ''}
        </ThemedText>
      </View>
      <Switch
        accessibilityRole="switch"
        accessibilityLabel="Force relay-only transport"
        value={relayOnly}
        onValueChange={onToggle}
        trackColor={{ true: accent, false: theme.backgroundSelected }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
});
