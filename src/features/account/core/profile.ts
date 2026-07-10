const art = (...lines: string[]): string => lines.join('\n');

export const CRYPTID_PRESETS = [
  {
    id: 'mothman',
    name: 'Mothman',
    art: art('  \\.    ./', '   \\(oo)/', '    )~~(', '   /_||_\\'),
  },
  {
    id: 'jackalope',
    name: 'Jackalope',
    art: art('  \\Y/\\Y/', '   (o.o)', '   (>w<)', '   /"  "\\'),
  },
  {
    id: 'black-shuck',
    name: 'Black Shuck',
    art: art('  /^--^\\', ' ( o  o )', '  \\ ~~ /', " _/'  '\\_"),
  },
  {
    id: 'night-crawler',
    name: 'Night Crawler',
    art: art('    __', '   /  \\', '   |  |', '   |  |', '  _/  \\_'),
  },
  {
    id: 'lake-thing',
    name: 'Lake Thing',
    art: art('    .-.', '  _(o o)_', ' /  \\_/  \\', ' \\__   __/', '    |_|'),
  },
] as const;

export type CryptidPresetId = (typeof CRYPTID_PRESETS)[number]['id'];

export const DEFAULT_SIGNAL_COLOR = '#2F9E6A';
export const CRYPTID_PROFILE_VERSION = 1 as const;
export const MAX_SIGIL_LINES = 12;
export const MAX_SIGIL_COLUMNS = 32;
export const MAX_SIGIL_CHARS = 512;

export interface CryptidProfileDraft {
  handle: string;
  cryptidName: string;
  sigil: string;
  color: string;
  presetId: CryptidPresetId | null;
}

export interface CryptidProfile extends CryptidProfileDraft {
  version: typeof CRYPTID_PROFILE_VERSION;
}

export class CryptidProfileValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues[0] ?? 'Cryptid profile is invalid.');
    this.name = 'CryptidProfileValidationError';
  }
}

export function normalizeAsciiArt(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function normalizeHandle(value: string): string {
  const bare = value.trim().replace(/^@+/, '').toLowerCase();
  return `@${bare}`;
}

export function handleInputValue(handle: string): string {
  return handle.replace(/^@+/, '');
}

export function findCryptidPreset(
  id: string | null | undefined
): (typeof CRYPTID_PRESETS)[number] | null {
  return CRYPTID_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function defaultCryptidProfileDraft(): CryptidProfileDraft {
  const preset = CRYPTID_PRESETS[0];
  return {
    handle: '',
    cryptidName: preset.name,
    sigil: preset.art,
    color: DEFAULT_SIGNAL_COLOR,
    presetId: preset.id,
  };
}

export function profileToDraft(profile: CryptidProfile): CryptidProfileDraft {
  return {
    handle: profile.handle,
    cryptidName: profile.cryptidName,
    sigil: profile.sigil,
    color: profile.color,
    presetId: profile.presetId,
  };
}

function expandedLineLength(line: string): number {
  return line.replace(/\t/g, '    ').length;
}

export function sigilMeasurements(value: string): { lines: number; columns: number } {
  const lines = normalizeAsciiArt(value).split('\n');
  return {
    lines: lines.length,
    columns: lines.reduce((max, line) => Math.max(max, expandedLineLength(line)), 0),
  };
}

export function validateCryptidProfile(draft: CryptidProfileDraft): string[] {
  const issues: string[] = [];
  const handle = normalizeHandle(draft.handle).slice(1);
  const cryptidName = draft.cryptidName.trim();
  const sigil = normalizeAsciiArt(draft.sigil);
  const color = draft.color.trim();
  const measurements = sigilMeasurements(sigil);

  if (!/^[a-z0-9][a-z0-9_-]{1,19}$/.test(handle)) {
    issues.push('Use 2-20 lowercase letters, numbers, underscores, or dashes for the name.');
  }
  if (cryptidName.length < 1 || cryptidName.length > 24) {
    issues.push('Give the ASCII form a name between 1 and 24 characters.');
  }
  if (sigil.trim().length === 0) {
    issues.push('Choose a cryptid form or paste your own ASCII art.');
  }
  if (sigil.length > MAX_SIGIL_CHARS) {
    issues.push(`Keep ASCII art under ${MAX_SIGIL_CHARS} characters.`);
  }
  if (measurements.lines > MAX_SIGIL_LINES) {
    issues.push(`Keep ASCII art to ${MAX_SIGIL_LINES} lines or fewer.`);
  }
  if (measurements.columns > MAX_SIGIL_COLUMNS) {
    issues.push(`Keep each ASCII art line to ${MAX_SIGIL_COLUMNS} columns or fewer.`);
  }
  if (!/^[\t\n\x20-\x7e]*$/.test(sigil)) {
    issues.push('The custom form must use ASCII characters, spaces, tabs, and line breaks only.');
  }
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    issues.push('Choose a valid six-digit signal color.');
  }

  return issues;
}

export function createCryptidProfile(draft: CryptidProfileDraft): CryptidProfile {
  const normalized: CryptidProfileDraft = {
    handle: normalizeHandle(draft.handle),
    cryptidName: draft.cryptidName.trim(),
    sigil: normalizeAsciiArt(draft.sigil),
    color: draft.color.trim().toUpperCase(),
    presetId: findCryptidPreset(draft.presetId)?.id ?? null,
  };
  const issues = validateCryptidProfile(normalized);
  if (issues.length > 0) throw new CryptidProfileValidationError(issues);
  return { version: CRYPTID_PROFILE_VERSION, ...normalized };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseCryptidProfile(value: unknown): CryptidProfile {
  if (!isRecord(value) || value.version !== CRYPTID_PROFILE_VERSION) {
    throw new Error('Saved cryptid profile has an unsupported version.');
  }
  if (
    typeof value.handle !== 'string' ||
    typeof value.cryptidName !== 'string' ||
    typeof value.sigil !== 'string' ||
    typeof value.color !== 'string'
  ) {
    throw new Error('Saved cryptid profile is incomplete.');
  }

  return createCryptidProfile({
    handle: value.handle,
    cryptidName: value.cryptidName,
    sigil: value.sigil,
    color: value.color,
    presetId:
      typeof value.presetId === 'string' ? (findCryptidPreset(value.presetId)?.id ?? null) : null,
  });
}
