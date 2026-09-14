import { Canvas, Circle, RadialGradient, SweepGradient, vec } from '@shopify/react-native-skia';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from 'react-native';

import { ThemedTextInput } from '@/components/themed-text-input';
import { fullBrightnessColor, isSignalColor, signalColorInk } from '@/constants/signal-colors';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  colorAtWheelPosition,
  colorWheelPosition,
  hexToHsv,
  hsvToHex,
  SIGNAL_COLOR_VALUE,
  type HsvColor,
} from '../core/signal-color';

const WHEEL_SIZE = 232;
const WHEEL_RADIUS = WHEEL_SIZE / 2;
const HUE_STEP = 10;
const SATURATION_STEP = 0.05;
const HUE_COLORS = ['#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF', '#FF0000'];

export interface SignalColorPickerProps {
  color: string;
  disabled?: boolean;
  onChange(color: string): void;
}

function changedHsv(hsv: HsvColor, changes: Partial<Omit<HsvColor, 'value'>>): string {
  return hsvToHex({ ...hsv, ...changes, value: SIGNAL_COLOR_VALUE });
}

export function SignalColorPicker({ color, disabled = false, onChange }: SignalColorPickerProps) {
  const theme = useTheme();
  const normalizedColor = color.toUpperCase();
  const [hexInput, setHexInput] = useState({ color: normalizedColor, value: normalizedColor });
  const hsv = useMemo(() => hexToHsv(color), [color]);
  const marker = colorWheelPosition(hsv, WHEEL_SIZE);

  if (hexInput.color !== normalizedColor) {
    setHexInput({ color: normalizedColor, value: normalizedColor });
  }

  const changeWheel = (event: GestureResponderEvent): void => {
    if (disabled) return;
    const { locationX, locationY } = event.nativeEvent;
    onChange(hsvToHex(colorAtWheelPosition(locationX, locationY, WHEEL_SIZE)));
  };

  /**
   * Claim the touch outright, on both platforms, for as long as the finger is down.
   *
   * The wheel lives inside the profile editor's `ScrollView`, and a JS responder loses to a
   * scroll view by default the moment the finger moves: the scroll view asks for the responder,
   * the default answer is yes, and the drag turns into a page scroll partway through — the gesture
   * reads as the wheel "dragging the page" when you meant to pick a color, and the color stops
   * following your finger. Two different mechanisms have to be refused for that not to happen.
   *
   * `onResponderGrant` returning true is what blocks the NATIVE responder on Android
   * (`requestDisallowInterceptTouchEvent` up the tree — the same thing `PanResponder` returns by
   * default); `onResponderTerminationRequest` returning false is what denies the hand-off on iOS.
   */
  const grantWheel = (event: GestureResponderEvent): boolean => {
    changeWheel(event);
    return true;
  };

  const changeWheelWithAccessibility = (event: AccessibilityActionEvent): void => {
    if (disabled) return;
    switch (event.nativeEvent.actionName) {
      case 'increment':
        onChange(changedHsv(hsv, { hue: hsv.hue + HUE_STEP }));
        break;
      case 'decrement':
        onChange(changedHsv(hsv, { hue: hsv.hue - HUE_STEP }));
        break;
      case 'increaseSaturation':
        onChange(changedHsv(hsv, { saturation: hsv.saturation + SATURATION_STEP }));
        break;
      case 'decreaseSaturation':
        onChange(changedHsv(hsv, { saturation: hsv.saturation - SATURATION_STEP }));
        break;
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'position'}
      style={styles.container}
    >
      <View
        accessibilityActions={[
          { name: 'increment', label: 'Next hue' },
          { name: 'decrement', label: 'Previous hue' },
          { name: 'increaseSaturation', label: 'More saturated' },
          { name: 'decreaseSaturation', label: 'Less saturated' },
        ]}
        accessibilityHint="Swipe up or down to change hue. Use the custom actions to change saturation."
        accessibilityLabel="Signal color wheel"
        accessibilityRole="adjustable"
        accessibilityState={{ disabled }}
        accessibilityValue={{
          text: `${Math.round(hsv.hue)} degree hue, ${Math.round(hsv.saturation * 100)} percent saturation`,
        }}
        onAccessibilityAction={changeWheelWithAccessibility}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={grantWheel}
        onResponderMove={changeWheel}
        onResponderTerminationRequest={() => false}
        onStartShouldSetResponder={() => !disabled}
        style={styles.wheel}
      >
        <Canvas pointerEvents="none" style={styles.canvas}>
          <Circle cx={WHEEL_RADIUS} cy={WHEEL_RADIUS} r={WHEEL_RADIUS}>
            <SweepGradient c={vec(WHEEL_RADIUS, WHEEL_RADIUS)} colors={HUE_COLORS} />
          </Circle>
          <Circle cx={WHEEL_RADIUS} cy={WHEEL_RADIUS} r={WHEEL_RADIUS}>
            <RadialGradient
              c={vec(WHEEL_RADIUS, WHEEL_RADIUS)}
              colors={['#FFFFFF', '#FFFFFF00']}
              r={WHEEL_RADIUS}
            />
          </Circle>
          <Circle
            color="#07131F"
            cx={marker.x}
            cy={marker.y}
            r={10}
            style="stroke"
            strokeWidth={5}
          />
          <Circle
            color="#FFFFFF"
            cx={marker.x}
            cy={marker.y}
            r={10}
            style="stroke"
            strokeWidth={2}
          />
        </Canvas>
      </View>

      <View
        style={[
          styles.currentColor,
          { backgroundColor: color, borderColor: theme.backgroundSelected },
        ]}
      >
        <ThemedTextInput
          accessibilityLabel="Signal color hex value"
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!disabled}
          maxLength={7}
          onBlur={() => {
            if (!isSignalColor(hexInput.value)) {
              setHexInput({ color: normalizedColor, value: normalizedColor });
            }
          }}
          onChangeText={(value) => {
            if (disabled) return;
            const next = `#${value
              .replace(/^#/, '')
              .replace(/[^0-9a-f]/gi, '')
              .slice(0, 6)}`.toUpperCase();
            setHexInput({ color: normalizedColor, value: next });
            if (isSignalColor(next)) onChange(fullBrightnessColor(next));
          }}
          selectTextOnFocus
          spellCheck={false}
          style={[styles.hex, { color: signalColorInk(color) }]}
          type="code"
          value={hexInput.value}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  wheel: {
    borderRadius: WHEEL_RADIUS,
    height: WHEEL_SIZE,
    overflow: 'hidden',
    width: WHEEL_SIZE,
  },
  canvas: {
    flex: 1,
  },
  currentColor: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    marginTop: Spacing.one,
    minHeight: 38,
    minWidth: 112,
    paddingHorizontal: Spacing.three,
  },
  hex: {
    fontFamily: Fonts.mono,
    fontWeight: '700',
  },
});
