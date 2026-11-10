import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

interface HexTabProps {
  readonly fill: string;
  readonly width: number;
  /** How far each hex cut reaches in, both across and along the tab. */
  readonly cut: number;
  /** Omitted, the tab fills its parent's height (`flex: 1`), for a parent stretched by its row. */
  readonly height?: number;
  /** Laid over the whole tab, for its content. */
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
}

/**
 * A tab with hex-cut corners on its leading side and a square trailing side, for sitting flush
 * against an edge — the screen's for the onboarding rail, the island's for the friend pane's
 * navigate button. Drawn from plain views, so it needs no SVG or Skia: two border-trick
 * trapezoids for the cut ends and a rectangle between them. The pieces meet without overlapping,
 * so a translucent fill stays one even tint.
 */
export function HexTab({ fill, width, cut, height, style, children }: HexTabProps) {
  const sized: ViewStyle = height === undefined ? { flex: 1, width } : { height, width };
  return (
    <View style={sized}>
      <View
        style={[
          styles.cut,
          { borderBottomColor: fill, borderBottomWidth: cut, borderLeftWidth: cut, top: 0, width },
        ]}
      />
      <View style={[styles.body, { backgroundColor: fill, bottom: cut, top: cut }]} />
      <View
        style={[
          styles.cut,
          { borderTopColor: fill, borderTopWidth: cut, borderLeftWidth: cut, bottom: 0, width },
        ]}
      />
      <View style={[StyleSheet.absoluteFill, style]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  cut: {
    borderLeftColor: 'transparent',
    height: 0,
    position: 'absolute',
    right: 0,
  },
  body: {
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
