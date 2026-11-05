import { PERMISSION_STEPS } from '@/features/social/core/permission-steps';

import { parseCopy, parsePermissionsCopy } from './parse-copy';

/**
 * Every Markdown file in this folder and the module generated from it. `scripts/build-copy.ts`
 * writes each module; `__tests__/copy.test.ts` fails when one disagrees with its Markdown.
 */
export interface CopyFile {
  /** Beside this file. */
  readonly markdown: string;
  readonly module: string;
  /** Each export of the module, from the Markdown's text. */
  readonly parse: (markdown: string) => Record<string, unknown>;
  /** An export's declared type, where it has one; the rest are `as const`. */
  readonly types?: Readonly<Record<string, string>>;
  readonly imports?: string;
}

const ONBOARDING = {
  splash: { required: ['heading', 'body', 'start', 'rail-start'] },
  profile: { required: ['title', 'intro'] },
  privacy: {
    required: [
      'title',
      'lede',
      'letter',
      'caveat',
      'next',
      'signoff',
      'back',
      'back-label',
      'continue',
      'continue-label',
      'rail-continue',
    ],
  },
  delivery: {
    required: [
      'title',
      'loading',
      'load-error',
      'retry',
      'save-error',
      'back',
      'back-label',
      'continue',
      'saving',
      'continue-label',
      'rail-continue',
    ],
  },
  'delivery-mutual': { required: ['title', 'segment', 'heading', 'body'] },
  'delivery-stash': { required: ['title', 'segment', 'heading', 'body'] },
} as const;

export const COPY_FILES: readonly CopyFile[] = [
  {
    markdown: 'onboarding.md',
    module: 'onboarding.ts',
    parse: (markdown) => ({ ONBOARDING_COPY: parseCopy(markdown, ONBOARDING) }),
  },
  {
    markdown: 'permissions.md',
    module: 'permissions.ts',
    parse: (markdown) => {
      const copy = parsePermissionsCopy(markdown, PERMISSION_STEPS);
      return { PERMISSIONS_PAGE_COPY: copy.page, PERMISSION_STEP_COPY: copy.steps };
    },
    types: {
      PERMISSIONS_PAGE_COPY: 'PageCopyText',
      PERMISSION_STEP_COPY: 'Record<PermissionStepId, StepCopyText>',
    },
    imports: `import type { PermissionStepId } from '@/features/social/core/permission-steps';
import type { PageCopyText, StepCopyText } from './parse-copy';`,
  },
];
