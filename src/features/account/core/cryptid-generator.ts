import {
  tryGetCryptidGenerator,
  type CryptidGenerationProgressEvent,
  type NativeGeneratedCryptid,
} from 'cryptid-generator';

import { recordEventLog } from '@/features/dev/telemetry';
import { CRYPTID_FORMS, EYES, MOUTHS, type CryptidForm } from './cryptid-forms';
import { DEFAULT_SIGNAL_COLOR, normalizeAsciiArt, validateCryptidProfileFields } from './profile';
import { repairCryptidName, repairSigil, sigilHasEnoughInk } from './sigil-repair';

const MAX_DESCRIPTION_LENGTH = 160;
const MAX_NATIVE_SEED = 2_147_483_647;

export type CryptidGenerationSource = 'system' | 'local';

export interface GeneratedCryptid {
  name: string;
  sigil: string;
  source: CryptidGenerationSource;
  /** Set when the system model was skipped or failed and the offline maker took over. */
  fallbackReason?: string;
  /** What had to be cleaned up before the model's art fit the tile. Empty when it arrived clean. */
  repairs?: readonly string[];
}

const PREFIXES = ['Quiet', 'Fog', 'Moss', 'Night', 'Rain', 'Alley', 'Signal', 'Ash'] as const;

const PREFIX_KEYWORDS: readonly [readonly string[], string][] = [
  [['rain', 'storm', 'wet'], 'Rain'],
  [['fog', 'mist', 'haze'], 'Fog'],
  [['moss', 'green', 'forest'], 'Moss'],
  [['night', 'dark', 'moon'], 'Night'],
  [['city', 'street', 'alley'], 'Alley'],
  [['quiet', 'shy', 'gentle'], 'Quiet'],
];

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pick<T>(values: readonly T[], hash: number, shift: number): T {
  return values[(hash >>> shift) % values.length];
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  return Math.max(1, Math.trunc(Math.abs(seed)) % MAX_NATIVE_SEED);
}

export function normalizeCryptidDescription(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_LENGTH);
}

/**
 * The creature whose keywords the description names, or one picked off the hash.
 *
 * First match in roster order wins, so a description matching two creatures gets
 * the earlier one rather than an arbitrary one.
 */
function matchingForm(description: string, hash: number): CryptidForm {
  return (
    CRYPTID_FORMS.find((candidate) =>
      candidate.keywords.some((keyword) => description.includes(keyword))
    ) ?? pick(CRYPTID_FORMS, hash, 0)
  );
}

function generatedName(description: string, form: CryptidForm, hash: number): string {
  const keywordPrefix = PREFIX_KEYWORDS.find(([keywords]) =>
    keywords.some((keyword) => description.includes(keyword))
  )?.[1];
  const prefix = keywordPrefix ?? pick(PREFIXES, hash, 8);
  return `${prefix} ${form.creature}`;
}

/**
 * Repairs the model's output, then checks it against the profile grid.
 *
 * Repair runs only for `system` output: the offline maker's art is authored, already fits, and
 * should be passed through byte for byte. Anything the system model produced is best effort, so
 * it gets cleaned up first and is only rejected when there is no drawing left to salvage.
 */
export function validateGeneratedCryptid(
  value: NativeGeneratedCryptid,
  source: CryptidGenerationSource
): GeneratedCryptid {
  const repairedName = source === 'system' ? repairCryptidName(value.name) : null;
  const repairedSigil = source === 'system' ? repairSigil(value.sigil) : null;
  const name = repairedName?.name ?? value.name.trim();
  const sigil = repairedSigil?.sigil ?? normalizeAsciiArt(value.sigil);
  const repairs = [...(repairedName?.repairs ?? []), ...(repairedSigil?.repairs ?? [])];

  // Checked before the grid rules so a drawing that repaired down to nothing explains itself,
  // rather than telling the user to "choose a profile icon" as the reason the model failed.
  const salvageIssues: string[] = [];
  if (source === 'system') {
    if (name.length === 0) salvageIssues.push('The model did not name the cryptid.');
    if (!sigilHasEnoughInk(sigil)) {
      salvageIssues.push('The drawing was mostly characters that cannot be shown.');
    }
  }

  const issues = validateCryptidProfileFields({
    handle: 'generator',
    cryptidName: name,
    sigil,
    color: DEFAULT_SIGNAL_COLOR,
    presetId: null,
  });
  const generationIssues =
    salvageIssues.length > 0 ? salvageIssues : [...issues.cryptidName, ...issues.sigil];
  if (generationIssues.length > 0) {
    throw new Error(
      `The on-device generator made an icon that does not fit the profile grid. ${generationIssues.join(
        ' '
      )}`
    );
  }
  return repairs.length > 0 ? { name, sigil, source, repairs } : { name, sigil, source };
}

