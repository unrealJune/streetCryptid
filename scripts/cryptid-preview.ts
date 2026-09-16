/**
 * Lay the whole cryptid roster out on one page, at the sizes it is actually seen at.
 *
 *   bun scripts/cryptid-preview.ts            # -> store/cryptid-preview/index.html
 *   just cryptid-preview                      # same, then opens it
 *
 * There was no way to look at the roster except by mashing reroll in the profile
 * editor, which is why nobody noticed that the drawings were being squeezed to
 * 5.6px on the map. This reads `CRYPTID_FORMS` directly and renders each creature
 * three times: through the map's own `sigilMetrics`, at the roster row's 9px, and
 * at the profile tile's 15px.
 *
 * Deliberately NOT a browser capture the way `island-preview.ts` is. `CryptidAvatar`
 * is monospace text in a colour and nothing else, so HTML is faithful, and this
 * regenerates in well under a second — which is the only reason authoring four
 * dozen drawings is bearable. The trade is that it cannot show anything that
 * depends on layout around the sigil; when that matters, `just island-shots` is
 * still the tool.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CRYPTID_FORMS,
  EYES,
  MOUTHS,
  type CryptidForm,
  type CryptidMood,
} from '../src/features/account/core/cryptid-forms';
import {
  CRYPTID_PRESETS,
  sigilMeasurements,
  validateCryptidProfileFields,
} from '../src/features/account/core/profile';
import { RANDOM_PERSONA_VOCABULARY } from '../src/features/account/core/random-persona';
import { sigilMetrics } from '../src/features/map/render/sigil-metrics';

const { TITLES } = RANDOM_PERSONA_VOCABULARY;

/** Below this the drawing stops reading as a face at marker size. */
const MARKER_LEGIBILITY_FLOOR = 4.5;

/** Matches `CryptidAvatar`'s two size presets in `features/account/components`. */
const ROSTER = { fontSize: 9, lineHeight: 11 };
const PROFILE = { fontSize: 15, lineHeight: 18 };

const MOOD_ORDER: readonly CryptidMood[] = ['cute', 'spooky', 'eerie', 'goofy'];

const MOOD_BLURB: Record<CryptidMood, string> = {
  cute: 'Compact, big eyes, small body. These are the ones that hit the 7px marker cap.',
  spooky: 'The angular register the app shipped with, kept and extended.',
  eerie: 'Thin, tall, wrong-proportioned. Nothing here has feet.',
  goofy: 'Chunky, mid-size, and they all have feet.',
};

