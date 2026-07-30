/**
 * Shape analysis for generated ASCII sigils.
 *
 * The on-device models are small (a ~3B system model on iOS, Gemini Nano on Android) and they
 * routinely answer a "draw an icon" prompt with something that is technically valid ASCII but not
 * icon shaped: three ragged lines, a paragraph of prose, a blank interior, a wall of hashes. The
 * profile validator in `profile.ts` only checks size, so it happily accepts all of those.
 *
 * This module adds the missing judgement. It is deliberately pure TypeScript with no native
 * dependency so it can act as three things at once: the acceptance gate, the retry trigger (its
 * `defects` feed the repair prompt verbatim), and the selector for best-of-N candidates.
 *
 * Thresholds are calibrated against the hand-drawn archetype renders in `cryptid-archetypes.ts`,
 * which are the ground truth for "the shape we want" — see the tests.
 */

import {
  MAX_SIGIL_COLUMNS,
  MAX_SIGIL_LINES,
  normalizeAsciiArt,
  validateCryptidProfileFields,
  DEFAULT_SIGNAL_COLOR,
} from './profile';

/** Tabs become spaces early so every later measurement is a plain character count. */
const TAB_REPLACEMENT = '  ';

/** A candidate at or above this score is accepted without a repair round. */
export const ICON_SHAPE_ACCEPT_SCORE = 0.62;

/** The height band the prompts ask for, and the band the scorer rewards. */
const MIN_ART_LINES = 4;
const MAX_ART_LINES = 8;

export interface SigilShapeFeatures {
  /** Rows after cropping to the inked bounding box. */
  lines: number;
  /** Widest inked row. */
  columns: number;
  /** columns / lines. Icons want roughly 1.2–2.2 in a monospaced grid (cells are ~2:1 tall). */
  aspect: number;
  /** Share of the bounding box that carries ink. */
  density: number;
  /** Share of mirrored cell pairs whose ink state matches. */
  symmetry: number;
  /** Standard deviation of inked row widths divided by the mean width. */
  raggedness: number;
  /** Share of rows inside the box that carry any ink. */
  rowOccupancy: number;
  /** Distinct non-space characters — a cheap novelty proxy. */
  distinctCharacters: number;
  /** Share of rows that read as prose or filler rather than drawing. */
  proseRatio: number;
}

export interface SigilShapeReport {
  /** The normalized art the score describes. Empty when nothing survived normalization. */
  sigil: string;
  /** 0..1. Higher is more icon shaped. */
  score: number;
  features: SigilShapeFeatures;
  /**
   * Concrete, model-readable complaints, most important first. These are fed straight back into
   * the repair prompt, so they are phrased as observations plus a fix.
   */
  defects: string[];
  /** False when the art cannot be stored on a profile at all (empty, non-ASCII, oversized). */
  valid: boolean;
}

const EMPTY_FEATURES: SigilShapeFeatures = {
  lines: 0,
  columns: 0,
  aspect: 0,
  density: 0,
  symmetry: 0,
  raggedness: 0,
  rowOccupancy: 0,
  distinctCharacters: 0,
  proseRatio: 1,
};

