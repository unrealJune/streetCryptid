/**
 * Prompt construction for the on-device icon models.
 *
 * All prompting lives in TypeScript rather than in the Swift/Kotlin bridges. The native side is a
 * dumb executor that runs whatever instructions/prompt it is handed, which means prompt strategy
 * can be changed, unit tested, and measured without a native rebuild on either platform.
 *
 * Two techniques do the heavy lifting for small models:
 *  - few-shot exemplars drawn from the in-house archetypes (structure is copied, prose rules are
 *    not), rotated by seed so every generation is not anchored to the same silhouette; and
 *  - a JS-sampled trait set, so run-to-run novelty is guaranteed even when the model's own
 *    sampling collapses onto one answer. "Regenerate" then reliably produces something different.
 */

import { MAX_SIGIL_COLUMNS } from './profile';
import { ARCHETYPES, exemplarRender, hashString, matchingArchetype, pick } from './cryptid-archetypes';

export const MIN_SIGIL_ART_LINES = 4;
export const MAX_SIGIL_ART_LINES = 8;
/** Icons stay well inside the profile tile so a stray wide row is still recoverable. */
export const TARGET_SIGIL_COLUMNS = 28;

const HEAD_SHAPES = [
  'a domed head',
  'a narrow wedge head',
  'a flat crowned head',
  'a round hooded head',
  'a horned skull',
] as const;

const EYE_MOTIFS = [
  'wide round eyes',
  'narrow slit eyes',
  'a single central eye',
  'four small eyes',
  'glowing pinprick eyes',
] as const;

const TEXTURES = [
  'ragged fur',
  'wet feathers',
  'cracked bark',
  'oily scales',
  'drifting smoke',
  'lichen patches',
] as const;

const ODDITIES = [
  'one limb far too long',
  'a lantern it carries',
  'antenna that curl backwards',
  'a hollow chest',
  'too many small hands',
  'a tail that trails off the tile',
  'ears turned inside out',
] as const;

export interface CryptidTraits {
  /** Silhouette family, taken from the archetype the description matches (or a seeded one). */
  silhouette: string;
  headShape: string;
  eyeMotif: string;
  texture: string;
  oddity: string;
}

/** Samples a trait set from the description and seed. Deterministic for a given pair. */
export function pickTraits(normalizedDescription: string, normalizedSeed: number): CryptidTraits {
  const lowered = normalizedDescription.toLowerCase();
  const hash = hashString(`traits:${lowered || 'surprise'}:${normalizedSeed}`);
  return {
    silhouette: matchingArchetype(lowered, hash).label,
    headShape: pick(HEAD_SHAPES, hash, 3),
    eyeMotif: pick(EYE_MOTIFS, hash, 8),
    texture: pick(TEXTURES, hash, 13),
    oddity: pick(ODDITIES, hash, 19),
  };
}

export function describeTraits(traits: CryptidTraits): string {
  return [
    `silhouette: ${traits.silhouette}`,
    `head: ${traits.headShape}`,
    `eyes: ${traits.eyeMotif}`,
    `texture: ${traits.texture}`,
    `one odd detail: ${traits.oddity}`,
  ].join('\n');
}

/** Two archetype renders, rotated by seed so the exemplars do not anchor every generation. */
export function pickExemplars(normalizedSeed: number, count = 2): string[] {
  const start = normalizedSeed % ARCHETYPES.length;
  const stride = 3; // coprime with the archetype count, so the pair varies with the seed
  return Array.from({ length: Math.min(count, ARCHETYPES.length) }, (_unused, index) =>
    exemplarRender(ARCHETYPES[(start + index * stride) % ARCHETYPES.length])
  );
}

/**
 * A single unit of work for the native bridge. Everything the model needs is in here, so both
 * platforms run the same prompt and the same budget.
 */
export interface CryptidPromptSpec {
  instructions: string;
  prompt: string;
  seed: number;
  /** How many independent drawings to ask for. The best one wins. */
  candidateCount: number;
  maxOutputTokens: number;
  temperature: number;
  maxLines: number;
  maxColumns: number;
  /** 1-based round, mirrored into progress events. */
  attempt: number;
}

function baseInstructions(exemplars: string[]): string {
  return [
    'You draw tiny ASCII creature icons for a profile tile.',
    '',
    'These are good icons. Copy their size and structure, not their creature:',
    ...exemplars.map((exemplar) => `${exemplar}\n`),
    'Rules:',
    `- Answer with ${MIN_SIGIL_ART_LINES} to ${MAX_SIGIL_ART_LINES} drawing rows and nothing else.`,
    `- Keep every row under ${TARGET_SIGIL_COLUMNS} columns.`,
    '- Use printable 7-bit ASCII and spaces only. No markdown, no words, no commentary.',
    '- Put ink on every row; never leave a blank row inside the drawing.',
    '- Keep the left and right halves roughly mirrored so the silhouette reads at a glance.',
    '- Give it a distinctive name of 1 to 24 characters.',
  ].join('\n');
}

export function buildDraftPrompt(
  normalizedDescription: string,
  normalizedSeed: number,
  traits: CryptidTraits,
  options: { candidateCount?: number } = {}
): CryptidPromptSpec {
  const description = normalizedDescription || 'an unknown city cryptid';
  return {
    instructions: baseInstructions(pickExemplars(normalizedSeed)),
    prompt: [
      `Draw one cryptid icon for: "${description}".`,
      '',
      'Use exactly these traits:',
      describeTraits(traits),
      '',
      `Variation seed ${normalizedSeed}. Stop as soon as the drawing is complete.`,
    ].join('\n'),
    seed: normalizedSeed,
    candidateCount: options.candidateCount ?? 3,
    // Several small candidates beat one long one: the per-answer budget is what keeps the model
    // from looping on ASCII art until it fills its context window.
    maxOutputTokens: 200,
    temperature: 0.8,
    maxLines: MAX_SIGIL_ART_LINES,
    maxColumns: MAX_SIGIL_COLUMNS,
    attempt: 1,
  };
}

/**
 * One repair round. The model is shown its own best attempt and the scorer's concrete complaints,
 * which works far better on small models than a generic "try again, but tighter" reprompt.
 */
export function buildRepairPrompt(
  draft: CryptidPromptSpec,
  previousSigil: string,
  defects: readonly string[],
  options: { candidateCount?: number } = {}
): CryptidPromptSpec {
  const complaints = defects.slice(0, 3);
  return {
    ...draft,
    prompt: [
      'Your previous drawing was rejected:',
      previousSigil,
      '',
      'Problems to fix:',
      ...complaints.map((defect) => `- ${defect}`),
      '',
      'Draw it again, keeping the same creature and traits. Answer with the drawing rows only.',
    ].join('\n'),
    // A different seed so the retry is not the same sample with a longer preamble.
    seed: draft.seed + 1,
    candidateCount: options.candidateCount ?? 2,
    temperature: 0.6,
    maxOutputTokens: 180,
    attempt: draft.attempt + 1,
  };
}
