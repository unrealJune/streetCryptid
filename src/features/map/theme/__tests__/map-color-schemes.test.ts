import { BUILT_IN_MAP_COLOR_SCHEMES, parseCustomMapColorScheme } from '../map-color-schemes';

describe('map color schemes', () => {
  it('provides paired light and dark palettes for every built-in scheme', () => {
    expect(BUILT_IN_MAP_COLOR_SCHEMES.map((scheme) => scheme.id)).toEqual([
      'atlas',
      'field-notes',
      'afterglow',
      'sunset',
      'retrowave',
      'aurora',
      'neon-grid',
    ]);
    for (const scheme of BUILT_IN_MAP_COLOR_SCHEMES) {
      expect(scheme.light.terr.length).toBeGreaterThanOrEqual(2);
      expect(scheme.dark.terr.length).toBeGreaterThanOrEqual(2);
      expect(scheme.light.bg).not.toEqual(scheme.dark.bg);
    }
  });

  it('parses a custom light and dark palette into renderer colors', () => {
    const result = parseCustomMapColorScheme(
      JSON.stringify({
        name: 'Moss',
        light: {
          bg: '#FFFFFF',
          accent: '#AA5500',
          terrain: ['#CCCCCC', '#111111'],
          water: ['#AADDFF', '#005588'],
          park: ['#AAFFAA', '#116611'],
          transit: '#663399',
          streetLabel: '#222222',
          parkLabel: '#225522',
        },
        dark: {
          bg: '#000000',
          accent: '#FFAA22',
          terrain: ['#222222', '#EEEEEE'],
          water: ['#003355', '#55CCFF'],
          park: ['#113311', '#88DD88'],
          transit: '#CC99FF',
          streetLabel: '#DDDDDD',
          parkLabel: '#AADD99',
        },
      })
    );

    expect(result.scheme.name).toBe('Moss');
    expect(result.scheme.light.bg).toEqual([255, 255, 255]);
    expect(result.scheme.dark.accent).toEqual([255, 170, 34]);
    expect(result.scheme.light.terr).toEqual([
      { t: 0, rgb: [204, 204, 204] },
      { t: 1, rgb: [17, 17, 17] },
    ]);
  });

  it('rejects malformed colors before they reach the renderer', () => {
    expect(() =>
      parseCustomMapColorScheme(
        JSON.stringify({
          name: 'Broken',
          light: {},
          dark: {},
        })
      )
    ).toThrow('light.bg must be a six-digit hex color');
  });
});
