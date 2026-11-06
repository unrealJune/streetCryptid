import { useFocusEffect } from 'expo-router';
import { tryGetIrohLocation, type DeliveryStatistics } from 'iroh-location';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing, type CryptidChrome } from '@/constants/theme';
import {
  RECEIPT_DIMENSIONS,
  RECEIPT_LABELS,
  receiptChart,
  type ReceiptDimension,
  type ReceiptFilters,
  type ReceiptGrouping,
} from '../core/delivery-statistics';

type State =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; statistics: DeliveryStatistics };

function Choices({
  label,
  choices,
  value,
  onChange,
  chrome,
}: {
  label: string;
  choices: Record<string, string>;
  value: string;
  onChange(value: string): void;
  chrome: CryptidChrome;
}) {
  return (
    <View style={styles.group}>
      <ThemedText type="smallBold">{label}</ThemedText>
      <View style={styles.choices}>
        {Object.entries(choices).map(([key, text]) => (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${text}`}
            accessibilityState={{ selected: key === value }}
            onPress={() => onChange(key)}
            style={[styles.choice, { borderColor: key === value ? chrome.green : chrome.hairline }]}
          >
            <ThemedText type="small">{text}</ThemedText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function DeliveryStatisticsChart({ chrome }: { chrome: CryptidChrome }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [grouping, setGrouping] = useState<ReceiptGrouping>('source');
  const [filters, setFilters] = useState<ReceiptFilters>({});
  const [showFilters, setShowFilters] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const native = tryGetIrohLocation();
      if (typeof native?.deliveryStatistics !== 'function') {
        setState({ kind: 'unsupported' });
        return;
      }
      let busy = false;
      const refresh = async () => {
        if (busy) return;
        busy = true;
        try {
          const statistics = await native.deliveryStatistics!();
          if (active) setState({ kind: 'ready', statistics });
        } catch (error) {
          if (active) {
            setState({
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          busy = false;
        }
      };
      void refresh();
      const timer = setInterval(() => void refresh(), 60_000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }, [])
  );

  if (state.kind !== 'ready') {
    return (
      <ThemedText type="small" accessibilityRole={state.kind === 'error' ? 'alert' : undefined}>
        {state.kind === 'loading'
          ? 'Loading local delivery history...'
          : state.kind === 'unsupported'
            ? 'Local delivery history requires an updated installed app. It is not collected in a browser.'
            : `Delivery history unavailable: ${state.message}`}
      </ThemedText>
    );
  }

  const chart = receiptChart(state.statistics, grouping, filters);
  const labels: Record<string, string> = RECEIPT_LABELS[grouping];
  const colors = [chrome.green, chrome.dot, chrome.amber, chrome.ink, chrome.steel];
  return (
    <View style={styles.container}>
      <ThemedText type="small">
        Unique incoming location updates per hour, including parked updates. Counted once, when
        received.
      </ThemedText>
      {state.statistics.incomplete ? (
        <ThemedText type="small" accessibilityRole="alert">
          Some receipts could not be counted. These totals may be lower than actual delivery.
        </ThemedText>
      ) : null}
      <Choices
        label="Stack by"
        choices={{ source: 'Delivered by', path: 'Connection' }}
        value={grouping}
        onChange={(value) => setGrouping(value === 'path' ? 'path' : 'source')}
        chrome={chrome}
      />
      {chart.days === 0 ? (
        <ThemedText type="small">
          Collecting your first day. Averages appear after local midnight.
        </ThemedText>
      ) : (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            Average over {chart.days} completed {chart.days === 1 ? 'day' : 'days'} (up to 30).
            Zero-update days included. Local hour at receipt.
          </ThemedText>
          <ThemedText type="code">0 - {chart.maximum.toFixed(2)} updates / hour</ThemedText>
          <View style={[styles.plot, { borderBottomColor: chrome.steel }]}>
            {chart.hours.map((bar) => (
              <View
                key={bar.hour}
                accessible
                accessibilityLabel={`${bar.hour}:00, ${bar.total.toFixed(2)} updates per day. ${bar.stacks
                  .map((stack) => `${labels[stack.key]} ${stack.average.toFixed(2)}`)
                  .join(', ')}`}
                style={styles.bar}
              >
                {bar.stacks.map((stack, index) => (
                  <View
                    key={stack.key}
                    style={{
                      height: chart.maximum > 0 ? (stack.average / chart.maximum) * 144 : 0,
                      backgroundColor: colors[index],
                    }}
                  />
                ))}
              </View>
            ))}
          </View>
          <View style={styles.ticks}>
            {['00', '06', '12', '18', '24'].map((hour) => (
              <ThemedText key={hour} type="code">
                {hour}
              </ThemedText>
            ))}
          </View>
          {chart.maximum === 0 ? (
            <ThemedText type="small">
              No updates match these filters in the recorded days.
            </ThemedText>
          ) : null}
          <View style={styles.choices}>
            {Object.entries(labels).map(([key, label], index) => (
              <View key={key} style={styles.legend}>
                <View style={[styles.swatch, { backgroundColor: colors[index] }]} />
                <ThemedText type="small">{label}</ThemedText>
              </View>
            ))}
          </View>
        </>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Delivery filters"
        accessibilityState={{ expanded: showFilters }}
        onPress={() => setShowFilters((value) => !value)}
        style={styles.filterButton}
      >
        <ThemedText type="smallBold">
          {showFilters ? 'Hide filters' : 'Filters'} ({Object.keys(filters).length} active)
        </ThemedText>
      </Pressable>
      {showFilters
        ? (Object.keys(RECEIPT_DIMENSIONS) as ReceiptDimension[]).map((dimension) => (
            <Choices
              key={dimension}
              label={RECEIPT_DIMENSIONS[dimension]}
              choices={{ all: 'All', ...RECEIPT_LABELS[dimension] }}
              value={filters[dimension] ?? 'all'}
              onChange={(value) =>
                setFilters((current) => {
                  const next = { ...current };
                  if (value === 'all') delete next[dimension];
                  else Object.assign(next, { [dimension]: value });
                  return next;
                })
              }
              chrome={chrome}
            />
          ))
        : null}
      <ThemedText type="small" themeColor="textSecondary">
        Local IP means a private or link-local address, not necessarily the same Wi-Fi. mDNS finds
        devices; it is not a connection type. Stash storage is separate from an internet relay.
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Unknown includes ambiguous or resumed transfers. Relay-assisted setup means relay handshake
        traffic was observed; a direct connection alone cannot prove a relay was not involved. These
        measurements are separate from the nearest-open-path badges.
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Only anonymous hourly totals and expiring duplicate-check tokens stay on this phone. No
        identities, positions or individual receipt history are saved here or uploaded.
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.three },
  group: { gap: Spacing.two },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  choice: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    padding: Spacing.two,
    minHeight: 44,
    justifyContent: 'center',
  },
  plot: { height: 144, flexDirection: 'row', alignItems: 'flex-end', gap: 2, borderBottomWidth: 1 },
  bar: { flex: 1, height: 144, flexDirection: 'column-reverse' },
  ticks: { flexDirection: 'row', justifyContent: 'space-between' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  swatch: { width: 10, height: 10 },
  filterButton: { minHeight: 44, justifyContent: 'center' },
});
