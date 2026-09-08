import * as Clipboard from 'expo-clipboard';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, type StyleProp, View, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

const COPIED_RESET_MS = 2000;

interface ErrorNoticeProps {
  accent: string;
  title: string;
  message: string;
  /** Text placed on the clipboard when the notice is tapped. Defaults to the title and message. */
  copyText?: string;
  backgroundColor?: string;
  numberOfLines?: number;
  /** Rendered at the trailing edge, next to the copy. Presses on it do not copy. */
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function ErrorNotice({
  accent,
  title,
  message,
  copyText,
  backgroundColor,
  numberOfLines,
  action,
  style,
}: ErrorNoticeProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const copy = async (): Promise<void> => {
    const text = copyText ?? `${title}\n${message}`;
    if (!text.trim()) return;
    await Clipboard.setStringAsync(text);
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${message}`}
      accessibilityHint="Copies the error details to the clipboard"
      accessibilityLiveRegion="polite"
      onPress={() => void copy()}
      style={({ pressed }) => [
        styles.notice,
        { borderColor: accent },
        backgroundColor ? { backgroundColor } : null,
        pressed && styles.pressed,
        style,
      ]}
    >
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <ThemedText type="smallBold" style={styles.title}>
            {title}
          </ThemedText>
          {copied ? (
            <ThemedText type="code" style={{ color: accent }}>
              COPIED
            </ThemedText>
          ) : null}
        </View>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={numberOfLines}>
          {message}
        </ThemedText>
      </View>
      {action}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  notice: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  title: {
    flexShrink: 1,
  },
  pressed: {
    opacity: 0.62,
  },
});
