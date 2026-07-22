import { SymbolView } from 'expo-symbols';
import { useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  clearEventLog,
  EVENT_LOG_MAX_ENTRIES,
  eventLogEntryMatchesQuery,
  getEventLog,
  loadEventLog,
  subscribeEventLog,
  type EventLogEntry,
  type EventLogLaunchContext,
  type EventLogLevel,
} from '@/features/dev/telemetry';
import { useTheme } from '@/hooks/use-theme';

type CategoryFilter = 'all' | 'transport' | 'pairing' | 'system';
type LevelFilter = 'all' | EventLogLevel;
type LaunchContextFilter = 'all' | EventLogLaunchContext;

const PAGE_SIZE = 100;
const LEVEL_WEIGHT: Record<EventLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface EventLogPanelProps {
  activeColor: string;
  warningColor: string;
}

function filterEntries(
  entries: EventLogEntry[],
  category: CategoryFilter,
  level: LevelFilter,
  launchContext: LaunchContextFilter,
  search: string,
  exclude: string
): EventLogEntry[] {
  const excludedQueries = exclude
    .split(/[,\n]/)
    .map((query) => query.trim())
    .filter(Boolean);
  return entries.filter((entry) => {
    if (category !== 'all' && entry.category !== category) return false;
    if (level !== 'all' && LEVEL_WEIGHT[entry.level] < LEVEL_WEIGHT[level]) return false;
    if (launchContext !== 'all' && entry.launchContext !== launchContext) return false;
    if (!eventLogEntryMatchesQuery(entry, search)) return false;
    return !excludedQueries.some((query) => eventLogEntryMatchesQuery(entry, query));
  });
}

const EventRow = memo(function EventRow({
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
              {entry.level}
            </ThemedText>
            <ThemedText type="code" themeColor="textSecondary">
              {entry.category}
            </ThemedText>
            <ThemedText type="code" themeColor="textSecondary">
              {entry.launchContext}
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
});

export function EventLogPanel({ activeColor, warningColor }: EventLogPanelProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [launchContext, setLaunchContext] = useState<LaunchContextFilter>('all');
  const [search, setSearch] = useState('');
  const [exclude, setExclude] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [entries, setEntries] = useState(getEventLog);
  const pausedRef = useRef(false);

  useEffect(() => {
    if (!expanded || paused) return;
    const unsubscribe = subscribeEventLog(setEntries);
    return unsubscribe;
  }, [expanded, paused]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadEventLog().then((loaded) => {
        if (active && !pausedRef.current) setEntries(loaded);
      });
      return () => {
        active = false;
      };
    }, [])
  );

  const filteredEntries = useMemo(
    () => filterEntries(entries, category, level, launchContext, search, exclude),
    [category, entries, exclude, launchContext, level, search]
  );
  const visibleEntries = filteredEntries.slice(0, visibleLimit);

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
            are redacted; the newest {EVENT_LOG_MAX_ENTRIES.toLocaleString()} events are retained on
            this device.
          </ThemedText>
          <View style={styles.controls}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: paused }}
              onPress={() =>
                setPaused((current) => {
                  pausedRef.current = !current;
                  return !current;
                })
              }
              style={[
                styles.control,
                { borderColor: paused ? warningColor : theme.backgroundSelected },
              ]}
            >
              <ThemedText type="smallBold">{paused ? 'Resume' : 'Pause'}</ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setEntries([]);
                void clearEventLog();
              }}
              style={[styles.control, styles.clear, { borderColor: warningColor }]}
            >
              <ThemedText type="smallBold">Clear</ThemedText>
            </Pressable>
          </View>
          {paused ? (
            <ThemedText type="small" themeColor="textSecondary">
              Paused — new events are still being recorded.
            </ThemedText>
          ) : null}
          <View style={styles.filterGroup}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              LEVEL
            </ThemedText>
            <View style={styles.controls}>
              {(['all', 'info', 'warn', 'error'] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: level === value }}
                  onPress={() => {
                    setLevel(value);
                    setVisibleLimit(PAGE_SIZE);
                  }}
                  style={[
                    styles.control,
                    { borderColor: level === value ? activeColor : theme.backgroundSelected },
                  ]}
                >
                  <ThemedText type="smallBold">
                    {value === 'all'
                      ? 'All'
                      : value === 'info'
                        ? 'Info+'
                        : value === 'warn'
                          ? 'Warn+'
                          : 'Errors'}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.filterGroup}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              CATEGORY
            </ThemedText>
            <View style={styles.controls}>
              {(['all', 'transport', 'pairing', 'system'] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: category === value }}
                  onPress={() => {
                    setCategory(value);
                    setVisibleLimit(PAGE_SIZE);
                  }}
                  style={[
                    styles.control,
                    {
                      borderColor: category === value ? activeColor : theme.backgroundSelected,
                    },
                  ]}
                >
                  <ThemedText type="smallBold">
                    {value === 'all' ? 'All' : `${value.charAt(0).toUpperCase()}${value.slice(1)}`}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.filterGroup}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              LAUNCH CONTEXT
            </ThemedText>
            <View style={styles.controls}>
              {(['all', 'foreground', 'background'] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: launchContext === value }}
                  onPress={() => {
                    setLaunchContext(value);
                    setVisibleLimit(PAGE_SIZE);
                  }}
                  style={[
                    styles.control,
                    {
                      borderColor: launchContext === value ? activeColor : theme.backgroundSelected,
                    },
                  ]}
                >
                  <ThemedText type="smallBold">
                    {value === 'all' ? 'All' : `${value.charAt(0).toUpperCase()}${value.slice(1)}`}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          </View>
          <TextInput
            accessibilityLabel="Search event log"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(value) => {
              setSearch(value);
              setVisibleLimit(PAGE_SIZE);
            }}
            placeholder="Filter action, summary, transport…"
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.search,
              {
                borderColor: theme.backgroundSelected,
                color: theme.text,
              },
            ]}
            value={search}
          />
          <TextInput
            accessibilityLabel="Exclude events from event log"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(value) => {
              setExclude(value);
              setVisibleLimit(PAGE_SIZE);
            }}
            placeholder="Exclude names or properties (comma-separated)…"
            placeholderTextColor={theme.textSecondary}
            style={[
              styles.search,
              {
                borderColor: theme.backgroundSelected,
                color: theme.text,
              },
            ]}
            value={exclude}
          />
          <ThemedText type="small" themeColor="textSecondary">
            Showing {visibleEntries.length} of {filteredEntries.length} matching events
          </ThemedText>

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
          {visibleEntries.length < filteredEntries.length ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setVisibleLimit((current) => current + PAGE_SIZE)}
              style={[styles.control, styles.showMore, { borderColor: theme.backgroundSelected }]}
            >
              <ThemedText type="smallBold">Show {PAGE_SIZE} more</ThemedText>
            </Pressable>
          ) : null}
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
  filterGroup: {
    gap: Spacing.one,
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
  search: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: 'IBMPlexMono_400Regular',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  showMore: {
    alignItems: 'center',
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
