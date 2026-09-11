import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';

import type { PairingFigure } from '../core/pairing-figures';
import { PressableAction } from './pressable-action';

interface PairingFigureViewProps {
  readonly accent: string;
  readonly figure: PairingFigure;
  /** The stage-sized figure this phone is displaying, rather than one of four candidates. */
  readonly large?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

export function PairingFigureView({
  accent,
  figure,
  large = false,
  style,
}: PairingFigureViewProps) {
  return (
    <View
      accessible={large}
      accessibilityLabel={large ? `${figure.name} ASCII pairing figure` : undefined}
      accessibilityRole={large ? 'text' : undefined}
      testID={large ? 'pairing-target-figure' : undefined}
      style={[styles.figure, style]}
    >
      <Text
        accessible={false}
        allowFontScaling={false}
        style={[styles.art, large ? styles.artLarge : styles.artSmall, { color: accent }]}
      >
        {figure.art}
      </Text>
      <ThemedText
        accessible={false}
        type="code"
        themeColor="textSecondary"
        style={styles.figureName}
      >
        {figure.name.toUpperCase()}
      </ThemedText>
    </View>
  );
}

interface PairingFigureChoicesProps {
  readonly accent: string;
  readonly borderColor: string;
  readonly disabled: boolean;
  readonly options: readonly PairingFigure[];
  onChoose(figureIndex: number): void;
}

/**
 * The four candidates, as a fixed two-by-two grid.
 *
 * Two columns rather than a wrapping row: the choice is between four things at once, and a
 * layout that can reflow to 1×4 or 3+1 on a narrow phone turns a comparison into a scroll.
 */
export function PairingFigureChoices({
  accent,
  borderColor,
  disabled,
  options,
  onChoose,
}: PairingFigureChoicesProps) {
  return (
    <View accessibilityRole="radiogroup" style={styles.options}>
      {options.map((figure) => (
        <PressableAction
          key={figure.index}
          accessibilityRole="radio"
          accessibilityLabel={`Pairing figure: ${figure.name}`}
          accessibilityState={{ checked: false, disabled }}
          disabled={disabled}
          onPress={() => onChoose(figure.index)}
          testID={`pairing-figure-option-${figure.index}`}
          style={[styles.option, { borderColor }]}
        >
          <PairingFigureView accent={accent} figure={figure} />
        </PressableAction>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    width: '100%',
  },
  option: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 132,
    // Two per row at any stage width: a 45% basis fits exactly two before the third wraps,
    // and flexGrow then shares out whatever the gap left over.
    flexBasis: '45%',
    flexGrow: 1,
    minWidth: 0,
    padding: Spacing.two,
  },
  figure: {
    alignItems: 'center',
    gap: Spacing.two,
    justifyContent: 'center',
  },
  art: {
    fontFamily: Fonts.mono,
    includeFontPadding: false,
    textAlign: 'left',
  },
  artSmall: {
    fontSize: 14,
    lineHeight: 17,
  },
  artLarge: {
    fontSize: 22,
    lineHeight: 26,
  },
  figureName: {
    letterSpacing: 0.6,
    textAlign: 'center',
  },
});
