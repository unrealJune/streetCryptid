import { SymbolView } from 'expo-symbols';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  clearEventLog,
  getEventLog,
  loadEventLog,
  subscribeEventLog,
  type EventLogEntry,
} from '@/features/dev/telemetry';
import { useTheme } from '@/hooks/use-theme';

type Filter = 'all' | 'transport' | 'errors';

interface EventLogPanelProps {
  activeColor: string;
  warningColor: string;
}

function filterEntries(entries: EventLogEntry[], filter: Filter): EventLogEntry[] {
  if (filter === 'errors') return entries.filter((entry) => entry.status === 'error');
  if (filter === 'transport') return entries.filter((entry) => entry.category === 'transport');
  return entries;
}

function EventRow({
  entry,
  activeColor,
  warningColor,
}: {
  entry: EventLogEntry;
  activeColor: string;
  warningColor: string;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const color =
    entry.status === 'error'
      ? warningColor
      : entry.status === 'ok'
        ? activeColor
        : theme.textSecondary;

  return (
    <View style={[styles.event, { borderTopColor: theme.backgroundSelected }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        style={({ pressed }) => [styles.eventButton, pressed && styles.pressed]}
      >
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={styles.eventCopy}>
          <View style={styles.eventHeading}>
            <ThemedText type="smallBold">{entry.action}</ThemedText>
            <ThemedText type="code" themeColor="textSecondary">
              {new Date(entry.timestamp).toISOString()}
            </ThemedText>
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {entry.summary}
          </ThemedText>
          <View style={styles.tags}>
            <ThemedText type="code" themeColor="textSecondary">
              {entry.category}
            </ThemedText>
            {entry.transport ? (
              <ThemedText type="code" themeColor="textSecondary">
                via {entry.transport}
              </ThemedText>
            ) : null}
          </View>
        </View>
      </Pressable>
      {expanded ? (
        <ThemedText selectable type="code" style={styles.details}>
          {JSON.stringify(entry.details, null, 2)}
        </ThemedText>
      ) : null}
    </View>
  );
}

export function EventLogPanel({ activeColor, warningColor }: EventLogPanelProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [entries, setEntries] = useState(getEventLog);

  useEffect(() => {
    const unsubscribe = subscribeEventLog(setEntries);
    return unsubscribe;
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadEventLog();
    }, [])
  );

  const visibleEntries = useMemo(() => filterEntries(entries, filter), [entries, filter]);

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Transport event log, ${entries.length} events`}
        onPress={() => setExpanded((current) => !current)}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <View style={styles.headerCopy}>
          <ThemedText type="smallBold">Event log</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {entries.length} persisted event{entries.length === 1 ? '' : 's'}
          </ThemedText>
        </View>
        <SymbolView
          name={
            expanded
              ? { ios: 'chevron.up', android: 'keyboard_arrow_up', web: 'keyboard_arrow_up' }
              : { ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' }
          }
          size={18}
          weight="bold"
          tintColor={theme.textSecondary}
        />
      </Pressable>

      {expanded ? (
        <View style={[styles.body, { borderTopColor: theme.backgroundSelected }]}>
          <ThemedText type="small" themeColor="textSecondary">
            Live transport, pairing, delivery, and error history. Precise locations and credentials
            are redacted; the newest 1,000 events are retained on this device.
          </ThemedText>
          <View style={styles.controls}>
            {(['all', 'transport', 'errors'] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: filter === value }}
                onPress={() => setFilter(value)}
                style={[
                  styles.control,
                  {
                    borderColor: filter === value ? activeColor : theme.backgroundSelected,
                  },
                ]}
              >
                <ThemedText type="smallBold">
                  {value === 'all' ? 'All' : value === 'transport' ? 'Transport' : 'Errors'}
                </ThemedText>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => void clearEventLog()}
              style={[styles.control, styles.clear, { borderColor: warningColor }]}
            >
              <ThemedText type="smallBold">Clear</ThemedText>
            </Pressable>
          </View>

          <View style={[styles.events, { borderColor: theme.backgroundSelected }]}>
            {visibleEntries.length > 0 ? (
              visibleEntries.map((entry) => (
                <EventRow
                  key={entry.id}
                  entry={entry}
                  activeColor={activeColor}
                  warningColor={warningColor}
                />
              ))
            ) : (
              <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
                No matching events yet.
              </ThemedText>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: Spacing.three,
  },
  headerCopy: {
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.7,
  },
  body: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    padding: Spacing.three,
  },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  control: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  clear: {
    marginLeft: 'auto',
  },
  events: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    borderRightWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  event: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  eventButton: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.two,
    padding: Spacing.three,
  },
  dot: {
    borderRadius: Spacing.one,
    height: Spacing.two,
    marginTop: Spacing.one,
    width: Spacing.two,
  },
  eventCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  eventHeading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  details: {
    padding: Spacing.three,
    paddingTop: 0,
  },
  empty: {
    padding: Spacing.three,
  },
});
