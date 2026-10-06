#!/usr/bin/env python3
"""Plan an outing for the walker: real streets, human pace, real stops.

The planner does the mechanics so whoever picks the destinations (a Sonnet tick, or you) only has
to say where and for how long:

  plan_outing.py geocode "Kamo Shrine, Kyoto"
  plan_outing.py plan --name "Morning loop to the shrine" \
      --stop "35.0597,135.7524,25,Kamigamo Shrine grounds" \
      --stop "home,0,home,foot" --depart "+10m"

Stop spec: "LAT,LON | home | here , DWELL_MIN [, LABEL [, MODE]]", where MODE is how you get TO
that stop: foot (default) or car (a stand-in for a bus or taxi, since trains are not routable).
--depart takes now, +30m, +2h, HH:MM (in the city's timezone; the next one to come), or an ISO time.

Routing uses the FOSSGIS OSRM servers (routing.openstreetmap.de). Note that router.project-osrm.org
serves ONLY the car profile, whatever profile the URL names. Timing is baked into the outing here,
including traffic-light pauses and per-walk pace, so the walker stays deterministic and can resume.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

UA = "streetcryptid-field-soak/1 (dev testing; low volume)"
OSRM = {"foot": "https://routing.openstreetmap.de/routed-foot", "car": "https://routing.openstreetmap.de/routed-car"}


def http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def geocode(q: str) -> list[dict]:
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": 5})
    time.sleep(1.1)  # Nominatim policy: at most one request per second
    return [{"name": r["display_name"], "lat": float(r["lat"]), "lon": float(r["lon"]), "type": r.get("type")} for r in http_json(url)]


def route(a: tuple[float, float], b: tuple[float, float], mode: str) -> tuple[list[list[float]], list[float], list[float]]:
    coords = f"{a[1]},{a[0]};{b[1]},{b[0]}"
    url = f"{OSRM[mode]}/route/v1/driving/{coords}?overview=full&geometries=geojson&annotations=duration,distance"
    r = http_json(url)
    if r.get("code") != "Ok":
        raise SystemExit(f"routing failed {a}->{b}: {r.get('code')} {r.get('message')}")
    rt = r["routes"][0]
    pts = [[lat, lon] for lon, lat in rt["geometry"]["coordinates"]]
    ann = rt["legs"][0]["annotation"]
    return pts, ann["distance"], ann["duration"]


def pace(points: list[list[float]], dists: list[float], durs: list[float], mode: str, rng: random.Random) -> list[dict]:
    """Turn a route into move segments plus short pauses, with timing a person would produce."""
    segs: list[dict] = []
    cur_pts, cur_dt = [points[0]], []
    if mode == "foot":
        speed = rng.uniform(1.15, 1.5)  # this walk's natural pace, m/s
        since_pause, next_pause = 0.0, rng.uniform(250, 700)
    else:
        factor = rng.uniform(1.05, 1.35)  # OSRM car times are optimistic
        since_pause, next_pause = 0.0, rng.uniform(600, 1500)
    for i, d in enumerate(dists):
        if mode == "foot":
            dt = d / max(0.6, speed * rng.uniform(0.9, 1.1))
        else:
            dt = max(durs[i] * factor, d / 22)
        cur_pts.append(points[i + 1])
        cur_dt.append(round(dt, 2))
        since_pause += d
        if since_pause >= next_pause and i < len(dists) - 1:
            segs.append({"kind": "move", "mode": mode, "points": cur_pts, "dt": cur_dt})
            wait = rng.uniform(15, 75) if mode == "foot" else rng.uniform(20, 90)
            segs.append({"kind": "dwell", "at": points[i + 1], "seconds": round(wait), "label": "crossing" if mode == "foot" else "lights"})
            cur_pts, cur_dt = [points[i + 1]], []
            since_pause, next_pause = 0.0, (rng.uniform(250, 700) if mode == "foot" else rng.uniform(600, 1500))
    if cur_dt:
        segs.append({"kind": "move", "mode": mode, "points": cur_pts, "dt": cur_dt})
    return segs


def parse_depart(spec: str, tz: ZoneInfo) -> float:
    now = time.time()
    if spec == "now":
        return now
    if m := re.fullmatch(r"\+(\d+(?:\.\d+)?)([mh])", spec):
        return now + float(m[1]) * (60 if m[2] == "m" else 3600)
    if m := re.fullmatch(r"(\d{1,2}):(\d{2})", spec):
        local = datetime.now(tz)
        t = local.replace(hour=int(m[1]), minute=int(m[2]), second=0, microsecond=0)
        if t <= local:
            t += timedelta(days=1)
        return t.timestamp()
    return datetime.fromisoformat(spec).astimezone(tz).timestamp()


def queued_end_position() -> tuple[tuple[float, float], float]:
    """Where the phone will be, and from when, after everything already active or queued."""
    rest = C.read_json(C.REST)
    cfg = C.load_config()
    pos = (rest["lat"], rest["lon"]) if rest else (cfg["home"]["lat"], cfg["home"]["lon"])
    t = time.time()
    active = C.read_json(C.ACTIVE)
    chain = ([active["outing"]] if active else []) + [C.read_json(p) for p in sorted(C.QUEUE.glob("*.json"))]
    if active:
        t = active["start"]
    for o in chain:
        if not o:
            continue
        t = max(t, o.get("depart_at") or t) + o["planned_s"]
        last = o["segments"][-1]
        pos = tuple(last["points"][-1] if last["kind"] == "move" else last["at"])  # type: ignore[assignment]
    return pos, t


def cmd_plan(a: argparse.Namespace) -> None:
    cfg = C.load_config()
    tz = ZoneInfo(cfg["city"]["tz"])
    home = (cfg["home"]["lat"], cfg["home"]["lon"])
    start, free_at = queued_end_position()
    depart = max(parse_depart(a.depart, tz), free_at)
    rng = random.Random(a.seed)
    segs: list[dict] = []
    here, total_m = start, 0.0
    rest_label = "out"
    for spec in a.stop:
        parts = [p.strip() for p in spec.split(",")]
        if parts[0] in ("home", "here"):
            dest = home if parts[0] == "home" else here
            rest_ = parts[1:]
        else:
            dest = (float(parts[0]), float(parts[1]))
            rest_ = parts[2:]
        dwell_min = float(rest_[0]) if rest_ else 0
        label = rest_[1] if len(rest_) > 1 else ""
        mode = rest_[2] if len(rest_) > 2 else "foot"
        if C.haversine_m(here, dest) > 25:
            pts, dists, durs = route(here, dest, mode)
            pts[0] = list(here)  # start exactly where we are, not where OSRM snapped us
            segs += pace(pts, dists, durs, mode, rng)
            total_m += sum(dists)
            here = tuple(pts[-1])  # type: ignore[assignment]
        if dwell_min > 0:
            # A stop is where you stand still, not the road OSRM snapped to: walk the last bit in.
            if C.haversine_m(here, dest) > 5:
                segs.append({"kind": "move", "mode": "foot", "points": [list(here), list(dest)], "dt": [round(C.haversine_m(here, dest) / 1.1, 1)]})
                here = dest
            secs = dwell_min * 60 * rng.uniform(0.85, 1.2)
            segs.append({"kind": "dwell", "at": list(here), "seconds": round(secs), "label": label})
        rest_label = label or rest_label
    planned = sum(s["seconds"] if s["kind"] == "dwell" else sum(s["dt"]) for s in segs)
    stamp = datetime.fromtimestamp(depart, tz).strftime("%Y%m%d-%H%M")
    slug = re.sub(r"[^a-z0-9]+", "-", a.name.lower()).strip("-")[:40]
    outing = {
        "id": f"{stamp}-{slug}",
        "name": a.name,
        "notes": a.notes,
        "depart_at": depart,
        "planned_s": round(planned),
        "distance_m": round(total_m),
        "rest_label": rest_label if C.haversine_m(here, home) > 50 else "home",
        "segments": segs,
    }
    if C.haversine_m(start, tuple(segs[0]["points"][0]) if segs[0]["kind"] == "move" else tuple(segs[0]["at"])) > 300:
        raise SystemExit("outing does not start where the phone will be — refusing to teleport")
    if a.dry_run:
        print(json.dumps({k: v for k, v in outing.items() if k != "segments"}, indent=2))
        return
    C.write_json(C.QUEUE / f"{outing['id']}.json", outing)
    loc = datetime.fromtimestamp(depart, tz)
    print(f"queued {outing['id']}: departs {loc:%a %H:%M} {cfg['city']['name']} time, "
          f"{total_m / 1000:.1f} km, {planned / 60:.0f} min, ends at {outing['rest_label']}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("geocode")
    g.add_argument("query")
    pl = sub.add_parser("plan")
    pl.add_argument("--name", required=True)
    pl.add_argument("--notes", default="")
    pl.add_argument("--stop", action="append", required=True)
    pl.add_argument("--depart", default="now")
    pl.add_argument("--seed", type=int)
    pl.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    if a.cmd == "geocode":
        print(json.dumps(geocode(a.query), indent=2, ensure_ascii=False))
    else:
        cmd_plan(a)


if __name__ == "__main__":
    main()
