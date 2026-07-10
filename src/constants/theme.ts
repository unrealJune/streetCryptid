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

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const TopTabInset = Platform.select({ web: 64 }) ?? 0;
export const MaxContentWidth = 800;
