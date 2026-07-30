import {
  tryGetCryptidGenerator,
  type CryptidGenerationProgressEvent,
  type NativeGeneratedCryptid,
  type NativeGenerationRequest,
} from 'cryptid-generator';

import { recordEventLog } from '@/features/dev/telemetry';
import { hashString, normalizeSeed, renderLocalCryptid } from './cryptid-archetypes';
import {
  buildDraftPrompt,
  buildRepairPrompt,
  pickTraits,
  type CryptidPromptSpec,
  type CryptidTraits,
} from './cryptid-prompt';
import { DEFAULT_SIGNAL_COLOR, normalizeAsciiArt, validateCryptidProfileFields } from './profile';
import { ICON_SHAPE_ACCEPT_SCORE, scoreSigilShape, type SigilShapeReport } from './sigil-shape';

const MAX_DESCRIPTION_LENGTH = 160;

export type CryptidGenerationSource = 'system' | 'local' | 'hybrid';

export interface GeneratedCryptid {
  name: string;
  sigil: string;
  source: CryptidGenerationSource;
  /** Set when the system model was skipped or failed and the offline maker took over. */
  fallbackReason?: string;
  /** Shape score of the art that was returned, when it came from the model. */
  shapeScore?: number;
}

export function normalizeCryptidDescription(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_LENGTH);
}

export function validateGeneratedCryptid(
  value: NativeGeneratedCryptid,
  source: CryptidGenerationSource
): GeneratedCryptid {
  const name = value.name.trim();
  const sigil = normalizeAsciiArt(value.sigil);
  const issues = validateCryptidProfileFields({
    handle: 'generator',
    cryptidName: name,
    sigil,
    color: DEFAULT_SIGNAL_COLOR,
    presetId: null,
  });
  const generationIssues = [...issues.cryptidName, ...issues.sigil];
  if (generationIssues.length > 0) {
    throw new Error(
      `The on-device generator made an icon that does not fit the profile grid. ${generationIssues.join(
        ' '
      )}`
    );
  }
  return { name, sigil, source };
}

export function generateLocalCryptid(
  description: string,
  seed: number,
  fallbackReason?: string
): GeneratedCryptid {
  const normalizedDescription = normalizeCryptidDescription(description).toLowerCase();
  const rendered = renderLocalCryptid(normalizedDescription, normalizeSeed(seed));
  const generated = validateGeneratedCryptid({ name: rendered.name, sigil: rendered.sigil }, 'local');
  return fallbackReason ? { ...generated, fallbackReason } : generated;
}

/**
 * Phases of the icon pipeline, in the order they usually happen. `downloadingModel`, `repairing`
 * and `fallback` are conditional. Native phases are mirrored from the Expo module so the dialog
 * can distinguish "downloading a multi-hundred-megabyte model" from "actually running inference".
 */
export type CryptidGenerationPhase =
  | 'starting'
  | 'checkingModel'
  | 'downloadingModel'
  | 'preparingModel'
  | 'generating'
  | 'formatting'
  | 'scoring'
  | 'repairing'
  | 'checkingArt'
  | 'fallback'
  | 'done';

export interface CryptidGenerationProgress {
  phase: CryptidGenerationPhase;
  /** Short headline for the current phase. */
  title: string;
  /** Extra context: download size, retry reason, why the fallback kicked in. */
  detail: string | null;
  /** 0..1 when the phase has measurable progress (model download), otherwise null. */
  ratio: number | null;
  /** 1-based inference round; the model gets one repair round. */
  attempt: number;
}

export type CryptidGenerationProgressListener = (progress: CryptidGenerationProgress) => void;

const PHASE_TITLES: Record<CryptidGenerationPhase, string> = {
  starting: 'Starting up...',
  checkingModel: "Checking this phone's icon model...",
  downloadingModel: 'Downloading the system model...',
  preparingModel: 'Loading the model into memory...',
  generating: 'Drawing your cryptid...',
  formatting: 'Tidying up the ASCII art...',
  scoring: 'Picking the best sketch...',
  repairing: 'Asking for a cleaner redraw...',
  checkingArt: 'Checking it fits the profile tile...',
  fallback: 'Switching to the offline icon maker...',
  done: 'Done',
};

