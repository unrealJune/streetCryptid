/**
 * The delivery diagram, as data.
 *
 * Each mode is a loop over normalised time `t ∈ [0, 1)` that tells one true story about how a
 * sealed envelope gets from your phone to a friend's: mutual relay survives your friend going
 * dark, and the stash holds a copy until she comes back and then drops it. The point of
 * animating any of this is that the failure is the interesting part, and a still frame cannot
 * show a failure — only its aftermath.
 *
 * This module is pure geometry and pure timing: no Skia, no React, no theme. It exists apart
 * from the renderer so the thing worth being sure about — that the stash countdown really
 * reaches zero, that the relayed payload really arrives only after the dark phone wakes — is
 * testable without a canvas. {@link DeliveryStage} draws whatever this returns.
 *
 * Ported from the `Delivery Systems.dc.html` design canvas, whose timings are kept verbatim so
 * the shipped screen and the design stay comparable frame for frame.
 */

import { STASH_RETENTION_MS, type DeliveryMode } from './delivery-mode';

export interface StageSize {
  readonly width: number;
  readonly height: number;
}

export interface StageRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface StagePoint {
  readonly x: number;
  readonly y: number;
}

/** A device in the diagram. */
export interface PhoneNode {
  readonly id: string;
  readonly rect: StageRect;
  readonly label: string;
  /** Screen dead: dark face, dashed edge, one flat line. The friend is off the network. */
  readonly off: boolean;
  /** 0→1 as the lattice relights column by column after {@link off} lifts. */
  readonly wake: number;
  /** Edge glow, 0→1. Used for "something just happened here". */
  readonly lit: boolean | number;
  /** Rendered at half weight — reachable in principle, not answering. */
  readonly dim: boolean;
}

/**
 * One encrypted packet. `resolve` is the only state that means "opened": a sealed payload is a
 * hairline square holding four loose dots, an opened one is solid with a single cut-out. The
 * distinction carries the whole privacy claim of the screen, so it is never merely a colour.
 */
export interface PayloadNode {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly alpha: number;
  /** 0 sealed → 1 opened by its intended recipient. */
  readonly resolve: number;
  /** 0 intact → 1 coming apart, for a delivery that failed. */
  readonly scatter: number;
  readonly seed: number;
}

export interface RouteEdge {
  readonly key: string;
  readonly from: StagePoint;
  readonly to: StagePoint;
  /** 0→1. Drives opacity only: a route is a possibility, never a pipe with contents. */
  readonly strength: number;
}

/** The stash server slab. Only present in `stash`. */
export interface SlabNode {
  readonly rect: StageRect;
  readonly label: string;
  /** Whether it is currently holding something. */
  readonly holding: boolean;
}

/** The ring that closes over the whole scene once the mutual circle has caught up. */
export interface CircleNode {
  readonly center: StagePoint;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly alpha: number;
}

export interface StageBeat {
  /** Uppercase micro-label — the current step, in the diagram's own vocabulary. */
  readonly word: string;
  readonly index: number;
  readonly total: number;
}

export interface DeliveryScene {
  readonly mode: DeliveryMode;
  readonly phones: readonly PhoneNode[];
  readonly payloads: readonly PayloadNode[];
  readonly routes: readonly RouteEdge[];
  readonly slab: SlabNode | null;
  readonly circle: CircleNode | null;
  /** Milliseconds left on the stash's hold, or null when nothing is being held. */
  readonly countdownMs: number | null;
  readonly beat: StageBeat;
}

const BEATS: Readonly<Record<DeliveryMode, readonly (readonly [number, string])[]>> = {
  mutual: [
    [0.28, 'SENDING'],
    [0.44, 'OFFLINE'],
    [0.54, 'RESUMED'],
    [0.78, 'RELAYING'],
    [0.88, 'CAUGHT UP'],
    [1.01, 'MUTUALS'],
  ],
  stash: [
    [0.12, 'ENCRYPT'],
    [0.3, 'STASHED'],
    [0.42, 'HOLDING'],
    [0.62, 'FETCHING'],
    [0.74, 'DELIVERED'],
    [0.92, 'HOLDING'],
    [1.01, 'EXPIRED'],
  ],
};

