#!/usr/bin/env python3
"""who.py <telemetry-id> [hours]  -- one phone's account of itself, on one screen.

The id is what a friend card shows as TELEMETRY ID with "Show friend connection details" on: the
first ten hex of the friend's endpoint id, i.e. `service.instance.id` on every span that phone
ships. It answers, in order: when did the phone last say anything and on which build; is it still
capturing, publishing and pulling; what did it last report about its own permissions and runtime
(`device.health`, read against the mismatch table in infra/otel/README.md); did anything end it
(crash, hang, init stall, isolation); and which phones has it actually talked to.

Uses the same Grafana settings as tq.sh / pq.sh (GRAFANA_URL, GRAFANA_TOKEN, optional proxy).
"""

import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
NOW = time.time()

# Spans that say the phone is doing its job, in pipeline order. Absence of one while the earlier
# ones run is where to look.
KEY_SPANS = [
    ("device.health", "app opened / periodic refresh (JS; iOS only when foreground)"),
    ("location.runtime", "native location runtime alive (5 min pulse)"),
    ("engine.ingest", "a fix reached the core"),
    ("engine.heartbeat", "a heartbeat (parked / clock) reached the core"),
    ("trail.push", "published to stash + friends"),
    ("friend.pull", "native pull of friends' fixes"),
    ("trail.sync", "any friend sync"),
    ("peer.contact", "actually exchanged data with a phone or the stash"),
]

TROUBLE = [
    "ios.diagnostic",
    "app.previous_run",
    "app.init.timeout",
    "app.init.stranded",
    "app.init.failed",
    "ui.hang",
    "node.isolation",
    "bg.refresh.expired",
    "pairing.poll.stalled",
]

HEALTH_FIELDS = [
    "sharing.enabled", "sharing.muted", "sharing.friends", "sharing.recipients",
    "sharing.native_recipients", "ratchet.dropped", "ratchet.dropped_lapsed",
    "perm.foreground", "perm.background", "perm.ios_scope", "perm.accuracy",
    "task.location_running", "task.refresh_status", "battery.optimization_exempt",
    "storage.backend", "telemetry.queued",
    "last_fix_age_ms", "last_publish_age_ms", "last_push_age_ms", "last_wake_age_ms",
    "location.state", "location.wake_reason", "location.auth_status",
    "location.fence_registered", "location.moving_fence_armed", "location.delegate_on_main",
    "wake.wakes", "wake.syncs", "wake.publish_expired", "wake.publish_stranded",
    "wake.pull_expired", "wake.pull_stranded",
]


