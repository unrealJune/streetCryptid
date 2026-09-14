/**
 * App Store / Play screenshot generator — drives the REAL app (the web build,
 * with the Rust core running as wasm) in Chrome at exact device metrics, then
 * frames each capture with a headline.
 *
 * This is the same trick `map-shot.ts` plays one level up: rather than a
 * simulator we cannot run on this machine, use the wasm path the project
 * already ships (`modules/iroh-location/rust-wasm`, `just build-wasm`) and the
 * CanvasKit build of Skia the web target already loads. What comes out is the
 * app's own components, its own shaders and its own tiles — not a mockup.
 *
 * Two phases, both in Chrome over CDP (`cdp.ts`):
 *
 *   1. CAPTURE. For each device preset, emulate its exact metrics, override
 *      geolocation, drive the app to each scene, and screenshot. Output lands
 *      at `width × height` in real pixels, which is the only thing App Store
 *      Connect checks before rejecting an upload.
 *   2. FRAME. Compose each capture into the marketing plate — headline, device
 *      bezel, brand ground — as an HTML page rendered at the SAME device size,
 *      so the text is laid out by the browser with the app's own fonts rather
 *      than by hand in a canvas.
 *
 * Needs a `bunx expo export -p web` output directory (`--web-build`), built
 * with `EXPO_PUBLIC_SCREENSHOT_FIXTURES=1` so the demo friends and demo walk are
 * compiled in, and a CORS-adding proxy in front of the tile server — the coarse
 * tile path sends no `Access-Control-Allow-Origin`, so a browser cannot read it
 * directly. `just store-shots` wires all of that up.
 *
 *   just store-shots
 *   just store-shots "--devices ios-6.9 --scenes map,friends"
 *   just store-shots "--raw-only"          # skip the framing pass
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FIXTURE_ANCHOR } from '../src/features/dev/fixtures/people';
import { emulateDevice, launch, setGeolocation, type Page } from './cdp';
import { serveFixedRoutes, serveWebBuild, sleep } from './shot-server';

// --- Devices -----------------------------------------------------------------

interface Device {
  id: string;
  /** What App Store Connect calls this size, for the run summary. */
  label: string;
  /** CSS pixels — the layout the app sees. */
  width: number;
  height: number;
  /** Capture scale. width × scale must equal the required upload resolution. */
  scale: number;
  mobile: boolean;
}

const DEVICES: readonly Device[] = [
  // iPhone 16 Pro Max / 17 Pro Max class. ASC "6.9-inch display" — required.
  {
    id: 'ios-6.9',
    label: 'iPhone 6.9" (1290×2796)',
    width: 430,
    height: 932,
    scale: 3,
    mobile: true,
  },
  // iPad Pro 13" (M4). ASC "13-inch display" — required while supportsTablet is true.
  {
    id: 'ipad-13',
    label: 'iPad 13" (2064×2752)',
    width: 1032,
    height: 1376,
    scale: 2,
    mobile: true,
  },
];

// --- Scenes ------------------------------------------------------------------

interface Scene {
  id: string;
  /** The headline on the framed plate. Kept short — this is read at thumbnail size. */
  headline: string;
  /** One supporting line, uppercased and letterspaced in the frame. */
  kicker: string;
  /** Drive the app into the state worth photographing, starting from the map. */
  prepare?(page: Page, device: Device): Promise<void>;
  /**
   * Return to the map after the shot.
   *
   * Always the screen's OWN dismiss control, never `history.back()`: the pairing
   * sheet and the settings modal are presented without pushing a history entry,
   * so going back from either walks off the origin entirely and kills the CDP
   * target ("Inspected target navigated or closed").
   */
  reset?(page: Page): Promise<void>;
  /** Extra settle time for scenes that animate in. */
  settleMs?: number;
}

/**
 * Click the control whose accessible name is `text`.
 *
 * react-native-web renders `Pressable` as a `<div role="button">` with no id or
 * class worth matching, so the accessible name is the only stable handle — and
 * it is the one the app already maintains, for VoiceOver.
 *
 * An EXACT name wins over a containing one, and that ordering is load-bearing
 * rather than tidiness. Accessible names nest: the friends drawer labels itself
 * with a summary sentence that contains the word "friends", so a plain
 * substring match clicks the drawer instead of the FRIENDS tab inside it — a
 * silent miss that photographs the previous screen rather than failing.
 */
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

/**
 * Click `text`, or fail the run naming what was actually on screen.
 *
 * The failure mode this exists to prevent is silent: a missed click leaves the
 * app on the previous screen, the capture succeeds, and the wrong picture ends
 * up in the listing looking entirely plausible. Better to stop and say so.
 */
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

