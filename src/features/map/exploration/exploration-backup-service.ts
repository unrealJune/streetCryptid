import {
  decodeExplorationBackup,
  encodeExplorationBackup,
  ExplorationBackupError,
} from './exploration-backup';
import { pickExplorationBackup, shareExplorationBackup } from './exploration-backup-file';
import type { ExplorationStore } from './exploration-store';

/**
 * Backup and restore, joined up: the store owns the cells, the codec owns the
 * document, this owns the two user-facing verbs and their outcomes. The device
 * IO is a port so the flows can be tested without native modules.
 */

export interface ExplorationBackupIo {
  /** Present the share sheet; false when this build cannot share. */
  share(text: string): Promise<boolean>;
  /** Read a picked file, or null when the user cancelled. */
  pick(): Promise<string | null>;
}

export const deviceExplorationBackupIo: ExplorationBackupIo = {
  share: (text) => shareExplorationBackup(text),
  pick: () => pickExplorationBackup(),
};

export type ExplorationExportOutcome =
  | { readonly status: 'shared'; readonly cells: number }
  | { readonly status: 'empty' }
  | { readonly status: 'unavailable' };

export type ExplorationRestoreOutcome =
  | {
      readonly status: 'restored';
      readonly added: number;
      readonly skipped: number;
      readonly rejected: number;
    }
  | { readonly status: 'canceled' }
  | { readonly status: 'failed'; readonly message: string };

/** Encode every explored cell and hand the file to the share sheet. */
export async function exportExplorationBackup(
  store: ExplorationStore,
  io: ExplorationBackupIo = deviceExplorationBackupIo
): Promise<ExplorationExportOutcome> {
  const cells = await store.exportCells();
  // An empty file restores to nothing; saying so beats a share sheet full of `[]`.
  if (!cells.length) return { status: 'empty' };
  const shared = await io.share(encodeExplorationBackup(cells));
  return shared ? { status: 'shared', cells: cells.length } : { status: 'unavailable' };
}

/**
 * Read a picked backup and fold it in. Restore is a UNION, never a replace:
 * cells you have walked since the backup was written survive it, and importing
 * the same file twice changes nothing.
 */
export async function restoreExplorationBackup(
  store: ExplorationStore,
  io: ExplorationBackupIo = deviceExplorationBackupIo
): Promise<ExplorationRestoreOutcome> {
  let text: string | null;
  try {
    text = await io.pick();
  } catch {
    return { status: 'failed', message: 'That file could not be read.' };
  }
  if (text === null) return { status: 'canceled' };

  try {
    const backup = decodeExplorationBackup(text);
    const result = await store.importCells(backup.cells);
    return {
      status: 'restored',
      added: result.added.length,
      skipped: result.skipped,
      rejected: result.rejected,
    };
  } catch (error) {
    return {
      status: 'failed',
      message:
        error instanceof ExplorationBackupError ? error.message : 'That backup could not be read.',
    };
  }
}
