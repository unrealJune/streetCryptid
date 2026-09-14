/**
 * Photograph the bottom island in every state it has, on the REAL app.
 *
 * Same machinery as `store-shots.ts` — the web build with the Rust core as wasm,
 * driven in Chrome over `cdp.ts` — but aimed at the drawer rather than at a
 * marketing plate: no framing pass, no headline, one capture per detent so the
 * states can be read against each other.
 *
 *   bunx expo export --platform web --output-dir <dir>   (fixtures on)
 *   bun scripts/island-preview.ts --web-build <dir> --out <dir>
 *
 * Safe-area insets are INJECTED (`--insets top,bottom`). A browser reports zero
 * for both, and the whole question this exists to answer — how much room the
 * island leaves the gesture bar — is a question about a non-zero bottom inset.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FIXTURE_ANCHOR } from '../src/features/dev/fixtures/people';
import { emulateDevice, launch, setGeolocation, type Browser, type Page } from './cdp';
import { serveFixedRoutes, serveWebBuild, sleep } from './shot-server';

const HANDLE = '@wanderer';

interface Args {
  webBuild: string;
  out: string;
  insetTop: number;
  insetBottom: number;
  scale: number;
  headless: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    webBuild: process.env.SC_SHOTS_WEB_BUILD ?? '.expo/web-island-preview',
    out: 'store/island-preview',
    insetTop: 59,
    insetBottom: 34,
    scale: 2,
    headless: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--web-build') args.webBuild = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--scale') args.scale = Number(argv[++i]);
    else if (arg === '--headed') args.headless = false;
    else if (arg === '--insets') {
      const [top, bottom] = argv[++i].split(',').map(Number);
      args.insetTop = top;
      args.insetBottom = bottom;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/**
 * Make the browser report a phone's safe-area insets.
 *
 * `react-native-safe-area-context` measures the computed padding of one hidden
 * fixed element it appends to `<body>`, whose padding is `env(safe-area-inset-*)`
 * — zero everywhere but an actual notched device. The padding is inline, so only
 * `!important` from a stylesheet can outrank it, and the rule has to be in the
 * document BEFORE the provider mounts: it reads the element once on mount and
 * then only on transitionend.
 */
function insetShim(top: number, bottom: number): string {
  const rule = `body > div[style*="z-index"][style*="visibility: hidden"] { padding: ${top}px 0px ${bottom}px 0px !important; }`;
  // Deferred until there is somewhere to put it: this runs before the parser has
  // built <head>, so appending straight away throws and the shim silently never
  // installs. The provider mounts with the JS bundle, long after DOMContentLoaded.
  return `(() => {
    const install = () => {
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(rule)};
      (document.head ?? document.documentElement).appendChild(style);
    };
    if (document.head) install();
    else document.addEventListener('DOMContentLoaded', install, { once: true });
  })()`;
}

async function clickText(page: Page, text: string): Promise<boolean> {
  return page.eval<boolean>(`(() => {
    const want = ${JSON.stringify(text)}.toLowerCase();
    const nodes = [...document.querySelectorAll('[role="button"], button, [aria-label]')].filter(
      (node) => node.getAttribute('aria-disabled') !== 'true'
    );
    const nameOf = (node) =>
      (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().toLowerCase();
    const el =
      nodes.find((node) => nameOf(node) === want) ?? nodes.find((node) => nameOf(node).includes(want));
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.click();
    return true;
  })()`);
}

async function mustClick(page: Page, text: string): Promise<void> {
  if (await clickText(page, text)) return;
  const names = await page.eval<string[]>(`(() => {
    const seen = new Set();
    for (const node of document.querySelectorAll('[role="button"], button, [aria-label]')) {
      const name = (node.getAttribute('aria-label') ?? node.textContent ?? '').trim();
      if (name && name.length < 60) seen.add(name);
    }
    return [...seen].slice(0, 30);
  })()`);
  throw new Error(`no control named "${text}". On screen: ${names.join(' | ')}`);
}

async function typeInto(page: Page, selector: string, value: string): Promise<boolean> {
  const focused = await page.eval<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
  if (!focused) return false;
  await page.send('Input.insertText', { text: value });
  return true;
}

