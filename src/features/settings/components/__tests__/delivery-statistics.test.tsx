import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { View } from 'react-native';
import type { DeliveryStatistics } from 'iroh-location';
import { CryptidThemes } from '@/constants/theme';
import { DeliveryStatisticsChart } from '../delivery-statistics';

jest.mock('@/global.css', () => ({}));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ text: '#123', textSecondary: '#456' }),
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
const mockRead = jest.fn();
let mockSupported = true;
jest.mock('iroh-location', () => ({
  tryGetIrohLocation: () => (mockSupported ? { deliveryStatistics: mockRead } : {}),
}));

const report: DeliveryStatistics = {
  recordedDays: 10,
  incomplete: false,
  counts: [
    {
      hour: 9,
      source: 'friend',
      path: 'bluetooth',
      relaySetup: 'unknown',
      mechanism: 'gossip',
      count: 60,
    },
  ],
};

describe('local delivery history', () => {
  let renderer: ReactTestRenderer;
  beforeEach(() => {
    jest.useFakeTimers();
    mockSupported = true;
    mockRead.mockReset().mockResolvedValue(report);
  });
  afterEach(async () => {
    act(() => renderer?.unmount());
    const calls = mockRead.mock.calls.length;
    await act(async () => jest.advanceTimersByTime(120_000));
    expect(mockRead).toHaveBeenCalledTimes(calls);
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  async function render() {
    await act(async () => {
      renderer = create(<DeliveryStatisticsChart chrome={CryptidThemes.daybreak.chrome} />);
    });
  }
  const text = () => JSON.stringify(renderer.toJSON());

  it('renders 24 accessible stacked bars and switches grouping and filters', async () => {
    await render();
    expect(
      renderer.root.findAll(
        (node) =>
          node.type === View &&
          node.props.accessible &&
          node.props.accessibilityLabel?.includes('updates per day')
      )
    ).toHaveLength(24);
    expect(text()).toContain('9:00, 6.00 updates per day');
    act(() =>
      renderer.root.findByProps({ accessibilityLabel: 'Stack by: Connection' }).props.onPress()
    );
    expect(text()).toContain('Bluetooth 6.00');
    act(() =>
      renderer.root.findByProps({ accessibilityLabel: 'Delivery filters' }).props.onPress()
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: 'Delivered by: Stash server' })
        .props.onPress()
    );
    expect(text()).toContain('No updates match');
    expect(text()).toContain('10');
  });

  it('distinguishes first-day collection from empty history', async () => {
    mockRead.mockResolvedValue({ ...report, recordedDays: 0 });
    await render();
    expect(text()).toContain('Collecting your first day');
    expect(text()).not.toContain('No updates match');
  });

  it('reports an unsupported binary honestly without polling', async () => {
    mockSupported = false;
    await render();
    expect(text()).toContain('requires an updated installed app');
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('surfaces read errors and partial collection', async () => {
    mockRead.mockRejectedValueOnce(new Error('disk unavailable'));
    await render();
    expect(text()).toContain('disk unavailable');
    mockRead.mockResolvedValue({ ...report, incomplete: true });
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(text()).toContain('Some receipts could not be counted');
  });
});
