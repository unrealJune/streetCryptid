import {
  Canvas,
  Circle,
  LinearGradient,
  RadialGradient,
  Rect,
  SweepGradient,
  vec,
} from '@shopify/react-native-skia';
import { useMemo } from 'react';
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { signalColorInk } from '@/constants/signal-colors';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  colorAtWheelPosition,
  colorWheelPosition,
  hexToHsv,
  hsvToHex,
  type HsvColor,
} from '../core/signal-color';

const WHEEL_SIZE = 232;
const WHEEL_RADIUS = WHEEL_SIZE / 2;
const BRIGHTNESS_HEIGHT = 28;
const HUE_STEP = 10;
const SATURATION_STEP = 0.05;
const VALUE_STEP = 0.05;
const HUE_COLORS = ['#FF0000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF', '#FF0000'];

interface SignalColorPickerProps {
  color: string;
  onChange(color: string): void;
}

function changedHsv(hsv: HsvColor, changes: Partial<HsvColor>): string {
  return hsvToHex({ ...hsv, ...changes });
}

export function SignalColorPicker({ color, onChange }: SignalColorPickerProps) {
  const theme = useTheme();
  const hsv = useMemo(() => hexToHsv(color), [color]);
  const marker = colorWheelPosition(hsv, WHEEL_SIZE);
  const fullBrightnessColor = hsvToHex({ ...hsv, value: 1 });

  const changeWheel = (event: GestureResponderEvent): void => {
    const { locationX, locationY } = event.nativeEvent;
    onChange(hsvToHex(colorAtWheelPosition(locationX, locationY, WHEEL_SIZE, hsv.value)));
  };

  const changeBrightness = (event: GestureResponderEvent): void => {
    onChange(changedHsv(hsv, { value: event.nativeEvent.locationX / WHEEL_SIZE }));
  };

  const changeWheelWithAccessibility = (event: AccessibilityActionEvent): void => {
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

  const changeBrightnessWithAccessibility = (event: AccessibilityActionEvent): void => {
    const direction = event.nativeEvent.actionName === 'increment' ? 1 : -1;
    onChange(changedHsv(hsv, { value: hsv.value + direction * VALUE_STEP }));
  };

  return (
    <View style={styles.container}>
      <View
        accessibilityActions={[
          { name: 'increment', label: 'Next hue' },
          { name: 'decrement', label: 'Previous hue' },
          { name: 'increaseSaturation', label: 'More saturated' },
          { name: 'decreaseSaturation', label: 'Less saturated' },
        ]}
        accessibilityLabel="Signal color wheel"
        accessibilityRole="adjustable"
        accessibilityValue={{
          text: `${Math.round(hsv.hue)} degree hue, ${Math.round(hsv.saturation * 100)} percent saturation`,
        }}
        onAccessibilityAction={changeWheelWithAccessibility}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={changeWheel}
        onResponderMove={changeWheel}
        onStartShouldSetResponder={() => true}
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
            color="#000000"
            cx={WHEEL_RADIUS}
            cy={WHEEL_RADIUS}
            opacity={1 - hsv.value}
            r={WHEEL_RADIUS}
          />
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

      <View style={styles.brightnessCopy}>
        <ThemedText style={styles.label}>Brightness</ThemedText>
        <ThemedText type="code" themeColor="textSecondary">
          {Math.round(hsv.value * 100)}%
        </ThemedText>
      </View>
      <View
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        accessibilityLabel="Signal color brightness"
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(hsv.value * 100) }}
        onAccessibilityAction={changeBrightnessWithAccessibility}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={changeBrightness}
        onResponderMove={changeBrightness}
        onStartShouldSetResponder={() => true}
        style={[styles.brightness, { borderColor: theme.backgroundSelected }]}
      >
        <Canvas pointerEvents="none" style={styles.canvas}>
          <Rect height={BRIGHTNESS_HEIGHT} width={WHEEL_SIZE} x={0} y={0}>
            <LinearGradient
              colors={['#000000', fullBrightnessColor]}
              end={vec(WHEEL_SIZE, 0)}
              start={vec(0, 0)}
            />
          </Rect>
          <Rect
            color="#07131F"
            height={BRIGHTNESS_HEIGHT}
            width={5}
            x={hsv.value * (WHEEL_SIZE - 5)}
            y={0}
          />
          <Rect
            color="#FFFFFF"
            height={BRIGHTNESS_HEIGHT}
            width={2}
            x={hsv.value * (WHEEL_SIZE - 2)}
            y={0}
          />
        </Canvas>
      </View>

      <View
        style={[
          styles.currentColor,
          { backgroundColor: color, borderColor: theme.backgroundSelected },
        ]}
      >
        <ThemedText type="code" style={[styles.hex, { color: signalColorInk(color) }]}>
          {color.toUpperCase()}
        </ThemedText>
      </View>
    </View>
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
  brightnessCopy: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: WHEEL_SIZE,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  brightness: {
    borderRadius: BRIGHTNESS_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
    height: BRIGHTNESS_HEIGHT,
    overflow: 'hidden',
    width: WHEEL_SIZE,
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
