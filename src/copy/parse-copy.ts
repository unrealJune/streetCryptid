import type { PermissionPlatform, PermissionStepId } from '@/features/social/core/permission-steps';

/**
 * Reads the Markdown in this folder into the objects the generated `.ts` beside it export. Pure, so
 * the jest test can hold each generated module to its Markdown and `scripts/build-copy.ts` can
 * write it. Each file's own preamble documents the format for whoever edits it; this is the strict
 * half of that contract — anything it does not recognise is an error rather than text that
 * silently goes missing.
 *
 * A field left empty is the same as one deleted: the screen leaves that text out. Only what a
 * screen cannot work without (a button, a name, an error) is required, and an empty required field
 * is an error that says so.
 */

export type CardTone = 'amber' | 'green';

export interface StepCopyText {
  readonly name: string;
  /** The heading once the row is open. */
  readonly title?: string;
  readonly lede?: string;
  /** One line under the name while the step is still to come. */
  readonly summary?: string;
  readonly cards: readonly { label: string; body: string; tone: CardTone }[];
  /** `default` is every platform without its own line; a platform with neither shows none. */
  readonly note: Partial<Record<PermissionPlatform | 'default', string>>;
  readonly action: string;
}

export interface PageCopyText {
  readonly title: string;
  readonly titleSingle: string;
  readonly subtitle?: string;
  readonly continue: string;
  readonly notNow: string;
  readonly railOk: string;
  readonly outcome: {
    readonly allowed: string;
    readonly refused: string;
    readonly asked: string;
    readonly declined: string;
    readonly skipped: string;
  };
}

export interface PermissionsCopy {
  readonly page: PageCopyText;
  readonly steps: Record<string, StepCopyText>;
}

interface Field {
  readonly key: string;
  /** Empty when the field was left blank. */
  readonly text: string;
  readonly line: number;
}

/** `## id` → its `### fields`, in order. Everything before the first `##` is the preamble. */
function sections(markdown: string): Map<string, Field[]> {
  // Comments are blanked rather than removed, so line numbers in errors stay true.
  const source = markdown.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''));
  const out = new Map<string, Field[]>();
  let section: Field[] | null = null;
  let field: { key: string; line: number; lines: string[] } | null = null;

  const close = () => {
    if (!field || !section) return;
    const text = field.lines
      .join('\n')
      .trim()
      .split(/\n\s*\n/)
      .map((paragraph) =>
        paragraph
          .split('\n')
          .map((line) => line.trim())
          .join(' ')
      )
      .join('\n\n');
    section.push({ key: field.key, text, line: field.line });
    field = null;
  };

  source.split(/\r?\n/).forEach((line, index) => {
    const number = index + 1;
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      if (!section) throw new Error(`line ${number}: "### ${h3[1]}" is outside any ## section`);
      close();
      field = { key: h3[1], line: number, lines: [] };
    } else if (h2) {
      close();
      if (out.has(h2[1])) throw new Error(`line ${number}: section "${h2[1]}" appears twice`);
      section = [];
      out.set(h2[1], section);
    } else if (field) {
      field.lines.push(line);
    } else if (section && line.trim()) {
      throw new Error(`line ${number}: text in "${[...out.keys()].pop()}" before any ### field`);
    }
  });
  close();
  return out;
}

