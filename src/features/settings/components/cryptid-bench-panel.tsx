import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  BENCH_DESCRIPTIONS,
  BENCH_SEEDS,
  formatBenchSummary,
  runCryptidGeneratorBench,
} from '@/features/account/dev/cryptid-generator-bench';
import { useTheme } from '@/hooks/use-theme';

interface CryptidBenchPanelProps {
  accent: string;
}

const TOTAL_RUNS = BENCH_DESCRIPTIONS.length * BENCH_SEEDS.length;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the fixed generator corpus so prompt and scorer changes can be compared on a real device
 * instead of eyeballed. Every run also lands in the event log above.
 */
export function CryptidBenchPanel({ accent }: CryptidBenchPanelProps) {
  const theme = useTheme();
  const [status, setStatus] = useState(`Idle — ${TOTAL_RUNS} runs queued.`);
  const [report, setReport] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setReport(null);
    setStatus(`Running 1/${TOTAL_RUNS}…`);
    try {
      const summary = await runCryptidGeneratorBench({
        onRun: (_run, index, total) => setStatus(`Running ${index}/${total}…`),
      });
      setReport(formatBenchSummary(summary));
      setStatus(`Done at ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      setStatus(`Bench failed: ${errorMessage(error)}`);
    } finally {
      running.current = false;
    }
  }, []);

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.heading}>
        <View style={styles.copy}>
          <ThemedText type="smallBold">Icon generator bench</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Generates {TOTAL_RUNS} cryptids and reports how many drawings the shape scorer accepts.
            Slow — the on-device model runs every time.
          </ThemedText>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Run the icon generator bench"
          onPress={() => void run()}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <ThemedText type="code" style={{ color: accent }}>
            RUN
          </ThemedText>
        </Pressable>
      </View>

      <ThemedText type="code" themeColor="textSecondary">
        {status}
      </ThemedText>
      {report ? <ThemedText type="code">{report}</ThemedText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
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
