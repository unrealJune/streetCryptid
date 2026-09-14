import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

export function DisplayPreferencesStatus({
  error,
  onRetry,
}: {
  readonly error: string | null;
  onRetry(): Promise<void>;
}) {
  return (
    <View style={styles.container}>
      <ThemedText
        accessibilityRole={error ? 'alert' : undefined}
        type="small"
        themeColor="textSecondary"
      >
        {error ?? 'Loading preferences…'}
      </ThemedText>
      {error ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading display preferences"
          onPress={() => void onRetry()}
          style={styles.retry}
        >
          <ThemedText type="smallBold">Retry</ThemedText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: Spacing.two },
  retry: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
});
