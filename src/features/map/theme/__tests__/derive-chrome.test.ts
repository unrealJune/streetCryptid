import { CryptidThemes, type CryptidChrome, type CryptidTheme } from '@/constants/cryptid-theme';

import { ramp } from '../../core/color';
import type { MapPalette } from '../../core/types';
import {
  contrastRatio,
  deriveChrome,
  formatColor,
  parseColor,
  srgbToOklch,
} from '../derive-chrome';
import { BUILT_IN_MAP_COLOR_SCHEMES } from '../map-color-schemes';

const DAYBREAK = CryptidThemes.daybreak;
const DEEPSEA = CryptidThemes.deepsea;
const SEATTLE = BUILT_IN_MAP_COLOR_SCHEMES[0];
const KYOTO = BUILT_IN_MAP_COLOR_SCHEMES.find((scheme) => scheme.id === 'kyoto')!;

const TOKENS = Object.keys(DAYBREAK.chrome) as (keyof CryptidChrome)[];

/** Every base/palette pairing the app can reach, as `[label, theme, palette]`. */
const EVERY_COMBINATION = BUILT_IN_MAP_COLOR_SCHEMES.flatMap(
  (scheme) =>
    [
      [`${scheme.id} light`, DAYBREAK, scheme.light],
      [`${scheme.id} dark`, DEEPSEA, scheme.dark],
    ] as const
);

function rgb(token: string) {
  const parsed = parseColor(token);
  if (!parsed) throw new Error(`unparseable token: ${token}`);
  return parsed.rgb;
}

