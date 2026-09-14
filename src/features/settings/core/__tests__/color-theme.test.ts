import {
  COLOR_THEME_PREFERENCES,
  colorThemeLabel,
  isColorThemePreference,
  resolveColorTheme,
  type ColorThemePreference,
} from '../color-theme';

describe('color theme preference', () => {
  it('offers light and dark before the default', () => {
    expect(COLOR_THEME_PREFERENCES).toEqual(['light', 'dark', 'system']);
    expect(COLOR_THEME_PREFERENCES.map(colorThemeLabel)).toEqual(['Light', 'Dark', 'System']);
  });

  it.each(['light', 'dark'] as const)('%s overrides whatever the OS reports', (preference) => {
    expect(resolveColorTheme(preference, 'light')).toBe(preference);
    expect(resolveColorTheme(preference, 'dark')).toBe(preference);
    expect(resolveColorTheme(preference, null)).toBe(preference);
  });

  it('follows the OS on system, treating anything but dark as light', () => {
    expect(resolveColorTheme('system', 'dark')).toBe('dark');
    expect(resolveColorTheme('system', 'light')).toBe('light');
    // React Native reports both of these for a platform that will not say.
    expect(resolveColorTheme('system', null)).toBe('light');
    expect(resolveColorTheme('system', 'unspecified')).toBe('light');
  });

  // Every screen paints from `useColorScheme`, which paints from this. A value that
  // is neither a preference nor a scheme must still produce a palette.
  it('falls back to the OS rather than passing an unknown preference through', () => {
    const rogue = 'sepia' as ColorThemePreference;
    expect(resolveColorTheme(rogue, 'dark')).toBe('dark');
    expect(resolveColorTheme(rogue, 'light')).toBe('light');
    expect(isColorThemePreference(rogue)).toBe(false);
  });

  it.each(['system', 'light', 'dark'])('recognises %s as a stored preference', (value) => {
    expect(isColorThemePreference(value)).toBe(true);
  });

  it.each([null, undefined, 1, '', 'Dark'])('rejects %p as a stored preference', (value) => {
    expect(isColorThemePreference(value)).toBe(false);
  });
});
