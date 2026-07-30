import { ARCHETYPES, exemplarRender } from '../cryptid-archetypes';
import { CRYPTID_PRESETS } from '../profile';
import {
  ICON_SHAPE_ACCEPT_SCORE,
  isIconShaped,
  normalizeSigilTile,
  scoreSigilShape,
} from '../sigil-shape';

const PROSE = [
  'Here is your cryptid icon:',
  'A tall creature with wide eyes that lives under the bridge.',
  'Let me know if you would like another one.',
].join('\n');

describe('sigil tile normalizer', () => {
  it('strips code fences and edge commentary while keeping the drawing', () => {
    const raw = ['Here is your icon:', '```', '  /^-^\\', ' ( o o )', '  \\_-_/', '```'].join('\n');

    expect(normalizeSigilTile(raw)).toBe([' /^-^\\', '( o o )', ' \\_-_/'].join('\n'));
  });

  it('removes the common indent without disturbing relative alignment', () => {
    expect(normalizeSigilTile(['    .-.', '   ( o )', '    \\_/'].join('\n'))).toBe(
      [' .-.', '( o )', ' \\_/'].join('\n')
    );
  });

  it('expands tabs, drops blank edges, and right-trims', () => {
    expect(normalizeSigilTile('\n\n\t(oo)   \n\t/||\\\n\n')).toBe('(oo)\n/||\\');
  });

  it('hard-crops to the profile tile', () => {
    const report = scoreSigilShape(Array.from({ length: 20 }, () => 'x'.repeat(60)).join('\n'));

    expect(report.features.lines).toBeLessThanOrEqual(12);
    expect(report.features.columns).toBeLessThanOrEqual(32);
  });

  it('keeps a prose-looking row that sits inside the drawing', () => {
    const raw = ['  /^-^\\', 'the old one waits', '  \\_-_/'].join('\n');

    expect(normalizeSigilTile(raw).split('\n')).toHaveLength(3);
  });

  it('returns nothing when the answer is only prose', () => {
    expect(normalizeSigilTile(PROSE)).toBe('');
  });
});

describe('sigil shape scorer', () => {
  it.each(ARCHETYPES.map((archetype) => [archetype.id, exemplarRender(archetype)]))(
    'accepts the %s archetype render',
    (_id, art) => {
      const report = scoreSigilShape(art);

      expect(report.valid).toBe(true);
      expect(isIconShaped(report)).toBe(true);
      expect(report.defects).toEqual([]);
    }
  );

  it.each(CRYPTID_PRESETS.map((preset) => [preset.id, preset.art]))(
    'accepts the shipped %s preset',
    (_id, art) => {
      expect(scoreSigilShape(art).score).toBeGreaterThanOrEqual(ICON_SHAPE_ACCEPT_SCORE);
    }
  );

  it('rejects prose and says so', () => {
    const report = scoreSigilShape(PROSE);

    expect(isIconShaped(report)).toBe(false);
    expect(report.score).toBe(0);
    expect(report.defects.join(' ')).toContain('drawn');
  });

  it('rejects a two-line stub and asks for more rows', () => {
    const report = scoreSigilShape('(oo)\n/||\\');

    expect(isIconShaped(report)).toBe(false);
    expect(report.defects.join(' ')).toContain('4 to 8 lines');
  });

  it('rejects a wide banner and asks for a squarer silhouette', () => {
    const report = scoreSigilShape(
      ['=========================', '=  hello there cryptid  ='].join('\n')
    );

    expect(isIconShaped(report)).toBe(false);
    expect(report.defects.join(' ')).toContain('compact and square');
  });

  it('rejects a blank interior row and names it', () => {
    const report = scoreSigilShape(['  /^-^\\', ' ( o o )', '', '  \\_-_/', '  /   \\'].join('\n'));

    expect(isIconShaped(report)).toBe(false);
    expect(report.defects.join(' ')).toContain('blank in the middle');
  });

  it('rejects a solid block for having no silhouette', () => {
    const report = scoreSigilShape(Array.from({ length: 6 }, () => '########').join('\n'));

    expect(isIconShaped(report)).toBe(false);
    expect(report.defects.join(' ')).toContain('solid block');
  });

  // Still icon shaped enough to keep; the complaint is what drives the repair round.
  it('complains about a lopsided drawing', () => {
    const report = scoreSigilShape(['/^^^^^^^', '| o o', '|  ~', '|_____', '|/'].join('\n'));

    expect(report.defects.join(' ')).toContain('lopsided');
  });

  it('strips non-ASCII characters before judging the shape', () => {
    const report = scoreSigilShape('(👁)\n /|\\ \n / \\ \n ~~~');

    expect(report.sigil).not.toContain('👁');
    expect(report.valid).toBe(true);
  });

  it('rejects a uniform block of one repeated character', () => {
    const report = scoreSigilShape(Array.from({ length: 4 }, () => '....').join('\n'));

    expect(isIconShaped(report)).toBe(false);
    expect(report.defects.join(' ')).toContain('too few different characters');
  });

  it('scores empty input at zero and marks it invalid', () => {
    const report = scoreSigilShape('   \n\n  ');

    expect(report.valid).toBe(false);
    expect(report.score).toBe(0);
  });

  it('prefers the archetype render over a degenerate one', () => {
    const good = scoreSigilShape(exemplarRender(ARCHETYPES[0])).score;
    const bad = scoreSigilShape('....\n....\n....\n....').score;

    expect(good).toBeGreaterThan(bad);
  });
});
