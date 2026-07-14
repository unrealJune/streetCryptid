import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { TransportReport, TransportStatus } from '@/features/social/net/transports';

interface TransportDiagnosticProps {
  report: TransportReport;
  /** Accent for the "active" status dot (the social-system green). */
  activeColor: string;
  /** Accent for the "available (idle)" status dot (the amber "you"). */
  availableColor: string;
}

const STATUS_LABEL: Record<TransportStatus, string> = {
  active: 'Active',
  available: 'Ready',
  inactive: 'Off',
  unavailable: 'Unavailable',
  'n/a': 'N/A',
  planned: 'Planned',
};

/**
 * Honest per-transport diagnostic list. Only `active` gets the social-green dot and `available`
 * the amber dot; everything else is muted — the app never colors an idle/absent transport as if
 * it were carrying traffic.
 */
export function TransportDiagnostic({
  report,
  activeColor,
  availableColor,
}: TransportDiagnosticProps) {
  const theme = useTheme();

  const dotColor = (status: TransportStatus): string => {
    if (status === 'active') return activeColor;
    if (status === 'available') return availableColor;
    return theme.textSecondary;
  };

  return (
    <View style={[styles.list, { borderColor: theme.backgroundSelected }]}>
      {report.rows.map((row, index) => (
        <View
          key={row.id}
          style={[
            styles.row,
            index > 0 && {
              borderTopColor: theme.backgroundSelected,
              borderTopWidth: StyleSheet.hairlineWidth,
            },
          ]}
        >
          <View style={[styles.dot, { backgroundColor: dotColor(row.status) }]} />
          <View style={styles.copy}>
            <View style={styles.headerRow}>
              <ThemedText type="smallBold">{row.label}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {STATUS_LABEL[row.status]}
              </ThemedText>
            </View>
            <ThemedText type="small" themeColor="textSecondary">
              {row.detail}
            </ThemedText>
          </View>
        </View>
      ))}
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
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  dot: {
    borderRadius: Spacing.one,
    height: Spacing.two,
    marginTop: Spacing.half,
    width: Spacing.two,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