/**
 * Zoom the map by scrolling on it, the way a trackpad would.
 *
 * `Input.dispatchMouseEvent` rather than a synthetic DOM event: the map's
 * gesture handling reads real wheel input, and a dispatched `WheelEvent` from
 * page script does not carry the same trusted path. Steps are separated so the
 * camera animates between them instead of jumping.
 */
async function zoomMap(page: Page, device: Device, steps: number): Promise<void> {
  for (let step = 0; step < Math.abs(steps); step++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(device.width / 2),
      y: Math.round(device.height * 0.42),
      deltaX: 0,
      deltaY: steps > 0 ? -120 : 120,
    });
    await sleep(420);
  }
}

/**
 * Type into a field the way a person does — focus, then real key events.
 *
 * Assigning `.value` is not enough: react-native-web's `TextInput` listens for
 * the synthetic change React raises off a genuine input event, so a direct
 * assignment leaves the component's state (and the Continue button's disabled
 * flag) exactly where it was.
 */
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

/** True once the element exists, polled — RN-Web mounts screens asynchronously. */
async function waitFor(page: Page, predicate: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.eval<boolean>(`Boolean(${predicate})`).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Walk first run: pick a persona, claim a handle, choose a delivery route, and
 * accept the location disclosure. This is the app's real onboarding, driven
 * rather than bypassed — a fresh browser profile starts here every time, and
 * the map is behind it.
 *
 * Every step after the first is probed rather than assumed. Onboarding gains
 * screens (the delivery choice is the most recent), and a run that walked a
 * fixed number of Continues did not fail — it photographed whatever screen it
 * had stalled on and labelled it `map`.
 */
async function onboard(page: Page, handle: string): Promise<void> {
  const atProfile = await waitFor(page, `document.querySelector('input')`);
  if (!atProfile) return; // Already onboarded (a reused profile), or a deep link.

  await clickText(page, 'Randomize persona');
  await sleep(600);
  await typeInto(page, 'input', handle);
  await sleep(600);
  await clickText(page, 'Continue');

  // The delivery choice, second half of the account onboarding. It keeps its
  // default; this only gets past it.
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

  // The background-location disclosure gate stands between onboarding and the
  // map on every platform (Play requires it); accept it explicitly.
  const atDisclosure = await waitFor(
    page,
    `[...document.querySelectorAll('*')].some((n) => n.textContent === 'Turn on location')`,
    20_000
  );
  if (atDisclosure) {
    await clickText(page, 'Turn on location');
    await sleep(1200);
  }

  // Nothing below this point can recover from still being in onboarding, and a
  // capture that silently photographs the wrong screen is worse than a failure.
  const atMap = await waitFor(
    page,
    `[...document.querySelectorAll('*')].some((n) => n.textContent === 'FRIENDS')`,
    30_000
  );
  if (!atMap) throw new Error('onboarding did not reach the map');
}

/**
 * The scenes, in listing order.
 *
 * Every one starts from the map and gets where it is going by CLICKING, not by
 * navigating. `Page.navigate` reloads the document, which on this app means
 * booting the whole thing again — CanvasKit, the wasm node, a fresh tile fetch,
 * and first-run onboarding a second time if storage did not survive. Driving the
 * real controls is both faster and a truer picture of the screen, since it is
 * the state a user would actually be looking at when they got there.
 *
 * `depth` is how many history entries the scene pushed, so the run can walk back
 * to the map before the next one.
 */
const SCENES: readonly Scene[] = [
  {
    id: 'map',
    headline: 'Only your friends\ncan see you.',
    kicker: 'End-to-end encrypted · peer-to-peer',
    // The first shot waits out the exploration backfill as well as the tiles:
    // the demo walk is folded in one fix at a time, and the coverage readout
    // climbs for a few seconds after the map itself looks finished.
    settleMs: 7_000,
  },
  {
    id: 'friends',
    headline: 'Everyone you\nchose. No feed.',
    kicker: 'No accounts · no ads · no brokers',
    settleMs: 1800,
    async prepare(page) {
      await mustClick(page, 'FRIENDS');
      await sleep(1200);
    },
  },
  {
    id: 'pairing',
    headline: 'Pair in person.\nNo phone numbers.',
    kicker: 'Bump over Bluetooth · or a one-time link',
    settleMs: 3000,
    async prepare(page) {
      await mustClick(page, 'FRIENDS');
      await sleep(900);
      await mustClick(page, 'Open pairing');
      await sleep(1600);
      // Go on to the LINK half of pairing rather than photographing the screen
      // as it opens. Bump is the headline gesture, but it is Bluetooth, so on
      // the web build it renders "PAIRING UNAVAILABLE — installed build
      // required" — a true statement about a browser and a nonsense one in an
      // iOS listing. The one-time link runs the same handshake and the same
      // crypto, works here, and produces a real invite to photograph.
      await mustClick(page, 'Make a link');
      await sleep(2500);
    },
    async reset(page) {
      await mustClick(page, 'Close pairing');
      await sleep(1200);
    },
  },
  {
    id: 'coverage',
    headline: 'The map remembers\nwhere you walked.',
    kicker: 'Your trail · your coverage · yours alone',
    settleMs: 3500,
    async prepare(page, device) {
      // Zoom in rather than switching tabs: the ME island is already what the
      // first shot shows, and clicking it again only expands the drawer over
      // the very thing this plate is about. Closer in, the walked sectors fill
      // the frame and the coverage readout counts a neighbourhood instead of
      // half the city.
      await zoomMap(page, device, 3);
      await sleep(1500);
    },
  },
  {
    id: 'delivery',
    headline: 'You decide how\nit travels.',
    kicker: 'Direct · via mutuals · via your stash',
    settleMs: 1800,
    async prepare(page) {
      await mustClick(page, 'Settings');
      await sleep(1600);
      // One level in, to the screen the headline is actually about. The settings
      // menu itself is a list of rows ending in DEBUG — honest, since that
      // section does ship, but not what this plate is claiming.
      await mustClick(page, 'Delivery options');
      await sleep(1400);
    },
    async reset(page) {
      await mustClick(page, 'Back to settings');
      await sleep(900);
      await mustClick(page, 'Close settings');
      await sleep(1200);
    },
  },
];

// --- Brand -------------------------------------------------------------------

/** Transcribed from `src/constants/cryptid-theme.ts` — deepsea, the dark alternate. */
/** The handle first run claims. Shown on the ME island, so keep it plausible. */
const HANDLE = process.env.SC_SHOTS_HANDLE ?? 'june';

const BRAND = {
  ground: '#0d1a24',
  groundLow: '#132635',
  ink: '#eaf2f7',
  steel: '#8fa9ba',
  amber: '#d67c1a',
  bezel: '#05101a',
};

// --- Run ---------------------------------------------------------------------

interface Args {
  server: string;
  webBuild: string | null;
  devices: string[] | null;
  scenes: string[] | null;
  out: string;
  rawOnly: boolean;
  headless: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    server: process.env.SC_SHOTS_SERVER ?? 'http://localhost:8081',
    webBuild: process.env.SC_SHOTS_WEB_BUILD ?? null,
    devices: null,
    scenes: null,
    out: 'store/screenshots',
    rawOnly: false,
    headless: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--server') args.server = argv[++i];
    else if (arg === '--web-build') args.webBuild = argv[++i];
    else if (arg === '--devices') args.devices = argv[++i].split(',');
    else if (arg === '--scenes') args.scenes = argv[++i].split(',');
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--raw-only') args.rawOnly = true;
    else if (arg === '--headless') args.headless = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const devices = args.devices
    ? DEVICES.filter((device) => args.devices!.includes(device.id))
    : DEVICES;
  const scenes = args.scenes ? SCENES.filter((scene) => args.scenes!.includes(scene.id)) : SCENES;
  if (devices.length === 0) throw new Error('no devices selected');
  if (scenes.length === 0) throw new Error('no scenes selected');

  const rawDir = join(args.out, 'raw');
  await mkdir(rawDir, { recursive: true });

  const hosted = args.webBuild ? await serveWebBuild(args.webBuild) : null;
  const origin = hosted?.origin ?? args.server;
  console.log(`serving the app from ${hosted ? `${args.webBuild} at ${origin}` : origin}`);

  const browser = await launch({ headless: args.headless });
  const captured: { device: Device; scene: Scene; file: string }[] = [];

  try {
    for (const device of devices) {
      console.log(`\n=== ${device.label} ===`);
      const page = await browser.newPage('about:blank');
      await emulateDevice(page, {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.scale,
        mobile: device.mobile,
      });
      // The same constant the demo fixtures stage themselves around, so the
      // browser's reported position and the invented neighbourhood are the same
      // place by construction rather than by two values that happen to agree.
      await setGeolocation(page, {
        latitude: FIXTURE_ANCHOR.lat,
        longitude: FIXTURE_ANCHOR.lon,
      });

      // Onboard once per browser page: the profile and the disclosure choice
      // both persist, so every later navigation lands straight on the map.
      process.stdout.write('  first run … ');
      await page.send('Page.navigate', { url: `${origin}/` });
      await waitForApp(page);
      await onboard(page, HANDLE);
      console.log('done');

      for (const scene of scenes) {
        process.stdout.write(`  ${scene.id} … `);
        await scene.prepare?.(page, device);
        await sleep(scene.settleMs ?? 1500);
        const png = await page.screenshot();
        const file = join(rawDir, `${device.id}-${scene.id}.png`);
        await writeFile(file, png);
        captured.push({ device, scene, file });
        console.log(`${png.length.toLocaleString()} bytes -> ${file}`);

        // Back to the map, so the next scene starts where it expects to.
        await scene.reset?.(page);
      }
      await page.close();
    }

    if (!args.rawOnly) {
      await frameAll(browser, captured, args.out);
    }
  } finally {
    await browser.close();
    await hosted?.close();
  }

  console.log(`\nDone. ${captured.length} capture(s) under ${args.out}/`);
}

/**
 * Wait until the app has actually painted something — a mounted root with real
 * children. Metro serves the shell instantly and the bundle takes seconds, so
 * a fixed sleep is either flaky or wasteful.
 */
async function waitForApp(page: Page, timeoutMs = 420_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page
      .eval<string>(
        `(() => {
          // Chrome's own network-error page has a body but never an Expo root,
          // so keying on #root is what keeps a refused connection from being
          // screenshotted as if it were the app.
          if (document.querySelector('.error-code, #main-frame-error')) return 'error';
          const root = document.getElementById('root');
          if (!root || root.childElementCount === 0) return 'waiting';
          // A canvas means Skia is up (the map); a settings route has no canvas
          // but does render its own subtree.
          return root.querySelector('canvas') || root.textContent.trim().length > 0
            ? 'ready'
            : 'waiting';
        })()`
      )
      .catch(() => 'waiting');
    if (state === 'ready') return;
    if (state === 'error') throw new Error('the page failed to load — is the server up?');
    await sleep(400);
  }
  throw new Error('app never painted — is the server bundling?');
}

