import { explorationBackupFileName } from './exploration-backup';

/**
 * The device side of exploration backup: hand the encoded document to the
 * system share sheet, and read one back through the system file picker.
 *
 * Both halves are lazy-required and guarded, following the expo-sqlite pattern
 * used elsewhere in this feature — web and any build without the native modules
 * degrade to "unavailable" rather than crashing the settings screen.
 *
 * The export is written to the CACHE directory on purpose: it is a throwaway
 * copy that exists only long enough for the share sheet to read it, and cache is
 * the one location Android's Auto Backup never captures
 * (`plugins/withBackupExclusion.js`), so the export cannot smuggle history into
 * the cloud backup the app deliberately opts out of.
 */

type FileHandle = {
  readonly uri: string;
  create(options?: { overwrite?: boolean }): void;
  write(content: string): void;
  text(): Promise<string>;
  delete(): void;
};

type FileSystemModule = {
  Paths: { cache: unknown };
  File: {
    new (...uris: unknown[]): FileHandle;
    pickFileAsync(options?: {
      mimeTypes?: string | string[];
    }): Promise<{ canceled: boolean; result: FileHandle | FileHandle[] | null }>;
  };
};

type SharingModule = {
  isAvailableAsync(): Promise<boolean>;
  shareAsync(
    url: string,
    options?: { mimeType?: string; dialogTitle?: string; UTI?: string }
  ): Promise<void>;
};

const MIME_TYPE = 'application/json';

function loadFileSystem(): FileSystemModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native load, same pattern as exploration-store.ts
    return require('expo-file-system') as FileSystemModule;
  } catch {
    return null;
  }
}

function loadSharing(): SharingModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native load, same pattern as exploration-store.ts
    return require('expo-sharing') as SharingModule;
  } catch {
    return null;
  }
}

/**
 * Write `text` to a dated file and present the system share sheet for it.
 * Resolves false when this build has no sharing (web / missing native module).
 */
export async function shareExplorationBackup(
  text: string,
  now: Date = new Date()
): Promise<boolean> {
  const fs = loadFileSystem();
  const sharing = loadSharing();
  if (!fs || !sharing) return false;
  if (!(await sharing.isAvailableAsync())) return false;

  const file = new fs.File(fs.Paths.cache, explorationBackupFileName(now));
  file.create({ overwrite: true });
  file.write(text);
  await sharing.shareAsync(file.uri, {
    mimeType: MIME_TYPE,
    UTI: 'public.json',
    dialogTitle: 'Back up explored hexes',
  });
  return true;
}

/**
 * Ask the user for a backup file and read it. Resolves null when the picker is
 * cancelled, and throws when the file cannot be read.
 */
export async function pickExplorationBackup(): Promise<string | null> {
  const fs = loadFileSystem();
  if (!fs) return null;

  const picked = await fs.File.pickFileAsync({ mimeTypes: [MIME_TYPE] });
  if (picked.canceled || !picked.result) return null;
  const file = Array.isArray(picked.result) ? picked.result[0] : picked.result;
  if (!file) return null;
  return file.text();
}

/** Whether this build can export at all — drives the settings copy. */
export function explorationBackupAvailable(): boolean {
  return loadFileSystem() !== null && loadSharing() !== null;
}