/**
 * Where each loop should be frozen when the OS asks for reduced motion.
 *
 * Not 0, and not the same number for every mode: a frozen diagram still has to be a true
 * picture of what the mode does, so each one stops on the frame that states its outcome —
 * delivered, caught up, held on the server with time on the clock.
 */
export const REDUCED_MOTION_FRAME: Readonly<Record<DeliveryMode, number>> = {
  mutual: 0.93,
  stash: 0.8,
};

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/** Normalised progress through the window `[a, b]`, clamped at both ends. */
export const seg = (t: number, a: number, b: number): number => clamp((t - a) / (b - a), 0, 1);

/** The design system's one entrance curve, as a scalar ease-out. */
export const ease = (p: number): number => 1 - Math.pow(1 - p, 3);

export function beatAt(mode: DeliveryMode, t: number): StageBeat {
  const list = BEATS[mode];
  for (let i = 0; i < list.length; i++) {
    if (t < list[i][0]) return { word: list[i][1], index: i, total: list.length };
  }
  const last = list.length - 1;
  return { word: list[last][1], index: last, total: list.length };
}

function centerOf(rect: StageRect): StagePoint {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/**
 * Three phones. Yours, a mutual's, and a friend who is dark for the first half. What you send
 * her directly is lost; what the mutual is holding reaches her the moment she comes back.
 */
function mutualScene(t: number, size: StageSize): DeliveryScene {
  const pw = 80;
  const ph = Math.min(154, (size.height - 60) / 2);
  const m: StageRect = { x: (size.width - pw) / 2, y: 6, w: pw, h: ph };
  const a: StageRect = { x: 4, y: size.height - ph - 34, w: pw, h: ph };
  const b: StageRect = { x: size.width - 4 - pw, y: size.height - ph - 34, w: pw, h: ph };
  const cm = centerOf(m);
  const ca = centerOf(a);
  const cb = centerOf(b);
  const off = t < 0.46;
  const arrived = t >= 0.78;

  const payloads: PayloadNode[] = [];
  // You → mutual, held sealed while she is unreachable.
  if (t < 0.26) {
    const p = ease(seg(t, 0.02, 0.24));
    payloads.push({
      key: 'to-mutual',
      x: ca.x + (cm.x - ca.x) * p,
      y: ca.y + (cm.y - ca.y) * p,
      scale: 1.05,
      alpha: seg(t, 0, 0.05),
      resolve: 0,
      scatter: 0,
      seed: 2,
    });
  } else if (t < 0.58) {
    payloads.push({
      key: 'held',
      x: cm.x,
      y: cm.y,
      scale: 1.05,
      alpha: 1,
      resolve: 0,
      scatter: 0,
      seed: 2,
    });
  }
  // You → her, dropped: her phone is dark.
  if (t < 0.24) {
    const p = ease(seg(t, 0.02, 0.18));
    payloads.push({
      key: 'dropped',
      x: ca.x + (cb.x - ca.x) * p * 0.68,
      y: ca.y - Math.sin(p * Math.PI) * 10,
      scale: 1.05,
      alpha: seg(t, 0, 0.05),
      resolve: 0,
      scatter: seg(t, 0.14, 0.24),
      seed: 6,
    });
  }
  // Mutual → her, once she is back.
  if (t >= 0.56 && t < 0.84) {
    const p = ease(seg(t, 0.56, 0.78));
    payloads.push({
      key: 'relayed',
      x: cm.x + (cb.x - cm.x) * p,
      y: cm.y + (cb.y - cm.y) * p,
      scale: 1.05,
      alpha: 1 - seg(t, 0.76, 0.84),
      resolve: 0,
      scatter: 0,
      seed: 2,
    });
  }
  if (arrived) {
    payloads.push({
      key: 'arrived',
      x: cb.x,
      y: cb.y,
      scale: 1.2,
      alpha: 1,
      resolve: ease(seg(t, 0.78, 0.88)),
      scatter: 0,
      seed: 2,
    });
  }

  const circleP = t >= 0.88 ? ease(seg(t, 0.88, 0.97)) : 0;

  return {
    mode: 'mutual',
    phones: [
      { id: 'you', rect: a, label: 'YOU', off: false, wake: 1, dim: false, lit: 0 },
      {
        id: 'mutual',
        rect: m,
        label: 'MUTUAL',
        off: false,
        wake: 1,
        dim: false,
        lit: t > 0.24 && t < 0.62 ? 0.45 : 0,
      },
      {
        id: 'friend',
        rect: b,
        label: 'MAYA',
        off,
        wake: ease(seg(t, 0.46, 0.58)),
        dim: false,
        lit: arrived ? 0.7 : 0,
      },
    ],
    routes: [
      { key: 'a-m', from: ca, to: cm, strength: seg(t, 0.02, 0.24) },
      { key: 'm-b', from: cm, to: cb, strength: t > 0.56 ? seg(t, 0.56, 0.78) : 0.04 },
      {
        key: 'a-b',
        from: ca,
        to: cb,
        strength: off ? 0.04 * (1 - seg(t, 0.14, 0.22)) : 0.02,
      },
    ],
    payloads,
    slab: null,
    circle:
      circleP > 0
        ? {
            center: { x: size.width / 2, y: size.height / 2 - 4 },
            radiusX: (size.width / 2 - 2) * circleP,
            radiusY: (size.height / 2 - 4) * circleP,
            alpha: 0.42 * circleP,
          }
        : null,
    countdownMs: null,
    beat: beatAt('mutual', t),
  };
}

/**
 * The stash. The first hop goes straight there and lands; the second finds her dark, so the
 * sealed copy waits on the server with a clock on it until she is back — then the copy expires.
 */
function stashScene(t: number, size: StageSize): DeliveryScene {
  const pw = 80;
  const ph = Math.min(154, (size.height - 60) / 2);
  const sw = 152;
  const sh = 78;
  const slabRect: StageRect = { x: (size.width - sw) / 2, y: 8, w: sw, h: sh };
  const cs = centerOf(slabRect);
  const a: StageRect = { x: 4, y: size.height - ph - 34, w: pw, h: ph };
  const b: StageRect = { x: size.width - 4 - pw, y: size.height - ph - 34, w: pw, h: ph };
  const ca = centerOf(a);
  const cb = centerOf(b);
  const dropIn: StagePoint = { x: cs.x - 30, y: cs.y + sh / 2 };
  const dropOut: StagePoint = { x: cs.x + 30, y: cs.y + sh / 2 };

  const off = t >= 0.32 && t < 0.62;
  const directArrived = t >= 0.18 && t < 0.32;
  const stashArrived = t >= 0.86;
  const stashed = t >= 0.58;

  const payloads: PayloadNode[] = [];
  // Hop 1 — straight to her, and it lands.
  if (t < 0.32) {
    const p = ease(seg(t, 0.02, 0.18));
    payloads.push({
      key: 'hop1',
      x: ca.x + (cb.x - ca.x) * p,
      y: ca.y - Math.sin(p * Math.PI) * 14,
      scale: 1.2,
      alpha: seg(t, 0, 0.05) * (1 - seg(t, 0.28, 0.32)),
      resolve: ease(seg(t, 0.18, 0.26)),
      scatter: 0,
      seed: 3,
    });
  }
  // Hop 2 — direct fails, she is dark.
  if (t >= 0.34 && t < 0.48) {
    const p = ease(seg(t, 0.34, 0.44));
    payloads.push({
      key: 'hop2-failed',
      x: ca.x + (cb.x - ca.x) * p * 0.6,
      y: ca.y - Math.sin(p * Math.PI) * 12,
      scale: 1.2,
      alpha: seg(t, 0.34, 0.37),
      resolve: 0,
      scatter: seg(t, 0.42, 0.48),
      seed: 5,
    });
  }
  // …so it goes to the stash instead.
  if (t >= 0.46 && t < 0.62) {
    const p = ease(seg(t, 0.46, 0.58));
    payloads.push({
      key: 'to-stash',
      x: ca.x + (dropIn.x - ca.x) * p,
      y: ca.y + (dropIn.y - ca.y) * p,
      scale: 1.05,
      alpha: seg(t, 0.46, 0.5) * (1 - seg(t, 0.56, 0.6)),
      resolve: 0,
      scatter: 0,
      seed: 7,
    });
  }
  // Held on the server, sealed, until it expires.
  if (stashed) {
    payloads.push({
      key: 'holding',
      x: cs.x,
      y: cs.y,
      scale: 1.05,
      alpha: seg(t, 0.58, 0.62) * (1 - seg(t, 0.94, 1)),
      resolve: 0,
      scatter: 0,
      seed: 7,
    });
  }
  // Stash → her, when she is back.
  if (t >= 0.68 && t < 0.92) {
    const p = ease(seg(t, 0.68, 0.86));
    payloads.push({
      key: 'from-stash',
      x: dropOut.x + (cb.x - dropOut.x) * p,
      y: dropOut.y + (cb.y - dropOut.y) * p,
      scale: 1.05,
      alpha: 1 - seg(t, 0.84, 0.92),
      resolve: 0,
      scatter: 0,
      seed: 7,
    });
  }
  if (stashArrived) {
    payloads.push({
      key: 'arrived',
      x: cb.x,
      y: cb.y,
      scale: 1.2,
      alpha: 1,
      resolve: ease(seg(t, 0.86, 0.94)),
      scatter: 0,
      seed: 7,
    });
  }

  return {
    mode: 'stash',
    phones: [
      { id: 'you', rect: a, label: 'YOU', off: false, wake: 1, dim: false, lit: 0 },
      {
        id: 'friend',
        rect: b,
        label: 'MAYA',
        off,
        wake: ease(seg(t, 0.62, 0.72)),
        dim: false,
        lit: directArrived || stashArrived ? 0.7 : 0,
      },
    ],
    routes: [
      {
        key: 'a-b',
        from: ca,
        to: cb,
        strength: t < 0.32 ? seg(t, 0.02, 0.18) : 0.04 * (1 - seg(t, 0.4, 0.48)),
      },
      { key: 'a-stash', from: ca, to: dropIn, strength: t >= 0.46 ? seg(t, 0.46, 0.6) : 0.03 },
      { key: 'stash-b', from: dropOut, to: cb, strength: t >= 0.68 ? seg(t, 0.68, 0.86) : 0.03 },
    ],
    payloads,
    slab: { rect: slabRect, label: 'STASH SERVER', holding: stashed },
    circle: null,
    // The clock runs only while something is actually being held, and reaches zero exactly as
    // the held copy finishes fading — the expiry and the disappearance are the same event.
    countdownMs: stashed ? Math.max(0, STASH_RETENTION_MS * (1 - seg(t, 0.6, 0.98))) : null,
    beat: beatAt('stash', t),
  };
}

/** Build the whole diagram for one mode at one instant. Pure. */
export function buildDeliveryScene(mode: DeliveryMode, t: number, size: StageSize): DeliveryScene {
  const wrapped = ((t % 1) + 1) % 1;
  return mode === 'stash' ? stashScene(wrapped, size) : mutualScene(wrapped, size);
}

/** `mm:ss`, for the stash hold. Tabular by construction — both fields are always two digits. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
