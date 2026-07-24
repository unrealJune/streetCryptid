import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { TransportPreferences } from '@/features/social/net/persistence';
import { useTheme } from '@/hooks/use-theme';

interface TransportControlsProps {
  accent: string;
  preferences: TransportPreferences;
  onToggle: (transport: keyof TransportPreferences, enabled: boolean) => void;
}

const TRANSPORTS: {
  id: keyof TransportPreferences;
  label: string;
  detail: string;
}[] = [
  {
    id: 'relay',
    label: 'Relay',
    detail: 'Authenticated internet relay paths.',
  },
  {
    id: 'ip',
    label: 'Direct IP / LAN',
    detail: 'Hole-punched IP, ticket-seeded LAN, and mDNS paths.',
  },
  {
    id: 'ble',
    label: 'Bluetooth LE',
    detail: 'Nearby BLE discovery, pairing, and data paths.',
  },
];

export function TransportControls({
  accent,
  preferences,
  onToggle,
}: TransportControlsProps) {
  const theme = useTheme();
  const enabledCount = Object.values(preferences).filter(Boolean).length;

  return (
    <View style={[styles.list, { borderColor: theme.backgroundSelected }]}>
      {TRANSPORTS.map((transport, index) => {
        const enabled = preferences[transport.id];
        const isOnlyEnabled = enabled && enabledCount === 1;
        return (
          <View
            key={transport.id}
            style={[
              styles.row,
              index > 0 && {
                borderTopColor: theme.backgroundSelected,
                borderTopWidth: StyleSheet.hairlineWidth,
              },
            ]}
          >
            <View style={styles.copy}>
              <ThemedText type="smallBold">{transport.label}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {transport.detail}
                {isOnlyEnabled ? ' At least one transport must stay on.' : ''}
              </ThemedText>
            </View>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel={`${transport.label} transport`}
              disabled={isOnlyEnabled}
              value={enabled}
              onValueChange={(value) => onToggle(transport.id, value)}
              trackColor={{ true: accent, false: theme.backgroundSelected }}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
});
