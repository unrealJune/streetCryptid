/**
 * A minimal Chrome DevTools Protocol client — enough to drive a headful Chrome
 * from a bun script, with no puppeteer/playwright dependency.
 *
 * It exists for `store-shots.ts`, which needs two things the browser-extension
 * tooling cannot give: an EXACT output resolution (App Store screenshots are
 * rejected at the wrong pixel size) and a scripted geolocation override. Both
 * are one CDP call each — `Emulation.setDeviceMetricsOverride` and
 * `Emulation.setGeolocationOverride` — against a Chrome launched with its own
 * throwaway user-data-dir, so nothing here touches the user's real profile.
 *
 * Bun's global `WebSocket` is the whole transport; there is no dependency to
 * install and nothing to keep in step with a Chrome release.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sleep } from './shot-server';

const CHROME_CANDIDATES = [
  process.env.SC_CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((path): path is string => typeof path === 'string' && path.length > 0);

async function chromeBinary(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not this one.
    }
  }
  throw new Error(
    `No Chrome found. Set SC_CHROME_PATH. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`
  );
}

export interface BrowserOptions {
  /** Devtools port. A fixed port keeps a crashed run from stranding a second browser. */
  port?: number;
  /** Headful by default: Skia/WebGL behaves closer to a real device with a real compositor. */
  headless?: boolean;
}

export interface Browser {
  /** Open a page and attach a CDP session to it. */
  newPage(url?: string): Promise<Page>;
  close(): Promise<void>;
}

export interface Page {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Resolve once `event` arrives, or reject after `timeoutMs`. */
  once(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: Record<string, unknown>) => void): () => void;
  /** Evaluate an expression in the page and return its (JSON-serialisable) value. */
  eval<T = unknown>(expression: string): Promise<T>;
  /** PNG bytes of the current viewport, at exactly the emulated device metrics. */
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export async function launch(options: BrowserOptions = {}): Promise<Browser> {
  const port = options.port ?? 9333;
  const binary = await chromeBinary();
  const userDataDir = await mkdtemp(join(tmpdir(), 'sc-shots-'));

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-popup-blocking',
    // The tile proxy and Metro are plain http on localhost; nothing here is a
    // security boundary, and the shots are thrown away after the run.
    '--allow-insecure-localhost',
    '--autoplay-policy=no-user-gesture-required',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    ...(options.headless ? ['--headless=new'] : []),
    'about:blank',
  ];

  const child: ChildProcess = spawn(binary, args, { stdio: 'ignore', detached: false });
  const version = await waitForDevtools(port);
  if (!version) {
    child.kill();
    throw new Error(`Chrome did not open a devtools endpoint on :${port}`);
  }

  const pages: Page[] = [];
  return {
    async newPage(url = 'about:blank') {
      const target = await createTarget(port, url);
      const page = await attach(target.webSocketDebuggerUrl);
      pages.push(page);
      return page;
    },
    async close() {
      for (const page of pages) {
        try {
          await page.close();
        } catch {
          // A page that already went away is not a failure to close the browser.
        }
      }
      child.kill();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function waitForDevtools(port: number, timeoutMs = 20_000): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      // Not listening yet.
    }
    await sleep(150);
  }
  return null;
}

interface TargetInfo {
  id: string;
  webSocketDebuggerUrl: string;
}

async function createTarget(port: number, url: string): Promise<TargetInfo> {
  // Chrome 111+ requires PUT on /json/new; older builds only accept GET.
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  for (const method of ['PUT', 'GET'] as const) {
    const res = await fetch(endpoint, { method });
    if (res.ok) return (await res.json()) as TargetInfo;
  }
  throw new Error('Could not create a devtools target');
}

async function attach(wsUrl: string): Promise<Page> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    if (typeof message.id === 'number') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of listeners.get(message.method) ?? []) {
        handler(message.params ?? {});
      }
    }
  });

  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  const on = (event: string, handler: (params: Record<string, unknown>) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    return () => set.delete(handler);
  };

  const page: Page = {
    send,
    on,
    once(event, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`timed out waiting for ${event}`));
        }, timeoutMs);
        const off = on(event, (params) => {
          clearTimeout(timer);
          off();
          resolve(params);
        });
      });
    },
    async eval<T>(expression: string) {
      const result = await send<{
        result: { value?: T };
        exceptionDetails?: { exception?: { description?: string }; text: string };
      }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        // Screenshot seeding calls into the app's own modules; without this a
        // `document.querySelector` in the expression is fine but a promise that
        // rejects would resolve as undefined and hide the failure.
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
        );
      }
      return result.result?.value as T;
    },
    async screenshot() {
      const { data } = await send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        fromSurface: true,
      });
      return Buffer.from(data, 'base64');
    },
    async close() {
      socket.close();
    },
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable').catch(() => {});
  return page;
}

/**
 * Put the page on a device: exact CSS size and pixel ratio, so a capture comes
 * out at `width * deviceScaleFactor` by `height * deviceScaleFactor` — which is
 * the only thing App Store Connect checks before rejecting an upload.
 */
export async function emulateDevice(
  page: Page,
  device: { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
): Promise<void> {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.deviceScaleFactor,
    mobile: device.mobile,
    screenWidth: device.width,
    screenHeight: device.height,
  });
  await page.send('Emulation.setTouchEmulationEnabled', {
    enabled: device.mobile,
    maxTouchPoints: 5,
  });
}

/** Hand the page a fixed position, so the map opens somewhere worth photographing. */
export async function setGeolocation(
  page: Page,
  position: { latitude: number; longitude: number; accuracy?: number }
): Promise<void> {
  await page.send('Emulation.setGeolocationOverride', {
    latitude: position.latitude,
    longitude: position.longitude,
    accuracy: position.accuracy ?? 8,
  });
  await page.send('Browser.grantPermissions', {
    permissions: ['geolocation'],
  });
}
