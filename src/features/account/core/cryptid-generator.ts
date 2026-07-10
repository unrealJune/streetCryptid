import { tryGetCryptidGenerator, type NativeGeneratedCryptid } from 'cryptid-generator';

import { DEFAULT_SIGNAL_COLOR, normalizeAsciiArt, validateCryptidProfileFields } from './profile';

const MAX_DESCRIPTION_LENGTH = 160;
const MAX_NATIVE_SEED = 2_147_483_647;

export type CryptidGenerationSource = 'system' | 'local';

export interface GeneratedCryptid {
  name: string;
  sigil: string;
  source: CryptidGenerationSource;
}

interface LocalArchetype {
  keywords: readonly string[];
  nouns: readonly string[];
  render(leftEye: string, rightEye: string, mouth: string): string;
}

const art = (...lines: string[]): string => lines.join('\n');

const ARCHETYPES: readonly LocalArchetype[] = [
  {
    keywords: ['moth', 'wing', 'fly', 'bat'],
    nouns: ['Moth', 'Flutter', 'Nightwing'],
    render: (left, right, mouth) =>
      art(
        '  /\\     /\\',
        ' /  \\___/  \\',
        `((  ${left}   ${right}  ))`,
        ` \\\\   ${mouth}   //`,
        '   \\_/_\\_/'
      ),
  },
  {
    keywords: ['antler', 'deer', 'stag', 'forest'],
    nouns: ['Stag', 'Warden', 'Briar'],
    render: (left, right, mouth) =>
      art(
        ' \\|/   \\|/',
        '  \\ \\_/ /',
        `  / ${left} ${right} \\`,
        ` (   ${mouth}   )`,
        '  \\_===_/',
        '   /   \\'
      ),
  },
  {
    keywords: ['dog', 'hound', 'wolf', 'shuck'],
    nouns: ['Hound', 'Shuck', 'Howler'],
    render: (left, right, mouth) =>
      art(
        '   /^---^\\',
        `  / ${left}   ${right} \\`,
        ` |    ${mouth}    |`,
        '  \\  ===  /',
        '   /|   |\\'
      ),
  },
  {
    keywords: ['lake', 'water', 'river', 'fish', 'swamp'],
    nouns: ['Lake Thing', 'Reedling', 'Tidekin'],
    render: (left, right, mouth) =>
      art(
        '     .-.',
        ` .--(${left} ${right})--.`,
        `(    \\${mouth}/    )`,
        " `--.___.--'",
        '    /~~~\\'
      ),
  },
  {
    keywords: ['owl', 'bird', 'feather', 'sky'],
    nouns: ['Owl', 'Watcher', 'Rook'],
    render: (left, right, mouth) =>
      art('   .---.', `  / ${left} ${right} \\`, ` |   ${mouth}   |`, '  \\ /|\\ /', "   '---'"),
  },
  {
    keywords: ['crawl', 'long', 'leg', 'tall'],
    nouns: ['Crawler', 'Longstep', 'Strider'],
    render: (left, right, mouth) =>
      art(
        '    _____',
        `   / ${left} ${right} \\`,
        `  /   ${mouth}   \\`,
        '  |  ---  |',
        ' /|       |\\',
        '/_|       |_\\'
      ),
  },
  {
    keywords: ['horn', 'goat', 'ram', 'mountain'],
    nouns: ['Ram', 'Cragling', 'Hornkin'],
    render: (left, right, mouth) =>
      art(
        '   /\\/\\',
        '  /    \\',
        ` | ${left}  ${right} |`,
        ` |  ${mouth}   |`,
        '  \\_==_/',
        '  / || \\'
      ),
  },
  {
    keywords: ['ghost', 'wisp', 'fog', 'mist', 'spirit'],
    nouns: ['Wisp', 'Drifter', 'Veil'],
    render: (left, right, mouth) =>
      art(
        '    .-.',
        `   (${left} ${right})`,
        ` .--\`${mouth}'--.`,
        ' (   /|\\   )',
        "  `- /_\\ -'"
      ),
  },
] as const;

