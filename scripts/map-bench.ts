/**
 * Map smoothness benchmark — drives the REAL app (production web bundle, CanvasKit
 * Skia on WebGL, the wasm core) in Chrome with a phone's metrics and a throttled
 * CPU, lets the map's own scripted camera run (`perf/use-map-perf-runner.ts`), and
 * reports what a user would feel: how long the JS thread was blocked, how many
 * frames were dropped, and how long until each view was finished drawing.
 *
 * There is no iOS simulator on the machine this was built on, so this is the
 * `store-shots.ts` trick aimed at performance instead of pixels. Absolute numbers
 * are not a phone's (V8 is not Hermes, and CanvasKit is not native Skia); the
 * throttled CPU keeps them in the right order of magnitude, and before/after
 * comparisons on one machine are what it is for.
 *
 * Two runs per invocation: COLD (fresh browser profile — onboarding, empty tile
 * store) and WARM (a reload: tiles come from the persisted store).
 *
 *   just map-bench
 *   just map-bench "--cpu 6 --out /tmp/bench.json"
 *   bun scripts/map-bench.ts --web-build .expo/web-map-bench [--cpu 4] [--headless]
 *       [--runs cold,warm] [--out file.json] [--compare previous.json]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { emulateDevice, launch, setGeolocation, type Page } from './cdp';
import { serveWebBuild, sleep } from './shot-server';

/** Capitol Hill: a dense grid, parks, water and relief all inside one region. */
const HOME = { latitude: 47.6205, longitude: -122.3169 };
const DEVICE = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };
/** A frame this late is one a user sees as a stutter (two missed vsyncs at 60 Hz). */
const JANK_FRAME_MS = 34;

