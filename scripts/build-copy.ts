/**
 * Regenerates the app's copy modules from the Markdown people edit (`just copy`).
 *
 * The Markdown in `src/copy/` is the source; the `.ts` beside each file is what the bundle imports,
 * generated so the app needs no Markdown loader in Metro and the words are typed like any other
 * module. `src/copy/__tests__/copy.test.ts` parses the Markdown again and fails if a module
 * disagrees, so editing one and forgetting to run this cannot ship.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { COPY_FILES } from '../src/copy/registry';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'copy');

for (const file of COPY_FILES) {
  const exports = file.parse(readFileSync(path.join(dir, file.markdown), 'utf8'));
  const body = Object.entries(exports)
    .map(([name, value]) => {
      const type = file.types?.[name];
      const json = JSON.stringify(value, null, 2);
      return type
        ? `export const ${name}: ${type} = ${json};`
        : `export const ${name} = ${json} as const;`;
    })
    .join('\n\n');
  const target = path.join(dir, file.module);
  const source = `// GENERATED from ${file.markdown} by \`just copy\`. Edit the Markdown, not this file.
${file.imports ?? ''}

${body}
`;
  writeFileSync(
    target,
    await format(source, { ...(await resolveConfig(target)), filepath: target })
  );
  console.log(`wrote src/copy/${file.module}`);
}
