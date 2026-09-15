/**
 * Which palette the app wears, as a user CHOICE rather than an observation.
 *
 * `system` is the default and means "whatever the OS says", which is what every screen did
 * unconditionally before this existed. The other two override it, so a phone left in light mode
 * can still run the app dark — the thing people actually ask for when they ask for a dark mode
 * toggle.
 */
export type ColorThemePreference = 'system' | 'light' | 'dark';

export const COLOR_THEME_PREFERENCES: readonly ColorThemePreference[] = [
  'light',
  'dark',
  'system',
] as const;

export function isColorThemePreference(value: unknown): value is ColorThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** The label a picker shows for each choice. */
export function colorThemeLabel(preference: ColorThemePreference): string {
  return preference === 'system' ? 'System' : preference === 'light' ? 'Light' : 'Dark';
}

/**
 * Resolve a preference against the OS scheme.
 *
 * Anything that is not literally `dark` resolves to light — React Native reports `null` and
 * `'unspecified'` for a platform that will not say, and `light` is the app's answer to both, the
 * same fallback `useTheme` has always applied.
 */
export function resolveColorTheme(
  preference: ColorThemePreference,
  systemScheme: string | null | undefined
): 'light' | 'dark' {
  // Positive test, not `!== 'system'`: this is reached from `useColorScheme`, which every screen
  // in the app paints from, so an unset or unrecognised preference has to fall through to the OS
  // rather than become the literal theme name and leave a screen with no palette at all.
  if (preference === 'light' || preference === 'dark') return preference;
  return systemScheme === 'dark' ? 'dark' : 'light';
}
