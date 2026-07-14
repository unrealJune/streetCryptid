import { useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Fonts } from '@/constants/theme';
import { normalizeAsciiArt } from '../core/profile';

type AvatarSize = 'compact' | 'large';

interface CryptidAvatarProps {
  art: string;
  name: string;
  color: string;
  size?: AvatarSize;
  muted?: boolean;
  style?: StyleProp<ViewStyle>;
}

const ART_MEASUREMENT_WIDTH = 10000;

const sizes = {
  compact: {
    artSize: 9,
    artLineHeight: 11,
    labelSize: 8,
    gap: 4,
  },
  large: {
    artSize: 15,
    artLineHeight: 18,
    labelSize: 10,
    gap: 8,
  },
} as const;

export function CryptidAvatar({
  art,
  name,
  color,
  size = 'compact',
  muted = false,
  style,
}: CryptidAvatarProps) {
  const dimensions = sizes[size];
  const signalColor = muted ? `${color}70` : color;
  const normalizedArt = normalizeAsciiArt(art);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [naturalWidth, setNaturalWidth] = useState(0);
  const scale =
    availableWidth > 0 && naturalWidth > availableWidth ? availableWidth / naturalWidth : 1;

  return (
    <View
      accessibilityLabel={`${name} ASCII cryptid`}
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
      style={[styles.container, { gap: dimensions.gap }, style]}
    >
      {/* Measure unwrapped lines so the visible art can scale to the available phone width. */}
      <Text
        accessible={false}
        allowFontScaling={false}
        onTextLayout={(event) =>
          setNaturalWidth(
            event.nativeEvent.lines.reduce((width, line) => Math.max(width, line.width), 0)
          )
        }
        style={[
          styles.art,
          styles.measurementArt,
          {
            fontSize: dimensions.artSize,
            lineHeight: dimensions.artLineHeight,
          },
        ]}
      >
        {normalizedArt}
      </Text>
      <Text
        allowFontScaling={false}
        style={[
          styles.art,
          {
            color: signalColor,
            fontSize: dimensions.artSize * scale,
            lineHeight: dimensions.artLineHeight * scale,
          },
        ]}
      >
        {normalizedArt}
      </Text>
      <Text
        allowFontScaling={false}
        style={[styles.label, { color: signalColor, fontSize: dimensions.labelSize }]}
      >
        {name.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
  },
  art: {
    alignSelf: 'center',
    fontFamily: Fonts.mono,
    includeFontPadding: false,
    maxWidth: '100%',
    textAlign: 'left',
  },
  measurementArt: {
    opacity: 0,
    position: 'absolute',
    width: ART_MEASUREMENT_WIDTH,
  },
  label: {
    fontFamily: Fonts.mono,
    fontWeight: '600',
    letterSpacing: 2,
    textAlign: 'center',
  },
});
