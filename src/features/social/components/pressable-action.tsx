import { type ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface PressableActionProps extends Omit<PressableProps, 'style' | 'children'> {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  /** How far the control sinks under a finger. Smaller controls need less to read. */
  readonly pressScale?: number;
}

const PRESS_IN_MS = 90;
const PRESS_OUT_MS = 180;

/**
 * A control that acknowledges the finger before the work starts.
 *
 * `opacity: pressed ? 0.6 : 1` jumps between two values on the JS thread, so a tap that kicks
 * off Bluetooth work registers late or not at all. Driving scale and opacity from the UI thread
 * means the control always responds on the frame it was touched, however busy JS is.
 */
export function PressableAction({
  children,
  disabled,
  pressScale = 0.97,
  style,
  ...rest
}: PressableActionProps) {
  const reducedMotion = useReducedMotion();
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: (disabled ? 0.42 : 1) - pressed.value * 0.26,
    transform: [{ scale: 1 - pressed.value * (1 - pressScale) }],
  }));

  return (
    <AnimatedPressable
      disabled={disabled}
      onPressIn={() => {
        pressed.value = withTiming(1, { duration: reducedMotion ? 0 : PRESS_IN_MS });
      }}
      onPressOut={() => {
        pressed.value = withTiming(0, { duration: reducedMotion ? 0 : PRESS_OUT_MS });
      }}
      style={[style, animatedStyle]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}