interface Args {
  webBuild: string;
  cpu: number;
  headless: boolean;
  runs: ('cold' | 'warm')[];
  out?: string;
  compare?: string;
  /** Write a V8 CPU profile of each run here (`<path>.<run>.cpuprofile`), for DevTools. */
  profile?: string;
  /** Screenshot every view once it is ready, into this directory (perturbs timing a little). */
  shots?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    webBuild: '.expo/web-map-bench',
    cpu: 4,
    headless: false,
    runs: ['cold', 'warm'],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--web-build') args.webBuild = argv[++i];
    else if (arg === '--cpu') args.cpu = Number(argv[++i]);
    else if (arg === '--headless') args.headless = true;
    else if (arg === '--runs') args.runs = argv[++i].split(',') as Args['runs'];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--compare') args.compare = argv[++i];
    else if (arg === '--profile') args.profile = argv[++i];
    else if (arg === '--shots') args.shots = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

/**
 * Installed before the app's own scripts: every long task and every frame, on
 * the page's clock (the same `performance.now()` the map-perf events carry).
 */
const PROBE = `(() => {
  const w = window;
  w.__bench = { long: [], frames: [] };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__bench.long.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  let last = null;
  const tick = (t) => {
    if (last !== null) w.__bench.frames.push([t, t - last]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

interface PerfEvent {
  type: string;
  scenario: string;
  atMs: number;
  [key: string]: unknown;
}

interface Window {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly status: string;
}

interface WindowStats {
  name: string;
  status: string;
  /** Scenario start → the map runner's "target ready" (fine detail covering the view). */
  readyMs: number;
  /** Scenario start → the LAST region drawn in the window: when the picture stops changing. */
  settledMs: number | null;
  /** Regions rasterized in the window (previews, detail, relief upgrades). */
  renders: number;
  renderMs: number;
  maxRenderMs: number;
  longTasks: number;
  longTaskMs: number;
  maxLongTaskMs: number;
  frames: number;
  jankFrames: number;
  maxFrameMs: number;
  p95FrameMs: number;
}

interface RunResult {
  run: string;
  /** The raw map-perf events, for digging past the summary. */
  events?: PerfEvent[];
  windows: WindowStats[];
  totals: Omit<WindowStats, 'name' | 'status' | 'readyMs' | 'settledMs'> & {
    readyMs: number;
    settledMs: number;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = await serveWebBuild(args.webBuild);
  const browser = await launch({ headless: args.headless, port: 9334 });
  const results: RunResult[] = [];
  try {
    const page = await browser.newPage('about:blank');
    await emulateDevice(page, DEVICE);
    await setGeolocation(page, HOME);
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

    const events: PerfEvent[] = [];
    let shotRun = '';
    let shotIndex = 0;
    if (args.shots) await mkdir(args.shots, { recursive: true });
    // The app's own errors, so a broken build reads as broken rather than as an empty table.
    let errors = 0;
    const report = (text: string) => {
      if (errors++ < 8) console.log(`  [page] ${text.slice(0, 400)}`);
    };
    page.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails as {
        exception?: { description?: string };
        text?: string;
      };
      report(details.exception?.description ?? details.text ?? 'exception');
    });
    page.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        report(
          ((params.args as { value?: unknown; description?: string }[]) ?? [])
            .map((a) => String(a.value ?? a.description ?? ''))
            .join(' ')
        );
      }
      const first = (params.args as { value?: unknown }[] | undefined)?.[0]?.value;
      if (typeof first !== 'string' || !first.startsWith('[map-perf] ')) return;
      try {
        const event = JSON.parse(first.slice('[map-perf] '.length)) as PerfEvent;
        events.push(event);
        if (args.shots && event.type === 'scenario-result') {
          const name = `${shotRun}-${String(shotIndex++).padStart(2, '0')}-${event.scenario}.png`;
          // Late enough for the last relief upgrade of the view to have landed.
          setTimeout(() => {
            void page.screenshot().then((png) => writeFile(`${args.shots}/${name}`, png));
          }, 200);
        }
      } catch {
        // A truncated console line is not a result.
      }
    });

    for (const run of args.runs) {
      events.length = 0;
      shotRun = run;
      shotIndex = 0;
      process.stdout.write(`\n=== ${run} (cpu ${args.cpu}×) ===\n`);
      const throttle = () => page.send('Emulation.setCPUThrottlingRate', { rate: args.cpu });
      // Onboarding runs unthrottled — it is in the way, not what is measured — and the
      // throttle goes on just before the map mounts. A warm launch is throttled from boot.
      await page.send('Emulation.setCPUThrottlingRate', { rate: run === 'cold' ? 1 : args.cpu });
      await page.send('Page.navigate', { url: `${server.origin}/` });
      await waitForApp(page);
      if (run === 'cold') await onboard(page, throttle);
      if (args.profile) {
        await page.send('Profiler.enable');
        await page.send('Profiler.setSamplingInterval', { interval: 500 });
        await page.send('Profiler.start');
      }
      const done = await waitForEvent(events, 'run-complete', 240_000);
      if (args.profile) {
        const { profile } = await page.send<{ profile: unknown }>('Profiler.stop');
        await writeFile(`${args.profile}.${run}.cpuprofile`, JSON.stringify(profile));
      }
      await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      // Late relief upgrades land after the runner calls the last view done.
      await sleep(1500);
      const probe = await page.eval<{ long: [number, number][]; frames: [number, number][] }>(
        'window.__bench'
      );
      if (!done) console.log('  (runner did not complete — partial results)');
      const result = summarize(run, events, probe);
      result.events = [...events];
      results.push(result);
      print(result);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (args.out) await writeFile(args.out, JSON.stringify(results, null, 2));
  if (args.compare)
    compare(JSON.parse(await readFile(args.compare, 'utf8')) as RunResult[], results);
}

function summarize(
  run: string,
  events: readonly PerfEvent[],
  probe: { long: [number, number][]; frames: [number, number][] }
): RunResult {
  // Scenario windows from the runner's own markers. `launch` starts at the
  // runner's mount, which is when the map screen appeared.
  const windows: Window[] = [];
  let open: { name: string; from: number } | null = null;
  for (const e of events) {
    if (e.type === 'runner-ready') open = { name: 'launch', from: e.atMs };
    else if (e.type === 'scenario-start' && e.scenario !== 'launch')
      open = { name: e.scenario, from: e.atMs };
    else if (e.type === 'scenario-result' && open) {
      windows.push({ ...open, to: e.atMs, status: String(e.status) });
      open = null;
    }
  }
  const renders = events.filter((e) => e.type === 'region-render' && e.cacheHit === false);
  const stats = windows.map((w, i): WindowStats => {
    // A window owns everything until the next one starts, so a relief upgrade
    // that lands after "ready" is counted against the view it changed.
    const until = windows[i + 1]?.from ?? Infinity;
    const inside = <T>(rows: readonly T[], at: (row: T) => number) =>
      rows.filter((row) => at(row) >= w.from && at(row) < until);
    const r = inside(renders, (e) => e.atMs);
    const long = inside(probe.long, ([start]) => start);
    const frames = inside(probe.frames, ([t]) => t)
      .map(([, dt]) => dt)
      .sort((a, b) => a - b);
    return {
      name: w.name,
      status: w.status,
      readyMs: w.to - w.from,
      settledMs: r.length ? r[r.length - 1].atMs - w.from : null,
      renders: r.length,
      renderMs: sum(r.map((e) => Number(e.totalMs))),
      maxRenderMs: Math.max(0, ...r.map((e) => Number(e.totalMs))),
      longTasks: long.length,
      longTaskMs: sum(long.map(([, d]) => d)),
      maxLongTaskMs: Math.max(0, ...long.map(([, d]) => d)),
      frames: frames.length,
      jankFrames: frames.filter((dt) => dt > JANK_FRAME_MS).length,
      maxFrameMs: frames.length ? frames[frames.length - 1] : 0,
      p95FrameMs: frames.length ? frames[Math.floor(frames.length * 0.95)] : 0,
    };
  });
  const phase = (key: string) => Math.round(sum(renders.map((e) => Number(e[key] ?? 0))));
  console.log(
    `  render phases: mask ${phase('maskMs')}  cellTexture ${phase('cellTextureMs')}  raster ${phase('rasterMs')}`
  );
  const totals = {
    readyMs: sum(stats.map((s) => s.readyMs)),
    settledMs: sum(stats.map((s) => s.settledMs ?? s.readyMs)),
    renders: sum(stats.map((s) => s.renders)),
    renderMs: sum(stats.map((s) => s.renderMs)),
    maxRenderMs: Math.max(0, ...stats.map((s) => s.maxRenderMs)),
    longTasks: sum(stats.map((s) => s.longTasks)),
    longTaskMs: sum(stats.map((s) => s.longTaskMs)),
    maxLongTaskMs: Math.max(0, ...stats.map((s) => s.maxLongTaskMs)),
    frames: sum(stats.map((s) => s.frames)),
    jankFrames: sum(stats.map((s) => s.jankFrames)),
    maxFrameMs: Math.max(0, ...stats.map((s) => s.maxFrameMs)),
    p95FrameMs: Math.max(0, ...stats.map((s) => s.p95FrameMs)),
  };
  return { run, windows: stats, totals };
}

const COLUMNS: [string, (s: WindowStats | RunResult['totals']) => string][] = [
  ['ready', (s) => ms(s.readyMs)],
  ['settled', (s) => (s.settledMs === null ? '—' : ms(s.settledMs))],
  ['renders', (s) => String(s.renders)],
  ['render', (s) => ms(s.renderMs)],
  ['maxRender', (s) => ms(s.maxRenderMs)],
  ['longTasks', (s) => `${s.longTasks}/${ms(s.longTaskMs)}`],
  ['maxTask', (s) => ms(s.maxLongTaskMs)],
  ['jank', (s) => `${s.jankFrames}/${s.frames}`],
  ['maxFrame', (s) => ms(s.maxFrameMs)],
  ['p95', (s) => ms(s.p95FrameMs)],
];

function print(result: RunResult): void {
  const rows = [
    ['view', ...COLUMNS.map(([name]) => name)],
    ...result.windows.map((w) => [
      w.status === 'complete' ? w.name : `${w.name}!`,
      ...COLUMNS.map(([, f]) => f(w)),
    ]),
    ['TOTAL', ...COLUMNS.map(([, f]) => f(result.totals))],
  ];
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  for (const r of rows) console.log('  ' + r.map((cell, c) => cell.padStart(widths[c])).join('  '));
}

function compare(before: readonly RunResult[], after: readonly RunResult[]): void {
  console.log('\n=== vs baseline ===');
  for (const a of after) {
    const b = before.find((r) => r.run === a.run);
    if (!b) continue;
    const line = (
      ['readyMs', 'settledMs', 'renderMs', 'longTaskMs', 'maxLongTaskMs', 'jankFrames'] as const
    )
      .map((k) => `${k} ${fmt(b.totals[k])} → ${fmt(a.totals[k])}`)
      .join('   ');
    console.log(`  ${a.run}: ${line}`);
  }
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const ms = (v: number) => `${Math.round(v)}`;
const fmt = (v: number) => String(Math.round(v));

async function waitForEvent(
  events: readonly PerfEvent[],
  type: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === type)) return true;
    await sleep(250);
  }
  return false;
}

// --- Driving the app (the same handles `store-shots.ts` uses) ----------------

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

async function waitFor(page: Page, predicate: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.eval<boolean>(`Boolean(${predicate})`).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

async function waitForApp(page: Page, timeoutMs = 120_000): Promise<void> {
  const ready = await waitFor(
    page,
    `(() => { const root = document.getElementById('root'); return root && root.childElementCount > 0 && (root.querySelector('canvas') || root.textContent.trim().length > 0); })()`,
    timeoutMs
  );
  if (!ready) throw new Error('the app never rendered — is the web build served?');
}

/** First run, abbreviated from `store-shots.ts`: every step probed, none assumed. */
async function onboard(page: Page, beforeMap: () => Promise<unknown>): Promise<void> {
  if (await waitFor(page, `document.querySelector('input')`, 20_000)) {
    await clickText(page, 'Randomize persona');
    await sleep(500);
    await page.eval(`document.querySelector('input').focus()`);
    await page.send('Input.insertText', { text: 'benchmark' });
    await sleep(500);
    await clickText(page, 'Continue');
  }
  for (const testId of ['privacy-onboarding', 'delivery-onboarding']) {
    if (await waitFor(page, `!!document.querySelector('[data-testid="${testId}"]')`, 15_000)) {
      await sleep(900);
      await clickText(page, 'Continue');
      await sleep(700);
    }
  }
  if (
    await waitFor(
      page,
      `[...document.querySelectorAll('*')].some((n) => n.textContent === 'Turn on location')`,
      15_000
    )
  ) {
    await beforeMap();
    await clickText(page, 'Turn on location');
  } else {
    await beforeMap();
  }
  if (
    !(await waitFor(
      page,
      `[...document.querySelectorAll('*')].some((n) => n.textContent === 'FRIENDS')`
    ))
  ) {
    throw new Error('onboarding did not reach the map');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