describe('parseColor / formatColor', () => {
  it('round-trips both notations CryptidChrome uses', () => {
    expect(parseColor('#152633')).toEqual({ rgb: [21, 38, 51], alpha: null });
    // The themes are written with a bare `.9`, which is legal CSS and not what a naive split
    // would hand `parseFloat`.
    expect(parseColor('rgba(238,242,245,.9)')).toEqual({ rgb: [238, 242, 245], alpha: 0.9 });
    expect(formatColor([21, 38, 51], null)).toBe('#152633');
    expect(formatColor([238, 242, 245], 0.9)).toBe('rgba(238,242,245,0.9)');
  });

  it('rejects anything it does not fully understand', () => {
    expect(parseColor('red')).toBeNull();
    expect(parseColor('#abc')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('deriveChrome', () => {
  it('is the identity for the palette each theme was authored against', () => {
    // `daybreak.canvas` and `seattle.light` are the same numbers — both transcribed from
    // mock_real.html — so the default scheme has nothing to shift and must come back out exactly
    // as it went in. This is the anchor for the whole module: if a future hue-source change moves
    // Seattle, it has changed the app's DEFAULT look, which is the thing that must never happen
    // by accident.
    expect(deriveChrome(DAYBREAK, SEATTLE.light)).toEqual(DAYBREAK.chrome);
    expect(deriveChrome(DEEPSEA, SEATTLE.dark)).toEqual(DEEPSEA.chrome);
  });

  it('actually moves for a scheme that is somewhere else', () => {
    const derived = deriveChrome(DAYBREAK, KYOTO.light);
    expect(derived).not.toEqual(DAYBREAK.chrome);
    for (const token of ['amber', 'ink', 'bg', 'island'] as const) {
      expect([token, derived[token] === DAYBREAK.chrome[token]]).toEqual([token, false]);
    }
  });

  it('preserves every token’s lightness, whatever the palette', () => {
    for (const [label, base, palette] of EVERY_COMBINATION) {
      const derived = deriveChrome(base, palette);
      for (const token of TOKENS) {
        const before = srgbToOklch(rgb(base.chrome[token])).l;
        const after = srgbToOklch(rgb(derived[token])).l;
        // 8-bit output is the only thing between these two numbers.
        expect([label, token, Math.abs(after - before) < 0.006]).toEqual([label, token, true]);
      }
    }
  });

  it('holds the hand-tuned contrast ratios the themes were built around', () => {
    // The pairs that carry small text. `amberDark` exists solely to clear AA against `panel`, and
    // a palette that pushed it under 4.5 would be an accessibility regression nobody sees until
    // it ships on someone else's wallpaper.
    const pairs = [
      ['ink', 'panel'],
      ['steel', 'panel'],
      ['steelDark', 'panel'],
      ['amberDark', 'panel'],
      ['ink', 'bg'],
    ] as const;

    for (const [label, base, palette] of EVERY_COMBINATION) {
      const derived = deriveChrome(base, palette);
      for (const [fg, bgToken] of pairs) {
        const before = contrastRatio(rgb(base.chrome[fg]), rgb(base.chrome[bgToken]));
        const after = contrastRatio(rgb(derived[fg]), rgb(derived[bgToken]));
        expect([label, fg, Math.abs(after - before) < 0.4]).toEqual([label, fg, true]);
        if (before >= 4.5) expect([label, fg, after >= 4.5]).toEqual([label, fg, true]);
      }
    }
  });

  it('keeps the translucent tokens translucent', () => {
    for (const [label, base, palette] of EVERY_COMBINATION) {
      const derived = deriveChrome(base, palette);
      for (const token of TOKENS) {
        expect([label, token, parseColor(derived[token])!.alpha]).toEqual([
          label,
          token,
          parseColor(base.chrome[token])!.alpha,
        ]);
      }
    }
  });

  it('rotates each token by its own group’s move, not onto the source’s hue', () => {
    const derived = deriveChrome(DAYBREAK, KYOTO.light);
    const hueOf = (token: string) => srgbToOklch(rgb(token)).h;
    const signed = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

    // Kyoto's accent is a rose where Seattle's is an orange. The chrome takes the whole of that
    // swing — a fraction of a hue change reads as a fault rather than a decision — so `amber` and
    // `segHi` both turn by exactly as far as the palette's accent did.
    const accentSwing = signed(
      srgbToOklch(DAYBREAK.canvas.accent).h,
      srgbToOklch(KYOTO.light.accent).h
    );
    const amberSwing = signed(hueOf(DAYBREAK.chrome.amber), hueOf(derived.amber));
    const segHiSwing = signed(hueOf(DAYBREAK.chrome.segHi), hueOf(derived.segHi));
    expect(Math.abs(amberSwing - accentSwing)).toBeLessThan(0.05);
    // Same group, same rotation — the two accent tokens cannot drift apart.
    expect(Math.abs(amberSwing - segHiSwing)).toBeLessThan(0.05);

    // Rotated, though, not replaced: `green` lands a full rotation from daybreak's green rather
    // than on top of Kyoto's park colour, which is what keeps the theme's internal relationships.
    const greenSwing = signed(hueOf(DAYBREAK.chrome.green), hueOf(derived.green));
    const parkSwing = signed(
      srgbToOklch(ramp(DAYBREAK.canvas.park, 1)).h,
      srgbToOklch(ramp(KYOTO.light.park, 1)).h
    );
    expect(Math.abs(greenSwing - parkSwing)).toBeLessThan(0.05);
    expect(hueOf(derived.green)).not.toBeCloseTo(srgbToOklch(ramp(KYOTO.light.park, 1)).h, 2);
  });

  it('quiets the chrome for a scheme with no colour in it, without inventing a hue', () => {
    const grey = (v: number) => [v, v, v] as const;
    const neutral: MapPalette = {
      bg: grey(240),
      accent: grey(128),
      terr: [
        { t: 0, rgb: grey(200) },
        { t: 1, rgb: grey(40) },
      ],
      water: [
        { t: 0, rgb: grey(180) },
        { t: 1, rgb: grey(90) },
      ],
      park: [
        { t: 0, rgb: grey(170) },
        { t: 1, rgb: grey(80) },
      ],
      transit: grey(110),
      building: grey(60),
      streetLabel: grey(70),
      parkLabel: grey(90),
    };

    const derived = deriveChrome(DAYBREAK, neutral);
    for (const token of ['amber', 'ink', 'green', 'dot'] as const) {
      const before = srgbToOklch(rgb(DAYBREAK.chrome[token]));
      const after = srgbToOklch(rgb(derived[token]));
      // No hue to borrow, so none is borrowed. The tolerance is eight-bit quantization, not
      // policy: `ink` is dark enough that one step of a channel is several degrees of hue.
      const drift = Math.atan2(Math.sin(after.h - before.h), Math.cos(after.h - before.h));
      expect([token, Math.abs(drift) < 0.12]).toEqual([token, true]);
      // But the scheme's own greyness still reads: saturation comes down.
      expect([token, after.c < before.c]).toEqual([token, true]);
    }
  });

  it('leaves shadow alone', () => {
    for (const [label, base, palette] of EVERY_COMBINATION) {
      expect([label, deriveChrome(base, palette).shadow]).toEqual([label, base.chrome.shadow]);
    }
  });

  it('returns the same object for the same theme and palette', () => {
    // Chrome flows into `useMemo` deps and style objects all over the tree; re-deriving on every
    // render would hand every consumer a new identity each frame.
    const theme: CryptidTheme = DAYBREAK;
    expect(deriveChrome(theme, KYOTO.light)).toBe(deriveChrome(theme, KYOTO.light));
    expect(deriveChrome(theme, KYOTO.light)).not.toBe(deriveChrome(theme, SEATTLE.light));
  });
});
