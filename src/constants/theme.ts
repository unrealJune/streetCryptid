/**
 * App-facing theme tokens. The brand source of truth is `cryptid-theme.ts`
 * (pure data — chrome + canvas palettes per DESIGN.md); this module derives the
 * template's `Colors` tokens from it and adds platform font stacks.
 */

import '@/global.css';

import { Platform } from 'react-native';

import { CryptidThemes, type CryptidChrome } from '@/constants/cryptid-theme';

export { CryptidThemes } from '@/constants/cryptid-theme';
export type { CryptidChrome, CryptidTheme, CryptidThemeName } from '@/constants/cryptid-theme';

/**
 * The five template tokens the themed components (text, views, inputs) paint from, projected out
 * of a chrome palette.
 *
 * A function rather than a constant because chrome is no longer fixed: it is retinted from the
 * selected map scheme (`features/map/theme/derive-chrome.ts`), so these have to be computed per
 * render from whatever palette is live. `useTheme()` is the only caller — every component reads
 * it through that hook, which is why widening this cost no call sites.
 *
 * `backgroundSelected` is the one token that is not the same chrome key in both schemes:
 * `hairline` is a visible edge on daybreak's near-white panels and disappears on deepsea's, where
 * `seg` is the token that reads as a selected row.
 */
export function chromeToColors(chrome: CryptidChrome, scheme: 'light' | 'dark') {
  return {
    text: chrome.ink,
    background: chrome.bg,
    backgroundElement: chrome.panel,
    backgroundSelected: scheme === 'dark' ? chrome.seg : chrome.hairline,
    textSecondary: chrome.steel,
  } as const;
}

/**
 * The unthemed fallback, still light = daybreak / dark = deepsea. Nothing paints from this in the
 * app — it is what a test or a screen outside the map scheme's provider would see.
 */
export const Colors = {
  light: chromeToColors(CryptidThemes.daybreak.chrome, 'light'),
  dark: chromeToColors(CryptidThemes.deepsea.chrome, 'dark'),
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

/**
 * The two brand faces, loaded once in `src/app/_layout.tsx`.
 *
 * Rajdhani is the condensed display voice every island, tab and locator on the map is
 * set in; IBM Plex Mono is the tracked data voice that sits under them. They are named
 * here because fourteen files had the family strings inline and Settings — the one
 * surface in the app that used NEITHER — rendered in the platform system font and read
 * as a different product.
 *
 * `Fonts.mono` is not the same thing: it is the platform's monospace (SF Mono on iOS),
 * which is what `ThemedText type="code"` still uses. Where a readout should match the
 * islands, use `BrandFonts.data`.
 */
export const BrandFonts = {
  display: 'Rajdhani_700Bold',
  displayMedium: 'Rajdhani_600SemiBold',
  data: 'IBMPlexMono_500Medium',
} as const;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const MaxContentWidth = 800;
