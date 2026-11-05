import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PERMISSION_STEPS } from '../../core/permission-steps';
import { parsePermissionsCopy } from '../parse-copy';
import { PERMISSION_STEP_COPY, PERMISSIONS_PAGE_COPY } from '../permissions';

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

describe('permissions copy', () => {
  it('is what permissions.md says — run `just copy` after editing it', () => {
    const markdown = readFileSync(path.join(__dirname, '../permissions.md'), 'utf8');
    expect({ page: PERMISSIONS_PAGE_COPY, steps: PERMISSION_STEP_COPY }).toEqual(
      parsePermissionsCopy(markdown, PERMISSION_STEPS)
    );
  });

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
      'an empty field',
      `${PAGE}${step('location', '### note\n\n')}${step('bluetooth')}`,
      /"note" has no text/,
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
