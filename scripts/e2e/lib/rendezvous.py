#!/usr/bin/env python3
"""A host-side key/value rendezvous, so the two halves of a pairing handshake can meet.

WHY THIS EXISTS
---------------
Pairing needs data to cross between two participants mid-handshake: the invite link (A -> B) and
the SAS figure the displayer is showing (displayer -> picker), plus a "the picker has chosen"
barrier so the displayer only confirms afterwards. The old harness moved that data by running a
SEPARATE `maestro test` per step and shuttling values through the shell.

That is exactly what broke under maestro-runner. Its flow runner calls the WDA driver's
EnsureSession() once per flow, and WebDriverAgent's create-session defaults `forceAppLaunch` to
YES (see FBSessionCommands.m) — so on iOS every `maestro-runner test` RELAUNCHES an
already-running app. A live SAS session lives only in the native module's in-memory PairCore
(modules/iroh-location/rust/src/pairing.rs), so the relaunch destroyed the handshake, and the
observable symptom was a "pairing-confirm-matched not found" failure whose hierarchy dump shows
the plain map screen.

The relaunch is per FLOW, not per step. So the fix is to run each device's whole pairing
sequence as ONE flow — the single relaunch then happens before any pairing state exists — and to
let the flows exchange the values they need through this server instead of through the shell.
Flows reach it with `runScript`'s `http` global; the host reaches it with the `get`/`put`
subcommands below. Note that `runScript` JS runs in the maestro-runner PROCESS, on the host, so
127.0.0.1 is correct for both iOS and Android devices — no 10.0.2.2 special case.

Long-polling (`?wait=<seconds>`) is what keeps the handshake inside its 60s SAS budget: a waiter
is released the instant the value is published, rather than on the next poll tick.

Usage:
  rendezvous.py serve [--port N] [--port-file F]   # blocks; prints "listening <base-url>"
  rendezvous.py put <base-url> <key> <value>
  rendezvous.py get <base-url> <key> [--wait S]    # prints value; exit 1 if it never arrives
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

_STORE: dict[str, str] = {}
# One condition variable guards the whole store. Waiters are woken on every write and re-check
# their own key, which is far simpler than per-key events and costs nothing at this scale (a
# handful of keys, a handful of waiters).
_CONDITION = threading.Condition()


def _put(key: str, value: str) -> None:
    with _CONDITION:
        _STORE[key] = value
        _CONDITION.notify_all()


def _get(key: str, wait_seconds: float) -> str | None:
    with _CONDITION:
        # Re-check in a loop rather than trusting a single wake: notify_all() fires on every
        # write, so a waiter can be woken by a key that isn't the one it wants.
        remaining = wait_seconds
        while key not in _STORE and remaining > 0:
            began = time.monotonic()
            _CONDITION.wait(remaining)
            remaining -= time.monotonic() - began
        return _STORE.get(key)


class _Handler(http.server.BaseHTTPRequestHandler):
    # Quiet by default: the harness logs its own progress, and one line per poll would bury it.
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        return

    def _respond(self, status: int, body: str = "") -> None:
        payload = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _key(self) -> tuple[str, dict[str, list[str]]]:
        parsed = urllib.parse.urlparse(self.path)
        return urllib.parse.unquote(parsed.path.removeprefix("/kv/")), urllib.parse.parse_qs(
            parsed.query
        )

    def do_GET(self) -> None:  # noqa: N802 - stdlib signature
        if urllib.parse.urlparse(self.path).path == "/health":
            self._respond(200, "ok")
            return
        key, query = self._key()
        wait = float(query.get("wait", ["0"])[0])
        value = _get(key, wait)
        if value is None:
            self._respond(404, "")
            return
        self._respond(200, value)

    def do_POST(self) -> None:  # noqa: N802 - stdlib signature
        key, _ = self._key()
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode() if length else ""
        # A JSON body is unwrapped so flows can post either a bare string or {"value": ...} —
        # maestro-runner's http.post JSON-encodes object bodies automatically.
        if body.startswith("{"):
            try:
                parsed = json.loads(body)
                if isinstance(parsed, dict) and "value" in parsed:
                    body = str(parsed["value"])
            except json.JSONDecodeError:
                pass
        _put(key, body)
        self._respond(204)

    def do_DELETE(self) -> None:  # noqa: N802 - stdlib signature
        key, _ = self._key()
        with _CONDITION:
            _STORE.pop(key, None)
        self._respond(204)


def _serve(port: int, port_file: str | None, parent_pid: int) -> int:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), _Handler)
    # daemon_threads keeps a long-poll from holding shutdown open when the harness kills us.
    server.daemon_threads = True
    base = f"http://127.0.0.1:{server.server_address[1]}"
    if port_file:
        # Write-then-rename: the harness polls for this file, and a partial read would hand it a
        # truncated URL.
        with open(f"{port_file}.tmp", "w") as handle:
            handle.write(base)
        os.replace(f"{port_file}.tmp", port_file)
    print(f"listening {base}", flush=True)

    # Self-terminate when the harness that started us is gone. The shell trap covers an orderly
    # exit, but it cannot fire on SIGKILL (or a killed process group), and a leaked server holds
    # a port and silently serves stale keys into the NEXT run — which would look like a pairing
    # that mysteriously reused an old figure. Polling the parent is the portable way to notice.
    if parent_pid > 0:

        def _watch_parent() -> None:
            while True:
                time.sleep(2)
                try:
                    os.kill(parent_pid, 0)
                except OSError:
                    server.shutdown()
                    return

        threading.Thread(target=_watch_parent, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def _request(url: str, method: str, body: str | None, timeout: float) -> tuple[int, str]:
    request = urllib.request.Request(
        url, method=method, data=body.encode() if body is not None else None
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve")
    serve.add_argument("--port", type=int, default=0)
    serve.add_argument("--port-file")
    serve.add_argument(
        "--parent-pid",
        type=int,
        default=0,
        help="exit once this pid is gone (survives SIGKILL of the harness, unlike a shell trap)",
    )

    put = sub.add_parser("put")
    put.add_argument("base")
    put.add_argument("key")
    put.add_argument("value")

    get = sub.add_parser("get")
    get.add_argument("base")
    get.add_argument("key")
    get.add_argument("--wait", type=float, default=0)

    args = parser.parse_args()
    if args.command == "serve":
        return _serve(args.port, args.port_file, args.parent_pid)

    url = f"{args.base}/kv/{urllib.parse.quote(args.key)}"
    if args.command == "put":
        status, _ = _request(url, "POST", args.value, timeout=10)
        return 0 if status == 204 else 1

    status, body = _request(f"{url}?wait={args.wait}", "GET", None, timeout=args.wait + 10)
    if status != 200:
        return 1
    print(body)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ConnectionError, socket.timeout, urllib.error.URLError) as error:
        print(f"rendezvous.py: {error}", file=sys.stderr)
        raise SystemExit(1) from error
