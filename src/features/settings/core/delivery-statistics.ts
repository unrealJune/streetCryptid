import type { DeliveryCount, DeliveryStatistics } from 'iroh-location';

export type ReceiptDimension = 'source' | 'path' | 'relaySetup';
export type ReceiptGrouping = 'source' | 'path';
export type ReceiptFilters = Partial<{ [K in ReceiptDimension]: DeliveryCount[K] }>;

export const RECEIPT_LABELS = {
  source: {
    author: 'Their phone',
    friend: 'Another friend',
    other: 'Another device',
    stash: 'Stash server',
    unknown: 'Unknown',
  },
  path: {
    bluetooth: 'Bluetooth',
    'local-ip': 'Local IP',
    'direct-ip': 'Direct IP',
    relay: 'Internet relay',
    unknown: 'Unknown',
  },
  relaySetup: { yes: 'Observed', no: 'Disabled', unknown: 'Unknown' },
} as const;

export const RECEIPT_DIMENSIONS: Record<ReceiptDimension, string> = {
  source: 'Delivered by',
  path: 'Connection',
  relaySetup: 'Relay-assisted setup',
};

export function receiptChart(
  statistics: DeliveryStatistics,
  grouping: ReceiptGrouping,
  filters: ReceiptFilters
) {
  const days = Math.min(statistics.recordedDays, 30);
  const keys = Object.keys(RECEIPT_LABELS[grouping]);
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    stacks: keys.map((key) => ({ key, average: 0 })),
    total: 0,
  }));
  if (days > 0) {
    for (const row of statistics.counts) {
      if (
        Object.entries(filters).some(
          ([dimension, value]) => row[dimension as ReceiptDimension] !== value
        )
      ) {
        continue;
      }
      const bar = hours[row.hour];
      const stack = bar?.stacks.find((stack) => stack.key === row[grouping]);
      if (!bar || !stack) throw new Error('Unrecognized delivery statistics bucket');
      stack.average += row.count / days;
      bar.total += row.count / days;
    }
  }
  return { days, hours, maximum: Math.max(0, ...hours.map((hour) => hour.total)) };
}
