import { forwardRef } from 'react';
import { TextInput, type TextInputProps } from 'react-native';

import { themedTextStyles, type ThemedTextProps } from '@/components/themed-text';
import { ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextInputProps = TextInputProps & {
  type?: ThemedTextProps['type'];
  themeColor?: ThemeColor;
};

export const ThemedTextInput = forwardRef<TextInput, ThemedTextInputProps>(function ThemedTextInput(
  { placeholderTextColor, style, type = 'default', themeColor, ...rest },
  ref
) {
  const theme = useTheme();

  return (
    <TextInput
      ref={ref}
      placeholderTextColor={placeholderTextColor ?? theme.textSecondary}
      style={[{ color: theme[themeColor ?? 'text'] }, themedTextStyles[type], style]}
      {...rest}
    />
  );
});
