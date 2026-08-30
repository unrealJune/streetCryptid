import {
  decodeExplorationBackup,
  encodeExplorationBackup,
  EXPLORATION_BACKUP_FORMAT,
  ExplorationBackupError,
  explorationBackupFileName,
} from '../exploration-backup';

import { H3_DISPLAY_RES } from '../../core/cell-ladder';
import { createH3Grid, realH3 } from '../../core/h3-grid';
import { latLonToWorld } from '../../core/mercator';

const grid = createH3Grid(realH3());
const cellA = grid.cellAt(latLonToWorld({ lat: 47.62, lon: -122.32 }), H3_DISPLAY_RES);
const cellB = grid.cellAt(latLonToWorld({ lat: 47.64, lon: -122.35 }), H3_DISPLAY_RES);

describe('encodeExplorationBackup', () => {
  it('round-trips cells, sorted and de-duplicated', () => {
    const text = encodeExplorationBackup([cellB, cellA, cellB]);
    expect(decodeExplorationBackup(text).cells).toEqual([cellA, cellB].sort());
  });

  it('carries nothing but cell indices', () => {
    const doc = JSON.parse(encodeExplorationBackup([cellA])) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['cells', 'format', 'resolution', 'version']);
    expect(doc.format).toBe(EXPLORATION_BACKUP_FORMAT);
    expect(doc.resolution).toBe(H3_DISPLAY_RES);
    // No timestamps anywhere: the whole file is the format header plus strings.
    expect(JSON.stringify(doc)).not.toMatch(/\d{10,}/);
  });

  it('encodes an empty history without failing', () => {
    expect(decodeExplorationBackup(encodeExplorationBackup([])).cells).toEqual([]);
  });
});

describe('decodeExplorationBackup', () => {
  it('rejects files that are not backups', () => {
    expect(() => decodeExplorationBackup('not json')).toThrow(ExplorationBackupError);
    expect(() => decodeExplorationBackup('[]')).toThrow(ExplorationBackupError);
    expect(() => decodeExplorationBackup('{"format":"something-else"}')).toThrow(
      ExplorationBackupError
    );
  });

  it('rejects a newer format version', () => {
    const text = JSON.stringify({
      format: EXPLORATION_BACKUP_FORMAT,
      version: 99,
      resolution: H3_DISPLAY_RES,
      cells: [],
    });
    expect(() => decodeExplorationBackup(text)).toThrow(/newer version/);
  });

  it('rejects a different hex resolution', () => {
    const text = JSON.stringify({
      format: EXPLORATION_BACKUP_FORMAT,
      version: 1,
      resolution: H3_DISPLAY_RES + 1,
      cells: [],
    });
    expect(() => decodeExplorationBackup(text)).toThrow(/hex size/);
  });

  it('rejects entries that are not H3 indices', () => {
    for (const cells of [['nope'], [42], [`${cellA}0`], [cellA.toUpperCase()]]) {
      const text = JSON.stringify({
        format: EXPLORATION_BACKUP_FORMAT,
        version: 1,
        resolution: H3_DISPLAY_RES,
        cells,
      });
      expect(() => decodeExplorationBackup(text)).toThrow(ExplorationBackupError);
    }
  });
});

describe('explorationBackupFileName', () => {
  it('is dated so successive exports do not collide', () => {
    expect(explorationBackupFileName(new Date(2026, 7, 30))).toBe(
      'streetcryptid-hexes-2026-08-30.json'
    );
  });
});
