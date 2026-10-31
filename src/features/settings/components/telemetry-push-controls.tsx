import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { describeTelemetryPush, type TelemetryPushResult } from '../core/telemetry-push';

interface TelemetryPushControlsProps {
  accent: string;
  onPush(): Promise<TelemetryPushResult>;
}

/**
 * Send every queued span and log to the collector now. Telemetry on both halves of the app is
 * spooled when a phone is offline and only drains as new telemetry is exported, with backoff; on an
 * iPhone that is then backgrounded, nothing new is exported, and the logs of the moment worth
 * debugging stay on the phone. Press this after reproducing something, while the app is open.
 */
export function TelemetryPushControls({ accent, onPush }: TelemetryPushControlsProps) {
  const theme = useTheme();
  const [status, setStatus] = useState<string[]>(['Ready']);
  const inFlight = useRef(false);

  const push = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus(['Pushing…']);
    try {
      const result = await onPush();
      setStatus([...describeTelemetryPush(result), `at ${new Date().toLocaleTimeString()}`]);
    } catch (error) {
      setStatus([`Push failed: ${error instanceof Error ? error.message : String(error)}`]);
    } finally {
      inFlight.current = false;
    }
  }, [onPush]);

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.heading}>
        <View style={styles.copy}>
          <ThemedText type="smallBold">Push Logs</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Sends everything queued on this phone to the collector now, ignoring backoff.
          </ThemedText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Push logs now"
          onPress={() => void push()}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <ThemedText type="code" style={{ color: accent }}>
            PUSH NOW
          </ThemedText>
        </Pressable>
      </View>
      <View style={styles.copy}>
        {status.map((line, index) => (
          <ThemedText key={index} type="code" themeColor="textSecondary">
            {line}
          </ThemedText>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    padding: Spacing.three,
  },
  heading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  action: {
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.58,
  },
});
