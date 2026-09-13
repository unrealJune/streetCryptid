/**
 * A transparent, CORS-adding pass-through in front of the tile server, so the
 * web build can read tiles from a browser.
 *
 * Only the coarse path needs it. `GET {url}/bundle/v2/...` already answers with
 * `Access-Control-Allow-Origin: *` and, crucially, an
 * `Access-Control-Expose-Headers` that includes `ETag` — the streaming decoder
 * refuses a bundle without a strong ETag, because that is what makes a partial
 * download resumable. `GET {url}/{z}/{x}/{y}` (the Martin coarse tile) sends no
 * CORS headers at all, so a browser fetches it, receives 200, and then refuses
 * to hand the bytes to the page. Native has no such rule, which is why this only
 * ever bites the web target.
 *
 * Transparent is the whole design: every upstream header is forwarded and the
 * body is streamed, not buffered. An earlier version rebuilt the response from
 * a short allowlist and broke the map twice over — it dropped the ETag the
 * stream decoder needs, and it re-declared `content-encoding` on a body `fetch`
 * had already decoded.
 *
 * Used by `just store-shots`. Not a fixture: the bytes are the real tileset's.
 *
 *   bun scripts/tile-proxy.ts
 *   SC_TILE_PROXY_PORT=9099 SC_TILE_UPSTREAM=https://tiles.example.com bun scripts/tile-proxy.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

const UPSTREAM = (process.env.SC_TILE_UPSTREAM ?? 'https://martin.junephilip.com').replace(
  /\/$/,
  ''
);
const PORT = Number(process.env.SC_TILE_PROXY_PORT ?? 8099);

/** Response headers a browser hides from script unless they are named here. */
const EXPOSED = 'ETag, Accept-Ranges, Content-Range, Content-Length, Content-Type';

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'OPTIONS') {
    response
      .writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,HEAD,OPTIONS',
        'access-control-max-age': '86400',
      })
      .end();
    return;
  }

  // Forward conditional and range headers: the bundle source resumes an
  // interrupted download with them, and swallowing them turns every resume into
  // a fresh full fetch (and, upstream, into a 429).
  const forward = new Headers();
  for (const header of ['accept', 'range', 'if-none-match', 'if-range']) {
    const value = request.headers[header];
    if (typeof value === 'string') forward.set(header, value);
  }

  const upstream = await fetch(`${UPSTREAM}${request.url ?? '/'}`, {
    method: request.method,
    headers: forward,
    redirect: 'follow',
  });

  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // `fetch` has already decoded the body, so both of these would describe bytes
  // that are no longer what we are about to send.
  if (headers['content-encoding']) {
    delete headers['content-encoding'];
    delete headers['content-length'];
  }
  headers['access-control-allow-origin'] = '*';
  headers['access-control-expose-headers'] = EXPOSED;

  response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return;
  }
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
}

createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    // A tile that fails upstream is the app's problem to retry, not a reason to
    // take the proxy (and the screenshot run) down.
    if (!response.headersSent) response.writeHead(502, { 'access-control-allow-origin': '*' });
    response.end(String(error));
  });
}).listen(PORT, () => {
  console.log(`tile proxy :${PORT} -> ${UPSTREAM}`);
});
