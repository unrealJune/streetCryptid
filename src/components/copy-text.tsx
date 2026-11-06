import { Text } from 'react-native';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';

import { ThemedText, type ThemedTextProps } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** `text` split into plain runs and `[label](https://…)` links, in order. */
export function copySegments(text: string): ({ text: string } | { text: string; href: string })[] {
  const out: ({ text: string } | { text: string; href: string })[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    if (match.index > at) out.push({ text: text.slice(at, match.index) });
    out.push({ text: match[1], href: match[2] });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

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