interface FieldRules {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

/**
 * A section's plain fields that have text, by key. Fields `extra` claims (cards, notes) are left
 * to the caller; anything else unknown, repeated, or required and empty is an error.
 */
function fieldsOf(
  fields: readonly Field[],
  section: string,
  { required, optional = [] }: FieldRules,
  extra: (key: string) => boolean = () => false
): Record<string, string> {
  const seen = new Set<string>();
  const text: Record<string, string> = {};
  for (const field of fields) {
    if (extra(field.key)) continue;
    if (!required.includes(field.key) && !optional.includes(field.key)) {
      throw new Error(`line ${field.line}: "${section}" has an unknown field "${field.key}"`);
    }
    if (seen.has(field.key)) {
      throw new Error(`line ${field.line}: "${field.key}" appears twice in "${section}"`);
    }
    seen.add(field.key);
    if (field.text) text[field.key] = field.text;
  }
  for (const key of required) {
    if (!(key in text)) {
      throw new Error(
        `"### ${key}" in "${section}" ${seen.has(key) ? 'is empty' : 'is missing'}, and the app can’t do without it`
      );
    }
  }
  return text;
}

/** Which fields a `## section` holds. A required field must have text; an optional one may not. */
export type CopySchema = Readonly<Record<string, FieldRules>>;

const camel = (key: string) =>
  key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** A file of plain fields: every section the schema names, keys in camelCase, empty ones left out. */
export function parseCopy(markdown: string, schema: CopySchema) {
  const all = sections(markdown);
  for (const id of all.keys()) {
    if (!(id in schema)) {
      throw new Error(`"## ${id}" is not a section here (${Object.keys(schema).join(', ')})`);
    }
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [id, rules] of Object.entries(schema)) {
    const fields = all.get(id);
    if (!fields) throw new Error(`no "## ${id}" section`);
    const text = fieldsOf(fields, id, rules);
    out[camel(id)] = Object.fromEntries(
      [...rules.required, ...(rules.optional ?? [])]
        .filter((key) => key in text)
        .map((key) => [camel(key), text[key]])
    );
  }
  return out;
}

/** The TypeScript type of what `parseCopy` returns for `schema`, for the generated module. */
export function copySchemaType(schema: CopySchema): string {
  const section = ({ required, optional = [] }: FieldRules) =>
    `{ ${[
      ...required.map((key) => `readonly ${camel(key)}: string;`),
      ...optional.map((key) => `readonly ${camel(key)}?: string;`),
    ].join(' ')} }`;
  return `{ ${Object.entries(schema)
    .map(([id, rules]) => `readonly ${JSON.stringify(camel(id))}: ${section(rules)};`)
    .join(' ')} }`;
}

const NOTE = /^note(?:-(ios|android|web))?$/;
const CARD = /^card:\s*(.+?)\s*\((amber|green)\)$/;

const STEP_FIELDS: FieldRules = {
  required: ['name', 'action'],
  optional: ['title', 'lede', 'summary'],
};

function stepCopy(id: string, fields: Field[]): StepCopyText {
  const text = fieldsOf(fields, id, STEP_FIELDS, (key) => CARD.test(key) || NOTE.test(key));
  const cards: StepCopyText['cards'][number][] = [];
  const note: Partial<Record<PermissionPlatform | 'default', string>> = {};
  for (const field of fields) {
    const card = CARD.exec(field.key);
    const platform = NOTE.exec(field.key);
    if (card) {
      // A card with no text is a card taken off the page.
      if (field.text) cards.push({ label: card[1], tone: card[2] as CardTone, body: field.text });
    } else if (platform) {
      const which = (platform[1] ?? 'default') as PermissionPlatform | 'default';
      if (which in note) throw new Error(`line ${field.line}: "${field.key}" appears twice`);
      if (field.text) note[which] = field.text;
    }
  }
  return {
    name: text.name,
    ...(text.title ? { title: text.title } : {}),
    ...(text.lede ? { lede: text.lede } : {}),
    ...(text.summary ? { summary: text.summary } : {}),
    cards,
    note,
    action: text.action,
  };
}

const PAGE_FIELDS: FieldRules = {
  required: [
    'title',
    'title-single',
    'continue',
    'not-now',
    'rail-ok',
    'allowed',
    'refused',
    'asked',
    'declined',
    'skipped',
  ],
  optional: ['subtitle'],
};

export function parsePermissionsCopy(
  markdown: string,
  stepIds: readonly PermissionStepId[]
): PermissionsCopy {
  const all = sections(markdown);
  const pageFields = all.get('page');
  if (!pageFields) throw new Error('no "## page" section');
  const page = fieldsOf(pageFields, 'page', PAGE_FIELDS);

  const steps: Record<string, StepCopyText> = {};
  for (const [id, fields] of all) {
    if (id === 'page') continue;
    if (!(stepIds as readonly string[]).includes(id)) {
      throw new Error(`"## ${id}" is not a permission step (${stepIds.join(', ')})`);
    }
    steps[id] = stepCopy(id, fields);
  }
  const missing = stepIds.filter((id) => !(id in steps));
  if (missing.length)
    throw new Error(`no section for ${missing.map((id) => `"## ${id}"`).join(', ')}`);

  return {
    page: {
      title: page.title,
      titleSingle: page['title-single'],
      ...(page.subtitle ? { subtitle: page.subtitle } : {}),
      continue: page.continue,
      notNow: page['not-now'],
      railOk: page['rail-ok'],
      outcome: {
        allowed: page.allowed,
        refused: page.refused,
        asked: page.asked,
        declined: page.declined,
        skipped: page.skipped,
      },
    },
    // In step order, so the generated module reads like the page.
    steps: Object.fromEntries(stepIds.map((id) => [id, steps[id]])),
  };
}
