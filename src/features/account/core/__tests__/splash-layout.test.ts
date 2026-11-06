import {
  introProgress,
  SPLASH_MAX_PINGS,
  splashHero,
  splashLayout,
  splashPings,
  type SplashRect,
} from '../splash-layout';

/** The screens the design canvas drew, in points. */
const SCREENS = {
  iphone: { width: 390, height: 844 },
  duoOuter: { width: 466, height: 678 },
  duoInner: { width: 626, height: 890 },
  ipadPortrait: { width: 820, height: 1180 },
  ipadLandscape: { width: 1180, height: 820 },
} as const;

/** iPhone Duo's trailing system rail. */
const DUO_RAIL = 84;

function sigilFor(width: number, height: number, island: SplashRect) {
  const layout = splashLayout(width, height);
  const hero: SplashRect = layout.landscape
    ? { x: 64, y: 0, width: island.x - 56 - 64, height }
    : { x: 16, y: 0, width: width - 32, height: island.y };
  return { layout, ...splashHero(hero, layout) };
}

describe('splashLayout', () => {
  it('shrinks the hero on a short outer foldable display and grows it on large screens', () => {
    expect(splashLayout(390, 844).logoWidth).toBe(150);
    expect(splashLayout(466, 678).logoWidth).toBeLessThan(150);
    expect(splashLayout(466, 678).headingSize).toBeLessThan(splashLayout(390, 844).headingSize);
    expect(splashLayout(626, 890).logoWidth).toBeGreaterThan(150);
    expect(splashLayout(820, 1180).logoWidth).toBeGreaterThan(150);
  });

  it('goes side by side only on a wide landscape window', () => {
    expect(splashLayout(1180, 820).landscape).toBe(true);
    expect(splashLayout(820, 1180).landscape).toBe(false);
    // A phone on its side is wider than tall but has no room for two columns.
    expect(splashLayout(844, 390).landscape).toBe(false);
  });

  it('keeps the sigil and wordmark clear of the island on every drawn screen', () => {
    for (const { width, height } of Object.values(SCREENS)) {
      const layout = splashLayout(width, height);
      if (layout.landscape) continue;
      // The island's height at that size, with its button.
      const islandTop = height - 34 - 16 - (layout.headingSize < 26 ? 230 : 250);
      const island = { x: 16, y: islandTop, width: width - 32, height: height - islandTop };
      const { sigil } = sigilFor(width, height, island);
      const wordBottom = sigil.y + sigil.height + layout.wordGap + layout.wordSize * 1.05;
      expect(sigil.y).toBeGreaterThan(0);
      expect(wordBottom).toBeLessThan(islandTop);
    }
  });
});

describe('splashPings', () => {
  const island: SplashRect = { x: 16, y: 560, width: 358, height: 250 };
  const { sigil } = sigilFor(390, 844, island);

  it('times every ring to reach the sigil together', () => {
    const { pings, speed } = splashPings({ width: 390, height: 844, sigil, island });
    const cx = sigil.x + sigil.width / 2;
    const cy = sigil.y + sigil.height / 2;
    const arrivals = pings.map((p) => p.start + Math.hypot(p.x - cx, p.y - cy) / speed);
    expect(Math.max(...arrivals) - Math.min(...arrivals)).toBeLessThan(0.25);
    for (const p of pings) expect(p.start).toBeGreaterThanOrEqual(0.35);
  });

  it('never places a friend under the island or the system rail', () => {
    for (const { width, height } of Object.values(SCREENS)) {
      const layout = splashLayout(width - DUO_RAIL, height);
      const panel: SplashRect = layout.landscape
        ? { x: width - DUO_RAIL - 64 - 400, y: height / 2 - 125, width: 400, height: 250 }
        : { x: 16, y: height - 300, width: width - DUO_RAIL - 32, height: 250 };
      const { sigil: placed } = sigilFor(width - DUO_RAIL, height, panel);
      const { pings } = splashPings({
        width,
        height,
        sigil: placed,
        island: panel,
        trailingInset: DUO_RAIL,
      });
      expect(pings.length).toBeLessThanOrEqual(SPLASH_MAX_PINGS);
      for (const p of pings) {
        expect(p.x).toBeLessThanOrEqual(width - DUO_RAIL);
        const under =
          p.x > panel.x &&
          p.x < panel.x + panel.width &&
          p.y > panel.y &&
          p.y < panel.y + panel.height;
        expect(under).toBe(false);
      }
    }
  });

  it('adds a fourth friend only on a tablet-sized field', () => {
    expect(splashPings({ width: 390, height: 844, sigil, island }).pings).toHaveLength(3);
    expect(splashPings({ width: 820, height: 1180, sigil, island }).pings).toHaveLength(4);
  });
});

describe('introProgress', () => {
  it('eases out from 0 to 1 across its window and holds', () => {
    expect(introProgress(0, 1, 0.5)).toBe(0);
    expect(introProgress(1.25, 1, 0.5)).toBeGreaterThan(0.9);
    expect(introProgress(3, 1, 0.5)).toBe(1);
  });
});
