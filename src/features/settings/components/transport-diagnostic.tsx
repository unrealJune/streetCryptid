import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type {
  TransportDetailItem,
  TransportReport,
  TransportStatus,
} from '@/features/social/net/transports';
import { useTheme } from '@/hooks/use-theme';

interface TransportDiagnosticProps {
  report: TransportReport;
  activeColor: string;
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

function ageLabel(updatedAt: number | null): string {
  if (!updatedAt) return 'Waiting for native path data';
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (seconds < 2) return 'Native paths updated now';
  return `Native paths updated ${seconds}s ago`;
}

export function TransportDiagnostic({
  report,
  activeColor,
  availableColor,
}: TransportDiagnosticProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const dotColor = (status: TransportStatus): string => {
    if (status === 'active') return activeColor;
    if (status === 'available') return availableColor;
    return theme.textSecondary;
  };

  const detailItem = (item: TransportDetailItem, index: number) => (
    <View key={`${item.label}-${index}`} style={styles.detailRow}>
      <View style={styles.detailLabel}>
        {item.status ? (
          <View style={[styles.detailDot, { backgroundColor: dotColor(item.status) }]} />
        ) : null}
        <ThemedText type="small" themeColor="textSecondary">
          {item.label}
        </ThemedText>
      </View>
      <ThemedText selectable type="code" style={styles.detailValue}>
        {item.value}
      </ThemedText>
    </View>
  );

  return (
    <View style={styles.container}>
      <ThemedText type="small" themeColor="textSecondary">
        {ageLabel(report.updatedAt)}
      </ThemedText>
      {report.error ? (
        <View style={[styles.error, { borderColor: availableColor }]}>
          <ThemedText type="small">{report.error}</ThemedText>
        </View>
      ) : null}
      <View style={[styles.list, { borderColor: theme.backgroundSelected }]}>
        {report.rows.map((row, index) => {
          const isExpanded = expanded[row.id] ?? false;
          const groups = row.groups.filter((group) => group.items.length > 0);
          return (
            <View
              key={row.id}
              style={[
                index > 0 && {
                  borderTopColor: theme.backgroundSelected,
                  borderTopWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                accessibilityLabel={`${row.label}, ${STATUS_LABEL[row.status]}`}
                onPress={() => setExpanded((current) => ({ ...current, [row.id]: !isExpanded }))}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={[styles.dot, { backgroundColor: dotColor(row.status) }]} />
                <View style={styles.copy}>
                  <View style={styles.headerRow}>
                    <ThemedText type="smallBold">{row.label}</ThemedText>
                    <View style={styles.status}>
                      <ThemedText type="small" themeColor="textSecondary">
                        {STATUS_LABEL[row.status]}
                      </ThemedText>
                      <SymbolView
                        name={
                          isExpanded
                            ? {
                                ios: 'chevron.up',
                                android: 'keyboard_arrow_up',
                                web: 'keyboard_arrow_up',
                              }
                            : {
                                ios: 'chevron.down',
                                android: 'keyboard_arrow_down',
                                web: 'keyboard_arrow_down',
                              }
                        }
                        size={16}
                        weight="bold"
                        tintColor={theme.textSecondary}
                      />
                    </View>
                  </View>
                  <ThemedText type="small" themeColor="textSecondary">
                    {row.detail}
                  </ThemedText>
                </View>
              </Pressable>
              {isExpanded ? (
                <View style={[styles.details, { borderTopColor: theme.backgroundSelected }]}>
                  {groups.map((group) => (
                    <View key={group.label} style={styles.group}>
                      <ThemedText
                        type="smallBold"
                        themeColor="textSecondary"
                        style={styles.groupLabel}
                      >
                        {group.label}
                      </ThemedText>
                      <View style={styles.groupItems}>{group.items.map(detailItem)}</View>
                    </View>
                  ))}
                  {groups.length === 0 ? (
                    <ThemedText type="small" themeColor="textSecondary">
                      No additional state is available.
                    </ThemedText>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
  },
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
  pressed: {
    opacity: 0.7,
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
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  status: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  details: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    padding: Spacing.three,
    paddingLeft: Spacing.four,
  },
  group: {
    gap: Spacing.one,
  },
  groupLabel: {
    fontSize: 11,
    letterSpacing: 1,
  },
  groupItems: {
    gap: Spacing.one,
  },
  detailRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  detailLabel: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: Spacing.two,
  },
  detailDot: {
    borderRadius: Spacing.half,
    height: Spacing.one,
    width: Spacing.one,
  },
  detailValue: {
    flex: 1,
    textAlign: 'right',
  },
  error: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.two,
  },
});
