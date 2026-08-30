import { H3_DISPLAY_RES } from '../core/cell-ladder';
import type { CellIndex } from '../core/h3-grid';

/**
 * The exploration backup document: the ONLY user data this app lets you carry
 * off the device by hand, and deliberately the least of it.
 *
 * OS-level backups are switched off wholesale (`plugins/withBackupExclusion.js`)
 * because restoring key material or a friend's plaintext fixes is either useless
 * or unsafe. That leaves the one thing a user genuinely does not want to lose on
 * a new phone — which hexes they have walked — with no way out. This is it.
 *
 * What the document contains is exactly a set of res-9 H3 indices:
 *  - no timestamps, so it cannot say WHEN (or in what order) anything was
 *    uncovered — a restored cell is indistinguishable from one walked years ago;
 *  - no raw fixes, accuracies or headings, so it cannot be re-walked into a track;
 *  - nothing about anyone else — friends' trails live in the social DB and are
 *    never read here.
 *
 * The file is plain JSON on purpose: it is the user's own data, they should be
 * able to look at it, and a format that needs this app to inspect is a format
 * nobody audits.
 */

export const EXPLORATION_BACKUP_FORMAT = 'streetcryptid.exploration';
export const EXPLORATION_BACKUP_VERSION = 1;

export interface ExplorationBackup {
  readonly format: typeof EXPLORATION_BACKUP_FORMAT;
  readonly version: number;
  /** The H3 resolution every cell is stated at — refuse anything else. */
  readonly resolution: number;
  /** Sorted, de-duplicated H3 indices. */
  readonly cells: readonly CellIndex[];
}

/** A backup that could not be read, with a message fit to show the user. */
export class ExplorationBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExplorationBackupError';
  }
}

/** Canonical string form of an H3 index at {@link H3_DISPLAY_RES} (15 hex chars). */
const CELL_PATTERN = /^[0-9a-f]{15}$/;

/**
 * Guards against a hand-edited or hostile file turning restore into an
 * unbounded insert loop. Far above any plausible history: 2 M res-9 cells is
 * roughly the walkable area of a continent.
 */
const MAX_CELLS = 2_000_000;

/** Serialize explored cells as a backup document (sorted, so diffs are stable). */
export function encodeExplorationBackup(cells: Iterable<CellIndex>): string {
  const unique = [...new Set(cells)].sort();
  const backup: ExplorationBackup = {
    format: EXPLORATION_BACKUP_FORMAT,
    version: EXPLORATION_BACKUP_VERSION,
    resolution: H3_DISPLAY_RES,
    cells: unique,
  };
  return `${JSON.stringify(backup, null, 2)}\n`;
}

/**
 * Parse a backup document. Throws {@link ExplorationBackupError} with a
 * user-facing message for anything that is not one of ours — a wrong file
 * picked out of Files is the expected failure, not the exceptional one.
 */
export function decodeExplorationBackup(text: string): ExplorationBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ExplorationBackupError('That file is not a streetCryptid backup.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ExplorationBackupError('That file is not a streetCryptid backup.');
  }

  const doc = parsed as Record<string, unknown>;
  if (doc.format !== EXPLORATION_BACKUP_FORMAT) {
    throw new ExplorationBackupError('That file is not a streetCryptid backup.');
  }
  if (typeof doc.version !== 'number' || doc.version > EXPLORATION_BACKUP_VERSION) {
    throw new ExplorationBackupError(
      'That backup was written by a newer version of streetCryptid.'
    );
  }
  if (doc.resolution !== H3_DISPLAY_RES) {
    throw new ExplorationBackupError('That backup uses an unsupported hex size.');
  }
  if (!Array.isArray(doc.cells)) {
    throw new ExplorationBackupError('That backup is missing its hex list.');
  }
  if (doc.cells.length > MAX_CELLS) {
    throw new ExplorationBackupError('That backup is too large to restore.');
  }

  const cells = new Set<CellIndex>();
  for (const cell of doc.cells) {
    if (typeof cell !== 'string' || !CELL_PATTERN.test(cell)) {
      throw new ExplorationBackupError('That backup contains an entry that is not a hex.');
    }
    cells.add(cell);
  }

  return {
    format: EXPLORATION_BACKUP_FORMAT,
    version: doc.version,
    resolution: H3_DISPLAY_RES,
    cells: [...cells].sort(),
  };
}

/** `streetcryptid-hexes-2026-08-30.json` — dated, so successive exports do not collide. */
export function explorationBackupFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `streetcryptid-hexes-${stamp}.json`;
}
