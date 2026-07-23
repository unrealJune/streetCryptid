import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface AuthorIdRowProps {
  authorId: string | null;
}

export function AuthorIdRow({ authorId }: AuthorIdRowProps) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);

  const copyAuthorId = async () => {
    if (!authorId) return;
    await Clipboard.setStringAsync(authorId);
    setCopied(true);
  };

  return (
    <View style={styles.container}>
      <ThemedText type="small" themeColor="textSecondary">
        Author ID
      </ThemedText>
      <View style={styles.valueRow}>
        <ThemedText selectable type="code" style={styles.value}>
          {authorId ?? 'Unavailable'}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy author ID"
          disabled={!authorId}
          onPress={() => void copyAuthorId()}
          style={({ pressed }) => [
            styles.button,
            { borderColor: theme.backgroundSelected },
            pressed && styles.pressed,
            !authorId && styles.disabled,
          ]}
        >
          <ThemedText type="smallBold">{copied ? 'Copied' : 'Copy'}</ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  valueRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  value: {
    flex: 1,
  },
  button: {
    borderRadius: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
});