async function waitFor(page: Page, predicate: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.eval<boolean>(`Boolean(${predicate})`).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

async function onboard(page: Page): Promise<void> {
  const atProfile = await waitFor(page, `document.querySelector('input')`);
  if (!atProfile) return;

  await clickText(page, 'Randomize persona');
  await sleep(600);
  await typeInto(page, 'input', HANDLE);
  await sleep(600);
  await clickText(page, 'Continue');

  const atDelivery = await waitFor(
    page,
    `!!document.querySelector('[data-testid="delivery-onboarding"]')`,
    20_000
  );
  if (atDelivery) {
    await sleep(1200);
    await clickText(page, 'Continue');
    await sleep(900);
  }

  const atDisclosure = await waitFor(
    page,
    `[...document.querySelectorAll('*')].some((n) => n.textContent === 'Turn on location')`,
    20_000
  );
  if (atDisclosure) {
    await clickText(page, 'Turn on location');
    await sleep(1200);
  }

  const atMap = await waitFor(
    page,
    `[...document.querySelectorAll('*')].some((n) => n.textContent === 'FRIENDS')`,
    30_000
  );
  if (!atMap) throw new Error('onboarding did not reach the map');
}

/**
 * Drag the drawer's grip, as a finger would.
 *
 * TOUCH events, not mouse: the page is emulating a phone
 * (`Emulation.setTouchEmulationEnabled`), and a dispatched mouse event in that
 * mode reaches react-native-gesture-handler's web recogniser as a hover rather
 * than as a pan — the drawer simply does not move. Moves are stepped so the pan
 * accumulates a plausible velocity instead of teleporting.
 */
async function dragGrip(page: Page, width: number, from: number, to: number): Promise<void> {
  const x = Math.round(width / 2);
  const steps = 14;
  const point = (y: number) => [{ x, y, radiusX: 10, radiusY: 10, force: 1 }];
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
  for (let step = 1; step <= steps; step++) {
    const y = Math.round(from + ((to - from) * step) / steps);
    await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(y) });
    await sleep(16);
  }
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(1000);
}

/** Top edge of the tab row, in CSS pixels — the floor a downward drag must stop above. */
async function tabsTop(page: Page): Promise<number> {
  return page.eval<number>(`(() => {
    const tab = document.querySelector('[role="tab"]');
    return tab ? Math.round(tab.getBoundingClientRect().top) : 0;
  })()`);
}

/**
 * Top edge of the island, in CSS pixels — where the grip is, and the only honest
 * read of which detent the drawer settled at.
 *
 * NOT `aria-valuetext`: the grip is an `accessibilityRole="adjustable"` carrying
 * `accessibilityValue.text`, and react-native-web renders the role (`slider`) and
 * the label but drops the value entirely, so the app's own statement of its size
 * is unreadable here. Geometry is what is left.
 */
async function islandTop(page: Page): Promise<number> {
  return page.eval<number>(`(() => {
    const grip = document.querySelector('[aria-label="Panel size"]');
    if (!grip) return -1;
    return Math.round(grip.getBoundingClientRect().top);
  })()`);
}

/**
 * Lay the captures out side by side as one sheet.
 *
 * Rendered in the same browser rather than composed by hand: the plates are just
 * `<img>` on a page served next to them, so the layout costs a template string
 * and the result is one image that can be read in a single glance instead of
 * five that have to be flicked between.
 */