export function generateLocalCryptid(
  description: string,
  seed: number,
  fallbackReason?: string
): GeneratedCryptid {
  const normalizedDescription = normalizeCryptidDescription(description).toLowerCase();
  const normalizedSeed = normalizeSeed(seed);
  const hash = hashString(`${normalizedDescription || 'surprise'}:${normalizedSeed}`);
  const form = matchingForm(normalizedDescription, hash);
  const eyes = pick(EYES, hash, 4);
  const mouth = pick(MOUTHS, hash, 12);

  const generated = validateGeneratedCryptid(
    {
      name: generatedName(normalizedDescription, form, hash),
      sigil: form.render(eyes[0], eyes[1], mouth),
    },
    'local'
  );
  return fallbackReason ? { ...generated, fallbackReason } : generated;
}

/**
 * Phases of the icon pipeline, in the order they usually happen. `downloadingModel` and
 * `fallback` are conditional. Native phases are mirrored from the Expo module so the dialog can
 * distinguish "downloading a multi-hundred-megabyte model" from "actually running inference".
 */
export type CryptidGenerationPhase =
  | 'starting'
  | 'checkingModel'
  | 'downloadingModel'
  | 'preparingModel'
  | 'generating'
  | 'formatting'
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
  /** 1-based inference attempt; the model gets one tighter retry. */
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
  checkingArt: 'Checking it fits the profile tile...',
  fallback: 'Switching to the offline icon maker...',
  done: 'Done',
};

const PHASE_DETAILS: Partial<Record<CryptidGenerationPhase, string>> = {
  checkingModel: 'Asking the system whether an on-device model is ready.',
  downloadingModel: 'The system model downloads once, then stays on this phone.',
  preparingModel: 'The first run after a reboot is the slow one.',
  generating: 'Inference runs entirely on this phone.',
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

export interface GenerateCryptidOptions {
  onProgress?: CryptidGenerationProgressListener;
}

/**
 * Runs the icon pipeline and narrates it through `onProgress`. The system model is best effort:
 * when it is missing, still downloading, or fails (for example when it writes past its context
 * window), the offline maker produces an icon and the reason travels back on `fallbackReason`.
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

  const finishLocal = (reason: string): GeneratedCryptid => {
    report(describeProgress('fallback', { detail: reason }));
    const generated = generateLocalCryptid(normalizedDescription, normalizedSeed, reason);
    recordEventLog({
      level: 'warn',
      category: 'generator',
      action: 'generator.fallback',
      summary: `Offline icon maker used: ${reason}`,
      status: 'ok',
      details: { reason, phase: lastPhase, elapsed_ms: Date.now() - startedAt },
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

  try {
    report(describeProgress('checkingModel'));
    const availability = await nativeGenerator.availability();
    if (availability === 'unavailable') {
      return finishLocal("This phone's system model is unavailable.");
    }
    if (availability === 'downloadable') {
      report(describeProgress('downloadingModel'));
    }

    const generated = await nativeGenerator.generate(
      normalizedDescription || 'an unknown city cryptid',
      normalizedSeed
    );
    report(describeProgress('checkingArt'));
    const validated = validateGeneratedCryptid(generated, 'system');
    recordEventLog({
      category: 'generator',
      action: 'generator.result',
      summary: `System model drew "${validated.name}"`,
      status: 'ok',
      details: {
        source: 'system',
        repairs: validated.repairs ?? [],
        elapsed_ms: Date.now() - startedAt,
      },
    });
    report(describeProgress('done'));
    return validated;
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
    return finishLocal(reason);
  } finally {
    subscription?.remove();
  }
}
