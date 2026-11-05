/**
 * Regenerates the app's copy modules from the Markdown people edit (`just copy`).
 *
 * The Markdown is the source; the `.ts` beside it is what the bundle imports, generated so the app
 * needs no Markdown loader in Metro and the words are typed like any other module. The jest test
 * next to each file parses the Markdown again and fails if the module disagrees, so editing one
 * and forgetting to run this cannot ship.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { parsePermissionsCopy } from '../src/features/social/copy/parse-copy';
import { PERMISSION_STEPS } from '../src/features/social/core/permission-steps';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function write(file: string, body: string) {
  const target = path.join(root, file);
  const formatted = await format(body, {
    ...(await resolveConfig(target)),
    filepath: target,
  });
  writeFileSync(target, formatted);
  console.log(`wrote ${file}`);
}

const source = 'src/features/social/copy/permissions.md';
const copy = parsePermissionsCopy(readFileSync(path.join(root, source), 'utf8'), PERMISSION_STEPS);

await write(
  'src/features/social/copy/permissions.ts',
  `// GENERATED from permissions.md by \`just copy\`. Edit the Markdown, not this file.
import type { PermissionStepId } from '../core/permission-steps';
import type { PageCopyText, StepCopyText } from './parse-copy';

export const PERMISSIONS_PAGE_COPY: PageCopyText = ${JSON.stringify(copy.page, null, 2)};

export const PERMISSION_STEP_COPY: Record<PermissionStepId, StepCopyText> = ${JSON.stringify(copy.steps, null, 2)};
`
);
