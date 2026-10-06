#!/usr/bin/env python3
"""Grade the app against ground truth, and the read-only telemetry helpers the ticks use.

`check` reads truth.jsonl (where the walker PUT the phone) and Tempo (what the phone SAID it did),
and turns their disagreement into findings. The expectations are the app's own contracts:

  * moving: a publish every SHARE_INTERVAL_S slot, so a gap past 2 slots while walking is a finding
  * stopped for longer than STOP_DWELL_S: a `publish.fix` with fix_state=2 (parked) should follow;
    the delay from the stop to that declaration is the parked latency
  * moving again after a stop: fix_state=1 (live) should come back within about one slot
  * the partner phone should be RECEIVING this author's envelopes (any span on the partner that
    carries sc.author = our id), and `peer.contact` says whether the two phones ever spoke directly
  * the latest `device.health` is screened with the "Reading silence" table in infra/otel/README.md

Severity: "alert" is worth waking a human; "warn" goes in the journal; "info" is just numbers.
Absent telemetry is NOT proof of a fault: the phone ships from a journal and may be behind. The
checker therefore never alerts on a window younger than LAG_GRACE_S.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C  # noqa: E402

GRAFANA = os.environ.get("FIELD_SOAK_GRAFANA_URL", "")  # from scripts/field-soak/.env
SECRETS = Path(os.environ.get("FIELD_SOAK_SECRETS_DIR", Path.home() / ".config/streetcryptid")).expanduser()
TOKEN_FILE = SECRETS / "grafana-token"
WEBHOOK_FILE = SECRETS / "field-soak-discord-webhook"
LAG_GRACE_S = 15 * 60
SLOT = C.SHARE_INTERVAL_S


# ---------------- Grafana ----------------
def _get(path: str, params: dict[str, Any]) -> Any:
    if not GRAFANA:
        raise SystemExit("FIELD_SOAK_GRAFANA_URL is not set — copy scripts/field-soak/.env.example to .env")
    token = TOKEN_FILE.read_text().strip()
    url = f"{GRAFANA}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _attrs(lst: list[dict]) -> dict[str, Any]:
    out = {}
    for a in lst or []:
        v = a.get("value", {})
        out[a["key"]] = next(iter(v.values()), None) if v else None
    return out


def tempo(q: str, start: float, end: float, limit: int = 2000) -> list[dict[str, Any]]:
    """Flat list of matched spans: {t, name, trace, **attrs}."""
    r = _get("/api/datasources/proxy/uid/tempo/api/search", {"q": q, "start": int(start), "end": int(end), "limit": limit, "spss": 100})
    spans = []
    for tr in r.get("traces", []):
        for ss in tr.get("spanSets") or [tr.get("spanSet", {})]:
            for s in ss.get("spans", []):
                spans.append({"t": int(s["startTimeUnixNano"]) / 1e9, "name": s.get("name"), "trace": tr["traceID"], **_attrs(s.get("attributes"))})
    uniq = {(s["trace"], s["t"], s["name"]): s for s in spans}
    return sorted(uniq.values(), key=lambda s: s["t"])


def full_span(trace_id: str, name: str) -> dict[str, Any]:
    r = _get(f"/api/datasources/proxy/uid/tempo/api/traces/{trace_id}", {})
    for b in r.get("batches", r.get("resourceSpans", [])):
        res = _attrs(b.get("resource", {}).get("attributes"))
        for ss in b.get("scopeSpans", b.get("instrumentationLibrarySpans", [])):
            for s in ss.get("spans", []):
                if s.get("name") == name:
                    return {**{f"resource.{k}": v for k, v in res.items()}, **_attrs(s.get("attributes"))}
    return {}


# ---------------- truth ----------------
def intervals(truth: list[dict]) -> list[dict]:
    """Collapse 10-s truth rows into intervals of moving vs still (dwell and rest are both still)."""
    out: list[dict] = []
    for r in truth:
        kind = "moving" if r["state"] == "moving" else "still"
        if r.get("label") in ("crossing", "lights"):
            kind = "moving"  # a traffic-light pause is part of the walk, not a stop
        if out and out[-1]["kind"] == kind:
            out[-1]["end"] = r["t"]
            continue
        if out:
            out[-1]["end"] = r["t"]
        out.append({"kind": kind, "start": r["t"], "end": r["t"], "label": r.get("label", ""), "outing": r.get("outing")})
    return out


def pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]


# ---------------- check ----------------
def cmd_check(a: argparse.Namespace) -> None:
    cfg = C.load_config()
    me, partner = cfg.get("se2_instance_id"), cfg.get("partner_instance_id")
    end = time.time()
    start = end - a.hours * 3600
    findings: list[dict] = []

    def find(sev: str, code: str, msg: str, **data: Any) -> None:
        findings.append({"severity": sev, "code": code, "msg": msg, **data})

    truth = C.read_jsonl(C.TRUTH, start)
    events = C.read_jsonl(C.EVENTS, start)
    graded_until = end - LAG_GRACE_S  # telemetry newer than this may simply not have shipped yet

    for ev in events:
        if ev["ev"] in ("disconnect", "app_down", "outing_rejected", "intervention_launch"):
            find("warn" if ev["ev"] != "app_down" else "info", f"walker.{ev['ev']}", json.dumps(ev))
    if not truth or end - truth[-1]["t"] > 120:
        find("alert", "walker.silent", "walker has not written ground truth for >2 min — the phone is not being driven")

    report: dict[str, Any] = {"window_h": a.hours, "me": me, "partner": partner}
    if not me:
        find("warn", "config.no_instance", "se2_instance_id not set — run `fs discover` and set it in config.json")
    else:
        pubs = tempo(f'{{ name = "publish.fix" && resource.service.instance.id = "{me}" }} | select(span.fix_state, span.published_delta_s)', start, end)
        report["publish_count"] = len(pubs)
        ptimes = [p["t"] for p in pubs]
        gaps = [b - a_ for a_, b in zip([start] + ptimes, ptimes + [graded_until]) if b > a_]
        report["publish_gap_s"] = {"p50": pct(gaps, 0.5), "p90": pct(gaps, 0.9), "max": max(gaps) if gaps else None}
        if not pubs and a.hours * 3600 > 3 * SLOT:
            find("alert", "publish.none", f"no publish.fix from {me} in {a.hours} h")

        for iv in intervals(truth):
            s, e = iv["start"], min(iv["end"], graded_until)
            if e - s < 2 * SLOT:
                continue
            inside = [p for p in pubs if s <= p["t"] <= e]
            if iv["kind"] == "moving":
                ts = [s] + [p["t"] for p in inside] + [e]
                worst = max(b - a_ for a_, b in zip(ts, ts[1:]))
                if worst > 2.5 * SLOT:
                    find("warn", "moving.gap", f"walking {iv['outing']}: {worst/60:.0f} min without a publish", start=s, gap_s=round(worst))
                parked_while_moving = [p for p in inside if str(p.get("fix_state")) == "2" and p["t"] - s > SLOT]
                if parked_while_moving:
                    find("warn", "moving.declared_parked", f"declared PARKED while walking {iv['outing']} ({len(parked_while_moving)}x)", start=s)
            else:
                if e - s < C.STOP_DWELL_S + 3 * SLOT:
                    continue
                parked = [p for p in inside if str(p.get("fix_state")) == "2"]
                if not parked:
                    sev = "alert" if e - s > 90 * 60 else "warn"
                    find(sev, "still.never_parked", f"still at '{iv['label']}' for {(e-s)/60:.0f} min, never declared parked", start=s)
                else:
                    lat = parked[0]["t"] - s
                    iv["parked_latency_s"] = round(lat)
                    if lat > C.STOP_DWELL_S + 2 * SLOT:
                        find("warn", "still.slow_park", f"parked declared {lat/60:.1f} min after stopping at '{iv['label']}'", start=s)
                # the next interval is moving again: does live come back?
        ivs = intervals(truth)
        for prev, nxt in zip(ivs, ivs[1:]):
            if prev["kind"] == "still" and nxt["kind"] == "moving" and nxt["start"] < graded_until - 2 * SLOT:
                live = [p for p in pubs if p["t"] >= nxt["start"] and str(p.get("fix_state")) == "1"]
                lat = (live[0]["t"] - nxt["start"]) if live else None
                if lat is None or lat > 2 * SLOT:
                    find("warn", "moving.slow_live", f"left '{prev['label']}' and live came back after {('never' if lat is None else f'{lat/60:.1f} min')}", start=nxt["start"])
        report["parked_latency_s"] = [iv.get("parked_latency_s") for iv in ivs if "parked_latency_s" in iv]

        # device.health — the latest one, read in full
        dh = tempo(f'{{ name = "device.health" && resource.service.instance.id = "{me}" }}', start - 6 * 3600, end, limit=50)
        if not dh:
            find("alert", "health.none", f"no device.health from {me} in {a.hours + 6} h")
        else:
            h = full_span(dh[-1]["trace"], "device.health")
            h["_age_s"] = round(end - dh[-1]["t"])
            report["health"] = h
            if h.get("sharing.muted"):
                find("alert", "health.muted", f"sharing.muted = {h['sharing.muted']}")
            if str(h.get("location.delegate_on_main", "true")).lower() == "false":
                find("alert", "health.delegate_off_main", "location.delegate_on_main is false — Core Location deliveries go nowhere")
            try:
                if int(h.get("sharing.recipients", 0)) >= 1 and int(h.get("sharing.native_recipients", 1)) == 0:
                    find("alert", "health.seal_diverged", "JS pool has recipients but the native seal list is empty — publishing to nobody")
                if float(h.get("wake.cpu_ms_max", 0)) > 40000:
                    find("warn", "health.cpu", f"wake.cpu_ms_max {h['wake.cpu_ms_max']} near iOS's 48 s CPU exception threshold")
            except (TypeError, ValueError):
                pass

        if partner:
            recv = tempo(f'{{ resource.service.instance.id = "{partner}" && span.sc.author = "{me}" }}', start, end)
            by: dict[str, int] = {}
            for r in recv:
                by[r["name"]] = by.get(r["name"], 0) + 1
            report["partner_saw_me"] = by
            back = tempo(f'{{ resource.service.instance.id = "{me}" && span.sc.author = "{partner}" }}', start, end)
            report["i_saw_partner"] = {n: sum(1 for r in back if r["name"] == n) for n in {r["name"] for r in back}}
            contacts = tempo(f'{{ name = "peer.contact" && ((resource.service.instance.id = "{me}" && span.sc.peer = "{partner}") || (resource.service.instance.id = "{partner}" && span.sc.peer = "{me}")) }} | select(span.contact.role, span.contact.dir, span.contact.via)', start, end)
            report["peer_contacts"] = len(contacts)
            partner_alive = tempo(f'{{ name = "device.health" && resource.service.instance.id = "{partner}" }}', start, end, limit=5)
            if len(pubs) >= 6 and not recv and partner_alive:
                find("alert", "delivery.partner_blind", f"I published {len(pubs)} envelopes and the partner phone (alive) recorded none of them")

    worst = "alert" if any(f["severity"] == "alert" for f in findings) else "warn" if any(f["severity"] == "warn" for f in findings) else "ok"
    verdict = {"at": end, "status": worst, "findings": findings, "report": report}
    out = C.VERDICTS / time.strftime("%Y%m%d-%H%M%S.json")
    C.write_json(out, verdict)
    print(json.dumps(verdict, indent=2, default=str) if a.json else summarize(verdict, out))


def summarize(v: dict, path: Path) -> str:
    r = v["report"]
    lines = [f"status: {v['status'].upper()}  ({path})", f"window {r['window_h']} h  me={r['me']}  partner={r['partner']}"]
    for k in ("publish_count", "publish_gap_s", "parked_latency_s", "partner_saw_me", "i_saw_partner", "peer_contacts"):
        if k in r:
            lines.append(f"  {k}: {json.dumps(r[k], default=str)}")
    if "health" in r:
        h = r["health"]
        keys = [k for k in sorted(h) if k.split(".")[0] in ("sharing", "location", "wake", "last", "ratchet", "bg", "app") or k.startswith("last_") or k == "_age_s"]
        lines.append("  health: " + ", ".join(f"{k}={h[k]}" for k in keys[:40]))
    for f in v["findings"]:
        lines.append(f"  [{f['severity']}] {f['code']}: {f['msg']}")
    return "\n".join(lines)


def cmd_discover(a: argparse.Namespace) -> None:
    end = time.time()
    rows = tempo('{ name = "device.health" } | select(resource.service.instance.id, resource.app.commit, resource.app.build_profile, resource.os.type, resource.device.model.identifier)', end - a.hours * 3600, end, limit=500)
    seen: dict[str, dict] = {}
    for r in rows:
        seen[r.get("service.instance.id", "?")] = {k: v for k, v in r.items() if k not in ("trace", "name")}
    for k, v in seen.items():
        print(k, json.dumps({**v, "t": time.strftime("%m-%d %H:%M", time.localtime(v["t"]))}))


def cmd_notify(a: argparse.Namespace) -> None:
    msg = " ".join(a.msg)
    if msg.startswith("@") and Path(msg[1:]).is_file():  # fs notify @message.md
        msg = Path(msg[1:]).read_text()
    msg = msg[:1900]
    cfg = C.load_config()
    if WEBHOOK_FILE.exists():
        uid = cfg.get("discord_user_id")
        body = json.dumps({"content": (f"<@{uid}> " if uid else "") + msg, "username": cfg.get("persona", {}).get("cryptidName", "field soak")}).encode()
        req = urllib.request.Request(WEBHOOK_FILE.read_text().strip(), data=body, headers={"Content-Type": "application/json", "User-Agent": "field-soak"})
        urllib.request.urlopen(req, timeout=20).read()
        print("sent to discord")
    else:
        subprocess.run(["osascript", "-e", f"display notification {json.dumps(msg)} with title \"streetCryptid field soak\""], check=False)
        print("no webhook file; posted a macOS notification")


BOT_TOKEN_FILE = SECRETS / "field-soak-discord-bot-token"
INBOX_CURSOR = C.STATE / "discord-cursor.json"


def _discord(method: str, path: str, body: dict | None = None) -> Any:
    req = urllib.request.Request(
        f"https://discord.com/api/v10{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Bot {BOT_TOKEN_FILE.read_text().strip()}", "Content-Type": "application/json",
                 "User-Agent": "DiscordBot (streetcryptid-field-soak, 1)"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r) if r.status != 204 else None


def cmd_inbox(a: argparse.Namespace) -> None:
    """New messages in the soak channel since the last read, oldest first. Advances the cursor."""
    cfg = C.load_config()
    chan = cfg["discord_channel_id"]
    me = _discord("GET", "/users/@me")["id"]
    cur = C.read_json(INBOX_CURSOR, {}) or {}
    q = f"?limit=50&after={cur['last']}" if cur.get("last") else "?limit=20"
    msgs = sorted(_discord("GET", f"/channels/{chan}/messages{q}"), key=lambda m: int(m["id"]))
    for m in msgs:
        if m["author"]["id"] == me or m.get("webhook_id"):
            continue
        ts = m["timestamp"][:16].replace("T", " ")
        print(f"[{m['id']}] {ts} {m['author'].get('global_name') or m['author']['username']}: {m['content']}")
    if msgs and not a.peek:
        C.write_json(INBOX_CURSOR, {"last": msgs[-1]["id"]})
    if not any(m["author"]["id"] != me and not m.get("webhook_id") for m in msgs):
        print("(no new messages)")


def cmd_say(a: argparse.Namespace) -> None:
    """Post as the bot (optionally as a reply). Falls back to the webhook if no bot token."""
    msg = " ".join(a.msg)
    if msg.startswith("@") and Path(msg[1:]).is_file():
        msg = Path(msg[1:]).read_text()
    if not BOT_TOKEN_FILE.exists():
        return cmd_notify(argparse.Namespace(msg=[msg]))
    body: dict[str, Any] = {"content": msg[:1990]}
    if a.reply_to:
        body["message_reference"] = {"message_id": a.reply_to, "fail_if_not_exists": False}
    _discord("POST", f"/channels/{C.load_config()['discord_channel_id']}/messages", body)
    print("sent")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--hours", type=float, default=3)
    c.add_argument("--json", action="store_true")
    t = sub.add_parser("tempo")
    t.add_argument("q")
    t.add_argument("hours", nargs="?", type=float, default=3)
    tr = sub.add_parser("trace")
    tr.add_argument("trace_id")
    tr.add_argument("name", nargs="?", default="device.health")
    d = sub.add_parser("discover")
    d.add_argument("hours", nargs="?", type=float, default=24)
    n = sub.add_parser("notify")
    n.add_argument("msg", nargs="+")
    ib = sub.add_parser("inbox")
    ib.add_argument("--peek", action="store_true", help="do not advance the read cursor")
    sy = sub.add_parser("say")
    sy.add_argument("--reply-to")
    sy.add_argument("msg", nargs="+")
    a = p.parse_args()
    if a.cmd == "inbox":
        return cmd_inbox(a)
    if a.cmd == "say":
        return cmd_say(a)
    if a.cmd == "check":
        cmd_check(a)
    elif a.cmd == "tempo":
        end = time.time()
        for s in tempo(a.q, end - a.hours * 3600, end):
            print(time.strftime("%m-%d %H:%M:%S", time.localtime(s["t"])), json.dumps({k: v for k, v in s.items() if k != "t"}))
    elif a.cmd == "trace":
        print(json.dumps(full_span(a.trace_id, a.name), indent=2))
    elif a.cmd == "discover":
        cmd_discover(a)
    else:
        cmd_notify(a)


if __name__ == "__main__":
    main()
