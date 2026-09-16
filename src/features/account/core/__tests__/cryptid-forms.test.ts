import { sigilMetrics } from '@/features/map/render/sigil-metrics';

import { CRYPTID_FORMS, EYES, MOUTHS, type CryptidMood } from '../cryptid-forms';
import { MAX_SIGIL_COLUMNS, MAX_SIGIL_LINES, sigilMeasurements } from '../profile';
import { RANDOM_PERSONA_VOCABULARY } from '../random-persona';

const { TITLES } = RANDOM_PERSONA_VOCABULARY;

/**
 * Below this a drawing stops reading as a face at marker size. It is not enforced
 * anywhere in the app — `sigilMetrics` will happily clamp to 3px — so it is
 * asserted here, where a new cryptid that sprawls gets caught before it ships.
 */
const MARKER_LEGIBILITY_FLOOR = 4.5;

const MOODS: readonly CryptidMood[] = ['cute', 'spooky', 'eerie', 'goofy'];

/** Every drawing a form can produce. The roster is small enough to enumerate. */
function* everySigil(): Generator<{ creature: string; sigil: string }> {
  for (const form of CRYPTID_FORMS) {
    for (const eyes of EYES) {
      for (const mouth of MOUTHS) {
        yield { creature: form.creature, sigil: form.render(eyes[0], eyes[1], mouth) };
      }
    }
  }
}

describe('cryptid roster', () => {
  it('names every creature once', () => {
    const names = CRYPTID_FORMS.map((form) => form.creature);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every creature name short enough for the longest title', () => {
    // The profile caps `cryptidName` at 24. A roll is "<title> <creature>", so the
    // budget a creature actually has is 24 minus the longest title minus the space.
    const longestTitle = TITLES.reduce((a, b) => (b.length > a.length ? b : a));
    for (const form of CRYPTID_FORMS) {
      expect(`${longestTitle} ${form.creature}`.length).toBeLessThanOrEqual(24);
    }
  });

  it('covers every mood without any one dominating', () => {
    for (const mood of MOODS) {
      const count = CRYPTID_FORMS.filter((form) => form.mood === mood).length;
      expect(count).toBeGreaterThanOrEqual(8);
      expect(count).toBeLessThanOrEqual(CRYPTID_FORMS.length / 2);
    }
    expect(CRYPTID_FORMS.every((form) => MOODS.includes(form.mood))).toBe(true);
  });

  it('draws inside the profile grid for every face', () => {
    for (const { creature, sigil } of everySigil()) {
      const measured = sigilMeasurements(sigil);
      expect({ creature, ...measured }).toEqual({
        creature,
        lines: expect.any(Number),
        columns: expect.any(Number),
      });
      expect(measured.lines).toBeLessThanOrEqual(MAX_SIGIL_LINES);
      expect(measured.columns).toBeLessThanOrEqual(MAX_SIGIL_COLUMNS);
      expect(sigil).toMatch(/^[\t\n\x20-\x7e]*$/);
      expect(sigil.trim().length).toBeGreaterThan(0);
    }
  });

  it('stays legible at the size the map actually renders it', () => {
    for (const form of CRYPTID_FORMS) {
      const { fontSize } = sigilMetrics(form.render('o', 'o', '-'));
      expect({ creature: form.creature, fontSize }).toEqual({
        creature: form.creature,
        fontSize: expect.any(Number),
      });
      expect(fontSize).toBeGreaterThanOrEqual(MARKER_LEGIBILITY_FLOOR);
    }
  });

  it('substitutes both eyes and the mouth into every drawing', () => {
    // A form that ignored its arguments would look identical on every roll, which
    // is invisible in a gallery of one face and obvious in a roster of friends.
    for (const form of CRYPTID_FORMS) {
      expect({ creature: form.creature, sigil: form.render('o', 'o', '-') }).not.toEqual({
        creature: form.creature,
        sigil: form.render('#', '#', '='),
      });
    }
  });

  it('gives the offline generator a distinct keyword to match on', () => {
    for (const form of CRYPTID_FORMS) {
      expect(form.keywords.length).toBeGreaterThan(0);
      // Matching is `description.includes(keyword)` on a lowercased description,
      // so an uppercase keyword can never match anything.
      for (const keyword of form.keywords) expect(keyword).toBe(keyword.toLowerCase());
    }
    const first = CRYPTID_FORMS.map((form) => form.keywords[0]);
    expect(new Set(first).size).toBe(first.length);
  });
});
