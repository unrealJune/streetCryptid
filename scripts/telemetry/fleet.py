#!/usr/bin/env python3
"""fleet.py [hours=168] [--all]  -- every phone that shipped telemetry, newest-silent last.

One row per `service.instance.id` (the TELEMETRY ID on a friend card): model, build, when it was
last heard at all, and when it last published (`trail.push`) and pulled (`friend.pull`). A phone
heard recently with an old publish is alive and not sharing; one not heard at all is dark (dead
battery, uninstalled, telemetry unreachable, or a build without it). Then run who.py on the id.

CI emulators and the OnePlus test rig mint a new id per run and are hidden unless --all.
Reads Prometheus span metrics, never Tempo search: a limited Tempo search does not reliably return
the newest spans, and "last heard" is exactly the newest span.
"""

import sys

from who import NOW, ago, run, semver, series_last

CI_MODELS = ("sdk_gphone", "OnePlus8Pro", "emulator")
METRIC = "traces_span_metrics_calls_total"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show_all = "--all" in sys.argv
    hours = int(args[0]) if args else 168
    step = 900 if hours <= 72 else 1800
    start = NOW - hours * 3600

    # Resource labels ride only on the JS spans (service_version set); Rust spans carry the id.
    idents = series_last(
        run("pq.sh", f'count by (service_instance_id, device_model, os_name, os_version, service_version) ({METRIC}{{service_version!=""}})', hours, step),
        ["service_instance_id", "device_model", "os_name", "os_version", "service_version"], start,
    )
    # count by() never moves, so "seen" here is just presence; take the newest version per id.
    info = {}
    for m, _, _ in idents:
        iid = m["service_instance_id"]
        cur = info.get(iid)
        if cur is None or semver(m["service_version"]) > semver(cur["service_version"]):
            info[iid] = m

    activity = series_last(
        run("pq.sh", f'sum by (service_instance_id, span_name, service_name) ({METRIC}{{span_name=~"trail.push|friend.pull|location.runtime|device.health|engine.ingest|engine.heartbeat|peer.contact|app.lifecycle|tx"}})', hours, step),
        ["service_instance_id", "span_name", "service_name"], start,
    )
    last, service = {}, {}
    for m, t, _ in activity:
        service.setdefault(m["service_instance_id"], m["service_name"])
        if t is None:
            continue
        row = last.setdefault(m["service_instance_id"], {})
        row[m["span_name"]] = max(t, row.get(m["span_name"], 0))
        row["*"] = max(t, row.get("*", 0))

    is_ci = lambda m: any(c in m.get("device_model", "") for c in CI_MODELS)  # noqa: E731
    newest = max((m["service_version"] for m in info.values() if not is_ci(m)), key=semver, default="")
    rows = []
    for iid in set(info) | set(last):
        m = info.get(iid, {})
        if not show_all and is_ci(m):
            continue
        if not m:  # no JS spans: the stash or a repeater, named by its service
            m = {"device_model": f"({service.get(iid, '?')})"}
        a = last.get(iid, {})
        rows.append((a.get("*"), iid, m, a))
    rows.sort(key=lambda r: -(r[0] or 0))

    print(f"{'id':<11} {'model':<20} {'os':<12} {'build':<8} {'heard':>12} {'published':>12} {'pulled':>12}")
    for heard, iid, m, a in rows:
        ver = m.get("service_version", "?")
        old = "*" if ver != "?" and semver(ver) < semver(newest) else " "
        osv = f"{m.get('os_name', '')} {m.get('os_version', '')}".strip()
        print(f"{iid:<11} {m.get('device_model', '?')[:20]:<20} {osv[:12]:<12} {ver:<7}{old} "
              f"{ago(heard):>12} {ago(a.get('trail.push')):>12} {ago(a.get('friend.pull')):>12}")
    print(f"\n* = behind the newest phone build seen ({newest}). Window {hours} h. Then: who.py <id>")


if __name__ == "__main__":
    main()
