/**
 * Geometry and timing for the first-launch splash (`components/onboarding-splash.tsx`).
 *
 * The splash is one animation: friends ping in from the screen's edges, every ring reaches the
 * sigil at about the same moment, you answer in amber (YOU before a profile exists, DESIGN.md),
 * the lattice clears and the sigil flips in row by row. Everything here is pure so the shape of
 * that animation, and the layout it plays over, can be pinned per screen size: a 5.4" outer
 * foldable display is ~680 pt tall and an iPad in landscape is wider than it is tall, and both
 * broke a layout drawn for a 390 x 844 phone.
 */

export interface SplashRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SplashLayout {
  /** Sigil beside the island rather than above it. */
  readonly landscape: boolean;
  readonly logoWidth: number;
  readonly logoHeight: number;
  readonly wordSize: number;
  readonly wordGap: number;
  readonly headingSize: number;
}

/** The sigil's artwork bounds in its 1024-unit source grid (`assets/images/mothman-logo.svg`). */
export const SIGIL_VIEWBOX = { x: 240, y: 255, width: 544, height: 516 } as const;

/** Where the lattice's dots sit, in points. Matches the design canvas. */
export const SPLASH_DOT_STEP = 15;

/** At most this many friends ping in: the shader has one uniform slot each. */
export const SPLASH_MAX_PINGS = 4;

/** Seconds, from the moment the layout is known. */
export const SPLASH_TIMELINE = {
  /** The amber reply leaves the sigil. */
  you: 1.85,
  /** The lattice clears around the sigil and wordmark. */
  clear: 1.9,
  /** Row `i` of the sigil flips in at `rows + i * rowStagger`. */
  rows: 1.95,
  rowStagger: 0.11,
  rowDuration: 0.45,
  eyes: 2.5,
  eyeStagger: 0.06,
  eyeDuration: 0.4,
  word: 2.65,
  wordDuration: 0.7,
  island: 2.95,
  islandDuration: 0.9,
  /** Where reduced motion parks the clock: everything arrived, nothing still moving. */
  settled: 9,
} as const;

export function splashLayout(width: number, height: number): SplashLayout {
  const landscape = width > height && width >= 900;
  const big = Math.min(width, height) >= 600;
  // An outer foldable display is a phone with the bottom cut off: shrink the hero so it never
  // meets the island.
  const compact = height < 760 && !big;
  const logoWidth = big ? 190 : compact ? 104 : 150;
  return {
    landscape,
    logoWidth,
    logoHeight: Math.round((logoWidth * SIGIL_VIEWBOX.height) / SIGIL_VIEWBOX.width),
    wordSize: big ? 52 : compact ? 34 : 42,
    wordGap: big ? 26 : compact ? 16 : 22,
    headingSize: compact ? 22 : 26,
  };
}

/** Ease-out expo over `[start, start + duration]` of the intro clock. */
export function introProgress(time: number, start: number, duration: number): number {
  'worklet';
  const p = (time - start) / duration;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return 1 - Math.pow(2, -10 * p);
}

export interface SplashPing {
  readonly x: number;
  readonly y: number;
  /** When its ring leaves, in intro seconds. */
  readonly start: number;
  /** Past this distance from its origin the ring has faded out. */
  readonly reach: number;
}

export interface SplashPings {
  readonly pings: readonly SplashPing[];
  /** Points per second for every friend ring, so they share one arrival. */
  readonly speed: number;
  readonly youSpeed: number;
  readonly youReach: number;
}

/**
 * Where the friends sit and when each one pings, so every ring reaches the sigil together.
 *
 * Origins are on the screen's edges, kept off the island (a dot under the panel pings from
 * nowhere) and inside `trailingInset` (a system rail, which draws over the field).
 */
export function splashPings({
  width,
  height,
  sigil,
  island,
  trailingInset = 0,
}: {
  readonly width: number;
  readonly height: number;
  readonly sigil: SplashRect;
  readonly island: SplashRect | null;
  readonly trailingInset?: number;
}): SplashPings {
  const cx = sigil.x + sigil.width / 2;
  const cy = sigil.y + sigil.height / 2;
  const right = width - trailingInset - 16;
  const candidates = [
    { x: 16, y: height * 0.2, arrive: 1.62 },
    { x: right, y: height * 0.42, arrive: 1.7 },
    { x: 30, y: height * 0.62, arrive: 1.78 },
  ];
  // A tablet-sized field looked empty with three.
  if (width - trailingInset >= 600) candidates.push({ x: width * 0.64, y: 16, arrive: 1.66 });

  const placed = candidates.slice(0, SPLASH_MAX_PINGS).map((point) => {
    if (!island || !near(point, island, 24)) return point;
    return { ...point, y: Math.max(16, island.y - 40) };
  });

  const distances = placed.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const speed = Math.max(270, Math.max(...distances) / 1.25);
  const diagonal = Math.hypot(width, height);
  return {
    pings: placed.map((point, index) => ({
      x: point.x,
      y: point.y,
      start: Math.max(0.35, point.arrive - distances[index] / speed),
      reach: distances[index] + 160,
    })),
    speed,
    youSpeed: 440 * Math.max(1, diagonal / 930),
    youReach: diagonal * 0.7,
  };
}

function near(point: { x: number; y: number }, rect: SplashRect, margin: number): boolean {
  return (
    point.x > rect.x - margin &&
    point.x < rect.x + rect.width + margin &&
    point.y > rect.y - margin &&
    point.y < rect.y + rect.height + margin
  );
}

/**
 * The sigil's rect inside a hero block centred in `hero`, and the ellipse the lattice clears
 * around sigil + wordmark. Computed rather than measured so it is known in the same frame as the
 * hero's own layout.
 */
export function splashHero(hero: SplashRect, layout: SplashLayout) {
  const wordHeight = layout.wordSize * 1.05;
  const blockHeight = layout.logoHeight + layout.wordGap + wordHeight;
  const top = hero.y + (hero.height - blockHeight) / 2;
  const cx = hero.x + hero.width / 2;
  const sigil: SplashRect = {
    x: cx - layout.logoWidth / 2,
    y: top,
    width: layout.logoWidth,
    height: layout.logoHeight,
  };
  // "streetCryptid" in Rajdhani runs ~5.4 em.
  const blockWidth = Math.max(layout.logoWidth, layout.wordSize * 5.4);
  return {
    sigil,
    clear: {
      x: cx,
      y: top + blockHeight / 2,
      rx: blockWidth / 2 + 60,
      ry: blockHeight / 2 + 50,
    },
  };
}
