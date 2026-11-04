import type { DeliveryCount, DeliveryStatistics } from 'iroh-location';
import { receiptChart } from '../delivery-statistics';

const row: DeliveryCount = {
  hour: 9,
  source: 'friend',
  path: 'bluetooth',
  relaySetup: 'unknown',
  mechanism: 'gossip',
  count: 60,
};
const statistics: DeliveryStatistics = {
  recordedDays: 10,
  incomplete: false,
  counts: [row, { ...row, source: 'stash', path: 'relay', mechanism: 'sync', count: 30 }],
};

it('draws all 24 hours and includes zero-receipt days in the denominator', () => {
  const chart = receiptChart(statistics, 'source', {});
  expect(chart.hours).toHaveLength(24);
  expect(chart.days).toBe(10);
  expect(chart.hours[9].total).toBe(9);
  expect(chart.hours[9].stacks.find((s) => s.key === 'friend')?.average).toBe(6);
  expect(chart.hours[8].total).toBe(0);
});

it('caps the denominator at 30 and does not divide by zero on the first day', () => {
  expect(receiptChart({ ...statistics, recordedDays: 60 }, 'source', {}).hours[9].total).toBe(3);
  expect(receiptChart({ ...statistics, recordedDays: 0 }, 'source', {}).maximum).toBe(0);
});

it('filters every axis without changing the denominator or inventing a route', () => {
  for (const filters of [
    { source: 'friend' },
    { path: 'bluetooth' },
    { mechanism: 'gossip' },
  ] as const) {
    const chart = receiptChart(statistics, 'path', filters);
    expect(chart.days).toBe(10);
    expect(chart.hours[9].total).toBe(6);
  }
  expect(receiptChart(statistics, 'path', { relaySetup: 'yes' }).maximum).toBe(0);
  expect(receiptChart(statistics, 'path', { relaySetup: 'unknown' }).maximum).toBe(9);
});