// --- Framing -----------------------------------------------------------------

/**
 * Compose the plates. The captures are served from a throwaway local server
 * rather than inlined as data URIs: a 1290×2796 PNG base64s to several MB, and
 * `Page.navigate` is not a reliable way to move that much.
 */
async function frameAll(
  browser: { newPage(url?: string): Promise<Page> },
  captured: { device: Device; scene: Scene; file: string }[],
  outRoot: string
): Promise<void> {
  const pages = new Map<string, string>();
  const files = new Map<string, string>();
  for (const shot of captured) {
    files.set(`/shot/${shot.device.id}-${shot.scene.id}.png`, shot.file);
  }

  const server = await serveFixedRoutes({ files, pages });
  const origin = server.origin;
  const fonts = await loadFonts();

  try {
    const byDevice = new Map<string, typeof captured>();
    for (const shot of captured) {
      const list = byDevice.get(shot.device.id) ?? [];
      list.push(shot);
      byDevice.set(shot.device.id, list);
    }

    for (const [deviceId, shots] of byDevice) {
      const device = shots[0].device;
      const dir = join(outRoot, deviceId);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });

      const page = await browser.newPage('about:blank');
      await emulateDevice(page, {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.scale,
        mobile: false,
      });

      console.log(`\n=== framing ${device.label} ===`);
      let index = 0;
      for (const shot of shots) {
        index += 1;
        const path = `/frame/${deviceId}-${shot.scene.id}.html`;
        pages.set(
          path,
          framePage({
            device,
            scene: shot.scene,
            shotUrl: `${origin}/shot/${deviceId}-${shot.scene.id}.png`,
            fonts,
          })
        );
        await page.send('Page.navigate', { url: `${origin}${path}` });
        await page.once('Page.loadEventFired', 20_000).catch(() => {});
        // Webfonts and the (large) capture both have to be decoded before the
        // paint is final; `document.fonts.ready` plus image decode covers both.
        await page.eval(
          `Promise.all([
             document.fonts.ready,
             ...[...document.images].map((img) => img.decode().catch(() => {})),
           ])`
        );
        await sleep(250);
        const png = await page.screenshot();
        const file = join(dir, `${String(index).padStart(2, '0')}-${shot.scene.id}.png`);
        await writeFile(file, png);
        console.log(`  ${shot.scene.id} -> ${file}`);
      }
      await page.close();
    }
  } finally {
    await server.close();
  }
}

