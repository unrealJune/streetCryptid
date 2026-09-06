import { fullBrightnessColor } from '@/constants/signal-colors';

import { validateCryptidProfileFields } from '../profile';
import { randomPersona, RANDOM_PERSONA_VOCABULARY } from '../random-persona';

const { FORMS, TITLES, EYES, MOUTHS } = RANDOM_PERSONA_VOCABULARY;

/** Fixed draws, then the last one forever — reproducible rolls without stubbing Math.random. */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe('random persona', () => {
  it('rolls a cryptid, a title, and a color together', () => {
    const persona = randomPersona({ random: sequence([0]) });

    expect(persona.cryptidName).toBe(`${TITLES[0]} ${FORMS[0].creatures[0]}`);
    expect(persona.sigil).toBe(FORMS[0].render(EYES[0][0], EYES[0][1], MOUTHS[0]));
    // hue 0, saturation at the floor, value 1.
    expect(persona.color).toBe('#FF6161');
  });

  it('every reachable persona fits the profile grid', () => {
    for (const form of FORMS) {
      for (const eyes of EYES) {
        for (const mouth of MOUTHS) {
          for (const creature of form.creatures) {
            for (const title of TITLES) {
              const issues = validateCryptidProfileFields({
                handle: '@tester',
                cryptidName: `${title} ${creature}`,
                sigil: form.render(eyes[0], eyes[1], mouth),
                color: '#4CFFAB',
                presetId: null,
              });
              expect([...issues.cryptidName, ...issues.sigil]).toEqual([]);
            }
          }
        }
      }
    }
  });

  it('always picks a color at 100% brightness', () => {
    for (let roll = 0; roll < 200; roll += 1) {
      const { color } = randomPersona();
      expect(fullBrightnessColor(color)).toBe(color);
    }
  });

  it('rolls a different name than the one it was told to avoid', () => {
    // The first draw would reproduce the avoided name; the retry moves on.
    const avoided = `${TITLES[0]} ${FORMS[0].creatures[0]}`;
    const persona = randomPersona({
      avoid: { cryptidName: avoided },
      random: sequence([0, 0, 0, 0, 0, 0, 0, 0.5]),
    });

    expect(persona.cryptidName).not.toBe(avoided);
  });

  it('gives up rather than looping when every retry collides', () => {
    const avoided = `${TITLES[0]} ${FORMS[0].creatures[0]}`;
    const persona = randomPersona({ avoid: { cryptidName: avoided }, random: () => 0 });

    expect(persona.cryptidName).toBe(avoided);
  });
});
