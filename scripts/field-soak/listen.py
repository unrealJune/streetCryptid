#!/usr/bin/env python3
"""Wake a Sonnet chat tick when someone writes in the soak's Discord channel.

Polls the channel over REST every POLL_S (the gateway would be instant, but needs a websocket
client and a resident connection, and 20 s is fast enough for a conversation with a kappa). When a
message from a human is newer than the inbox cursor that `fs inbox` keeps, it shows the typing
indicator and runs `tick.sh chat`, which reads the inbox (advancing that cursor) and replies.

`tick.sh` takes the same lock as the scheduled ticks, so a chat tick never overlaps one. If a
scheduled tick is running, it reads the inbox itself, and this loop sees nothing left to answer.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check as K  # noqa: E402
import common as C  # noqa: E402

POLL_S = 20
TICK_LOCK = C.STATE / "tick.lock"


MIN_GAP_S = 120


def newest_pending(chan: str, me: str) -> int | None:
    """Id of the newest unread human message, or None."""
    cur = (C.read_json(K.INBOX_CURSOR, {}) or {}).get("last")
    q = f"?limit=20&after={cur}" if cur else "?limit=5"
    msgs = K._discord("GET", f"/channels/{chan}/messages{q}")
    ids = [int(m["id"]) for m in msgs if m["author"]["id"] != me and not m.get("webhook_id") and not m["author"].get("bot")]
    return max(ids) if ids else None


def main() -> None:
    chan = C.load_config()["discord_channel_id"]
    me = K._discord("GET", "/users/@me")["id"]
    print(f"listening on channel {chan} as {me}", flush=True)
    # A chat tick that fails without advancing the inbox cursor must not be relaunched for the
    # same message every POLL_S: trigger once per newest message, and never faster than MIN_GAP_S.
    last_triggered, last_at = 0, 0.0
    while True:
        try:
            newest = newest_pending(chan, me)
            if newest and newest > last_triggered and time.time() - last_at > MIN_GAP_S and not TICK_LOCK.exists():
                last_triggered, last_at = newest, time.time()
                K._discord("POST", f"/channels/{chan}/typing")
                print(time.strftime("%H:%M:%S"), "message waiting: starting a chat tick", flush=True)
                subprocess.run(["/bin/bash", str(HERE / "tick.sh"), "chat"], check=False)
        except Exception as ex:  # noqa: BLE001 — a network blip must not kill the listener
            print(time.strftime("%H:%M:%S"), f"poll failed: {type(ex).__name__}: {ex}", flush=True)
            time.sleep(60)
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