const PHASE_DETAILS: Partial<Record<CryptidGenerationPhase, string>> = {
  checkingModel: 'Asking the system whether an on-device model is ready.',
  downloadingModel: 'The system model downloads once, then stays on this phone.',
  preparingModel: 'The first run after a reboot is the slow one.',
  generating: 'Inference runs entirely on this phone.',
  scoring: 'Every sketch is measured against the profile tile.',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

function describeProgress(
  phase: CryptidGenerationPhase,
  options: { detail?: string | null; ratio?: number | null; attempt?: number } = {}
): CryptidGenerationProgress {
  const attempt = Math.max(1, options.attempt ?? 1);
  const detail = options.detail ?? PHASE_DETAILS[phase] ?? null;
  return {
    phase,
    title: PHASE_TITLES[phase],
    detail: attempt > 1 && detail ? `Attempt ${attempt}. ${detail}` : detail,
    ratio: options.ratio ?? null,
    attempt,
  };
}

/** Maps a native progress event onto the shared phase model. */
export function progressFromNativeEvent(
  event: CryptidGenerationProgressEvent
): CryptidGenerationProgress {
  const downloaded = event.downloadedBytes ?? null;
  const total = event.totalBytes ?? null;
  const hasDownloadSize = typeof total === 'number' && total > 0;
  const detail =
    event.detail ??
    (hasDownloadSize && typeof downloaded === 'number'
      ? `${formatBytes(downloaded)} of ${formatBytes(total)} downloaded.`
      : hasDownloadSize
        ? `${formatBytes(total)} to download.`
        : null);
  return describeProgress(event.phase, {
    detail,
    ratio:
      hasDownloadSize && typeof downloaded === 'number'
        ? Math.min(1, Math.max(0, downloaded / total))
        : null,
    attempt: event.attempt,
  });
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  return 'The on-device model did not return an icon.';
}

/**
 * Recently accepted art, so a model that has collapsed onto one answer stops winning best-of-N.
 * Novelty has to take part in the selection or the pipeline drifts towards samey blobs.
 */
const RECENT_SIGIL_HASHES: number[] = [];
const RECENT_SIGIL_MEMORY = 8;
const REPEAT_PENALTY = 0.15;

function rememberSigil(sigil: string): void {
  RECENT_SIGIL_HASHES.push(hashString(sigil));
  while (RECENT_SIGIL_HASHES.length > RECENT_SIGIL_MEMORY) RECENT_SIGIL_HASHES.shift();
}

/** Exposed for tests and the dev bench; production code never needs to reset this. */
export function resetRecentSigilMemory(): void {
  RECENT_SIGIL_HASHES.length = 0;
}

/** Rejects names that carry the model's formatting noise rather than a creature. */
function usableModelName(modelName: string | null | undefined): string | null {
  const name = modelName?.trim() ?? '';
  if (name.length < 1 || name.length > 24) return null;
  if (/[^\x20-\x7e]/.test(name) || /["{}[\]<>]/.test(name)) return null;
  return name;
}

export interface ScoredCandidate {
  name: string;
  report: SigilShapeReport;
  /** Shape score minus the repeat penalty. This is what best-of-N sorts on. */
  score: number;
  repeated: boolean;
}

function scoreCandidate(candidate: NativeGeneratedCryptid): ScoredCandidate {
  const report = scoreSigilShape(candidate?.sigil ?? '');
  const repeated = report.sigil.length > 0 && RECENT_SIGIL_HASHES.includes(hashString(report.sigil));
  return {
    name: (candidate?.name ?? '').trim(),
    report,
    score: Math.max(0, report.score - (repeated ? REPEAT_PENALTY : 0)),
    repeated,
  };
}

/** Best-of-N selection: highest adjusted score wins, ties broken by the raw shape score. */
export function selectBestCandidate(
  candidates: readonly NativeGeneratedCryptid[]
): ScoredCandidate | null {
  const scored = candidates.map(scoreCandidate).filter((candidate) => candidate.report.valid);
  if (scored.length === 0) return null;
  return scored.reduce((best, candidate) =>
    candidate.score > best.score ||
    (candidate.score === best.score && candidate.report.score > best.report.score)
      ? candidate
      : best
  );
}

function specToRequest(spec: CryptidPromptSpec): NativeGenerationRequest {
  return {
    instructions: spec.instructions,
    prompt: spec.prompt,
    seed: spec.seed,
    candidateCount: spec.candidateCount,
    maxOutputTokens: spec.maxOutputTokens,
    temperature: spec.temperature,
    maxLines: spec.maxLines,
    maxColumns: spec.maxColumns,
    attempt: spec.attempt,
  };
}

type NativeGenerator = NonNullable<ReturnType<typeof tryGetCryptidGenerator>>;

/**
 * Runs one round against the model. Builds that predate the best-of-N bridge only expose
 * `generate`, so the request degrades to a single legacy call there.
 */
async function requestCandidates(
  generator: NativeGenerator,
  spec: CryptidPromptSpec,
  legacyDescription: string
): Promise<NativeGeneratedCryptid[]> {
  if (typeof generator.generateCandidates === 'function') {
    const candidates = await generator.generateCandidates(specToRequest(spec));
    return Array.isArray(candidates) ? candidates : [];
  }
  const single = await generator.generate(legacyDescription, spec.seed);
  return single ? [single] : [];
}

/**
 * Blends the model output with the offline maker: the name is the part a small model does well, so
 * it is kept, and only the art is replaced by the matching archetype render. The user still gets
 * something novel-feeling instead of a pure fallback.
 */
function blendWithLocal(
  normalizedDescription: string,
  normalizedSeed: number,
  reason: string,
  modelName: string | null
): GeneratedCryptid {
  const rendered = renderLocalCryptid(normalizedDescription.toLowerCase(), normalizedSeed);
  const name = usableModelName(modelName);
  try {
    return {
      ...validateGeneratedCryptid(
        { name: name ?? rendered.name, sigil: rendered.sigil },
        name ? 'hybrid' : 'local'
      ),
      fallbackReason: reason,
    };
  } catch {
    return generateLocalCryptid(normalizedDescription, normalizedSeed, reason);
  }
}

export interface GenerateCryptidOptions {
  onProgress?: CryptidGenerationProgressListener;
  /** Overrides how many drawings each round asks for. Used by the dev bench. */
  candidateCount?: number;
}

/**
 * Runs the icon pipeline and narrates it through `onProgress`.
 *
 * The loop is: draw N candidates -> normalize + score each -> accept the best if it clears the bar
 * -> otherwise one repair round seeded with the scorer's complaints -> otherwise blend the model's
 * name with an offline render. The system model is best effort throughout: when it is missing,
 * still downloading, or fails, the offline maker produces an icon and the reason travels back on
 * `fallbackReason`.
 */
export async function generateCryptid(
  description: string,
  seed: number,
  options: GenerateCryptidOptions = {}
): Promise<GeneratedCryptid> {
  const normalizedDescription = normalizeCryptidDescription(description);
  const normalizedSeed = normalizeSeed(seed);
  const startedAt = Date.now();
  let lastPhase: CryptidGenerationPhase = 'starting';

  const report = (progress: CryptidGenerationProgress): void => {
    lastPhase = progress.phase;
    recordEventLog({
      level: 'debug',
      category: 'generator',
      action: `generator.${progress.phase}`,
      summary: progress.title,
      status: 'ok',
      details: {
        phase: progress.phase,
        detail: progress.detail,
        ratio: progress.ratio,
        attempt: progress.attempt,
        elapsed_ms: Date.now() - startedAt,
      },
    });
    options.onProgress?.(progress);
  };

  const finishLocal = (reason: string, modelName: string | null = null): GeneratedCryptid => {
    report(describeProgress('fallback', { detail: reason }));
    const generated = blendWithLocal(normalizedDescription, normalizedSeed, reason, modelName);
    recordEventLog({
      level: 'warn',
      category: 'generator',
      action: 'generator.fallback',
      summary: `${generated.source === 'hybrid' ? 'Hybrid' : 'Offline'} icon maker used: ${reason}`,
      status: 'ok',
      details: {
        reason,
        source: generated.source,
        phase: lastPhase,
        elapsed_ms: Date.now() - startedAt,
      },
    });
    report(describeProgress('done'));
    return generated;
  };

  report(describeProgress('starting'));
  const nativeGenerator = tryGetCryptidGenerator();
  if (!nativeGenerator) {
    return finishLocal('This build has no on-device model bridge.');
  }

  const subscription =
    typeof nativeGenerator.addListener === 'function'
      ? nativeGenerator.addListener('onGenerationProgress', (event) => {
          report(progressFromNativeEvent(event));
        })
      : null;

  const traits: CryptidTraits = pickTraits(normalizedDescription, normalizedSeed);
  let best: ScoredCandidate | null = null;

  try {
    report(describeProgress('checkingModel'));
    const availability = await nativeGenerator.availability();
    if (availability === 'unavailable') {
      return finishLocal("This phone's system model is unavailable.");
    }
    if (availability === 'downloadable') {
      report(describeProgress('downloadingModel'));
    }

    const legacyDescription = normalizedDescription || 'an unknown city cryptid';
    let spec = buildDraftPrompt(normalizedDescription, normalizedSeed, traits, {
      candidateCount: options.candidateCount,
    });

    // Round 1 drafts, round 2 repairs. Two rounds is the whole budget: more than that and the wait
    // stops being defensible on a phone that is already slow on its first inference.
    for (let round = 1; round <= 2; round += 1) {
      const candidates = await requestCandidates(nativeGenerator, spec, legacyDescription);
      report(describeProgress('scoring', { attempt: spec.attempt }));
      const roundBest = selectBestCandidate(candidates);
      if (roundBest && (!best || roundBest.score > best.score)) best = roundBest;

      recordEventLog({
        category: 'generator',
        action: 'generator.round',
        summary: `Round ${round} scored ${candidates.length} sketch(es)`,
        status: 'ok',
        details: {
          round,
          candidates: candidates.length,
          best_score: best ? Number(best.score.toFixed(3)) : null,
          repeated: best?.repeated ?? null,
          defects: best?.report.defects.slice(0, 3) ?? [],
        },
      });

      if (best && best.score >= ICON_SHAPE_ACCEPT_SCORE) break;
      if (round === 2) break;

      report(
        describeProgress('repairing', {
          detail: best?.report.defects[0] ?? 'The first sketches were not icon shaped.',
          attempt: spec.attempt + 1,
        })
      );
      spec = buildRepairPrompt(spec, best?.report.sigil ?? '', best?.report.defects ?? []);
    }

    if (!best || best.score < ICON_SHAPE_ACCEPT_SCORE) {
      return finishLocal(
        best
          ? `The model's best sketch was not icon shaped: ${
              best.report.defects[0] ?? 'it did not fit the tile'
            }.`
          : 'The model did not return a usable drawing.',
        best?.name ?? null
      );
    }

    report(describeProgress('checkingArt'));
    const validated = validateGeneratedCryptid(
      { name: usableModelName(best.name) ?? best.name, sigil: best.report.sigil },
      'system'
    );
    rememberSigil(best.report.sigil);
    recordEventLog({
      category: 'generator',
      action: 'generator.result',
      summary: `System model drew "${validated.name}"`,
      status: 'ok',
      details: {
        source: 'system',
        score: Number(best.report.score.toFixed(3)),
        lines: best.report.features.lines,
        columns: best.report.features.columns,
        elapsed_ms: Date.now() - startedAt,
      },
    });
    report(describeProgress('done'));
    return { ...validated, shapeScore: best.report.score };
  } catch (error: unknown) {
    const reason = errorMessageOf(error);
    recordEventLog({
      level: 'error',
      category: 'generator',
      action: 'generator.error',
      summary: `System model failed during ${lastPhase}: ${reason}`,
      status: 'error',
      details: { phase: lastPhase, error: reason, elapsed_ms: Date.now() - startedAt },
    });
    return finishLocal(reason, best?.name ?? null);
  } finally {
    subscription?.remove();
  }
}
