import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * The little static servers `store-shots.ts` needs, on plain `node:http`.
 *
 * Deliberately not `Bun.serve`: everything under `scripts/` is type-checked by
 * the project's own `tsc` (see `tsconfig.json`'s `include`), and pulling in
 * `@types/bun` to describe those globals also replaces the global `fetch` type,
 * which breaks every existing test that mocks `fetch` with a `jest.fn()`. Node's
 * API costs a few more lines here and nothing anywhere else — the same reason
 * `map-shot.ts` reaches for `node:fs/promises` while being run by bun.
 */

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

const MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function sendFile(response: ServerResponse, path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    response.writeHead(200, {
      'content-type': mediaTypeOf(path),
      'content-length': String(info.size),
      // Every run is a fresh browser profile, but a redeploy between runs must
      // never be served from a disk cache that outlived it.
      'cache-control': 'no-store',
    });
    createReadStream(path).pipe(response);
    return true;
  } catch {
    return false;
  }
}

function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<StaticServer> {
  const server = createServer(handler);
  return new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        reject(new Error('server did not bind a port'));
        return;
      }
      resolveListening({
        origin: `http://localhost:${address.port}`,
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      });
    });
  });
}

/** Resolve a URL path inside `root`, refusing anything that escapes it. */
function withinRoot(root: string, urlPath: string): string | null {
  const candidate = resolve(join(root, normalize(decodeURIComponent(urlPath))));
  const base = resolve(root);
  return candidate === base || candidate.startsWith(base + sep) ? candidate : null;
}

/**
 * Serve a `bunx expo export -p web` output directory as a single-page app.
 *
 * `app.json` sets `web.output: "single"`, so anything that is not a real file
 * has to fall back to `index.html`; without that, `/settings/delivery` 404s and
 * the screenshot is of an error page rather than the screen.
 */
export async function serveWebBuild(dir: string): Promise<StaticServer> {
  return listen(async (request, response) => {
    const urlPath = new URL(request.url ?? '/', 'http://localhost').pathname;
    const path = withinRoot(dir, urlPath);
    if (path && urlPath !== '/' && (await sendFile(response, path))) return;
    if (await sendFile(response, join(dir, 'index.html'))) return;
    response.writeHead(404).end('not found');
  });
}

/** Serve an exact map of URL path → file or generated page. Nothing else exists. */
export async function serveFixedRoutes(routes: {
  files: ReadonlyMap<string, string>;
  pages: ReadonlyMap<string, string>;
}): Promise<StaticServer> {
  return listen(async (request, response) => {
    const urlPath = new URL(request.url ?? '/', 'http://localhost').pathname;

    const file = routes.files.get(urlPath);
    if (file && (await sendFile(response, file))) return;

    const page = routes.pages.get(urlPath);
    if (page !== undefined) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(page);
      return;
    }

    response.writeHead(404).end('not found');
  });
}

/** `setTimeout` as a promise. The one Bun global worth replacing by hand. */
export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
