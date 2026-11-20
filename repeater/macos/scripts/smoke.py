#!/usr/bin/env python3
"""Exercise the real bundled host without logging claim capabilities or installing anything."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading


def run(binary, state):
    child = subprocess.Popen(
        [binary, "--state-dir", str(state), "--mode", "user"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True,
    )
    messages = queue.Queue(maxsize=64)

    def read():
        for line in child.stdout:
            messages.put(json.loads(line))

    threading.Thread(target=read, daemon=True).start()

    def take(kind):
        for _ in range(30):
            value = messages.get(timeout=45)
            if value["kind"] == kind:
                assert value["protocol"] == 2
                return value
        raise AssertionError("Expected protocol response did not arrive")

    try:
        before = take("snapshot")["snapshot"]
        assert before["mode"] == "user" and not before["claimed"]
        assert before["claimUrl"].startswith("https://streetcrypt.id/repeater/claim#")
        for command in [
            {"kind": "settings", "telemetry": False, "keepAwake": False},
            {"kind": "name", "name": "Smoke test"},
        ]:
            child.stdin.write(json.dumps(dict(protocol=2, requestId="smoke", **command)) + "\n")
            child.stdin.flush()
            assert take("result")["ok"]
            after = take("snapshot")["snapshot"]
        assert after["name"] == "Smoke test"
        assert not after["settings"]["telemetry"]
        assert not after["keepAwakeHeld"]
        child.stdin.close()
        assert child.wait(timeout=12) == 0
        return before["endpointId"]
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        child.stdout.close()


with tempfile.TemporaryDirectory(prefix="sc-macos-smoke-") as directory:
    os.chmod(directory, 0o700)
    state = Path(directory)
    first = run(sys.argv[1], state)
    key = (state / "secret.key").read_bytes()
    assert first == run(sys.argv[1], state)
    assert (state / "secret.key").read_bytes() == key
    assert (state / "secret.key").stat().st_mode & 0o777 == 0o600
print("Bundled host: commands, EOF shutdown, private identity and restart passed.")
