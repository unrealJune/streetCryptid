import type { PermissionPlatform, PermissionStepId } from '../core/permission-steps';

/**
 * Reads `permissions.md` into the shape `permissions.ts` exports. Pure, so the jest test can hold
 * the generated module to the Markdown and `scripts/build-copy.ts` can write it. The file's own
 * preamble documents the format for whoever edits it; this is the strict half of that contract —
 * anything it does not recognise is an error rather than text that silently goes missing.
 */

export type CardTone = 'amber' | 'green';

export interface StepCopyText {
  readonly name: string;
  readonly title: string;
  readonly lede: string;
  readonly summary: string;
  readonly cards: readonly { label: string; body: string; tone: CardTone }[];
  /** `default` is every platform without its own line; a platform with neither shows none. */
  readonly note: Partial<Record<PermissionPlatform | 'default', string>>;
  readonly action: string;
}

export interface PageCopyText {
  readonly title: string;
  readonly titleSingle: string;
  readonly subtitle: string;
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
    if (!text) throw new Error(`line ${field.line}: "${field.key}" has no text`);
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

const NOTE = /^note(?:-(ios|android|web))?$/;
const CARD = /^card:\s*(.+?)\s*\((amber|green)\)$/;

function single(fields: Field[], section: string, keys: readonly string[]) {
  const seen: Record<string, string> = {};
  for (const field of fields) {
    if (!keys.includes(field.key)) continue;
    if (field.key in seen) {
      throw new Error(`line ${field.line}: "${field.key}" appears twice in "${section}"`);
    }
    seen[field.key] = field.text;
  }
  for (const key of keys) {
    if (!(key in seen)) throw new Error(`section "${section}" has no "### ${key}"`);
  }
  return seen;
}

function stepCopy(id: string, fields: Field[]): StepCopyText {
  const known = ['name', 'title', 'lede', 'summary', 'action'] as const;
  const text = single(fields, id, known);
  const cards: StepCopyText['cards'][number][] = [];
  const note: Partial<Record<PermissionPlatform | 'default', string>> = {};
  for (const field of fields) {
    const card = CARD.exec(field.key);
    const platform = NOTE.exec(field.key);
    if (card) {
      cards.push({ label: card[1], tone: card[2] as CardTone, body: field.text });
    } else if (platform) {
      const which = (platform[1] ?? 'default') as PermissionPlatform | 'default';
      if (which in note) throw new Error(`line ${field.line}: "${field.key}" appears twice`);
      note[which] = field.text;
    } else if (!(known as readonly string[]).includes(field.key)) {
      throw new Error(`line ${field.line}: "${id}" has an unknown field "${field.key}"`);
    }
  }
  return {
    name: text.name,
    title: text.title,
    lede: text.lede,
    summary: text.summary,
    cards,
    note,
    action: text.action,
  };
}

const PAGE_FIELDS = [
  'title',
  'title-single',
  'subtitle',
  'continue',
  'not-now',
  'rail-ok',
  'allowed',
  'refused',
  'asked',
  'declined',
  'skipped',
] as const;

export function parsePermissionsCopy(
  markdown: string,
  stepIds: readonly PermissionStepId[]
): PermissionsCopy {
  const all = sections(markdown);
  const pageFields = all.get('page');
  if (!pageFields) throw new Error('no "## page" section');
  for (const field of pageFields) {
    if (!(PAGE_FIELDS as readonly string[]).includes(field.key)) {
      throw new Error(`line ${field.line}: "page" has an unknown field "${field.key}"`);
    }
  }
  const page = single(pageFields, 'page', PAGE_FIELDS);

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
      subtitle: page.subtitle,
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
