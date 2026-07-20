import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import type { TransportReport } from '@/features/social/net/transports';

import { TransportDiagnostic } from '../transport-diagnostic';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

const REPORT: TransportReport = {
  updatedAt: null,
  error: null,
  rows: [
    {
      id: 'direct',
      label: 'Direct (IP)',
      status: 'available',
      detail: 'No active public IP path observed.',
      groups: [
        {
          label: 'PEER PATHS',
          items: [{ label: 'moth', value: '203.0.113.4:443 · inactive' }],
        },
      ],
    },
  ],
};

describe('TransportDiagnostic', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('reveals detailed native state when a transport is pressed', () => {
    act(() => {
      renderer = create(
        <TransportDiagnostic report={REPORT} activeColor="#2f9e6a" availableColor="#f2ad42" />
      );
    });

    const button = renderer.root.findByProps({
      accessibilityLabel: 'Direct (IP), Ready',
    });
    expect(button.props.accessibilityState).toEqual({ expanded: false });
    expect(
      renderer.root.findAllByType(Text).some((node) => node.props.children === 'PEER PATHS')
    ).toBe(false);

    act(() => button.props.onPress());

    expect(button.props.accessibilityState).toEqual({ expanded: true });
    expect(
      renderer.root.findAllByType(Text).some((node) => node.props.children === 'PEER PATHS')
    ).toBe(true);
  });
});
