import { Text } from 'react-native';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';

import { ThemedText, type ThemedTextProps } from '@/components/themed-text';
import { copySegments } from '@/copy/segments';
import { useTheme } from '@/hooks/use-theme';

/**
 * A paragraph from `src/copy/`, where `[label](https://…)` is the one piece of Markdown honoured:
 * it becomes an underlined link that opens in the in-app browser.
 */
export function CopyText({ text, ...props }: ThemedTextProps & { text: string }) {
  const theme = useTheme();
  return (
    <ThemedText {...props}>
      {copySegments(text).map((segment, index) =>
        'href' in segment ? (
          // A bare Text, so the link inherits the paragraph's size and weight.
          <Text
            key={index}
            accessibilityRole="link"
            onPress={() =>
              void openBrowserAsync(segment.href, {
                presentationStyle: WebBrowserPresentationStyle.AUTOMATIC,
              })
            }
            style={{ color: theme.text, textDecorationLine: 'underline' }}
          >
            {segment.text}
          </Text>
        ) : (
          segment.text
        )
      )}
    </ThemedText>
  );
}
