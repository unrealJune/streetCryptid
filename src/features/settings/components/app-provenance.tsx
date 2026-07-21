import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

import { getAppProvenance, type AppProvenance } from '../core/app-provenance';

interface AppProvenanceProps {
  provenance?: AppProvenance;
}

export function AppProvenanceDetails({
  provenance = getAppProvenance(),
}: AppProvenanceProps) {
  const rows = [
    { label: 'App version', value: provenance.appVersion },
    { label: 'Native build', value: provenance.buildVersion },
    { label: 'Commit', value: provenance.commit },
    { label: 'EAS build', value: provenance.buildId },
    { label: 'Build profile', value: provenance.profile },
    { label: 'Runtime', value: provenance.runtimeVersion },
  ].filter((row): row is { label: string; value: string } => row.value !== null);

  return (
    <View style={styles.container}>
      {rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <ThemedText type="small" themeColor="textSecondary">
            {row.label}
          </ThemedText>
          <ThemedText selectable type="code" style={styles.value}>
            {row.value}
          </ThemedText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  value: {
    flex: 1,
    textAlign: 'right',
  },
});
