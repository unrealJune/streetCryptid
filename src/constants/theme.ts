/**
 * App-facing theme tokens. The brand source of truth is `cryptid-theme.ts`
 * (pure data — chrome + canvas palettes per DESIGN.md); this module derives the
 * template's `Colors` tokens from it and adds platform font stacks.
 */

import '@/global.css';

import { Platform } from 'react-native';

import { CryptidThemes } from '@/constants/cryptid-theme';

export { CryptidThemes } from '@/constants/cryptid-theme';
export type { CryptidChrome, CryptidTheme, CryptidThemeName } from '@/constants/cryptid-theme';

/**
 * Template color tokens, derived from the cryptid themes so the existing themed
 * components (tabs, text, views) pick up the brand: light = daybreak, dark = deepsea.
 */
export const Colors = {
  light: {
    text: CryptidThemes.daybreak.chrome.ink,
    background: CryptidThemes.daybreak.chrome.bg,
    backgroundElement: CryptidThemes.daybreak.chrome.panel,
    backgroundSelected: CryptidThemes.daybreak.chrome.hairline,
    textSecondary: CryptidThemes.daybreak.chrome.steel,
  },
  dark: {
    text: CryptidThemes.deepsea.chrome.ink,
    background: CryptidThemes.deepsea.chrome.bg,
    backgroundElement: CryptidThemes.deepsea.chrome.panel,
    backgroundSelected: CryptidThemes.deepsea.chrome.seg,
    textSecondary: CryptidThemes.deepsea.chrome.steel,
  },
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