async function contactSheet(
  browser: Browser,
  shots: readonly { file: string; caption: string }[],
  device: { width: number; height: number },
  out: string
): Promise<string> {
  const PLATE = 300;
  const CAPTION = 44;
  const GAP = 20;
  const plateHeight = Math.round((PLATE * device.height) / device.width);
  const files = new Map(shots.map((shot, index) => [`/${index}.png`, shot.file]));
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #12151a; font: 500 13px/1.3 ui-monospace, monospace; }
    .sheet { display: flex; gap: ${GAP}px; padding: ${GAP}px; }
    figure { margin: 0; width: ${PLATE}px; }
    img { width: ${PLATE}px; height: ${plateHeight}px; display: block; border-radius: 10px; }
    figcaption { color: #cdd6e0; padding-top: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
  </style><div class="sheet">${shots
    .map(
      (shot, index) =>
        `<figure><img src="/${index}.png"><figcaption>${shot.caption}</figcaption></figure>`
    )
    .join('')}</div>`;

  const server = await serveFixedRoutes({ files, pages: new Map([['/', html]]) });
  const page = await browser.newPage('about:blank');
  try {
    await emulateDevice(page, {
      width: shots.length * (PLATE + GAP) + GAP,
      height: plateHeight + CAPTION + GAP * 2,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.send('Page.navigate', { url: `${server.origin}/` });
    await sleep(1500);
    const file = join(out, 'contact-sheet.png');
    await writeFile(file, await page.screenshot());
    return file;
  } finally {
    await page.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const device = { width: 430, height: 932 };
  await mkdir(args.out, { recursive: true });

  const hosted = await serveWebBuild(args.webBuild);
  const browser = await launch({ headless: args.headless });
  const shots: { file: string; caption: string }[] = [];

  try {
    const page = await browser.newPage('about:blank');

    const shoot = async (name: string, caption: string): Promise<void> => {
      // How far the tab row's bottom edge sits above the screen's, printed at every
      // state: the bar is the app's only navigation and is present at every detent,
      // so it must not travel as the drawer opens. One number, five times, same value.
      // Against the EMULATED height, not `innerHeight`: the CDP evaluation context
      // reports the real browser window, which on a headless run is nothing like the
      // device metrics the page is actually laid out at.
      const clearance = await page.eval<number>(`(() => {
        const tab = document.querySelector('[role="tab"]');
        return tab ? Math.round(${device.height} - tab.getBoundingClientRect().bottom) : -1;
      })()`);
      const png = await page.screenshot();
      const file = join(args.out, `${name}.png`);
      await writeFile(file, png);
      shots.push({ file, caption });
      console.log(
        `  ${name} -> ${file} (${png.length.toLocaleString()} bytes, tabs ${clearance}pt off the bottom)`
      );
    };

    await emulateDevice(page, {
      width: device.width,
      height: device.height,
      deviceScaleFactor: args.scale,
      mobile: true,
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: insetShim(args.insetTop, args.insetBottom),
    });
    await setGeolocation(page, { latitude: FIXTURE_ANCHOR.lat, longitude: FIXTURE_ANCHOR.lon });

    process.stdout.write('first run … ');
    await page.send('Page.navigate', { url: `${hosted.origin}/` });
    await onboard(page);
    console.log('done');

    /**
     * Drag the grip in one direction until the page says the drawer arrived.
     *
     * The test is the CONTENT, not the geometry: peek and collapsed differ by
     * about eighty points on the ME panel, which no height threshold separates
     * reliably across both bodies — but a body that is collapsed is one that has
     * stopped rendering everything below its first line, and that is unambiguous.
     *
     * The end point stays clear of the tab bar: a drag released ON it is also a
     * tap on whichever tab is under the finger, which silently swapped the panel
     * and photographed the roster as though it were a minimized ME.
     */
    const dragUntil = async (what: string, predicate: string, down: boolean): Promise<void> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await page.eval<boolean>(`Boolean(${predicate})`)) return;
        const top = await islandTop(page);
        if (top < 0) throw new Error('the drawer is showing no grip to drag');
        // Downward travel stops just above the tab row — releasing on it is also a
        // tap on a tab. On the ME panel that floor is barely below the grip, which
        // is exactly why this is measured rather than a constant off the screen
        // bottom: a fixed 130pt clamp left 22pt of travel and the drawer never moved.
        const floor = (await tabsTop(page)) - 12;
        const to = down ? Math.min(top + 300, floor) : Math.max(top - 380, device.height * 0.1);
        await dragGrip(page, device.width, top + 8, Math.round(to));
        await sleep(400);
      }
      throw new Error(`drawer would not reach ${what}`);
    };
    const NO_SECTOR_BAR = `!document.body.textContent.includes('PERCENT EXPLORED')`;
    const NO_ROSTER_ROWS = `!document.body.textContent.includes('HERE NOW')`;
    const DOCKED = `document.querySelector('[aria-label="Panel size"]').getBoundingClientRect().top < ${Math.round(device.height * 0.16)}`;

    // Let the demo walk fold in — the coverage readout climbs for a few seconds
    // after the map itself looks finished.
    await sleep(7000);
    const insets = await page.eval<string>(
      `JSON.stringify([...document.querySelectorAll('body > div')]
        .filter((n) => n.style.zIndex === '-1')
        .map((n) => getComputedStyle(n).padding))`
    );
    console.log(`  reported safe-area padding: ${insets}`);
    await shoot('01-me-peek', 'ME · summary');

    await dragUntil('minimized ME', NO_SECTOR_BAR, true);
    await shoot('02-me-collapsed', 'ME · minimized');

    await mustClick(page, 'FRIENDS');
    await sleep(1800);
    await shoot('03-friends-peek', 'Friends · summary');

    await dragUntil('minimized FRIENDS', NO_ROSTER_ROWS, true);
    await shoot('04-friends-collapsed', 'Friends · minimized');

    await dragUntil('full screen', DOCKED, false);
    await sleep(1400);
    await shoot('05-friends-full', 'Friends · full');
    await page.close();

    const sheet = await contactSheet(browser, shots, device, args.out);
    console.log(`  contact sheet -> ${sheet}`);
  } finally {
    await browser.close();
    await hosted.close();
  }

  console.log(`\n${shots.length} captures in ${args.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
