import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { isPairingFigureIndex, pairingFigure, type PairingFigure } from '../core/pairing-figures';
import type { PairingVerification } from '../net/location-sharing';

/** What the screen should be showing. `invalid` fails closed: no confirm path is offered. */
export type PairingVerificationMode = 'pick' | 'show' | 'waiting' | 'invalid';

export interface PairingVerificationState {
  readonly verification: PairingVerification | null;
  readonly mode: PairingVerificationMode | null;
  /** The figure this phone is displaying, once the challenge is known to be well formed. */
  readonly target: PairingFigure | null;
  /** The four candidates this phone must choose between. Empty unless `mode` is `pick`. */
  readonly options: readonly PairingFigure[];
  readonly status: string;
  readonly detail: string;
  /** `m:ss`, or `EXPIRED`, or `--:--` before the first clock tick lands. */
  readonly clock: string;
  readonly expired: boolean;
  /** True while an action is in flight, the window has closed, or this phone already answered. */
  readonly disabled: boolean;
  /** Verifications behind this one, waiting their turn. */
  readonly queued: number;
  choose(figureIndex: number): void;
  confirm(matched: boolean): void;
  cancel(): void;
}

interface PairingVerificationHandlers {
  onChoose(sessionId: string, figureIndex: number): Promise<void>;
  onConfirm(sessionId: string, matched: boolean): Promise<void>;
  onCancel(sessionId: string): Promise<void>;
}

function secondsRemaining(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

function formatRemaining(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * A picker challenge is only usable if it is exactly the shape `streetcryptid/pair/2` promises:
 * four distinct catalog figures, one of which is the target. Anything else is a malformed or
 * hostile challenge and must not be answerable.
 */
function isValidPickerChallenge(verification: PairingVerification): boolean {
  return (
    verification.optionIndices.length === 4 &&
    new Set(verification.optionIndices).size === 4 &&
    verification.optionIndices.includes(verification.targetIndex) &&
    verification.optionIndices.every(isPairingFigureIndex)
  );
}

async function selectionHaptic(): Promise<void> {
  try {
    await Haptics.selectionAsync();
  } catch {
    // The visual verification remains authoritative when haptics are unavailable.
  }
}

/**
 * The visual pairing check, as one source of truth.
 *
 * The check occupies two separate zones of the pairing screen — the figures sit in the stage,
 * the prompt and its buttons sit in the bottom panel — and both must agree about the clock,
 * about whether an action is already in flight, and about whether the challenge is answerable
 * at all. Deriving them from one hook is what keeps the panel from offering a confirm button
 * for a challenge the stage has refused to draw.
 */
export function usePairingVerification(
  verifications: readonly PairingVerification[],
  { onChoose, onConfirm, onCancel }: PairingVerificationHandlers
): PairingVerificationState {
  const verification = useMemo(
    () => [...verifications].sort((a, b) => a.deadlineMs - b.deadlineMs)[0] ?? null,
    [verifications]
  );
  const sessionId = verification?.sessionId ?? null;
  const [nowMs, setNowMs] = useState(0);
  const [workingSessionId, setWorkingSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const updateClock = () => setNowMs(Date.now());
    const initial = setTimeout(updateClock, 0);
    const timer = setInterval(updateClock, 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [sessionId]);

  const remaining =
    verification && nowMs !== 0 ? secondsRemaining(verification.deadlineMs, nowMs) : null;
  const expired = remaining === 0;
  const working = sessionId !== null && workingSessionId === sessionId;

  const run = useCallback(
    (action: (id: string) => Promise<void>, force = false): void => {
      if (!sessionId) return;
      if (!force && (working || expired || verification?.localConfirmed)) return;
      setWorkingSessionId(sessionId);
      void selectionHaptic()
        .then(() => action(sessionId))
        .finally(() => {
          setWorkingSessionId((current) => (current === sessionId ? null : current));
        });
    },
    [expired, sessionId, verification?.localConfirmed, working]
  );

  const choose = useCallback(
    (figureIndex: number) => run((id) => onChoose(id, figureIndex)),
    [onChoose, run]
  );
  const confirm = useCallback(
    (matched: boolean) => run((id) => onConfirm(id, matched)),
    [onConfirm, run]
  );
  // Stopping must stay available even once the window has closed or this phone has answered —
  // it is the only way out of a verification that will never complete.
  const cancel = useCallback(() => run((id) => onCancel(id), true), [onCancel, run]);

  return useMemo(() => {
    const idle: PairingVerificationState = {
      verification: null,
      mode: null,
      target: null,
      options: [],
      status: '',
      detail: '',
      clock: '--:--',
      expired: false,
      disabled: true,
      queued: 0,
      choose,
      confirm,
      cancel,
    };
    if (!verification) return idle;

    const targetValid = isPairingFigureIndex(verification.targetIndex);
    const pickerValid = verification.role !== 'picker' || isValidPickerChallenge(verification);
    const clock = expired ? 'EXPIRED' : remaining === null ? '--:--' : formatRemaining(remaining);
    const queued = Math.max(0, verifications.length - 1);

    if (!targetValid || !pickerValid) {
      return {
        ...idle,
        verification,
        mode: 'invalid',
        status: 'This verification signal is invalid.',
        detail:
          'Stop this attempt and start a fresh pairing. Friendship and location access were not granted.',
        clock,
        expired,
        queued,
      };
    }

    const mode: PairingVerificationMode = verification.localConfirmed
      ? 'waiting'
      : verification.role === 'picker'
        ? 'pick'
        : 'show';

    return {
      verification,
      mode,
      target: pairingFigure(verification.targetIndex),
      options:
        mode === 'pick' ? verification.optionIndices.map((index) => pairingFigure(index)) : [],
      status:
        mode === 'waiting'
          ? 'Waiting for the other phone'
          : mode === 'pick'
            ? 'Which figure is on their phone?'
            : 'Show them this figure',
      detail:
        mode === 'waiting'
          ? 'Keep both phones nearby. Pairing completes only after both people confirm.'
          : verification.nearby
            ? 'Compare the screens together before either person confirms.'
            : 'Compare over a trusted voice or video call before confirming.',
      clock,
      expired,
      disabled: working || expired || verification.localConfirmed,
      queued,
      choose,
      confirm,
      cancel,
    };
  }, [cancel, choose, confirm, expired, remaining, verification, verifications.length, working]);
}
