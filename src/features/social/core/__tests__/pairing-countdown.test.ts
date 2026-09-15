import {
  BUMP_SEARCH_DURATION_MS,
  pairingSearchProgress,
  secondsRemaining,
} from '../pairing-countdown';

describe('pairing countdown', () => {
  it('makes one sweep over the entire native search window', () => {
    const start = 1_700_000_000_000;
    expect(pairingSearchProgress(start, start)).toBe(0);
    expect(pairingSearchProgress(start, start + BUMP_SEARCH_DURATION_MS / 4)).toBe(0.25);
    expect(pairingSearchProgress(start, start + BUMP_SEARCH_DURATION_MS / 2)).toBe(0.5);
    expect(pairingSearchProgress(start, start + BUMP_SEARCH_DURATION_MS)).toBe(1);
  });

  it('does not wrap or restart after a delayed tick or a foreground resume', () => {
    expect(pairingSearchProgress(10_000, 19_000)).toBe(0.75);
    expect(pairingSearchProgress(10_000, 34_000)).toBe(1);
    expect(pairingSearchProgress(34_000, 34_000)).toBe(0);
  });

  it('clamps missing starts and clocks before the search begins', () => {
    expect(pairingSearchProgress(null, 10_000)).toBe(0);
    expect(pairingSearchProgress(undefined, 10_000)).toBe(0);
    expect(pairingSearchProgress(20_000, 10_000)).toBe(0);
  });

  it('keeps a link live through its final fractional second, then expires exactly', () => {
    expect(secondsRemaining(120_000, 0)).toBe(120);
    expect(secondsRemaining(120_000, 119_001)).toBe(1);
    expect(secondsRemaining(120_000, 119_999)).toBe(1);
    expect(secondsRemaining(120_000, 120_000)).toBe(0);
    expect(secondsRemaining(120_000, 150_000)).toBe(0);
    expect(secondsRemaining(null, 0)).toBe(0);
  });
});
