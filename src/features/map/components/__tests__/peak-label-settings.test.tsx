import { useState } from 'react';
import { Modal, ScrollView } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';
import { DEFAULT_PEAK_LABEL_OPTIONS, type PeakLabelOptions } from '../../core/map-labels';
import { PeakLabelSettings } from '../peak-label-settings';

jest.mock('@/global.css', () => ({}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }),
}));

describe('PeakLabelSettings', () => {
  let renderer: ReactTestRenderer;
  const onClose = jest.fn();
  const onChange = jest.fn();

  function Harness({ initial = DEFAULT_PEAK_LABEL_OPTIONS }: { initial?: PeakLabelOptions }) {
    const [options, setOptions] = useState(initial);
    return (
      <PeakLabelSettings
        visible
        options={options}
        peaksEnabled
        theme={CryptidThemes.daybreak}
        onClose={onClose}
        onChange={(next) => {
          setOptions(next);
          onChange(next);
        }}
      />
    );
  }

  const press = (label: string) =>
    act(() => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress());

  beforeEach(() => {
    jest.clearAllMocks();
    act(() => {
      renderer = create(<Harness />);
    });
  });
  afterEach(() => act(() => renderer.unmount()));

  it('provides a scrollable modal with button and system-back dismissal', () => {
    expect(renderer.root.findByType(ScrollView)).toBeTruthy();
    press('Close peak cutoffs');
    act(() => renderer.root.findByType(Modal).props.onRequestClose());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('applies every control immediately and resets all defaults', () => {
    press('Decrease minimum zoom');
    press('Automatic peak rank cutoff');
    press('Increase maximum rank');
    press('Increase maximum peak labels');
    press('Include unranked peaks');
    expect(onChange).toHaveBeenLastCalledWith({
      minZoom: 8.5,
      maxRank: 9,
      maxLabels: 9,
      includeUnranked: false,
    });
    press('Automatic peak rank cutoff');
    expect(onChange.mock.calls.at(-1)?.[0].maxRank).toBeNull();
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Increase maximum rank' })
    ).toHaveLength(0);
    press('Reset peak cutoffs');
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_PEAK_LABEL_OPTIONS);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    { direction: 'Decrease', minZoom: 0, maxRank: 1, maxLabels: 0 },
    { direction: 'Increase', minZoom: 20, maxRank: 128, maxLabels: 64 },
  ])('disables $direction controls at every bound', ({ direction, ...bounds }) => {
    const options = { ...bounds, includeUnranked: false };
    act(() => renderer.unmount());
    act(() => {
      renderer = create(<Harness initial={options} />);
    });
    for (const field of ['minimum zoom', 'maximum rank', 'maximum peak labels']) {
      const label = `${direction} ${field}`;
      expect(renderer.root.findByProps({ accessibilityLabel: label }).props.disabled).toBe(true);
      press(label);
      expect(onChange).toHaveBeenLastCalledWith(options);
    }
  });
});
