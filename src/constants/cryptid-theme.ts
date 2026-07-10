/**
 * streetCryptid theme — the single source of truth for both the UI chrome and the
 * map canvas palette (see DESIGN.md). Values are transcribed 1:1 from the design
 * reference implementation (docs/design/mock_real.html, THEMES object).
 *
 * daybreak (light) is the default; deepsea is the dark alternate the OS scheme
 * switches to; nocturne is a manual alternate kept for later.
 *
 * This module is pure data (no React Native, no CSS imports) so the map core and
 * its tests can consume palettes directly.
 */

import type { MapPalette } from '@/features/map/core/types';

export type CryptidThemeName = 'daybreak' | 'deepsea' | 'nocturne';

/** UI chrome tokens (panels, text, hairlines) — the CSS-vars half of the mock THEME. */
export interface CryptidChrome {
  /** Screen background outside the map (letterbox/void). */
  readonly void: string;
  /** Base surface behind the map. */
  readonly bg: string;
  readonly panel: string;
  readonly ink: string;
  readonly steel: string;
  readonly steelDark: string;
  readonly hairline: string;
  readonly amber: string;
  /** AA-tuned darker amber for small text. */
  readonly amberDark: string;
  /** Contact-green: default friend signal and social-system status. */
  readonly green: string;
  readonly edge: string;
  readonly scrim: string;
  readonly glass: string;
  readonly glassBorder: string;
  readonly island: string;
  readonly islandBorder: string;
  readonly shadow: string;
  /** Coverage-bar segment, undiscovered. */
  readonly seg: string;
  /** Coverage-bar segment highlight. */
  readonly segHi: string;
  readonly dot: string;
}

export interface CryptidTheme {
  readonly name: CryptidThemeName;
  readonly scheme: 'light' | 'dark';
  readonly chrome: CryptidChrome;
  readonly canvas: MapPalette;
}

export const CryptidThemes: Record<CryptidThemeName, CryptidTheme> = {
  daybreak: {
    name: 'daybreak',
    scheme: 'light',
    chrome: {
      void: '#c9d3da',
      bg: '#eef2f5',
      panel: '#ffffff',
      ink: '#152633',
      steel: '#4d6675',
      steelDark: '#5b7480',
      hairline: '#d6dee4',
      amber: '#C6791A',
      amberDark: '#9a5c10',
      green: '#2f9e6a',
      edge: 'rgba(238,242,245,.9)',
      scrim: 'rgba(238,242,245,.6)',
      glass: 'rgba(255,255,255,.78)',
      glassBorder: 'rgba(30,55,72,.14)',
      island: 'rgba(255,255,255,.9)',
      islandBorder: 'rgba(30,55,72,.12)',
      shadow: 'rgba(40,60,80,.28)',
      seg: '#d3dde3',
      segHi: '#C6791A',
      dot: '#1a848e',
    },
    canvas: {
      bg: [236, 240, 244],
      accent: [214, 124, 26],
      terr: [
        { t: 0, rgb: [176, 190, 200] },
        { t: 0.4, rgb: [108, 132, 148] },
        { t: 0.72, rgb: [52, 84, 106] },
        { t: 1, rgb: [20, 44, 64] },
      ],
      water: [
        { t: 0, rgb: [150, 192, 224] },
        { t: 0.5, rgb: [74, 140, 196] },
        { t: 1, rgb: [30, 104, 170] },
      ],
      park: [
        { t: 0, rgb: [158, 200, 168] },
        { t: 0.5, rgb: [80, 164, 110] },
        { t: 1, rgb: [34, 128, 80] },
      ],
      streetLabel: [46, 78, 98],
      parkLabel: [30, 110, 78],
    },
  },
  deepsea: {
    name: 'deepsea',
    scheme: 'dark',
    chrome: {
      void: '#060c14',
      bg: '#0a1420',
      panel: '#0b1826',
      ink: '#DCEBF0',
      steel: '#8AA6B2',
      steelDark: '#6E8A97',
      hairline: '#17293a',
      amber: '#EDA23C',
      amberDark: '#B9761E',
      green: '#6FD08A',
      edge: 'rgba(6,12,20,.85)',
      scrim: 'rgba(6,12,20,.55)',
      glass: 'rgba(11,21,32,.64)',
      glassBorder: 'rgba(130,170,190,.16)',
      island: 'rgba(10,20,31,.92)',
      islandBorder: 'rgba(130,170,190,.16)',
      shadow: 'rgba(0,0,0,.7)',
      seg: '#15293a',
      segHi: '#fff2dd',
      dot: '#68d2ce',
    },
    canvas: {
      bg: [9, 18, 30],
      accent: [240, 166, 64],
      terr: [
        { t: 0, rgb: [34, 66, 74] },
        { t: 0.45, rgb: [46, 120, 130] },
        { t: 0.72, rgb: [120, 196, 198] },
        { t: 1, rgb: [212, 236, 234] },
      ],
      water: [
        { t: 0, rgb: [26, 74, 128] },
        { t: 0.5, rgb: [38, 110, 176] },
        { t: 1, rgb: [86, 168, 232] },
      ],
      park: [
        { t: 0, rgb: [30, 84, 58] },
        { t: 0.5, rgb: [54, 140, 86] },
        { t: 1, rgb: [120, 206, 132] },
      ],
      streetLabel: [184, 208, 216],
      parkLabel: [132, 198, 150],
    },
  },
  nocturne: {
    name: 'nocturne',
    scheme: 'dark',
    chrome: {
      void: '#08081a',
      bg: '#0e0e22',
      panel: '#14142a',
      ink: '#E7E9FB',
      steel: '#9aa0c8',
      steelDark: '#7d82ac',
      hairline: '#22224a',
      amber: '#F0657F',
      amberDark: '#B23a52',
      green: '#63D0B0',
      edge: 'rgba(7,7,20,.85)',
      scrim: 'rgba(7,7,20,.55)',
      glass: 'rgba(16,16,34,.64)',
      glassBorder: 'rgba(150,150,205,.18)',
      island: 'rgba(14,14,30,.92)',
      islandBorder: 'rgba(150,150,210,.18)',
      shadow: 'rgba(0,0,0,.72)',
      seg: '#22224a',
      segHi: '#ffdfe7',
      dot: '#5cc8e0',
    },
    canvas: {
      bg: [12, 12, 30],
      accent: [244, 110, 136],
      terr: [
        { t: 0, rgb: [44, 42, 78] },
        { t: 0.42, rgb: [96, 100, 168] },
        { t: 0.72, rgb: [168, 176, 220] },
        { t: 1, rgb: [236, 238, 250] },
      ],
      water: [
        { t: 0, rgb: [38, 44, 104] },
        { t: 0.5, rgb: [62, 80, 180] },
        { t: 1, rgb: [104, 132, 236] },
      ],
      park: [
        { t: 0, rgb: [36, 64, 78] },
        { t: 0.5, rgb: [58, 124, 132] },
        { t: 1, rgb: [110, 196, 190] },
      ],
      streetLabel: [188, 196, 232],
      parkLabel: [150, 200, 200],
    },
  },
};
