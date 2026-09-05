import { BUILT_IN_MAP_COLOR_SCHEMES, parseCustomMapColorScheme } from '../map-color-schemes';

describe('map color schemes', () => {
  it('provides paired light and dark palettes for every built-in scheme', () => {
    expect(BUILT_IN_MAP_COLOR_SCHEMES.map((scheme) => scheme.id)).toEqual([
      'seattle',
      'portland',
      'kyoto',
      'marrakesh',
      'miami',
      'reykjavik',
      'tokyo',
    ]);
    for (const scheme of BUILT_IN_MAP_COLOR_SCHEMES) {
      expect(scheme.light.terr.length).toBeGreaterThanOrEqual(2);
      expect(scheme.dark.terr.length).toBeGreaterThanOrEqual(2);
      expect(scheme.light.bg).not.toEqual(scheme.dark.bg);
      // Every built-in scheme carries its own built-ground ink rather than
      // silently inheriting the street-label fallback.
      expect(scheme.light.building).not.toEqual(scheme.light.streetLabel);
      expect(scheme.dark.building).not.toEqual(scheme.dark.streetLabel);
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

  /**
   * `building` arrived after users could already save a custom palette, so a
   * stored scheme without it must still load — not fail validation and drop
   * someone's colours.
   */
  it('falls back to streetLabel when a saved palette predates the building ink', () => {
    const withoutBuilding = {
      bg: '#FFFFFF',
      accent: '#AA5500',
      terrain: ['#CCCCCC', '#111111'],
      water: ['#AADDFF', '#005588'],
      park: ['#AAFFAA', '#116611'],
      transit: '#663399',
      streetLabel: '#222222',
      parkLabel: '#225522',
    };
    const result = parseCustomMapColorScheme(
      JSON.stringify({
        name: 'Legacy',
        light: withoutBuilding,
        dark: { ...withoutBuilding, building: '#445566' },
      })
    );

    expect(result.scheme.light.building).toEqual([34, 34, 34]);
    expect(result.scheme.light.building).toEqual(result.scheme.light.streetLabel);
    expect(result.scheme.dark.building).toEqual([68, 85, 102]);
    // A palette that omitted it round-trips without gaining a spurious entry.
    expect(result.input.light.building).toBeUndefined();
    expect(result.input.dark.building).toBe('#445566');
  });

  it('rejects a malformed building ink', () => {
    expect(() =>
      parseCustomMapColorScheme(
        JSON.stringify({
          name: 'Broken',
          light: {
            bg: '#FFFFFF',
            accent: '#AA5500',
            terrain: ['#CCCCCC', '#111111'],
            water: ['#AADDFF', '#005588'],
            park: ['#AAFFAA', '#116611'],
            transit: '#663399',
            building: 'notacolor',
            streetLabel: '#222222',
            parkLabel: '#225522',
          },
          dark: {},
        })
      )
    ).toThrow('light.building must be a six-digit hex color');
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
