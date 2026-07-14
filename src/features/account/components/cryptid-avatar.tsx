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

const MIN_ART_FONT_SCALE = 0.5;

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
  const lineCount = normalizedArt.split('\n').length;

  return (
    <View
      accessibilityLabel={`${name} ASCII cryptid`}
      style={[styles.container, { gap: dimensions.gap }, style]}
    >
      {/* Preserve the line count while shrinking wide art instead of wrapping it. */}
      <Text
        adjustsFontSizeToFit
        allowFontScaling={false}
        minimumFontScale={MIN_ART_FONT_SCALE}
        numberOfLines={lineCount}
        style={[
          styles.art,
          {
            color: signalColor,
            fontSize: dimensions.artSize,
            lineHeight: dimensions.artLineHeight,
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
  label: {
    fontFamily: Fonts.mono,
    fontWeight: '600',
    letterSpacing: 2,
    textAlign: 'center',
  },
});
