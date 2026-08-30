import { useCallback, useMemo, useRef, useState } from 'react';

import { createH3Grid, realH3 } from '../core/h3-grid';
import { createNativeH3Enumerator } from '../core/native-h3-enumerator';
import {
  exportExplorationBackup,
  restoreExplorationBackup,
  type ExplorationExportOutcome,
  type ExplorationRestoreOutcome,
} from '../exploration/exploration-backup-service';
import { sharedExplorationStore } from '../exploration/exploration-store';

/**
 * Settings' handle on exploration backup. It goes through the SHARED store, so
 * a restore performed here lands in the same instance the open map is reading
 * and the newly restored hexes fill in behind the sheet.
 */
export function useExplorationBackup(): {
  readonly busy: boolean;
  /** Null when another backup action is still running. */
  exportBackup(): Promise<ExplorationExportOutcome | null>;
  restoreBackup(): Promise<ExplorationRestoreOutcome | null>;
} {
  const store = useMemo(
    () => sharedExplorationStore(createH3Grid(realH3(), createNativeH3Enumerator())),
    []
  );
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(async function run<T>(work: () => Promise<T>): Promise<T | null> {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  return {
    busy,
    exportBackup: () => run<ExplorationExportOutcome>(() => exportExplorationBackup(store)),
    restoreBackup: () => run<ExplorationRestoreOutcome>(() => restoreExplorationBackup(store)),
  };
}
