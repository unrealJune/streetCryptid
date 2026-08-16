#!/usr/bin/env python3
"""Parser for this harness's constrained scenario YAML subset (scripts/e2e/scenarios/*.yaml).

Not a general YAML parser — supports exactly what those files use: top-level `key: value`
scalars (quoted/unquoted strings, ints, booleans) plus one `assertions:` block holding a list
of flat two-key mappings (`- action: ...` / `  status: ...` / `  min_count: ...`). Kept
dependency-free (stdlib only), matching hierarchy_text.py's convention, since PyYAML isn't a
guaranteed-installed dependency of this repo's Python usage.

Usage: scenario.py <path/to/scenario.yaml>   # prints the parsed scenario as JSON on stdout
"""

import json
import sys
from typing import Optional


def _scalar(raw: str):
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    if raw in ("true", "false"):
        return raw == "true"
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


def parse(text: str) -> dict:
    result: dict = {}
    assertions: list = []
    current: Optional[dict] = None
    in_assertions = False
    for raw_line in text.splitlines():
        line = raw_line.split(" #", 1)[0].rstrip()
        if not line.strip() or line.strip().startswith("#"):
            continue
        if line == "assertions:":
            in_assertions = True
            continue
        if in_assertions:
            if line.startswith("  - "):
                if current is not None:
                    assertions.append(current)
                current = {}
                key, _, value = line[4:].partition(":")
                current[key.strip()] = _scalar(value)
                continue
            if line.startswith("    ") and current is not None:
                key, _, value = line.strip().partition(":")
                current[key.strip()] = _scalar(value)
                continue
            in_assertions = False
        if current is not None:
            assertions.append(current)
            current = None
        key, sep, value = line.partition(":")
        if not sep:
            raise ValueError(f"unparseable line: {raw_line!r}")
        result[key.strip()] = _scalar(value)
    if current is not None:
        assertions.append(current)
    result["assertions"] = assertions
    return result


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: scenario.py <scenario.yaml>", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        text = f.read()
    try:
        parsed = parse(text)
    except ValueError as error:
        print(f"scenario.py: {sys.argv[1]}: {error}", file=sys.stderr)
        return 1
    print(json.dumps(parsed))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
