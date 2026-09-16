/**
 * How big a sigil is allowed to be on the map.
 *
 * Lives apart from `friend-locator.tsx` so it can be imported without react-native
 * and reanimated coming with it — `scripts/cryptid-preview.ts` runs under bun and
 * measures the roster with this exact function rather than a copy of the formula
 * that would drift the first time either side was touched.
 */

export interface SigilMetrics {
  fontSize: number;
  height: number;
  lineHeight: number;
  width: number;
}

/**
 * Fit the drawing into the marker's box, never larger than 7px and never smaller
 * than 3px. The box is what the map has room for at any zoom; the ceiling is what
 * a screen-space marker is allowed to be before it starts covering the terrain it
 * is standing on.
 *
 * The consequence is worth stating plainly because it decides how `CRYPTID_FORMS`
 * is drawn: a compact cryptid renders LARGER here than a sprawling one. Four lines
 * and twelve columns is the largest drawing that still gets the full 7px.
 */
export function sigilMetrics(sigil: string): SigilMetrics {
  const lines = sigil.replace(/\r\n?/g, '\n').split('\n');
  const columns = Math.max(1, ...lines.map((line) => line.replace(/\t/g, '    ').length));
  const fontSize = Math.max(
    3,
    Math.min(7, 52 / (columns * 0.62), 38 / (Math.max(1, lines.length) * 1.12))
  );
  const lineHeight = fontSize * 1.12;
  return {
    fontSize,
    lineHeight,
    width: Math.ceil(columns * fontSize * 0.62 + 10),
    height: Math.ceil(lines.length * lineHeight + 8),
  };
}
