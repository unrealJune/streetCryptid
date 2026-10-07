/**
 * Map-language policy, mirrored by `Layer::map_name` in rust/src/mvt.rs.
 * Prefer English, then the tileset's romanization, then a Latin local name.
 * Both OMT language-key spellings occur (our tiles use `name_en`).
 *
 * Keep this at decode time, not in rendering: raw cached tiles retain every
 * translation for future localization. A language change will need a fresh
 * decoded-geometry cache, not a new tile download.
 */
const NAME_KEYS = ['name:en', 'name_en', 'name:latin', 'name_int', 'name'] as const;

// Conservative Latin typography: ASCII, Latin-1 (not Greek µ), Extended A/B,
// combining accents, Extended Additional, and ordinary spaces/punctuation.
// Do not strip foreign letters out of a mixed name or invent a transliteration.
const LATIN_TEXT =
  /^[\u0020-\u007e\u00a0-\u00b4\u00b6-\u024f\u0300-\u036f\u1e00-\u1eff\u2000-\u2027]+$/u;
const HAS_LETTER_OR_NUMBER = /[A-Za-z0-9\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u1e00-\u1eff]/u;

export function mapName(properties: Record<string, unknown>): string | undefined {
  for (const key of NAME_KEYS) {
    const value = properties[key];
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (LATIN_TEXT.test(name) && HAS_LETTER_OR_NUMBER.test(name)) return name;
  }
  return undefined;
}
