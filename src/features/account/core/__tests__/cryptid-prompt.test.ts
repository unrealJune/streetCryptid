import { ARCHETYPES } from '../cryptid-archetypes';
import {
  buildDraftPrompt,
  buildRepairPrompt,
  describeTraits,
  pickExemplars,
  pickTraits,
} from '../cryptid-prompt';
import { scoreSigilShape } from '../sigil-shape';

describe('cryptid prompt builder', () => {
  it('samples traits deterministically for a description and seed', () => {
    expect(pickTraits('a rain-soaked moth', 42)).toEqual(pickTraits('a rain-soaked moth', 42));
  });

  it('varies traits with the seed so regenerating gives something new', () => {
    const seeds = [1, 2, 3, 4, 5, 6].map((seed) =>
      JSON.stringify(pickTraits('a rain-soaked moth', seed))
    );

    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it('anchors the silhouette on the archetype the description matches', () => {
    expect(pickTraits('a black hound in the alley', 3).silhouette).toBe(
      ARCHETYPES.find((archetype) => archetype.id === 'hound')?.label
    );
  });

  it('rotates the few-shot exemplars with the seed', () => {
    const first = pickExemplars(1).join('|');
    const second = pickExemplars(2).join('|');

    expect(first).not.toBe(second);
  });

  it('only shows the model exemplars that pass the scorer', () => {
    for (const seed of [1, 5, 9]) {
      for (const exemplar of pickExemplars(seed)) {
        expect(scoreSigilShape(exemplar).defects).toEqual([]);
      }
    }
  });

  it('puts the traits and the description in the draft turn', () => {
    const traits = pickTraits('a shy lake thing', 11);
    const spec = buildDraftPrompt('a shy lake thing', 11, traits);

    expect(spec.prompt).toContain('a shy lake thing');
    expect(spec.prompt).toContain(describeTraits(traits));
    expect(spec.attempt).toBe(1);
    expect(spec.candidateCount).toBeGreaterThan(1);
  });

  it('falls back to a surprise description when the field is blank', () => {
    expect(buildDraftPrompt('', 11, pickTraits('', 11)).prompt).toContain('unknown city cryptid');
  });

  it('keeps every round inside a bounded token budget', () => {
    const draft = buildDraftPrompt('a fog wisp', 5, pickTraits('a fog wisp', 5));
    const repair = buildRepairPrompt(draft, '(oo)', ['too short']);

    expect(draft.maxOutputTokens).toBeLessThanOrEqual(256);
    expect(repair.maxOutputTokens).toBeLessThanOrEqual(draft.maxOutputTokens);
  });

  it('feeds the rejected art and its defects into the repair turn', () => {
    const draft = buildDraftPrompt('a fog wisp', 5, pickTraits('a fog wisp', 5));
    const repair = buildRepairPrompt(draft, '(oo)\n/||\\', [
      'the drawing is only 2 lines tall; draw 4 to 8 lines',
      'the drawing is lopsided; make the left and right halves mirror each other',
    ]);

    expect(repair.prompt).toContain('(oo)');
    expect(repair.prompt).toContain('4 to 8 lines');
    expect(repair.prompt).toContain('lopsided');
    expect(repair.attempt).toBe(2);
    expect(repair.seed).not.toBe(draft.seed);
    expect(repair.instructions).toBe(draft.instructions);
  });

  it('caps how many complaints the repair turn carries', () => {
    const draft = buildDraftPrompt('a fog wisp', 5, pickTraits('a fog wisp', 5));
    const repair = buildRepairPrompt(draft, '(oo)', ['a', 'b', 'c', 'd', 'e']);

    expect(repair.prompt).not.toContain('- d');
  });
});
