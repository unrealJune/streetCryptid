export const BUMP_SEARCH_DURATION_MS = 12_000;

export function secondsRemaining(deadlineMs: number | null | undefined, nowMs: number): number {
  if (deadlineMs == null || !Number.isFinite(deadlineMs)) return 0;
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/** Absolute service timestamps keep the sweep honest after navigation or backgrounding. */
export function pairingSearchProgress(
  startedAtMs: number | null | undefined,
  nowMs: number
): number {
  if (startedAtMs == null) return 0;
  return Math.max(0, Math.min(1, (nowMs - startedAtMs) / BUMP_SEARCH_DURATION_MS));
}
