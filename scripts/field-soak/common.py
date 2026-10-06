"""Shared paths, config and small geo helpers for the field soak.

Everything durable lives under STATE (outside the repo): the walker's queue and ground truth, the
checker's verdicts, and the journal the Sonnet ticks keep. The repo holds only code.
"""

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader for scripts/field-soak/.env (gitignored; see .env.example).
    Real environment variables win, so launchd or a shell can still override anything."""
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv(HERE / ".env")

STATE = Path(os.environ.get("FIELD_SOAK_STATE", Path.home() / ".local/state/streetcryptid-field"))
QUEUE = STATE / "queue"
DONE = STATE / "done"
VERDICTS = STATE / "verdicts"
SHOTS = STATE / "shots"
CONFIG = STATE / "config.json"
ACTIVE = STATE / "active.json"
REST = STATE / "rest.json"
TRUTH = STATE / "truth.jsonl"
EVENTS = STATE / "events.jsonl"

APP_BUNDLE_ID = "com.unrealjune.streetcryptid"
CONTROL_PORT = int(os.environ.get("FIELD_SOAK_PORT", "47811"))

# Mirrors of app constants the checker reasons about. Keep in step with the app:
#   SHARE_INTERVAL_MS   src/features/social/net/background/sampling-policy.ts
#   stopDwellSeconds    modules/iroh-location/ios/BackgroundLocationRuntime.swift
#   stopJitterRadiusM   (same file) — the walker's rest jitter must stay well inside it
SHARE_INTERVAL_S = 300
STOP_DWELL_S = 180
STOP_JITTER_RADIUS_M = 50

DEFAULT_CONFIG: dict[str, Any] = {
    "udid": None,
    "se2_instance_id": None,
    "partner_instance_id": None,
    "city": {"name": "Kyoto", "tz": "Asia/Tokyo"},
    "home": {"lat": 35.0302, "lon": 135.7725, "label": "home — by the Kamo river fork"},
}


def ensure_dirs() -> None:
    for d in (STATE, QUEUE, DONE, VERDICTS, SHOTS):
        d.mkdir(parents=True, exist_ok=True)


def load_config() -> dict[str, Any]:
    ensure_dirs()
    if not CONFIG.exists():
        CONFIG.write_text(json.dumps(DEFAULT_CONFIG, indent=2) + "\n")
    cfg = {**DEFAULT_CONFIG, **json.loads(CONFIG.read_text())}
    return cfg


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, obj: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n")
    tmp.replace(path)


def append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    obj = {"t": round(time.time(), 3), **obj}
    with path.open("a") as f:
        f.write(json.dumps(obj, separators=(",", ":")) + "\n")


def read_jsonl(path: Path, since: float = 0.0) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        with path.open() as f:
            for line in f:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("t", 0) >= since:
                    out.append(row)
    except FileNotFoundError:
        pass
    return out


EARTH_R = 6_371_000.0


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(h))


def offset_m(p: tuple[float, float], north_m: float, east_m: float) -> tuple[float, float]:
    dlat = north_m / EARTH_R
    dlon = east_m / (EARTH_R * math.cos(math.radians(p[0])))
    return (p[0] + math.degrees(dlat), p[1] + math.degrees(dlon))
