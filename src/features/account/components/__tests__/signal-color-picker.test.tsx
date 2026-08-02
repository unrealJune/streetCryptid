import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

import { SignalColorPicker } from '../signal-color-picker';

jest.mock('@/global.css', () => ({}));
jest.mock('@shopify/react-native-skia', () => {
  const { View } = jest.requireActual('react-native');
  return {
    Canvas: View,
    Circle: View,
    LinearGradient: () => null,
    RadialGradient: () => null,
    Rect: View,
    SweepGradient: () => null,
    vec: (x: number, y: number) => ({ x, y }),
  };
});

function PickerHarness() {
  const [color, setColor] = useState('#2F9E6A');
  return <SignalColorPicker color={color} onChange={setColor} />;
}

describe('SignalColorPicker', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('updates the wheel from a valid hex value', () => {
    act(() => {
      renderer = create(<PickerHarness />);
    });

    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('ff0000');
    });

    expect(renderer.root.findByType(TextInput).props.value).toBe('#FF0000');
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Signal color wheel' }).props
    ).toMatchObject({
      accessibilityValue: { text: '0 degree hue, 100 percent saturation' },
    });
  });

  it('keeps partial values editable without changing the selected color', () => {
    const onChange = jest.fn();

    act(() => {
      renderer = create(<SignalColorPicker color="#2F9E6A" onChange={onChange} />);
    });

    const input = renderer.root.findByType(TextInput);
    act(() => input.props.onChangeText('#12'));

    expect(renderer.root.findByType(TextInput).props.value).toBe('#12');
    expect(onChange).not.toHaveBeenCalled();

    act(() => renderer.root.findByType(TextInput).props.onBlur());
    expect(renderer.root.findByType(TextInput).props.value).toBe('#2F9E6A');
  });
});
