import { CRYPTID_FORMS, EYES, MOUTHS } from './cryptid-forms';
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

/**
 * The title half of the name. Kept short: the profile name caps at 24 characters
 * and the longest creature in `CRYPTID_FORMS` is 13, so a title has to fit inside
 * 10. `cryptid-forms.test.ts` asserts both halves of that arithmetic.
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
  const form = choose(CRYPTID_FORMS, random);
  const eyes = choose(EYES, random);
  return {
    cryptidName: `${choose(TITLES, random)} ${form.creature}`,
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
export const RANDOM_PERSONA_VOCABULARY = {
  FORMS: CRYPTID_FORMS,
  TITLES,
  EYES,
  MOUTHS,
} as const;
