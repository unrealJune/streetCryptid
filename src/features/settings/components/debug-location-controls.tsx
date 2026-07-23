import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type IntervalUnit = 'seconds' | 'minutes';
type PushTrigger = 'manual' | 'scheduled';

interface DebugLocationControlsProps {
  accent: string;
  onPush(trigger: PushTrigger): Promise<number>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DebugLocationControls({ accent, onPush }: DebugLocationControlsProps) {
  const theme = useTheme();
  const [amount, setAmount] = useState('30');
  const [unit, setUnit] = useState<IntervalUnit>('seconds');
  const [scheduled, setScheduled] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [status, setStatus] = useState('Ready');
  const inFlight = useRef(false);

  const intervalValue = Number(amount);
  const intervalMs =
    Number.isFinite(intervalValue) && intervalValue >= 1
      ? intervalValue * (unit === 'minutes' ? 60_000 : 1000)
      : null;

  const push = useCallback(
    async (trigger: PushTrigger) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setStatus(trigger === 'manual' ? 'Pushing…' : 'Scheduled push…');
      try {
        const seq = await onPush(trigger);
        setStatus(`Published seq ${seq} at ${new Date().toLocaleTimeString()}`);
      } catch (error) {
        setStatus(`Push failed: ${errorMessage(error)}`);
      } finally {
        inFlight.current = false;
      }
    },
    [onPush]
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!scheduled || !appActive || intervalMs === null) return;
    const timer = setInterval(() => void push('scheduled'), intervalMs);
    return () => clearInterval(timer);
  }, [appActive, intervalMs, push, scheduled]);

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.heading}>
        <View style={styles.copy}>
          <ThemedText type="smallBold">Forced location pushes</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Bypass motion sampling and publish a fresh GPS fix for trace and server debugging.
          </ThemedText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Push location now"
          onPress={() => void push('manual')}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <ThemedText type="code" style={{ color: accent }}>
            PUSH NOW
          </ThemedText>
        </Pressable>
      </View>

      <View style={styles.schedule}>
        <View style={styles.copy}>
          <ThemedText type="smallBold">Fixed foreground schedule</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Runs while the app is active. Scheduled pushes skip if another push is still running.
          </ThemedText>
        </View>
        <Switch
          accessibilityRole="switch"
          accessibilityLabel="Enable fixed location push schedule"
          disabled={intervalMs === null}
          value={scheduled}
          onValueChange={setScheduled}
          trackColor={{ true: accent, false: theme.backgroundSelected }}
        />
      </View>

      <View style={styles.interval}>
        <ThemedText type="small" themeColor="textSecondary">
          Every
        </ThemedText>
        <TextInput
          accessibilityLabel="Location push interval"
          keyboardType="number-pad"
          onChangeText={setAmount}
          selectTextOnFocus
          style={[
            styles.input,
            {
              borderColor: intervalMs === null ? theme.error : theme.backgroundSelected,
              color: theme.text,
            },
          ]}
          value={amount}
        />
        {(['seconds', 'minutes'] as const).map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={`Use ${option} for the location push interval`}
            accessibilityState={{ selected: unit === option }}
            onPress={() => setUnit(option)}
            style={[
              styles.unit,
              {
                backgroundColor:
                  unit === option ? theme.backgroundSelected : theme.backgroundSecondary,
              },
            ]}
          >
            <ThemedText type="code">{option === 'seconds' ? 'SEC' : 'MIN'}</ThemedText>
          </Pressable>
        ))}
      </View>

      <ThemedText type="code" themeColor="textSecondary">
        {intervalMs === null ? 'Enter a value of at least 1.' : status}
      </ThemedText>
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
  schedule: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
  },
  interval: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  input: {
    borderRadius: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: Fonts.mono,
    minWidth: 64,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    textAlign: 'center',
  },
  unit: {
    borderRadius: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
});