/** Fenced code blocks and "Here is your icon:" preambles are the two most common wrappers. */
const FENCE_PATTERN = /^\s*(```|~~~)/;
const PROSE_PATTERN = /^[\sA-Za-z,'"]*[A-Za-z]{3,}(\s+[A-Za-z]{2,}){2,}[\s.:!?]*$/;
const LABEL_PATTERN = /^\s*(name|sigil|icon|art|output|answer|note|explanation)\s*[:=]/i;
const FILLER_RUN_PATTERN = /^([-=_*.#~+])\1{2,}$/;

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/**
 * A drawing row can contain letters, but not several whitespace-separated words in a row.
 *
 * A row of one repeated character only counts as filler when it spans most of the drawing —
 * a short `_____` is usually a shoulder or a jaw, while a full-width `########` is padding.
 */
function looksLikeProse(line: string, width = 0): boolean {
  if (isBlank(line)) return false;
  if (LABEL_PATTERN.test(line)) return true;
  const trimmed = line.trim();
  if (FILLER_RUN_PATTERN.test(trimmed) && trimmed.length >= Math.max(6, width * 0.9)) return true;
  return PROSE_PATTERN.test(line);
}

/**
 * Stricter than `looksLikeProse`: only sentences and labels are removed from the edges of an
 * answer. Filler rows (`------`) are left in place because they are frequently the top or bottom
 * of a real drawing; the scorer penalizes them instead of the normalizer deleting them.
 */
function isEdgeCommentary(line: string): boolean {
  return LABEL_PATTERN.test(line) || PROSE_PATTERN.test(line);
}

/**
 * Best-effort tile fit applied before anything is judged.
 *
 * A slightly indented but otherwise good drawing used to fail the profile validator outright, and
 * a drawing wrapped in a code fence was thrown away entirely. Cleaning first costs nothing and
 * raises the usable-output rate. Steps: ASCII-normalize, drop fences and commentary at the edges,
 * expand tabs, strip unprintables, drop blank edge rows, right-trim, remove the common indent, and
 * hard-crop to the profile tile.
 */
export function normalizeSigilTile(raw: string): string {
  const ascii = normalizeAsciiArt(raw ?? '');
  let lines = ascii
    .split('\n')
    .filter((line) => !FENCE_PATTERN.test(line))
    // Control characters other than the line breaks we already split on.
    .map((line) => line.replace(/\t/g, TAB_REPLACEMENT).replace(/[^\x20-\x7e]/g, ''))
    .map((line) => line.replace(/\s+$/, ''));

  // Commentary only gets stripped from the edges: a prose-looking row in the middle is far more
  // likely to be part of the drawing, and dropping it would silently mangle the art.
  while (lines.length > 0 && (isBlank(lines[0]) || isEdgeCommentary(lines[0]))) lines.shift();
  while (
    lines.length > 0 &&
    (isBlank(lines[lines.length - 1]) || isEdgeCommentary(lines[lines.length - 1]))
  ) {
    lines.pop();
  }
  if (lines.length === 0) return '';

  const indents = lines
    .filter((line) => !isBlank(line))
    .map((line) => line.length - line.trimStart().length);
  const commonIndent = indents.length > 0 ? Math.min(...indents) : 0;
  lines = lines.map((line) => line.slice(commonIndent));

  return lines
    .slice(0, MAX_SIGIL_LINES)
    .map((line) => line.slice(0, MAX_SIGIL_COLUMNS).replace(/\s+$/, ''))
    .join('\n');
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** 1 inside [low, high], tapering to 0 at `low - slack` / `high + slack`. */
function band(value: number, low: number, high: number, slack: number): number {
  if (value >= low && value <= high) return 1;
  const distance = value < low ? low - value : value - high;
  return Math.max(0, 1 - distance / slack);
}

/** Ramps from 0 at `low` to 1 at `high`, clamped outside. */
function ramp(value: number, low: number, high: number): number {
  if (high <= low) return value >= high ? 1 : 0;
  return Math.min(1, Math.max(0, (value - low) / (high - low)));
}

function measureFeatures(lines: string[]): SigilShapeFeatures {
  const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const inkedRows = lines.filter((line) => !isBlank(line));
  const cells = lines.length * width;
  const inkCount = lines.reduce(
    (total, line) => total + line.split('').filter((char) => char !== ' ').length,
    0
  );

  let mirrored = 0;
  let mirrorPairs = 0;
  for (const line of lines) {
    const padded = line.padEnd(width, ' ');
    for (let index = 0; index < Math.floor(width / 2); index += 1) {
      const left = padded[index] !== ' ';
      const right = padded[width - 1 - index] !== ' ';
      mirrorPairs += 1;
      if (left === right) mirrored += 1;
    }
  }

  const distinct = new Set(
    lines
      .join('')
      .split('')
      .filter((char) => char !== ' ')
  );
  const widths = inkedRows.map((line) => line.trimEnd().length);
  const meanWidth = widths.reduce((sum, value) => sum + value, 0) / Math.max(1, widths.length);

  return {
    lines: lines.length,
    columns: width,
    aspect: lines.length > 0 ? width / lines.length : 0,
    density: cells > 0 ? inkCount / cells : 0,
    symmetry: mirrorPairs > 0 ? mirrored / mirrorPairs : 1,
    raggedness: meanWidth > 0 ? standardDeviation(widths) / meanWidth : 0,
    rowOccupancy: lines.length > 0 ? inkedRows.length / lines.length : 0,
    distinctCharacters: distinct.size,
    proseRatio:
      lines.length > 0
        ? lines.filter((line) => looksLikeProse(line, width)).length / lines.length
        : 0,
  };
}

function collectDefects(features: SigilShapeFeatures): string[] {
  const defects: string[] = [];
  if (features.lines < MIN_ART_LINES) {
    defects.push(
      `the drawing is only ${features.lines} lines tall; draw ${MIN_ART_LINES} to ${MAX_ART_LINES} lines`
    );
  } else if (features.lines > MAX_ART_LINES) {
    defects.push(
      `the drawing is ${features.lines} lines tall; draw ${MIN_ART_LINES} to ${MAX_ART_LINES} lines`
    );
  }
  if (features.aspect > 2.9) {
    defects.push(
      `the drawing is ${features.columns} columns wide but only ${features.lines} lines tall; make it more compact and square`
    );
  } else if (features.aspect < 1.05 && features.columns > 0) {
    defects.push(
      `the drawing is narrow and tall; widen the silhouette to about ${Math.max(8, features.lines * 2)} columns`
    );
  }
  if (features.density < 0.16) {
    defects.push('the drawing is mostly empty space; add solid strokes to the body');
  } else if (features.density > 0.68) {
    defects.push('the drawing is a solid block; open it up with spaces so the silhouette reads');
  }
  if (features.symmetry < 0.6) {
    defects.push('the drawing is lopsided; make the left and right halves mirror each other');
  }
  if (features.rowOccupancy < 1) {
    defects.push('some rows are blank in the middle; put ink on every row of the drawing');
  }
  if (features.raggedness > 0.35) {
    defects.push('the line widths are ragged; keep the rows a similar width so it reads as a body');
  }
  if (features.distinctCharacters < 4) {
    defects.push('the drawing uses too few different characters; vary the strokes');
  }
  if (features.proseRatio > 0) {
    defects.push('remove the words and filler rows; answer with the drawing rows only');
  }
  return defects;
}

/**
 * Scores a sigil on how icon shaped it is.
 *
 * `raw` is normalized first, so callers can pass model output straight through. Novelty is part of
 * the score on purpose (`distinctCharacters`): scoring shape alone would reward samey symmetric
 * blobs, which is the exact failure this pipeline is trying to avoid.
 */
export function scoreSigilShape(raw: string): SigilShapeReport {
  const sigil = normalizeSigilTile(raw);
  if (sigil.trim().length === 0) {
    return {
      sigil: '',
      score: 0,
      features: EMPTY_FEATURES,
      defects: ['nothing was drawn; answer with rows of ASCII art'],
      valid: false,
    };
  }

  const issues = validateCryptidProfileFields({
    handle: 'generator',
    cryptidName: 'Generated',
    sigil,
    color: DEFAULT_SIGNAL_COLOR,
    presetId: null,
  });
  const features = measureFeatures(sigil.split('\n'));
  const defects = collectDefects(features);

  if (issues.sigil.length > 0) {
    return {
      sigil,
      score: 0,
      features,
      defects: [...issues.sigil, ...defects],
      valid: false,
    };
  }

  // Three fundamentals act as gates rather than as summands, because a drawing that is the wrong
  // height, has a hole through the middle, or is made of a single repeated character is not
  // rescued by scoring well everywhere else.
  const heightFit = band(features.lines, MIN_ART_LINES, MAX_ART_LINES, 4);
  const occupancyFit = ramp(features.rowOccupancy, 0.8, 1);
  const varietyFit = ramp(features.distinctCharacters, 2, 5);

  // The remaining weights were calibrated so every archetype render and shipped preset lands well
  // above ICON_SHAPE_ACCEPT_SCORE while prose, banners, solid blocks and ragged blobs land below
  // it. Character variety gates the score on purpose: judging pure shape would reward samey
  // uniform blobs, which is the exact failure this pipeline exists to avoid.
  const parts: [number, number][] = [
    [0.18, band(features.aspect, 1.1, 2.7, 1.1)],
    [0.26, band(features.density, 0.18, 0.58, 0.2)],
    [0.18, ramp(features.symmetry, 0.5, 0.85)],
    [0.1, band(features.raggedness, 0, 0.28, 0.3)],
    [0.18, ramp(features.rowOccupancy, 0.8, 1)],
    [0.1, 1 - Math.min(1, features.proseRatio * 2)],
  ];
  const base = parts.reduce((total, [weight, value]) => total + weight * value, 0);
  const score =
    base * (0.3 + 0.7 * heightFit) * (0.45 + 0.55 * occupancyFit) * (0.5 + 0.5 * varietyFit);

  return { sigil, score: Math.min(1, Math.max(0, score)), features, defects, valid: true };
}

export function isIconShaped(report: SigilShapeReport): boolean {
  return report.valid && report.score >= ICON_SHAPE_ACCEPT_SCORE;
}
