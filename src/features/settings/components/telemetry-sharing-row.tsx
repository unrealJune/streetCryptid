import { useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  isTelemetryExportEnabled,
  setTelemetryExportEnabled,
  subscribeTelemetryExport,
} from '@/features/dev/telemetry';
import { useTheme } from '@/hooks/use-theme';

/**
 * The user's switch for sending diagnostics to our collector (`export-consent.ts`). Only rendered
 * in builds that carry telemetry at all; a stripped build has nothing to switch.
 */
export function TelemetrySharingRow({ accent }: { readonly accent: string }) {
  const theme = useTheme();
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void isTelemetryExportEnabled().then((value) => {
      if (live) setEnabled(value);
    });
    const unsubscribe = subscribeTelemetryExport(setEnabled);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return (
    <View style={styles.container}>
      <View style={[styles.row, { borderColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold" style={styles.label}>
          Send diagnostics
        </ThemedText>
        <Switch
          accessibilityLabel="Send diagnostics"
          accessibilityRole="switch"
          disabled={enabled === null}
          value={enabled ?? true}
          onValueChange={(next) => void setTelemetryExportEnabled(next)}
          trackColor={{ true: accent, false: theme.backgroundSelected }}
        />
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        Sends this build&apos;s debug logs and traces to the Street Cryptid developers to help fix
        delivery problems. Turning it off stops sending immediately, and anything recorded while it
        is off is never sent.
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.two },
  row: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  label: { flex: 1 },
});