const EYES = ['oo', 'OO', '..', '^^', '**', '++'] as const;
const MOUTHS = ['^', '~', '-', 'v', '_'] as const;
const PREFIXES = ['Quiet', 'Fog', 'Moss', 'Night', 'Rain', 'Alley', 'Signal', 'Ash'] as const;

const PREFIX_KEYWORDS: readonly [readonly string[], string][] = [
  [['rain', 'storm', 'wet'], 'Rain'],
  [['fog', 'mist', 'haze'], 'Fog'],
  [['moss', 'green', 'forest'], 'Moss'],
  [['night', 'dark', 'moon'], 'Night'],
  [['city', 'street', 'alley'], 'Alley'],
  [['quiet', 'shy', 'gentle'], 'Quiet'],
];

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pick<T>(values: readonly T[], hash: number, shift: number): T {
  return values[(hash >>> shift) % values.length];
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  return Math.max(1, Math.trunc(Math.abs(seed)) % MAX_NATIVE_SEED);
}

export function normalizeCryptidDescription(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_LENGTH);
}

function matchingArchetype(description: string, hash: number): LocalArchetype {
  return (
    ARCHETYPES.find((candidate) =>
      candidate.keywords.some((keyword) => description.includes(keyword))
    ) ?? pick(ARCHETYPES, hash, 0)
  );
}

function generatedName(description: string, archetype: LocalArchetype, hash: number): string {
  const keywordPrefix = PREFIX_KEYWORDS.find(([keywords]) =>
    keywords.some((keyword) => description.includes(keyword))
  )?.[1];
  const prefix = keywordPrefix ?? pick(PREFIXES, hash, 8);
  return `${prefix} ${pick(archetype.nouns, hash, 16)}`;
}

export function validateGeneratedCryptid(
  value: NativeGeneratedCryptid,
  source: CryptidGenerationSource
): GeneratedCryptid {
  const name = value.name.trim();
  const sigil = normalizeAsciiArt(value.sigil);
  const issues = validateCryptidProfileFields({
    handle: 'generator',
    cryptidName: name,
    sigil,
    color: DEFAULT_SIGNAL_COLOR,
    presetId: null,
  });
  const generationIssues = [...issues.cryptidName, ...issues.sigil];
  if (generationIssues.length > 0) {
    throw new Error(
      `The on-device generator made an icon that does not fit the profile grid. ${generationIssues.join(
        ' '
      )}`
    );
  }
  return { name, sigil, source };
}

export function generateLocalCryptid(description: string, seed: number): GeneratedCryptid {
  const normalizedDescription = normalizeCryptidDescription(description).toLowerCase();
  const normalizedSeed = normalizeSeed(seed);
  const hash = hashString(`${normalizedDescription || 'surprise'}:${normalizedSeed}`);
  const archetype = matchingArchetype(normalizedDescription, hash);
  const eyes = pick(EYES, hash, 4);
  const mouth = pick(MOUTHS, hash, 12);

  return validateGeneratedCryptid(
    {
      name: generatedName(normalizedDescription, archetype, hash),
      sigil: archetype.render(eyes[0], eyes[1], mouth),
    },
    'local'
  );
}

export async function generateCryptid(
  description: string,
  seed: number
): Promise<GeneratedCryptid> {
  const normalizedDescription = normalizeCryptidDescription(description);
  const normalizedSeed = normalizeSeed(seed);
  const nativeGenerator = tryGetCryptidGenerator();
  if (!nativeGenerator) return generateLocalCryptid(normalizedDescription, normalizedSeed);

  const availability = await nativeGenerator.availability();
  if (availability === 'unavailable') {
    return generateLocalCryptid(normalizedDescription, normalizedSeed);
  }

  const generated = await nativeGenerator.generate(
    normalizedDescription || 'an unknown city cryptid',
    normalizedSeed
  );
  return validateGeneratedCryptid(generated, 'system');
}
