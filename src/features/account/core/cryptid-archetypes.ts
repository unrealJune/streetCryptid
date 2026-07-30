/**
 * The offline icon maker: hand-drawn silhouette families plus the seeded picks that vary them.
 *
 * These renders are the ground truth for "icon shaped" in this app. They are used three ways:
 * as the deterministic fallback when the on-device model cannot produce anything usable, as the
 * calibration corpus for the shape scorer, and as few-shot exemplars in the model prompt — small
 * models copy structure from examples far more reliably than they follow prose rules.
 *
 * Split out of `cryptid-generator.ts` so the prompt builder can import the exemplars without
 * pulling in the generation pipeline (which imports the prompt builder).
 */

const art = (...lines: string[]): string => lines.join('\n');

export interface CryptidArchetype {
  id: string;
  /** Silhouette family name, also injected into prompts as a trait. */
  label: string;
  keywords: readonly string[];
  nouns: readonly string[];
  render(leftEye: string, rightEye: string, mouth: string): string;
}

export const ARCHETYPES: readonly CryptidArchetype[] = [
  {
    id: 'moth',
    label: 'winged moth',
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
    id: 'stag',
    label: 'antlered stag',
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
    id: 'hound',
    label: 'four-legged hound',
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
    id: 'lake',
    label: 'coiled water thing',
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
    id: 'owl',
    label: 'round perched bird',
    keywords: ['owl', 'bird', 'feather', 'sky'],
    nouns: ['Owl', 'Watcher', 'Rook'],
    render: (left, right, mouth) =>
      art('   .---.', `  / ${left} ${right} \\`, ` |   ${mouth}   |`, '  \\ /|\\ /', "   '---'"),
  },
  {
    id: 'crawler',
    label: 'long-limbed crawler',
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
    id: 'ram',
    label: 'horned ram',
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
    id: 'wisp',
    label: 'drifting wisp',
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

export const EYES = ['oo', 'OO', '..', '^^', '**', '++'] as const;
export const MOUTHS = ['^', '~', '-', 'v', '_'] as const;
export const PREFIXES = [
  'Quiet',
  'Fog',
  'Moss',
  'Night',
  'Rain',
  'Alley',
  'Signal',
  'Ash',
] as const;

const PREFIX_KEYWORDS: readonly [readonly string[], string][] = [
  [['rain', 'storm', 'wet'], 'Rain'],
  [['fog', 'mist', 'haze'], 'Fog'],
  [['moss', 'green', 'forest'], 'Moss'],
  [['night', 'dark', 'moon'], 'Night'],
  [['city', 'street', 'alley'], 'Alley'],
  [['quiet', 'shy', 'gentle'], 'Quiet'],
];

export const MAX_NATIVE_SEED = 2_147_483_647;

export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function pick<T>(values: readonly T[], hash: number, shift: number): T {
  return values[(hash >>> shift) % values.length];
}

export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  return Math.max(1, Math.trunc(Math.abs(seed)) % MAX_NATIVE_SEED);
}

export function matchingArchetype(description: string, hash: number): CryptidArchetype {
  return (
    ARCHETYPES.find((candidate) =>
      candidate.keywords.some((keyword) => description.includes(keyword))
    ) ?? pick(ARCHETYPES, hash, 0)
  );
}

export function generatedName(
  description: string,
  archetype: CryptidArchetype,
  hash: number
): string {
  const keywordPrefix = PREFIX_KEYWORDS.find(([keywords]) =>
    keywords.some((keyword) => description.includes(keyword))
  )?.[1];
  const prefix = keywordPrefix ?? pick(PREFIXES, hash, 8);
  return `${prefix} ${pick(archetype.nouns, hash, 16)}`;
}

export interface LocalCryptidRender {
  name: string;
  sigil: string;
  archetype: CryptidArchetype;
}

/** Deterministic offline render for a lowercased description and a normalized seed. */
export function renderLocalCryptid(
  normalizedDescription: string,
  normalizedSeed: number
): LocalCryptidRender {
  const hash = hashString(`${normalizedDescription || 'surprise'}:${normalizedSeed}`);
  const archetype = matchingArchetype(normalizedDescription, hash);
  const eyes = pick(EYES, hash, 4);
  const mouth = pick(MOUTHS, hash, 12);
  return {
    name: generatedName(normalizedDescription, archetype, hash),
    sigil: archetype.render(eyes[0], eyes[1], mouth),
    archetype,
  };
}

/** A neutral render of an archetype, used as a few-shot exemplar in prompts. */
export function exemplarRender(archetype: CryptidArchetype): string {
  return archetype.render('o', 'o', '~');
}
