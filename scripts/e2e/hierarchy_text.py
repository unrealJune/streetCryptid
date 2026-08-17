#!/usr/bin/env python3
"""Extract a single accessibility-text value from a `maestro hierarchy` JSON dump.

Reads the hierarchy JSON from stdin, finds the first node whose `resource-id`
(Maestro's iOS mapping of RN `testID`) matches the given id, and prints its
`accessibilityText`. Exits 1 with nothing on stdout if no match is found, so
callers can fail fast instead of silently piping an empty string downstream.

Usage: maestro --udid <udid> hierarchy | hierarchy_text.py <testID>
"""

import json
import sys
from typing import Optional


def find(node: object, resource_id: str) -> Optional[str]:
    """Locate a node by test id and return its accessibility text.

    Understands BOTH hierarchy dialects, so the harness works under either runner:

      maestro CLI      {"attributes": {"resource-id": ..., "accessibilityText": ..., "text": ...}}
      maestro-runner   {"id": ..., "text": ...}        (flattened; folds accessibilityText
                       (devicelab.dev)                  into `text`, bounds become an object)

    Keeping one parser that reads both is what lets the runner be swapped as a pure transport
    decision — same flows, same selectors, same assertions — instead of a migration.
    """
    if not isinstance(node, dict):
        return None
    attrs = node.get("attributes", {})
    # maestro CLI shape
    if attrs.get("resource-id") == resource_id:
        return attrs.get("accessibilityText")
    # maestro-runner shape: fields hoisted to the node, `text` carries the accessibility label
    if node.get("id") == resource_id:
        return node.get("text")
    for child in node.get("children", []) or []:
        result = find(child, resource_id)
        if result is not None:
            return result
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: hierarchy_text.py <testID>", file=sys.stderr)
        return 2
    resource_id = sys.argv[1]
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        print(f"hierarchy_text.py: invalid JSON on stdin: {error}", file=sys.stderr)
        return 1
    result = find(data, resource_id)
    if result is None:
        print(f"hierarchy_text.py: no element with resource-id={resource_id!r}", file=sys.stderr)
        return 1
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