def run(script, query, *args):
    # The query goes through the environment, not argv: on Windows, MSYS's sh re-parses its
    # command line and mangles brace-bearing arguments (`m{a="b"}` arrives as `m`), which turned
    # every PromQL selector into "all phones" without a word.
    proc = subprocess.run(
        ["sh", "-c", 'exec sh "$0" "$SC_QUERY" "$@"', os.path.join(HERE, script), *[str(a) for a in args]],
        capture_output=True, text=True, env={**os.environ, "SC_QUERY": query},
    )
    if proc.returncode != 0:
        sys.exit(f"{script} failed: {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.exit(f"{script} returned non-JSON: {proc.stdout[:300]}")


def ago(ts):
    if ts is None:
        return "never"
    s = NOW - ts
    if s < 90:
        return "just now"
    if s < 5400:
        return f"{s / 60:.0f} min ago"
    if s < 172800:
        return f"{s / 3600:.1f} h ago"
    return f"{s / 86400:.1f} d ago"


def ms(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return str(v)
    if v < 120000:
        return f"{v / 1000:.0f} s"
    if v < 7200000:
        return f"{v / 60000:.0f} min"
    return f"{v / 3600000:.1f} h"


def series_last(prom, by, window_start):
    """[(labels, last_seen_ts, count)] from a query_range of the RAW counter, grouped by `by`.

    Not increase(): a span emitted once creates a series whose first sample increase() reads as 0,
    so a phone's single `device.health` or `app.previous_run` vanished. Here a series born inside
    the window counts as events at its first sample, and every later step where the counter moved
    counts at that step.
    """
    grouped = {}
    for s in prom.get("data", {}).get("result", []):
        pts = [(float(t), float(v)) for t, v in s["values"]]
        if not pts:
            continue
        last, n = None, 0.0
        if pts[0][0] > window_start + 1:  # born inside the window
            last, n = pts[0][0], pts[0][1]
        for (_, v0), (t1, v1) in zip(pts, pts[1:]):
            if v1 > v0:
                last, n = t1, n + (v1 - v0)
            elif v1 < v0:  # counter reset (collector restart)
                last, n = t1, n + v1
        key = tuple((k, s["metric"].get(k, "")) for k in by)
        prev_t, prev_n = grouped.get(key, (None, 0.0))
        best = max((x for x in (prev_t, last) if x is not None), default=None)
        grouped[key] = (best, prev_n + n)
    return [(dict(k), t, n) for k, (t, n) in grouped.items()]


def spans(tempo):
    for t in tempo.get("traces", []):
        sets = t.get("spanSets") or ([t["spanSet"]] if t.get("spanSet") else [])
        for ss in sets:
            for sp in ss.get("spans", []):
                attrs = {}
                for a in sp.get("attributes", []):
                    v = a.get("value", {})
                    attrs[a["key"]] = next(iter(v.values()), None) if v else None
                yield int(sp["startTimeUnixNano"]) / 1e9, sp.get("name") or t.get("rootTraceName"), attrs


def semver(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:3]) or (0,)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def flags(h):
    """The mismatch table in infra/otel/README.md ("Reading silence"), as one-liners."""
    f = []
    sharing = h.get("sharing.enabled")
    if sharing in (False, "false"):
        f.append("sharing is switched OFF on this phone")
    if h.get("sharing.muted"):
        f.append(f"phone knows it cannot share: sharing.muted={h['sharing.muted']}")
    bg = h.get("perm.background")
    if bg and bg != "granted":
        f.append(f"background location not granted (perm.background={bg}) -- needs 'Always' / 'Allow all the time'")
    if h.get("perm.accuracy") == "reduced":
        f.append("precise location is OFF -- every fix fails the quality gate")
    if h.get("task.refresh_status") == "restricted":
        f.append("Background App Refresh is off")
    if sharing in (True, "true") and h.get("task.location_running") in (False, "false"):
        f.append("sharing on but the OS is not delivering location (task.location_running=false)")
    if h.get("battery.optimization_exempt") in (False, "false"):
        f.append("battery optimisation applies (not exempt) -- Android may kill the service")
    if h.get("storage.backend") == "memory":
        f.append("storage.backend=memory -- loses its pool on every restart")
    rec, nat = num(h.get("sharing.recipients")), num(h.get("sharing.native_recipients"))
    if rec and rec >= 1 and nat == 0:
        f.append("JS pool and native seal list diverged: publishing sealed for nobody")
    dropped = num(h.get("ratchet.dropped"))
    if rec and dropped is not None and dropped >= rec:
        f.append("every recipient's session dropped/lapsed: publishing to nobody (see session.recover)")
    q = num(h.get("telemetry.queued"))
    if q and q > 500:
        f.append(f"telemetry backlog {q:.0f} -- the phone may be fine and unable to reach us")
    if h.get("location.state") == "stopped" and h.get("location.fence_registered") in (False, "false"):
        f.append("parked with no fence -- nothing will wake it when it leaves")
    if h.get("location.state") == "moving" and h.get("location.moving_fence_armed") in (False, "false"):
        f.append("moving with no moving fence -- relaunched process wakes only on SLC/visits")
    if h.get("location.delegate_on_main") in (False, "false"):
        f.append("Core Location delegate not on main -- deaf runtime")
    for k in ("wake.publish_expired", "wake.publish_stranded", "wake.pull_expired", "wake.pull_stranded"):
        if (num(h.get(k)) or 0) > 0:
            f.append(f"{k}={h[k]} -- iOS cut work off mid-flight")
    return f


def main():
    if len(sys.argv) < 2 or not re.fullmatch(r"[0-9a-fA-F]{6,64}", sys.argv[1]):
        sys.exit("usage: who.py <telemetry-id> [hours=48]")
    iid = sys.argv[1].lower()[:10]
    hours = int(sys.argv[2]) if len(sys.argv) > 2 else 48
    sel = f'service_instance_id="{iid}"'
    step = 300 if hours <= 72 else 1800
    win = f"{step // 60} min"
    start = NOW - hours * 3600
    metric = "traces_span_metrics_calls_total"

    by_span = series_last(run("pq.sh", f"{metric}{{{sel}}}", hours, step), ["span_name"], start)
    versions = series_last(run("pq.sh", f'{metric}{{{sel}, service_version!=""}}', hours, step), ["service_version", "os_name"], start)
    fleet_versions = series_last(run("pq.sh", f'count by (service_version) ({metric}{{service_version!=""}})', 168, 3600), ["service_version"], NOW - 168 * 3600)
    outbound = series_last(run("pq.sh", f'{metric}{{{sel}, span_name="peer.contact"}}', hours, step), ["sc_peer", "contact_role"], start)
    inbound = series_last(run("pq.sh", f'{metric}{{sc_peer="{iid}", span_name="peer.contact"}}', hours, step), ["service_instance_id"], start)

    health = sorted(
        spans(run("tq.sh", f'{{ name = "device.health" && resource.service.instance.id = "{iid}" }} | select('
                  + ", ".join(["resource.device.model", "resource.os.name", "resource.os.version", "resource.app.native_version", "resource.app.native_build"]
                              + [f"span.{k}" for k in HEALTH_FIELDS]) + ")", 168, 100)),
        key=lambda s: s[0],
    )
    trouble = sorted(
        spans(run("tq.sh", "{ resource.service.instance.id = \"" + iid + "\" && ("
                  + " || ".join(f'name = "{n}"' for n in TROUBLE) + ") } | select(span.prev.last_state, span.prev.dark_ms, "
                  "span.termination_reason, span.diag.kind, span.duration_ms, span.init.phase, span.trigger, span.event, "
                  "span.last_step, span.error)", hours, 200)),
        key=lambda s: s[0],
    )

    # ---- header -------------------------------------------------------------------------------
    last_any = max((t for _, t, _ in by_span if t), default=None)
    latest_health = health[-1][2] if health else {}
    model = latest_health.get("device.model") or "unknown model"
    osv = " ".join(str(x) for x in (latest_health.get("os.name"), latest_health.get("os.version")) if x)
    ver = max(((t, m.get("service_version"), m.get("os_name")) for m, t, _ in versions if t), default=None)
    # Any version the fleet ran this week; count by() series never "move", so read them all.
    newest = max((m.get("service_version") for m, _, _ in fleet_versions), key=semver, default=None)
    print(f"== {iid}  {model} {osv}".rstrip())
    print(f"   last heard: {ago(last_any)}   (window {hours} h; resolution {win})")
    if ver:
        behind = f"  << fleet newest is {newest}" if newest and semver(ver[1]) < semver(newest) else ""
        print(f"   build: {ver[1]} ({ver[2]}){behind}")
    if not by_span:
        print("   NOTHING in this window. Wrong id, telemetry off in that build, or the phone has been dark longer.")

    # ---- pipeline -----------------------------------------------------------------------------
    print("\n-- pipeline (last seen, count in window)")
    have = {m.get("span_name"): (t, n) for m, t, n in by_span}
    for name, why in KEY_SPANS:
        t, n = have.get(name, (None, 0))
        print(f"   {name:<18} {ago(t):>14}  {n:>7.0f}   {why}")

    # ---- device.health ------------------------------------------------------------------------
    print("\n-- device.health" + (f" (latest, {ago(health[-1][0])})" if health else " -- none in 7 d"))
    if health:
        h = latest_health
        for k in HEALTH_FIELDS:
            if h.get(k) is None:
                continue
            v = ms(h[k]) if k.endswith("_ms") else h[k]
            print(f"   {k:<30} {v}")
        problems = flags(h)
        print("\n-- flags" + ("" if problems else ": none on the latest record"))
        for p in problems:
            print(f"   !! {p}")

    # ---- trouble ------------------------------------------------------------------------------
    print(f"\n-- endings & stalls ({len(trouble)})")
    for ts, name, a in trouble[-15:]:
        detail = " ".join(f"{k}={v}" for k, v in a.items() if v is not None and k != "service.instance.id")
        print(f"   {ago(ts):>14}  {name:<20} {detail}")

    # ---- contact ------------------------------------------------------------------------------
    print("\n-- it reached (peer.contact from this phone)")
    outbound = [o for o in outbound if o[1]]
    inbound = [i for i in inbound if i[1]]
    for m, t, n in sorted(outbound, key=lambda x: -(x[1] or 0)):
        print(f"   {m.get('sc_peer', '?'):<12} {m.get('contact_role', ''):<7} {ago(t):>14}  x{n:.0f}")
    if not outbound:
        print("   nobody in this window")
    print("-- reached it (peer.contact naming this phone)")
    for m, t, n in sorted(inbound, key=lambda x: -(x[1] or 0)):
        print(f"   {m.get('service_instance_id', '?'):<12} {ago(t):>22}  x{n:.0f}")
    if not inbound:
        print("   nobody in this window")


if __name__ == "__main__":
    main()
