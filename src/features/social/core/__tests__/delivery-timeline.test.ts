import { STASH_RETENTION_MS, type DeliveryMode } from '../delivery-mode';
import {
  REDUCED_MOTION_FRAME,
  beatAt,
  buildDeliveryScene,
  formatCountdown,
  type DeliveryScene,
} from '../delivery-timeline';

const SIZE = { width: 330, height: 340 };

const at = (mode: DeliveryMode, t: number): DeliveryScene => buildDeliveryScene(mode, t, SIZE);
const payload = (scene: DeliveryScene, key: string) =>
  scene.payloads.find((item) => item.key === key);
const phone = (scene: DeliveryScene, id: string) => scene.phones.find((item) => item.id === id);

describe('buildDeliveryScene', () => {
  it('wraps time so a loop never renders an empty frame', () => {
    expect(at('direct', 1).beat).toEqual(at('direct', 0).beat);
    expect(at('direct', -0.25).beat).toEqual(at('direct', 0.75).beat);
    expect(at('stash', 2.5).beat).toEqual(at('stash', 0.5).beat);
  });

  it('keeps every phone inside the stage', () => {
    for (const mode of ['direct', 'mutual', 'stash'] as const) {
      for (const t of [0, 0.25, 0.5, 0.75, 0.99]) {
        for (const item of at(mode, t).phones) {
          expect(item.rect.x).toBeGreaterThanOrEqual(0);
          expect(item.rect.y).toBeGreaterThanOrEqual(0);
          expect(item.rect.x + item.rect.w).toBeLessThanOrEqual(SIZE.width);
          // Room is left under each phone for its label.
          expect(item.rect.y + item.rect.h).toBeLessThanOrEqual(SIZE.height);
        }
      }
    }
  });
});

describe('direct', () => {
  it('loses the first attempt before it arrives, then lands a retry', () => {
    const failing = at('direct', 0.36);
    expect(payload(failing, 'first')?.scatter).toBeGreaterThan(0);
    expect(payload(failing, 'arrived')).toBeUndefined();

    const delivered = at('direct', 0.9);
    expect(payload(delivered, 'arrived')?.resolve).toBeGreaterThan(0.5);
    expect(delivered.beat.word).toBe('DELIVERED');
  });

  it('never involves anything but the two phones', () => {
    for (const t of [0, 0.3, 0.6, 0.9]) {
      const scene = at('direct', t);
      expect(scene.phones).toHaveLength(2);
      expect(scene.slab).toBeNull();
      expect(scene.countdownMs).toBeNull();
    }
  });
});

describe('mutual', () => {
  it('holds the payload on the mutual while the friend is dark', () => {
    const dark = at('mutual', 0.4);
    expect(phone(dark, 'friend')?.off).toBe(true);
    expect(payload(dark, 'held')).toBeDefined();
    expect(payload(dark, 'arrived')).toBeUndefined();
  });

  it('delivers only after she wakes, never before', () => {
    // The whole claim of the mode: the relayed copy lands because she came back, not despite it.
    expect(phone(at('mutual', 0.8), 'friend')?.off).toBe(false);
    expect(payload(at('mutual', 0.85), 'arrived')?.resolve).toBeGreaterThan(0);
    expect(payload(at('mutual', 0.45), 'arrived')).toBeUndefined();
  });

  it('closes the circle over the mutual set at the end', () => {
    expect(at('mutual', 0.5).circle).toBeNull();
    expect(at('mutual', 0.95)?.circle?.alpha).toBeGreaterThan(0);
  });
});

describe('stash', () => {
  it('runs the clock only while a copy is actually being held', () => {
    expect(at('stash', 0.2).countdownMs).toBeNull();
    expect(at('stash', 0.6).countdownMs).toBeGreaterThan(0);
  });

  it('starts the hold at the full retention window and reaches zero', () => {
    const started = at('stash', 0.6).countdownMs ?? -1;
    expect(started).toBeCloseTo(STASH_RETENTION_MS, -3);
    expect(at('stash', 0.99).countdownMs).toBe(0);
  });

  it('expires the held copy as the clock runs out, not before', () => {
    expect(payload(at('stash', 0.7), 'holding')?.alpha).toBeGreaterThan(0.5);
    const expired = at('stash', 0.999);
    expect(expired.countdownMs).toBe(0);
    expect(expired.payloads.find((item) => item.key === 'holding')?.alpha ?? 0).toBeLessThan(0.05);
  });

  it('names the server, so nobody has to infer that a third party is involved', () => {
    expect(at('stash', 0.6).slab?.label).toBe('STASH SERVER');
  });
});

describe('sealed versus opened', () => {
  it('only ever opens a payload at its intended recipient', () => {
    for (const mode of ['direct', 'mutual', 'stash'] as const) {
      for (let i = 0; i < 100; i++) {
        const scene = at(mode, i / 100);
        for (const item of scene.payloads) {
          // A carrier holds ciphertext. `holding` (the stash) and `held` (a mutual) must never
          // resolve — that is the privacy claim the picture is making.
          if (item.key === 'holding' || item.key === 'held' || item.key === 'to-stash') {
            expect(item.resolve).toBe(0);
          }
        }
      }
    }
  });
});

describe('beatAt', () => {
  it('reports a step for every instant of the loop', () => {
    for (const mode of ['direct', 'mutual', 'stash'] as const) {
      for (let i = 0; i < 100; i++) {
        const beat = beatAt(mode, i / 100);
        expect(beat.word).not.toBe('');
        expect(beat.index).toBeGreaterThanOrEqual(0);
        expect(beat.index).toBeLessThan(beat.total);
      }
    }
  });
});

describe('reduced motion', () => {
  it('freezes each mode on a frame that states its outcome', () => {
    expect(beatAt('direct', REDUCED_MOTION_FRAME.direct).word).toBe('DELIVERED');
    expect(beatAt('mutual', REDUCED_MOTION_FRAME.mutual).word).toBe('MUTUALS');
    // The stash's true resting state is a copy being held with time left on it.
    expect(at('stash', REDUCED_MOTION_FRAME.stash).countdownMs).toBeGreaterThan(0);
  });
});

describe('formatCountdown', () => {
  it('is always mm:ss so the digits do not jump', () => {
    expect(formatCountdown(STASH_RETENTION_MS)).toBe('30:00');
    expect(formatCountdown(61_000)).toBe('01:01');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5)).toBe('00:00');
  });
});