/**
 * The plate: kicker, headline, and the capture in a device bezel on brand ground.
 *
 * The device is sized by the space LEFT OVER rather than as a fraction of the
 * width — the headline is one or two lines depending on the scene, and the
 * tablet's proportions are nothing like the phone's, so any fixed fraction is
 * wrong for some combination. `flex: 1` on the stage plus `height: 100%` on the
 * image lets the browser solve it, and the bezel tracks the image with
 * `width: fit-content`.
 */
function framePage(input: {
  device: Device;
  scene: Scene;
  shotUrl: string;
  fonts: FontFaces;
}): string {
  const { device, scene, shotUrl, fonts } = input;
  const unit = Math.min(device.width, device.height);
  const bezel = Math.max(3, Math.round(unit * 0.012));
  const radius = Math.round(unit * 0.085);
  const headlineSize = Math.round(unit * 0.082);
  const kickerSize = Math.round(unit * 0.027);
  const padX = Math.round(device.width * 0.07);
  const padTop = Math.round(device.height * 0.055);
  const padBottom = Math.round(device.height * 0.045);

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Rajdhani';
    src: url('${fonts.rajdhani}') format('truetype');
    font-weight: 700; font-display: block;
  }
  @font-face {
    font-family: 'IBM Plex Mono';
    src: url('${fonts.plexMono}') format('truetype');
    font-weight: 500; font-display: block;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${device.width}px; height: ${device.height}px; overflow: hidden; }
  body {
    background:
      radial-gradient(128% 62% at 50% -8%, ${BRAND.groundLow} 0%, ${BRAND.ground} 68%),
      ${BRAND.ground};
    color: ${BRAND.ink};
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: ${padTop}px ${padX}px ${padBottom}px;
    font-family: 'Rajdhani', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .kicker {
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-weight: 500;
    font-size: ${kickerSize}px;
    letter-spacing: ${(kickerSize * 0.16).toFixed(2)}px;
    text-transform: uppercase;
    color: ${BRAND.amber};
    text-align: center;
    margin-bottom: ${Math.round(headlineSize * 0.44)}px;
  }
  h1 {
    font-weight: 700;
    font-size: ${headlineSize}px;
    line-height: 1.03;
    letter-spacing: ${(headlineSize * -0.014).toFixed(2)}px;
    text-align: center;
    white-space: pre-line;
    text-wrap: balance;
  }
  /* Takes whatever vertical space the headline did not, and centres in it. */
  .stage {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-top: ${Math.round(unit * 0.075)}px;
  }
  .device {
    height: 100%;
    width: fit-content;
    padding: ${bezel}px;
    border-radius: ${radius}px;
    background: ${BRAND.bezel};
    box-shadow:
      0 0 0 ${Math.max(1, Math.round(bezel * 0.24))}px rgba(255, 255, 255, 0.11),
      0 ${Math.round(device.height * 0.016)}px ${Math.round(device.height * 0.05)}px rgba(0, 0, 0, 0.55);
  }
  .device img {
    display: block;
    height: 100%;
    width: auto;
    border-radius: ${radius - bezel}px;
  }
</style></head>
<body>
  <div class="kicker">${escapeHtml(scene.kicker)}</div>
  <h1>${escapeHtml(scene.headline)}</h1>
  <div class="stage">
    <div class="device"><img src="${shotUrl}" alt=""></div>
  </div>
</body></html>`;
}

interface FontFaces {
  rajdhani: string;
  plexMono: string;
}

/**
 * The app's own typefaces, inlined as data URIs.
 *
 * Read from `node_modules/@expo-google-fonts/*` — the very files `_layout.tsx`
 * hands to `useFonts` — so the headline on the plate is set in the same metal as
 * the text inside the screenshot beside it. Inlined rather than linked because
 * the Google Fonts CDN is both a network dependency and a moving target: those
 * URLs carry a content hash that changes without notice, and a silently missing
 * face would render the whole set in Times before anyone noticed.
 */
async function loadFonts(): Promise<FontFaces> {
  const read = async (path: string): Promise<string> =>
    `data:font/ttf;base64,${(await readFile(path)).toString('base64')}`;
  return {
    rajdhani: await read('node_modules/@expo-google-fonts/rajdhani/700Bold/Rajdhani_700Bold.ttf'),
    plexMono: await read(
      'node_modules/@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf'
    ),
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  );
}

await main();
