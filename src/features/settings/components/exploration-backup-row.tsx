import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type {
  ExplorationExportOutcome,
  ExplorationRestoreOutcome,
} from '@/features/map/exploration/exploration-backup-service';
import { useTheme } from '@/hooks/use-theme';

interface ExplorationBackupRowProps {
  accent: string;
  warningColor: string;
  busy: boolean;
  onExport(): Promise<ExplorationExportOutcome | null>;
  onRestore(): Promise<ExplorationRestoreOutcome | null>;
}

const IDLE = 'Ready';

function exportStatus(outcome: ExplorationExportOutcome): string {
  switch (outcome.status) {
    case 'shared':
      return `Backed up ${outcome.cells.toLocaleString()} hex${outcome.cells === 1 ? '' : 'es'}.`;
    case 'empty':
      return 'Nothing to back up yet — go uncover some hexes.';
    case 'unavailable':
      return 'This build cannot share files.';
  }
}

function restoreStatus(outcome: ExplorationRestoreOutcome): string {
  switch (outcome.status) {
    case 'restored': {
      const skipped = outcome.skipped ? `, ${outcome.skipped.toLocaleString()} already known` : '';
      const rejected = outcome.rejected ? `, ${outcome.rejected.toLocaleString()} unreadable` : '';
      return `Restored ${outcome.added.toLocaleString()} hex${
        outcome.added === 1 ? '' : 'es'
      }${skipped}${rejected}.`;
    }
    case 'canceled':
      return IDLE;
    case 'failed':
      return outcome.message;
  }
}

/**
 * Export/restore for your explored hexes — the app's only user-carried data.
 *
 * The copy is explicit about what the file holds because the honest answer is
 * the selling point: hexes, and nothing else. No times, no track, no friends.
 */
export function ExplorationBackupRow({
  accent,
  warningColor,
  busy,
  onExport,
  onRestore,
}: ExplorationBackupRowProps) {
  const theme = useTheme();
  const [status, setStatus] = useState(IDLE);
  const [failed, setFailed] = useState(false);

  const act = useCallback(async function act<T extends { status: string }>(
    run: () => Promise<T | null>,
    describe: (outcome: T) => string,
    pending: string
  ): Promise<void> {
    setStatus(pending);
    setFailed(false);
    try {
      const outcome = await run();
      if (!outcome) return; // another action is still running
      setStatus(describe(outcome));
      setFailed(outcome.status === 'failed' || outcome.status === 'unavailable');
    } catch {
      setStatus('That did not work. Try again.');
      setFailed(true);
    }
  }, []);

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">Explored hexes</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Save the hexes you have uncovered to a file, and load them back on a new phone. The file
          holds hex IDs only — no times, no route, nothing about anyone else. Restoring adds to what
          you have; it never erases it.
        </ThemedText>
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back up explored hexes"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void act(onExport, exportStatus, 'Backing up…')}
          style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
        >
          <ThemedText type="code" style={{ color: accent }}>
            BACK UP
          </ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Restore explored hexes"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => void act(onRestore, restoreStatus, 'Restoring…')}
          style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
        >
          <ThemedText type="code" style={{ color: accent }}>
            RESTORE
          </ThemedText>
        </Pressable>
      </View>

      <ThemedText
        type="code"
        themeColor="textSecondary"
        style={failed ? { color: warningColor } : undefined}
      >
        {status}
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
  copy: {
    gap: Spacing.one,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.four,
  },
  action: {
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.58,
  },
});
