/**
 * Dev-only benchmark for the icon pipeline.
 *
 * Prompt changes are impossible to judge by eyeballing two generations, so this runs a fixed
 * corpus of descriptions x seeds, scores everything with the same scorer the pipeline uses, and
 * reports the pass rate and mean score through the redacted event log (Settings -> event log) as
 * well as returning a summary for the caller to print.
 *
 * Nothing imports this from a production path; it exists to be called from a dev build.
 */

import { recordEventLog } from '@/features/dev/telemetry';
import { generateCryptid, type CryptidGenerationSource } from '../core/cryptid-generator';
import { ICON_SHAPE_ACCEPT_SCORE, scoreSigilShape } from '../core/sigil-shape';

/** Deliberately mixes descriptions that hit an archetype keyword with ones that do not. */
export const BENCH_DESCRIPTIONS: readonly string[] = [
  'a rain-soaked moth under a streetlight',
  'an antlered forest watcher',
  'a black hound made of smoke',
  'a shy lake thing with too many arms',
  'an owl that watches the bus stop',
  'a very tall night crawler',
  'a horned mountain cryptid',
  'a fog wisp in an alley',
  'something that lives in the parking garage',
  '',
];

export const BENCH_SEEDS: readonly number[] = [11, 2_027, 190_003];

export interface BenchRun {
  description: string;
  seed: number;
  source: CryptidGenerationSource;
  name: string;
  score: number;
  passed: boolean;
  elapsedMs: number;
  defects: string[];
}

export interface BenchSummary {
  runs: BenchRun[];
  total: number;
  /** Share of runs whose art came from the model and cleared the shape bar. */
  systemPassRate: number;
  meanScore: number;
  medianElapsedMs: number;
  bySource: Record<CryptidGenerationSource, number>;
  /** Distinct drawings over total runs — the novelty check. */
  distinctRate: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export interface RunBenchOptions {
  descriptions?: readonly string[];
  seeds?: readonly number[];
  candidateCount?: number;
  onRun?(run: BenchRun, index: number, total: number): void;
}

export async function runCryptidGeneratorBench(
  options: RunBenchOptions = {}
): Promise<BenchSummary> {
  const descriptions = options.descriptions ?? BENCH_DESCRIPTIONS;
  const seeds = options.seeds ?? BENCH_SEEDS;
  const total = descriptions.length * seeds.length;
  const runs: BenchRun[] = [];
  const sigils = new Set<string>();

  for (const description of descriptions) {
    for (const seed of seeds) {
      const startedAt = Date.now();
      const generated = await generateCryptid(description, seed, {
        candidateCount: options.candidateCount,
      });
      const report = scoreSigilShape(generated.sigil);
      const run: BenchRun = {
        description,
        seed,
        source: generated.source,
        name: generated.name,
        score: report.score,
        passed: generated.source === 'system' && report.score >= ICON_SHAPE_ACCEPT_SCORE,
        elapsedMs: Date.now() - startedAt,
        defects: report.defects,
      };
      sigils.add(generated.sigil);
      runs.push(run);
      options.onRun?.(run, runs.length, total);
      recordEventLog({
        level: 'debug',
        category: 'generator',
        action: 'generator.bench.run',
        summary: `${run.source} "${run.name}" scored ${run.score.toFixed(2)}`,
        status: run.passed ? 'ok' : 'error',
        details: {
          description: run.description,
          seed: run.seed,
          source: run.source,
          score: Number(run.score.toFixed(3)),
          elapsed_ms: run.elapsedMs,
          defects: run.defects.slice(0, 3),
        },
      });
    }
  }

  const bySource = runs.reduce<Record<string, number>>((counts, run) => {
    counts[run.source] = (counts[run.source] ?? 0) + 1;
    return counts;
  }, {});

  const summary: BenchSummary = {
    runs,
    total,
    systemPassRate: total > 0 ? runs.filter((run) => run.passed).length / total : 0,
    meanScore: runs.length > 0 ? runs.reduce((sum, run) => sum + run.score, 0) / runs.length : 0,
    medianElapsedMs: median(runs.map((run) => run.elapsedMs)),
    bySource: {
      system: bySource.system ?? 0,
      hybrid: bySource.hybrid ?? 0,
      local: bySource.local ?? 0,
    },
    distinctRate: total > 0 ? sigils.size / total : 0,
  };

  recordEventLog({
    category: 'generator',
    action: 'generator.bench.summary',
    summary: `Bench: ${(summary.systemPassRate * 100).toFixed(0)}% icon shaped from the model over ${total} runs`,
    status: 'ok',
    details: {
      total,
      pass_rate: Number(summary.systemPassRate.toFixed(3)),
      mean_score: Number(summary.meanScore.toFixed(3)),
      median_elapsed_ms: summary.medianElapsedMs,
      distinct_rate: Number(summary.distinctRate.toFixed(3)),
      ...summary.bySource,
    },
  });

  return summary;
}

/** One-line-per-metric report, suitable for a console or a dev screen. */
export function formatBenchSummary(summary: BenchSummary): string {
  return [
    `runs                ${summary.total}`,
    `icon-shaped (model) ${(summary.systemPassRate * 100).toFixed(0)}%`,
    `mean shape score    ${summary.meanScore.toFixed(3)}`,
    `median duration     ${summary.medianElapsedMs} ms`,
    `distinct drawings   ${(summary.distinctRate * 100).toFixed(0)}%`,
    `source system/hybrid/local  ${summary.bySource.system}/${summary.bySource.hybrid}/${summary.bySource.local}`,
  ].join('\n');
}
