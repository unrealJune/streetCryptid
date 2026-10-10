/**
 * Map-language policy, mirrored by `Layer::map_name` in rust/src/mvt.rs.
 * Prefer English, then a real Latin name, then the local name as written.
 * Both OMT language-key spellings occur (our tiles use `name_en`).
 *
 * The bake runs with `--transliterate=false`, so `name:latin` / `name_int`
 * hold only names someone wrote (OSM `name:en`, `int_name`, `name:ja-Latn`…),
 * never ICU's Any-Latin guess, which reads Japanese kanji as Mandarin pinyin.
 * A local name in its own script beats a reading in somebody else's language.
 *
 * Keep this at decode time, not in rendering: raw cached tiles retain every
 * translation for future localization. A language change will need a fresh
 * decoded-geometry cache, not a new tile download.
 */
const LATIN_KEYS = ['name:en', 'name_en', 'name:latin', 'name_int'] as const;

// Conservative Latin typography: ASCII, Latin-1 (not Greek µ), Extended A/B,
// combining accents, Extended Additional, and ordinary spaces/punctuation.
// Do not strip foreign letters out of a mixed name or invent a transliteration.
const LATIN_TEXT =
  /^[\u0020-\u007e\u00a0-\u00b4\u00b6-\u024f\u0300-\u036f\u1e00-\u1eff\u2000-\u2027]+$/u;
const HAS_LETTER_OR_NUMBER = /[A-Za-z0-9\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u1e00-\u1eff]/u;
// A local name is shown as written, minus anything that is not text: control
// characters (a newline breaks the one-line chip) and bidi overrides/isolates
// (which reorder the chip's text and anything drawn after it).
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// Spaces and punctuation (ASCII, Latin-1, General, CJK, fullwidth); a name made
// only of these says nothing. Explicit ranges, not \p{…}, so Rust can match it.
const NOT_TEXT =
  /[\s\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e\u00a1-\u00bf\u2000-\u206f\u3000-\u303f\uff01-\uff0f]/gu;

export function mapName(properties: Record<string, unknown>): string | undefined {
  for (const key of LATIN_KEYS) {
    const value = properties[key];
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (LATIN_TEXT.test(name) && HAS_LETTER_OR_NUMBER.test(name)) return name;
  }
  const local = properties.name;
  if (typeof local !== 'string') return undefined;
  const name = local.trim();
  if (UNSAFE.test(name) || name.replace(NOT_TEXT, '') === '') return undefined;
  return name;
}