interface Args {
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { out: 'store/cryptid-preview' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

/**
 * Both quote characters, not just the double. The sigils are full of `'` — every
 * `'---'` base and `.-'` curve — and the variant payload rides in a SINGLE-quoted
 * attribute, so an unescaped apostrophe closes it early and the card renders blank.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Entry {
  creature: string;
  mood: CryptidMood | 'legacy';
  /** Every eye/mouth pair, so the page can cycle without regenerating. */
  variants: string[];
  /** The longest reading across all variants — a form's worst case, not its best. */
  lines: number;
  columns: number;
  markerFont: number;
  issues: string[];
}

function entryFor(form: CryptidForm): Entry {
  const variants: string[] = [];
  let lines = 0;
  let columns = 0;
  const issues = new Set<string>();

  for (const eyes of EYES) {
    for (const mouth of MOUTHS) {
      const sigil = form.render(eyes[0], eyes[1], mouth);
      variants.push(sigil);
      const measured = sigilMeasurements(sigil);
      lines = Math.max(lines, measured.lines);
      columns = Math.max(columns, measured.columns);
      // Names are checked against the longest title, which is the only one that
      // can push a creature past the profile's 24-character cap.
      const longestTitle = TITLES.reduce((a, b) => (b.length > a.length ? b : a));
      const field = validateCryptidProfileFields({
        handle: '@preview',
        cryptidName: `${longestTitle} ${form.creature}`,
        sigil,
        color: '#4CFFAB',
        presetId: null,
      });
      for (const issue of [...field.cryptidName, ...field.sigil]) issues.add(issue);
    }
  }

  const markerFont = sigilMetrics(form.render('o', 'o', '-')).fontSize;
  if (markerFont < MARKER_LEGIBILITY_FLOOR) {
    issues.add(`Renders at ${markerFont.toFixed(1)}px on the map — under the legibility floor.`);
  }
  return {
    creature: form.creature,
    mood: form.mood,
    variants,
    lines,
    columns,
    markerFont,
    issues: [...issues],
  };
}

/** The five ids old profiles still resolve through `findCryptidPreset`. */
function legacyEntries(): Entry[] {
  return CRYPTID_PRESETS.map((preset) => {
    const measured = sigilMeasurements(preset.art);
    return {
      creature: preset.name,
      mood: 'legacy' as const,
      variants: [preset.art],
      lines: measured.lines,
      columns: measured.columns,
      markerFont: sigilMetrics(preset.art).fontSize,
      issues: [],
    };
  });
}

function renderPage(entries: readonly Entry[]): string {
  const counts = MOOD_ORDER.map(
    (mood) => `${entries.filter((e) => e.mood === mood).length} ${mood}`
  ).join(' &middot; ');

  const sections = [...MOOD_ORDER, 'legacy' as const]
    .map((mood) => {
      const group = entries.filter((entry) => entry.mood === mood);
      if (group.length === 0) return '';
      const blurb =
        mood === 'legacy'
          ? 'Not rollable. Still resolved by <code>findCryptidPreset</code> for profiles saved before the roller existed, so they have to keep rendering.'
          : MOOD_BLURB[mood];
      const cards = group
        .map((entry) => {
          const flagged = entry.issues.length > 0;
          const tight = entry.markerFont < 6;
          return `<article class="card${flagged ? ' flagged' : ''}" data-mood="${entry.mood}" data-variants='${escapeHtml(JSON.stringify(entry.variants))}'>
  <header><h3>${escapeHtml(entry.creature)}</h3><span class="mood">${entry.mood}</span></header>
  <div class="sizes">
    <div class="size"><span class="tag">map</span><pre class="art marker" style="font-size:${entry.markerFont.toFixed(2)}px;line-height:${(entry.markerFont * 1.12).toFixed(2)}px"></pre></div>
    <div class="size"><span class="tag">roster</span><pre class="art roster" style="font-size:${ROSTER.fontSize}px;line-height:${ROSTER.lineHeight}px"></pre></div>
    <div class="size"><span class="tag">profile</span><pre class="art profile" style="font-size:${PROFILE.fontSize}px;line-height:${PROFILE.lineHeight}px"></pre></div>
  </div>
  <footer>
    <span class="readout${tight ? ' tight' : ''}">${entry.lines}L &times; ${entry.columns}C &middot; ${entry.markerFont.toFixed(2)}px</span>
    ${flagged ? `<span class="issue">${escapeHtml(entry.issues.join(' '))}</span>` : ''}
  </footer>
</article>`;
        })
        .join('\n');
      return `<section data-section="${mood}">
  <h2>${mood}<span class="count">${group.length}</span></h2>
  <p class="blurb">${blurb}</p>
  <div class="grid">${cards}</div>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cryptid roster</title>
<style>
  :root {
    --bg: #0c0f14;
    --panel: #161b23;
    --map: #1d2530;
    --ink: #e8edf5;
    --dim: #7c8798;
    --line: #262f3c;
    --signal: #4cffab;
    --warn: #ffb020;
    --bad: #ff5f6d;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 13px/1.5 var(--mono);
  }
  header.page {
    position: sticky; top: 0; z-index: 10;
    background: rgba(12,15,20,.94); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line); padding: 16px 24px;
  }
  h1 { margin: 0 0 4px; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; }
  .sub { margin: 0 0 12px; color: var(--dim); font-size: 12px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button, select, label.toggle {
    font: inherit; color: var(--ink); background: var(--panel);
    border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer;
  }
  button:hover, select:hover, label.toggle:hover { border-color: var(--signal); }
  label.toggle { display: inline-flex; align-items: center; gap: 6px; user-select: none; }
  .spacer { flex: 1; }
  .face { color: var(--signal); }
  main { padding: 24px; }
  section { margin: 0 0 40px; }
  h2 {
    margin: 0 0 2px; font-size: 13px; letter-spacing: 3px; text-transform: uppercase;
    color: var(--signal); display: flex; align-items: baseline; gap: 10px;
  }
  .count { color: var(--dim); letter-spacing: 0; font-size: 11px; }
  .blurb { margin: 0 0 14px; color: var(--dim); font-size: 12px; max-width: 70ch; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 12px; display: flex; flex-direction: column; gap: 10px;
  }
  .card.flagged { border-color: var(--bad); }
  .card header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .card h3 { margin: 0; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; }
  .mood { color: var(--dim); font-size: 10px; letter-spacing: 1px; }
  .sizes { display: grid; grid-template-columns: auto auto 1fr; gap: 12px; align-items: center; min-height: 92px; }
  .size { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .tag { color: var(--dim); font-size: 9px; letter-spacing: 1px; text-transform: uppercase; }
  pre.art {
    margin: 0; color: var(--signal); white-space: pre; font-family: var(--mono);
  }
  pre.marker {
    background: var(--map); border-radius: 4px; padding: 4px 5px;
  }
  body.plain pre.marker { background: transparent; }
  footer { display: flex; flex-direction: column; gap: 4px; margin-top: auto; }
  .readout { color: var(--dim); font-size: 10px; }
  .readout.tight { color: var(--warn); }
  .issue { color: var(--bad); font-size: 10px; }
</style>
</head>
<body>
<header class="page">
  <h1>Cryptid roster</h1>
  <p class="sub">${entries.filter((e) => e.mood !== 'legacy').length} rollable &mdash; ${counts} &mdash; and ${CRYPTID_PRESETS.length} legacy presets. Each card shows the same drawing at map-marker size (the real 3&ndash;7px clamp from <code>sigilMetrics</code>), roster size (9px) and profile size (15px).</p>
  <div class="controls">
    <button id="shuffle">shuffle faces</button>
    <span class="face">eyes <select id="eyes"></select></span>
    <span class="face">mouth <select id="mouth"></select></span>
    <span class="face">colour <select id="colour"></select></span>
    <select id="mood"><option value="">all moods</option>${[...MOOD_ORDER, 'legacy']
      .map((m) => `<option value="${m}">${m}</option>`)
      .join('')}</select>
    <label class="toggle"><input type="checkbox" id="plain" /> no map panel</label>
    <span class="spacer"></span>
  </div>
</header>
<main>${sections}</main>
<script>
const EYES = ${JSON.stringify(EYES)};
const MOUTHS = ${JSON.stringify(MOUTHS)};
const COLOURS = ['#4CFFAB', '#FF6161', '#61B2FF', '#FFD24C', '#C77DFF', '#FFFFFF'];
const cards = [...document.querySelectorAll('.card')];
const eyesSel = document.getElementById('eyes');
const mouthSel = document.getElementById('mouth');
const colourSel = document.getElementById('colour');
const moodSel = document.getElementById('mood');

// "any" means each card picks independently, which is what a roster of friends
// actually looks like — one shared face across 48 cards reads as a single creature.
for (const [i, e] of EYES.entries()) eyesSel.add(new Option(e, String(i)));
eyesSel.add(new Option('any', 'any'));
for (const [i, m] of MOUTHS.entries()) mouthSel.add(new Option(m, String(i)));
mouthSel.add(new Option('any', 'any'));
for (const c of COLOURS) colourSel.add(new Option(c, c));

const variantsOf = (card) => JSON.parse(card.dataset.variants);
const pick = (n) => Math.floor(Math.random() * n);

function paint() {
  const eyeChoice = eyesSel.value;
  const mouthChoice = mouthSel.value;
  const colour = colourSel.value;
  const mood = moodSel.value;
  for (const card of cards) {
    const variants = variantsOf(card);
    // Legacy presets have exactly one variant; the roster has EYES.length * MOUTHS.length.
    const e = variants.length === 1 ? 0 : (eyeChoice === 'any' ? pick(EYES.length) : Number(eyeChoice));
    const m = variants.length === 1 ? 0 : (mouthChoice === 'any' ? pick(MOUTHS.length) : Number(mouthChoice));
    const sigil = variants.length === 1 ? variants[0] : variants[e * MOUTHS.length + m];
    for (const pre of card.querySelectorAll('pre.art')) {
      pre.textContent = sigil;
      pre.style.color = colour;
    }
    card.style.display = !mood || card.dataset.mood === mood ? '' : 'none';
  }
  for (const section of document.querySelectorAll('section')) {
    section.style.display = !mood || section.dataset.section === mood ? '' : 'none';
  }
}

for (const el of [eyesSel, mouthSel, colourSel, moodSel]) el.addEventListener('change', paint);
document.getElementById('shuffle').addEventListener('click', () => {
  eyesSel.value = 'any';
  mouthSel.value = 'any';
  paint();
});
document.getElementById('plain').addEventListener('change', (event) => {
  document.body.classList.toggle('plain', event.target.checked);
});
eyesSel.value = 'any';
mouthSel.value = 'any';
paint();
</script>
</body>
</html>
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entries = [...CRYPTID_FORMS.map(entryFor), ...legacyEntries()];

  await mkdir(args.out, { recursive: true });
  const file = join(args.out, 'index.html');
  await writeFile(file, renderPage(entries), 'utf8');

  const flagged = entries.filter((entry) => entry.issues.length > 0);
  const tight = entries.filter(
    (entry) => entry.issues.length === 0 && entry.markerFont < 6 && entry.mood !== 'legacy'
  );
  console.log(
    `${CRYPTID_FORMS.length} rollable cryptids + ${CRYPTID_PRESETS.length} legacy presets`
  );
  for (const mood of MOOD_ORDER) {
    console.log(`  ${mood.padEnd(7)} ${entries.filter((e) => e.mood === mood).length}`);
  }
  if (tight.length > 0) {
    console.log(
      `\n${tight.length} render under 6px on the map: ${tight.map((e) => e.creature).join(', ')}`
    );
  }
  for (const entry of flagged) {
    console.error(`FAIL ${entry.creature}: ${entry.issues.join(' ')}`);
  }
  console.log(`\n-> ${file}`);
  if (flagged.length > 0) process.exitCode = 1;
}

await main();
