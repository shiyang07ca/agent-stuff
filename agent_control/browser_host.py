"""macOS web-browser Native Messaging files; no browser/profile changes."""
from __future__ import annotations

import json
import shlex
from pathlib import Path

HOST_NAME = "io.agent_stuff.web_browser"
EXTENSION_ID = "ddgmfcjoimgcdlbeigjpbdaobbnemjfn"
_DESCRIPTION = "agent-stuff managed web-browser Native Messaging host"
_LAUNCHER_MARKER = "# Managed by agent-stuff: io.agent_stuff.web_browser"


def launcher_content(node: Path, script: Path, browser: str) -> bytes:
    return (
        f"#!/bin/sh\n{_LAUNCHER_MARKER}\n"
        f"exec {shlex.quote(str(node))} {shlex.quote(str(script))} {browser}\n"
    ).encode()


def native_host_specs(
    repo: Path, home: Path, node: Path,
) -> tuple[tuple[Path, bytes, int], ...]:
    script = repo / ".runtime/current/skills/web-browser/scripts/native-host.js"
    support = home / "Library/Application Support"
    specs: list[tuple[Path, bytes, int]] = []
    for browser, folder in (("edge", "Microsoft Edge"), ("chrome", "Google/Chrome")):
        launcher = support / "agent-stuff/web-browser" / f"native-host-{browser}"
        manifest = support / folder / "NativeMessagingHosts" / f"{HOST_NAME}.json"
        content = json.dumps({
            "name": HOST_NAME,
            "description": _DESCRIPTION,
            "path": str(launcher),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
        }, indent=2) + "\n"
        specs.extend(((launcher, launcher_content(node, script, browser), 0o700),
                      (manifest, content.encode(), 0o600)))
    return tuple(specs)


def owns_native_host_file(path: Path, previous: bytes, desired: bytes) -> bool:
    """Accept only our complete format, with a previous absolute Node path."""
    try:
        if path.suffix == ".json":
            return json.loads(previous) == json.loads(desired)
        previous_lines = previous.decode().splitlines()
        desired_command = shlex.split(desired.decode().splitlines()[2])
        if len(previous_lines) != 3:
            return False
        command = shlex.split(previous_lines[2])
        if len(command) != 4 or command[0] != "exec" or command[2:] != desired_command[2:]:
            return False
        node = Path(command[1])
        return node.is_absolute() and previous == launcher_content(
            node, Path(command[2]), command[3],
        )
    except (UnicodeError, ValueError, IndexError):
        return False
