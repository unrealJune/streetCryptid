#!/usr/bin/env python3
"""Field-soak walker: owns the phone's developer tunnel and feeds it a simulated position at 1 Hz.

Why one long-lived process:
  * On iOS 17+ a DVT location simulation lasts only as long as the channel that set it — the
    `simulate-location set` CLI blocks on `wait_return()` for exactly that reason — so "set it and
    exit" silently snaps the phone back to its real position.
  * pymobiledevice3's userspace tunnel is a process-global PyTCP stack: a second establishment in
    the same process can only fail. So on ANY connection error this process exits non-zero and
    launchd (KeepAlive) restarts it. Every bit of state is on disk and every timeline is absolute,
    so a restart resumes mid-outing at the right position.
  * Other tools (screenshots, network conditions, app launch) go through this process's control
    port instead of opening a second tunnel to the same phone.

Files (see common.py): queue/*.json outings waiting to depart, active.json the one in progress,
rest.json where the phone sits between outings, truth.jsonl where it was SUPPOSED to be (the ground
truth check.py grades the app against), events.jsonl connection / app-process / condition events.
"""

from __future__ import annotations

import asyncio
import bisect
import json
import logging
import math
import os
import random
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel  # noqa: E402
from pymobiledevice3.services.accessibilityaudit import AccessibilityAudit  # noqa: E402
from pymobiledevice3.services.dvt.instruments.condition_inducer import ConditionInducer  # noqa: E402
from pymobiledevice3.services.dvt.instruments.device_info import DeviceInfo  # noqa: E402
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider  # noqa: E402
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation  # noqa: E402
from pymobiledevice3.services.dvt.instruments.process_control import ProcessControl  # noqa: E402
from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot  # noqa: E402
from pymobiledevice3.services.dvt.testmanaged.xcuitest import TestConfig, XCUITestService  # noqa: E402
from pymobiledevice3.services.wda import WdaServiceClient  # noqa: E402

log = logging.getLogger("walker")

TRUTH_EVERY_S = 10
APP_POLL_S = 60
WDA_RUNNER = "com.unrealjune.WebDriverAgentRunner.xctrunner"
WDA_IDLE_S = 600


class Timeline:
    """An outing laid out on absolute time. Pure: position(t) never depends on history."""

    def __init__(self, outing: dict[str, Any], start: float):
        self.outing = outing
        self.start = start
        self.spans: list[tuple[float, float, dict[str, Any], list[float]]] = []
        t = start
        for seg in outing["segments"]:
            if seg["kind"] == "move":
                cum = [0.0]
                for dt in seg["dt"]:
                    cum.append(cum[-1] + dt)
                self.spans.append((t, t + cum[-1], seg, cum))
                t += cum[-1]
            else:
                self.spans.append((t, t + seg["seconds"], seg, []))
                t += seg["seconds"]
        self.end = t

    def last_point(self) -> tuple[float, float]:
        seg = self.outing["segments"][-1]
        return tuple(seg["points"][-1]) if seg["kind"] == "move" else tuple(seg["at"])  # type: ignore[return-value]

    def at(self, now: float) -> dict[str, Any] | None:
        if now >= self.end:
            return None
        for s, e, seg, cum in self.spans:
            if now < e:
                if seg["kind"] == "dwell":
                    return {"lat": seg["at"][0], "lon": seg["at"][1], "state": "dwell", "label": seg.get("label", "")}
                el = now - s
                i = max(0, min(bisect.bisect_right(cum, el) - 1, len(seg["points"]) - 2))
                span = cum[i + 1] - cum[i]
                f = 0.0 if span <= 0 else (el - cum[i]) / span
                a, b = seg["points"][i], seg["points"][i + 1]
                return {
                    "lat": a[0] + (b[0] - a[0]) * f,
                    "lon": a[1] + (b[1] - a[1]) * f,
                    "state": "moving",
                    "mode": seg.get("mode", "foot"),
                    "label": seg.get("label", ""),
                }
        return None


