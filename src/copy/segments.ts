const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

export type CopySegment = { text: string } | { text: string; href: string };

/**
 * A paragraph from this folder split into plain runs and `[label](https://…)` links, in order —
 * the one piece of Markdown the copy honours. Kept apart from `CopyText` so it can be tested
 * without the component's theme imports.
 */
export function copySegments(text: string): CopySegment[] {
  const out: CopySegment[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    if (match.index > at) out.push({ text: text.slice(at, match.index) });
    out.push({ text: match[1], href: match[2] });
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
