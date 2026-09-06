import { hsvToHex, SIGNAL_COLOR_VALUE } from './signal-color';

/**
 * The one-tap identity: a cryptid, a title for it, and a signal color.
 *
 * This replaced the preset grid. Picking from five fixed cryptids made the choice
 * feel like a form field; rolling a whole persona — drawing, title, and color at
 * once — makes it feel like being handed one, the way a transit app hands you an
 * animal and a color and lets you get on with it. Every field it produces stays
 * editable afterwards: this seeds the profile, it does not own it.
 *
 * Nothing here is a preset id. A rolled persona is a custom persona (`presetId:
 * null`) whose fields happen to have been filled in for you.
 */

/** A cryptid drawing, plus the nouns that suit its silhouette. */
interface CryptidForm {
  /** Names that read correctly for this shape — the title is prefixed to one. */
  readonly creatures: readonly string[];
  render(leftEye: string, rightEye: string, mouth: string): string;
}

const art = (...lines: string[]): string => lines.join('\n');

const FORMS: readonly CryptidForm[] = [
  {
    creatures: ['Mothman', 'Flutterer', 'Nightwing'],
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
    creatures: ['Stag', 'Warden', 'Briarkin'],
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
    creatures: ['Shuck', 'Hound', 'Howler'],
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
    creatures: ['Lake Thing', 'Reedling', 'Tidekin'],
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
    creatures: ['Owl', 'Watcher', 'Rook'],
    render: (left, right, mouth) =>
      art('   .---.', `  / ${left} ${right} \\`, ` |   ${mouth}   |`, '  \\ /|\\ /', "   '---'"),
  },
  {
    creatures: ['Crawler', 'Longstep', 'Strider'],
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
    creatures: ['Ram', 'Cragling', 'Hornkin'],
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
    creatures: ['Wisp', 'Drifter', 'Veil'],
    render: (left, right, mouth) =>
      art(
        '    .-.',
        `   (${left} ${right})`,
        ` .--\`${mouth}'--.`,
        ' (   /|\\   )',
        "  `- /_\\ -'"
      ),
  },
  {
    creatures: ['Jackalope', 'Leaper', 'Thistle'],
    render: (left, right, mouth) =>
      art('  \\Y/ \\Y/', '   \\   /', `  ( ${left} ${right} )`, `  ( >${mouth}< )`, '   /"   "\\'),
  },
  {
    creatures: ['Grinner', 'Passenger', 'Straphanger'],
    render: (left, right, mouth) =>
      art(
        '  ,--------.',
        ` |  ${left}   ${right}  |`,
        ` |    ${mouth}    |`,
        ' | \\_____/ |',
        "  `-.____.-'"
      ),
  },
];

/**
 * The title half of the name. Kept short: the profile name caps at 24 characters
 * and the longest creature above is 11, so a title has to fit inside 12.
 */
const TITLES = [
  'Fogbound',
  'Lantern',
  'Hushed',
  'Midnight',
  'Rainslick',
  'Alleyway',
  'Marrow',
  'Static',
  'Hollow',
  'Gutter',
  'Cinder',
  'Drifting',
  'Velvet',
  'Rustling',
  'Quiet',
  'Neon',
  'Sleepless',
  'Overpass',
  'Restless',
  'Tunnel',
  'Ashen',
  'Mossy',
  'Wayward',
  'Last Bus',
] as const;

const EYES = ['oo', 'OO', '..', '^^', '**', '++'] as const;
const MOUTHS = ['^', '~', '-', 'v', '_'] as const;

/** Below this the color reads as grey against the map; at 1 it is a pure hue. */
const MIN_SATURATION = 0.62;

/** How many times a roll retries before accepting a repeat of the previous one. */
const REROLL_ATTEMPTS = 8;

export interface RandomPersona {
  /** Title plus cryptid, e.g. "Fogbound Mothman". */
  cryptidName: string;
  sigil: string;
  /** Always at full HSV brightness — see `constants/signal-colors`. */
  color: string;
}

export interface RandomPersonaOptions {
  /**
   * A persona the roll should try not to reproduce, so tapping the button again
   * visibly does something. Best effort: after `REROLL_ATTEMPTS` it gives up
   * rather than looping.
   */
  avoid?: Pick<RandomPersona, 'cryptidName'> | null;
  /** Injectable for tests. Must return [0, 1). */
  random?: () => number;
}

function choose<T>(values: readonly T[], random: () => number): T {
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

function randomSignalColor(random: () => number): string {
  return hsvToHex({
    hue: random() * 360,
    saturation: MIN_SATURATION + random() * (1 - MIN_SATURATION),
    value: SIGNAL_COLOR_VALUE,
  });
}

function rollOnce(random: () => number): RandomPersona {
  const form = choose(FORMS, random);
  const eyes = choose(EYES, random);
  return {
    cryptidName: `${choose(TITLES, random)} ${choose(form.creatures, random)}`,
    sigil: form.render(eyes[0], eyes[1], choose(MOUTHS, random)),
    color: randomSignalColor(random),
  };
}

/** Rolls a whole persona: cryptid drawing, cryptid title, and signal color. */
export function randomPersona(options: RandomPersonaOptions = {}): RandomPersona {
  const random = options.random ?? Math.random;
  const avoided = options.avoid?.cryptidName.trim();
  let persona = rollOnce(random);
  for (let attempt = 0; attempt < REROLL_ATTEMPTS && persona.cryptidName === avoided; attempt++) {
    persona = rollOnce(random);
  }
  return persona;
}

/** Exposed for the test that proves every reachable persona fits the profile grid. */
export const RANDOM_PERSONA_VOCABULARY = { FORMS, TITLES, EYES, MOUTHS } as const;