class Jitter:
    """Mean-reverting GPS wander. Bounded far inside the app's 50 m stop radius so a phone the
    walker means to be still can never read as moving."""

    def __init__(self) -> None:
        self.n = self.e = 0.0

    def step(self, radius_m: float) -> tuple[float, float]:
        sigma = radius_m / 3
        self.n += -0.15 * self.n + random.gauss(0, sigma * 0.3)
        self.e += -0.15 * self.e + random.gauss(0, sigma * 0.3)
        r = math.hypot(self.n, self.e)
        if r > radius_m:
            self.n, self.e = self.n * radius_m / r, self.e * radius_m / r
        return self.n, self.e


class Walker:
    def __init__(self) -> None:
        self.cfg = C.load_config()
        self.udid = self.cfg.get("udid") or os.environ.get("FIELD_SOAK_UDID") or None
        self.jitter = Jitter()
        self.dvt: DvtProvider | None = None
        self.rsd: Any = None
        self.wda_task: asyncio.Task | None = None
        self.wda_client: Any = None
        self.wda_session: str | None = None
        self.wda_used = 0.0
        self.condition: ConditionInducer | None = None
        self.condition_until: float | None = None
        self.app_pid: int | None = None
        self.app_seen = False
        self.current: dict[str, Any] = {}
        self.last_truth = 0.0
        self.last_key: tuple | None = None
        self.connected_at: float | None = None
        self.timeline: Timeline | None = None
        self._load_active()

    # ---------- schedule ----------
    def _rest(self) -> dict[str, Any]:
        rest = C.read_json(C.REST)
        if not rest:
            h = self.cfg["home"]
            rest = {"lat": h["lat"], "lon": h["lon"], "label": h.get("label", "home"), "since": time.time()}
            C.write_json(C.REST, rest)
        return rest

    def _load_active(self) -> None:
        a = C.read_json(C.ACTIVE)
        self.timeline = Timeline(a["outing"], a["start"]) if a else None

    def _next_queued(self, now: float) -> Path | None:
        for p in sorted(C.QUEUE.glob("*.json")):
            o = C.read_json(p)
            if o is None:
                continue
            if (o.get("depart_at") or 0) <= now:
                return p
            return None  # queue is ordered; the head isn't due yet
        return None

    def _advance(self, now: float) -> None:
        if self.timeline and now >= self.timeline.end:
            lat, lon = self.timeline.last_point()
            oid = self.timeline.outing["id"]
            C.write_json(C.REST, {"lat": lat, "lon": lon, "label": self.timeline.outing.get("rest_label", "home"), "since": self.timeline.end})
            C.append_jsonl(C.EVENTS, {"ev": "outing_end", "outing": oid})
            C.ACTIVE.unlink(missing_ok=True)
            done = C.QUEUE.parent / "done" / f"{oid}.json"
            C.write_json(done, self.timeline.outing)
            self.timeline = None
            log.info("outing %s finished", oid)
        if self.timeline is None:
            p = self._next_queued(now)
            if p is not None:
                outing = C.read_json(p)
                # The first point of an outing is where it was PLANNED from; start from where we are,
                # so a stale plan cannot teleport the phone.
                rest = self._rest()
                first = outing["segments"][0]
                if first["kind"] == "move" and C.haversine_m((rest["lat"], rest["lon"]), tuple(first["points"][0])) > 300:
                    C.append_jsonl(C.EVENTS, {"ev": "outing_rejected", "outing": outing["id"], "why": "starts >300m from rest position"})
                    p.rename(C.DONE / f"rejected-{p.name}")
                    return
                C.write_json(C.ACTIVE, {"outing": outing, "start": now})
                p.unlink()
                self.timeline = Timeline(outing, now)
                C.append_jsonl(C.EVENTS, {"ev": "outing_start", "outing": outing["id"], "name": outing.get("name", ""), "planned_s": round(self.timeline.end - now)})
                log.info("outing %s started (%.0f min)", outing["id"], (self.timeline.end - now) / 60)

    def position(self, now: float) -> dict[str, Any]:
        self._advance(now)
        pos = self.timeline.at(now) if self.timeline else None
        if pos is None:
            r = self._rest()
            pos = {"lat": r["lat"], "lon": r["lon"], "state": "rest", "label": r.get("label", "")}
        else:
            pos["outing"] = self.timeline.outing["id"]  # type: ignore[union-attr]
        return pos

    # ---------- device ----------
    async def feed(self, loc: LocationSimulation) -> None:
        while True:
            now = time.time()
            pos = self.position(now)
            radius = 4.0 if pos["state"] == "moving" else 6.0
            n, e = self.jitter.step(radius)
            lat, lon = C.offset_m((pos["lat"], pos["lon"]), n, e)
            await asyncio.wait_for(loc.set(lat, lon), timeout=10)
            self.current = {**pos, "set_lat": lat, "set_lon": lon}
            key = (pos["state"], pos.get("outing"), pos.get("label"))
            if now - self.last_truth >= TRUTH_EVERY_S or key != self.last_key:
                C.append_jsonl(C.TRUTH, {k: (round(v, 6) if isinstance(v, float) else v) for k, v in pos.items()})
                self.last_truth, self.last_key = now, key
            if self.condition_until and now >= self.condition_until:
                await self.clear_condition("expired")
            await asyncio.sleep(max(0.0, 1.0 - (time.time() - now)))

    async def watch_app(self) -> None:
        while True:
            assert self.dvt is not None
            async with DeviceInfo(self.dvt) as info:
                procs = await info.proclist()
            pid = None
            for p in procs:
                blob = json.dumps(p, default=str).lower()
                if "streetcryptid.app/" in blob:
                    pid = p.get("pid")
                    break
            if pid != self.app_pid or not self.app_seen:
                C.append_jsonl(C.EVENTS, {"ev": "app_up" if pid else "app_down", "pid": pid})
                self.app_pid, self.app_seen = pid, True
            await asyncio.sleep(APP_POLL_S)

    async def clear_condition(self, why: str) -> None:
        if self.condition is not None:
            try:
                await self.condition.clear()
            finally:
                C.append_jsonl(C.EVENTS, {"ev": "condition_clear", "why": why})
                self.condition_until = None

    # ---------- control port ----------
    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = (await reader.readline()).decode()
            while (await reader.readline()) not in (b"\r\n", b"\n", b""):
                pass
            method, target, _ = line.split(" ", 2)
            u = urlsplit(target)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            status, body = 200, await self.route(method, u.path, q)
        except Exception as ex:  # noqa: BLE001 — report every failure to the caller
            status, body = 500, {"error": f"{type(ex).__name__}: {ex}"}
        data = json.dumps(body, indent=2, default=str).encode()
        writer.write(f"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode() + data)
        await writer.drain()
        writer.close()

    async def route(self, method: str, path: str, q: dict[str, str]) -> Any:
        if path == "/status":
            return {
                "connected_since": self.connected_at,
                "udid": self.udid,
                "now": self.current,
                "active": (self.timeline.outing["id"], round(self.timeline.end - time.time())) if self.timeline else None,
                "queue": [p.name for p in sorted(C.QUEUE.glob("*.json"))],
                "app_pid": self.app_pid,
                "condition_until": self.condition_until,
            }
        if self.dvt is None:
            raise RuntimeError("not connected to the phone")
        if path == "/screenshot":
            async with Screenshot(self.dvt) as s:
                png = await s.get_screenshot()
            out = C.SHOTS / time.strftime("%Y%m%d-%H%M%S.png")
            out.write_bytes(png)
            return {"path": str(out)}
        if path == "/conditions":
            async with ConditionInducer(self.dvt) as ci:
                return await ci.list()
        if path == "/condition" and method == "POST":
            if self.condition is None:
                self.condition = ConditionInducer(self.dvt)
                await self.condition.__aenter__()
            await self.condition.set(q["profile"])
            minutes = float(q.get("minutes", "30"))
            self.condition_until = time.time() + minutes * 60
            C.append_jsonl(C.EVENTS, {"ev": "condition_set", "profile": q["profile"], "minutes": minutes})
            return {"ok": True, "until": self.condition_until}
        if path == "/condition/clear" and method == "POST":
            await self.clear_condition("requested")
            return {"ok": True}
        if path == "/ax":
            # Walk the foreground app's accessibility elements; optionally press the first whose
            # caption contains `press` (case-insensitive). Pressing needs a get-task-allow
            # (development-signed) app, which a local Release build is.
            want = q.get("press", "").lower()
            items: list[dict[str, Any]] = []
            target = None
            async with AccessibilityAudit(self.rsd) as ax:
                async for it in ax.iter_elements():
                    cap = it.caption or ""
                    items.append({"caption": cap, "spoken": it.spoken_description})
                    if want and target is None and want in cap.lower():
                        target = it
                        break
                    if len(items) >= 80:
                        break
                if want:
                    if target is None:
                        return {"pressed": None, "items": items}
                    await ax.perform_press(target.element.identifier)
                    C.append_jsonl(C.EVENTS, {"ev": "ax_press", "caption": target.caption})
                    return {"pressed": target.caption, "items": items}
            return {"items": items}
        if path.startswith("/wda"):
            return await self.wda(path, q)
        if path == "/launch" and method == "POST":
            async with ProcessControl(self.dvt) as pc:
                pid = await pc.launch(C.APP_BUNDLE_ID, kill_existing=False)
            C.append_jsonl(C.EVENTS, {"ev": "foreground", "pid": pid, "why": q.get("why", "")})
            return {"pid": pid}
        if path == "/background" and method == "POST":
            # Put the app in the background the way a person does: something else comes to the
            # front. Settings is always installed and does nothing on its own.
            async with ProcessControl(self.dvt) as pc:
                await pc.launch("com.apple.Preferences", kill_existing=False)
            C.append_jsonl(C.EVENTS, {"ev": "background"})
            return {"ok": True}
        raise KeyError(f"no route {method} {path}")

    # ---------- WebDriverAgent: typing, coordinate taps, swipes ----------
    # Accessibility (/ax) reads and presses, but cannot type. WDA (an XCUITest runner signed for
    # our team, bundle WDA_RUNNER) can. It is started on first use and stopped after WDA_IDLE_S so
    # a test runner is not resident on the phone for the whole soak.
    async def _wda_client(self) -> tuple[Any, str]:
        self.wda_used = time.time()
        if self.wda_task is None or self.wda_task.done():
            cfg = await TestConfig.create_for(self.rsd, runner_bundle_id=WDA_RUNNER)
            self.wda_task = asyncio.create_task(XCUITestService(self.rsd).run(cfg), name="wda-runner")
            self.wda_session = None
            client = WdaServiceClient(service_provider=self.rsd, timeout=20.0)
            for _ in range(60):
                if self.wda_task.done():
                    self.wda_task.result()
                    raise RuntimeError("WDA runner exited during startup")
                try:
                    await client.get_status()
                    break
                except Exception:  # noqa: BLE001 — not listening yet
                    await asyncio.sleep(0.5)
            else:
                raise TimeoutError("WDA did not come up in 30 s")
            self.wda_client = client
            C.append_jsonl(C.EVENTS, {"ev": "wda_start"})
        if not self.wda_session:
            self.wda_session = await self.wda_client.start_session()
        return self.wda_client, self.wda_session

    async def wda_reaper(self) -> None:
        while True:
            await asyncio.sleep(60)
            if self.wda_task and not self.wda_task.done() and time.time() - self.wda_used > WDA_IDLE_S:
                self.wda_task.cancel()
                self.wda_task, self.wda_session = None, None
                C.append_jsonl(C.EVENTS, {"ev": "wda_stop", "why": "idle"})

    async def wda(self, path: str, q: dict[str, str]) -> Any:
        client, sid = await self._wda_client()
        try:
            if path == "/wda/tap":
                await client._request_json("POST", f"/session/{sid}/wda/tap", {"x": float(q["x"]), "y": float(q["y"])})
                return {"tapped": [q["x"], q["y"]]}
            if path == "/wda/tapon":
                t = q["text"].replace("'", "\\'")
                el = await client.find_element("predicate string", f"label CONTAINS[c] '{t}' OR name CONTAINS[c] '{t}' OR value CONTAINS[c] '{t}'", session_id=sid)
                await client.click(el, session_id=sid)
                return {"tapped": q["text"]}
            if path == "/wda/type":
                await client.send_keys(q["text"], session_id=sid)
                return {"typed": len(q["text"])}
            if path == "/wda/swipe":
                await client.swipe(int(q["x1"]), int(q["y1"]), int(q["x2"]), int(q["y2"]), float(q.get("s", "0.3")), session_id=sid)
                return {"ok": True}
            if path == "/wda/press":
                await client.press_button(q["button"], session_id=sid)
                return {"pressed": q["button"]}
            if path == "/wda/pasteboard":
                import base64

                r = await client._request_json("POST", f"/session/{sid}/wda/getPasteboard", {"contentType": "plaintext"})
                return {"text": base64.b64decode(r.get("value") or "").decode(errors="replace")}
            if path == "/wda/size":
                return await client.get_window_size(session_id=sid)
            if path == "/wda/source":
                # A compact view of the element tree: type, label/value, frame. Raw XML is huge.
                import xml.etree.ElementTree as ET  # stdlib; WDA is our own runner

                root = ET.fromstring(await client.get_source(session_id=sid))
                out = []
                for e in root.iter():
                    lab = e.get("label") or e.get("value") or e.get("name")
                    if lab and e.get("visible") != "false":
                        out.append(f"{e.tag.replace('XCUIElementType', '')} '{lab}' @{e.get('x')},{e.get('y')} {e.get('width')}x{e.get('height')}")
                return out[:200]
            if path == "/wda/stop":
                if self.wda_task:
                    self.wda_task.cancel()
                self.wda_task, self.wda_session = None, None
                return {"ok": True}
        except Exception:
            self.wda_session = None  # a stale session is the usual cause; the next call re-creates it
            raise
        raise KeyError(path)

    async def run(self) -> None:
        server = await asyncio.start_server(self.handle, "127.0.0.1", C.CONTROL_PORT)
        log.info("control on 127.0.0.1:%d, device %s", C.CONTROL_PORT, self.udid or "(first USB device)")
        async with server:
            try:
                async with UserspaceRsdTunnel(serial=self.udid) as rsd:
                    async with DvtProvider(rsd) as dvt, LocationSimulation(dvt) as loc:
                        self.dvt, self.rsd = dvt, rsd
                        self.connected_at = time.time()
                        C.append_jsonl(C.EVENTS, {"ev": "connect", "udid": rsd.udid, "ios": rsd.product_version})
                        await asyncio.gather(self.feed(loc), self.watch_app(), self.wda_reaper())
            finally:
                self.dvt = None
                C.append_jsonl(C.EVENTS, {"ev": "disconnect"})


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        asyncio.run(Walker().run())
    except KeyboardInterrupt:
        pass
    except Exception:
        log.exception("walker died; launchd restarts it and the timeline resumes from disk")
        sys.exit(1)


if __name__ == "__main__":
    main()
