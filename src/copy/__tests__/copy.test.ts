import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseCopy, parsePermissionsCopy } from '../parse-copy';
import { COPY_FILES } from '../registry';

const STEPS = ['location', 'bluetooth'] as const;
const PAGE = `## page
### title
A few
### title-single
One
### subtitle
Sub
### continue
Continue
### not-now
Not now
### rail-ok
OK
### allowed
ALLOWED
### refused
NOT ALLOWED
### asked
ASKED
### declined
NOT NOW
### skipped
SKIPPED
`;
const step = (id: string, extra = '') => `## ${id}
### name
${id} name
### title
${id} title
### lede
${id} lede
### summary
${id} summary
### action
${id} action
${extra}`;

describe.each(COPY_FILES)('$markdown', (file) => {
  it('is what the generated module says — run `just copy` after editing it', () => {
    const markdown = readFileSync(path.join(__dirname, '..', file.markdown), 'utf8');
    const generated = jest.requireActual(`../${file.module}`);
    expect(Object.keys(generated).sort()).toEqual(Object.keys(file.parse(markdown)).sort());
    expect(generated).toEqual(expect.objectContaining(file.parse(markdown)));
  });
});

describe('plain copy', () => {
  const SCHEMA = { 'first-screen': { required: ['title', 'body-text'], optional: ['note'] } };
  const BASE = '## first-screen\n### title\nx\n### body-text\nx\n';

  it('reads each section with its fields in camelCase', () => {
    expect(
      parseCopy('Preamble.\n## first-screen\n### title\nHi\n### body-text\nOne\ntwo\n', SCHEMA)
    ).toEqual({ firstScreen: { title: 'Hi', bodyText: 'One two' } });
  });

  it('leaves out an optional field that is empty or deleted', () => {
    expect(parseCopy(`${BASE}### note\n   \n`, SCHEMA)).toEqual({
      firstScreen: { title: 'x', bodyText: 'x' },
    });
    expect(parseCopy(BASE, SCHEMA)).toEqual({ firstScreen: { title: 'x', bodyText: 'x' } });
  });

  it.each([
    ['a missing section', '', /no "## first-screen"/],
    ['an unknown section', `${BASE}## second\n`, /second/],
    ['a missing field', '## first-screen\n### title\nx\n', /"### body-text" .* is missing/],
    [
      'an emptied required field',
      '## first-screen\n### title\n\n### body-text\nx\n',
      /"### title" .* is empty/,
    ],
    ['an unknown field', `${BASE}### hint\nx\n`, /hint/],
    ['a repeated optional field', `${BASE}### note\na\n### note\nb\n`, /appears twice/],
  ])('refuses %s', (_, markdown, error) => {
    expect(() => parseCopy(markdown, SCHEMA)).toThrow(error);
  });
});

describe('permissions copy', () => {
  it('joins wrapped lines, keeps paragraphs and ignores comments', () => {
    const copy = parsePermissionsCopy(
      `Preamble.\n\n${PAGE}${step('location')}\n### card: ONE (amber)\nfirst\nline <!-- gone -->\n\nsecond\n${step('bluetooth')}`,
      STEPS
    );
    expect(copy.steps.location.cards).toEqual([
      { label: 'ONE', tone: 'amber', body: 'first line\n\nsecond' },
    ]);
  });

  it('resolves notes per platform with a default', () => {
    const copy = parsePermissionsCopy(
      `${PAGE}${step('location', '### note\nall\n### note-ios\niphone\n')}${step('bluetooth')}`,
      STEPS
    );
    expect(copy.steps.location.note).toEqual({ default: 'all', ios: 'iphone' });
    expect(copy.steps.bluetooth.note).toEqual({});
  });

  it('leaves out emptied prose, cards and notes', () => {
    const emptied = step('location')
      .replace('location title', '')
      .replace('location lede', '')
      .replace('location summary', '');
    const copy = parsePermissionsCopy(
      `${PAGE.replace('Sub', '')}${emptied}### card: GONE (green)\n\n### note-ios\n\n${step('bluetooth')}`,
      STEPS
    );
    expect(copy.page.subtitle).toBeUndefined();
    expect(copy.steps.location).toEqual({
      name: 'location name',
      action: 'location action',
      cards: [],
      note: {},
    });
  });

  it.each([
    ['a missing step', `${PAGE}${step('location')}`, /no section for "## bluetooth"/],
    ['an unknown step', `${PAGE}${step('location')}${step('bluetooth')}${step('radar')}`, /radar/],
    [
      'an unknown field',
      `${PAGE}${step('location', '### tagline\nx\n')}${step('bluetooth')}`,
      /tagline/,
    ],
    [
      'a misspelt tone',
      `${PAGE}${step('location', '### card: X (red)\nx\n')}${step('bluetooth')}`,
      /card: X \(red\)/,
    ],
    [
      'an emptied action',
      `${PAGE}${step('location').replace('location action', '')}${step('bluetooth')}`,
      /"### action" in "location" is empty/,
    ],
    [
      'a repeated field',
      `${PAGE}${step('location', '### name\nagain\n')}${step('bluetooth')}`,
      /appears twice/,
    ],
    [
      'a missing page field',
      `${PAGE.replace('### rail-ok\nOK\n', '')}${step('location')}${step('bluetooth')}`,
      /rail-ok/,
    ],
  ])('refuses %s', (_, markdown, error) => {
    expect(() => parsePermissionsCopy(markdown, STEPS)).toThrow(error);
  });
});
