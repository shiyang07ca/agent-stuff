from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path

from .models import DesiredState, Finding, SkillSelection


_IGNORED_NAMES = {
    "__pycache__",
    ".DS_Store",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}
_CLAUDE_POLICY_KEY = re.compile(
    r"^disable-model-invocation:[ \t]*(?P<value>true|false)[ \t]*$"
)
_CODEX_POLICY_HEADER = re.compile(r"^policy:[ \t]*(?:#.*)?$")
_CODEX_POLICY_KEY = re.compile(
    r"^(?P<indent>[ \t]*)allow_implicit_invocation:[ \t]*"
    r"(?P<value>true|false)[ \t]*(?:#.*)?$"
)


def desired_snapshot_identity(
    state: DesiredState,
    *,
    inventory: dict[str, tuple[str, str, bool]] | None = None,
) -> str:
    authorities: list[dict[str, object]] = []
    for relative in (
        "AGENTS.md",
        "CLAUDE.md",
        "config/agent-control.toml",
        "global/AGENTS.md",
    ):
        path = state.repo / relative
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError(f"Authoritative input is not a regular file: {relative}")
        authorities.append(
            {
                "path": relative,
                "content": hashlib.sha256(path.read_bytes()).hexdigest(),
                "executable": bool(metadata.st_mode & stat.S_IXUSR),
            }
        )
    skills = [
        {
            "name": selection.name,
            "source": selection.source,
            "invocation": selection.invocation,
        }
        for selection in state.skills
    ]
    serialized_inventory = _serializable_inventory(
        inventory if inventory is not None else expected_snapshot_inventory(state)
    )
    payload = json.dumps(
        {
            "authorities": authorities,
            "inventory": serialized_inventory,
            "skills": skills,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def expected_snapshot_inventory(
    state: DesiredState,
) -> dict[str, tuple[str, str, bool]]:
    inventory: dict[str, tuple[str, str, bool]] = {}
    for selection in state.skills:
        for relative, metadata in _adapted_skill_inventory(selection).items():
            inventory[f"skills/{selection.name}/{relative}"] = metadata
    return inventory


def read_snapshot_inventory(root: Path) -> dict[str, tuple[str, str, bool]]:
    skills = root / "skills"
    if not skills.exists() and not skills.is_symlink():
        return {}
    metadata = skills.lstat()
    executable = bool(metadata.st_mode & stat.S_IXUSR)
    if skills.is_symlink():
        return {"skills": ("symlink", os.readlink(skills), executable)}
    if skills.is_file():
        return {
            "skills": (
                "file",
                hashlib.sha256(skills.read_bytes()).hexdigest(),
                executable,
            )
        }
    if not skills.is_dir():
        return {"skills": ("other", "", executable)}
    return {
        f"skills/{relative}": metadata
        for relative, metadata in _runtime_inventory(skills).items()
    }


def inventory_identity(inventory: dict[str, tuple[str, str, bool]]) -> str:
    payload = json.dumps(
        _serializable_inventory(inventory),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def _serializable_inventory(
    inventory: dict[str, tuple[str, str, bool]],
) -> list[dict[str, object]]:
    return [
        {
            "path": path,
            "kind": metadata[0],
            "value": metadata[1],
            "executable": metadata[2],
        }
        for path, metadata in sorted(inventory.items())
    ]


def _runtime_inventory(root: Path) -> dict[str, tuple[str, str, bool]]:
    return {
        path: metadata
        for path, metadata in _inventory(root).items()
        if metadata[0] != "directory"
    }


def _adapted_skill_inventory(
    selection: SkillSelection,
) -> dict[str, tuple[str, str, bool]]:
    inventory = _runtime_inventory(selection.source_path)
    if selection.invocation != "explicit":
        return inventory

    adapted_contents: dict[str, str] = {}
    skill_destination = _adapter_destination(selection.source_path, "SKILL.md")
    skill_input = _adapter_input_content(
        selection.source_path,
        skill_destination,
        adapted_contents,
    )
    if skill_input is None:
        raise OSError("Adapted snapshot path is missing: SKILL.md")
    _store_adapted_content(
        inventory,
        adapted_contents,
        skill_destination,
        _claude_explicit_content(skill_input),
    )

    openai_relative = "agents/openai.yaml"
    openai_destination = _adapter_destination(selection.source_path, openai_relative)
    openai_input = _adapter_input_content(
        selection.source_path,
        openai_destination,
        adapted_contents,
    )
    _store_adapted_content(
        inventory,
        adapted_contents,
        openai_destination,
        _codex_explicit_content(openai_input),
    )
    return inventory


def _adapter_destination(root: Path, relative: str) -> str:
    resolved_root = root.resolve(strict=True)
    try:
        return (
            (root / relative)
            .resolve(strict=False)
            .relative_to(resolved_root)
            .as_posix()
        )
    except (RuntimeError, ValueError) as error:
        raise OSError(f"Adapted snapshot path escapes its skill: {relative}") from error


def _adapter_input_content(
    root: Path,
    destination: str,
    adapted_contents: dict[str, str],
) -> str | None:
    if destination in adapted_contents:
        return adapted_contents[destination]
    path = root / destination
    return path.read_text() if path.is_file() else None


def _store_adapted_content(
    inventory: dict[str, tuple[str, str, bool]],
    adapted_contents: dict[str, str],
    destination: str,
    content: str,
) -> None:
    metadata = inventory.get(destination)
    if metadata is not None and metadata[0] != "file":
        raise OSError(f"Adapted snapshot path is not a regular file: {destination}")
    executable = metadata[2] if metadata is not None else False
    inventory[destination] = (
        "file",
        hashlib.sha256(content.encode()).hexdigest(),
        executable,
    )
    adapted_contents[destination] = content


def build_candidate_snapshot(
    state: DesiredState,
    destination: Path,
    snapshot_id: str,
    *,
    expected_inventory: dict[str, tuple[str, str, bool]],
) -> tuple[int, list[Finding]]:
    findings: list[Finding] = []
    try:
        candidate_skills = destination / "skills"
        candidate_skills.mkdir()
        for selection in state.skills:
            skill_destination = candidate_skills / selection.name
            shutil.copytree(
                selection.source_path,
                skill_destination,
                symlinks=True,
                ignore=_copy_ignore,
            )
            if _inventory(selection.source_path) != _inventory(skill_destination):
                findings.append(
                    Finding(
                        "error",
                        "SNAPSHOT_CONTENT_MISMATCH",
                        f"Candidate copy did not preserve source content for {selection.name!r}.",
                        selection.source,
                    )
                )
                continue
            if not _candidate_symlinks_are_internal(skill_destination):
                findings.append(
                    Finding(
                        "error",
                        "SNAPSHOT_SYMLINK_ESCAPE",
                        f"Candidate contains a symlink outside copied skill {selection.name!r}.",
                        selection.source,
                    )
                )
                continue
            _apply_invocation_adapters(skill_destination, selection)
            _validate_adapted_candidate(skill_destination, selection, findings)

        actual_inventory = read_snapshot_inventory(destination)
        if actual_inventory != expected_inventory:
            findings.append(
                Finding(
                    "error",
                    "SNAPSHOT_CONTENT_MISMATCH",
                    "Candidate snapshot does not match the planned runtime inventory.",
                )
            )
        elif desired_snapshot_identity(state, inventory=actual_inventory) != snapshot_id:
            findings.append(
                Finding(
                    "error",
                    "SNAPSHOT_IDENTITY_MISMATCH",
                    "Candidate snapshot does not match the reviewed desired state.",
                )
            )
        if not findings:
            (destination / ".snapshot-id").write_text(f"{snapshot_id}\n")
    except (OSError, UnicodeError, ValueError) as error:
        findings.append(
            Finding(
                "error",
                "SNAPSHOT_BUILD_FAILED",
                f"Cannot build candidate snapshot: {error}",
            )
        )
    return len(state.skills), findings


def validate_candidate_snapshot(state: DesiredState) -> tuple[int, list[Finding]]:
    try:
        expected_inventory = expected_snapshot_inventory(state)
        snapshot_id = desired_snapshot_identity(state, inventory=expected_inventory)
        with tempfile.TemporaryDirectory(
            prefix="agent-control-candidate-"
        ) as temporary:
            return build_candidate_snapshot(
                state,
                Path(temporary),
                snapshot_id,
                expected_inventory=expected_inventory,
            )
    except (OSError, UnicodeError, ValueError) as error:
        return len(state.skills), [
            Finding(
                "error",
                "SNAPSHOT_BUILD_FAILED",
                f"Cannot build candidate snapshot: {error}",
            )
        ]


def _copy_ignore(_directory: str, names: list[str]) -> set[str]:
    return {name for name in names if name in _IGNORED_NAMES or name.endswith(".pyc")}


def _inventory(root: Path) -> dict[str, tuple[str, str, bool]]:
    inventory: dict[str, tuple[str, str, bool]] = {}
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        directory_names[:] = [
            name
            for name in directory_names
            if name not in _IGNORED_NAMES and not name.endswith(".pyc")
        ]
        for name in sorted((*directory_names, *file_names)):
            if name in _IGNORED_NAMES or name.endswith(".pyc"):
                continue
            path = directory_path / name
            relative = path.relative_to(root).as_posix()
            metadata = path.lstat()
            executable = bool(metadata.st_mode & stat.S_IXUSR)
            if path.is_symlink():
                inventory[relative] = ("symlink", os.readlink(path), executable)
            elif path.is_dir():
                inventory[relative] = ("directory", "", executable)
            else:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                inventory[relative] = ("file", digest, executable)
    return inventory


def _apply_invocation_adapters(destination: Path, selection: SkillSelection) -> None:
    if selection.invocation != "explicit":
        return
    _set_claude_explicit(destination / "SKILL.md")
    _set_codex_explicit(destination / "agents" / "openai.yaml")


def _set_claude_explicit(skill_file: Path) -> None:
    skill_file.write_text(_claude_explicit_content(skill_file.read_text()))


def _claude_explicit_content(content: str) -> str:
    lines = content.splitlines()
    closing_index = lines.index("---", 1)
    for index in range(1, closing_index):
        if _CLAUDE_POLICY_KEY.fullmatch(lines[index]):
            lines[index] = "disable-model-invocation: true"
            break
    else:
        lines.insert(closing_index, "disable-model-invocation: true")
    return "\n".join(lines) + "\n"


def _set_codex_explicit(openai_file: Path) -> None:
    openai_file.parent.mkdir(parents=True, exist_ok=True)
    content = openai_file.read_text() if openai_file.exists() else None
    openai_file.write_text(_codex_explicit_content(content))


def _codex_explicit_content(content: str | None) -> str:
    if content is None:
        return "policy:\n  allow_implicit_invocation: false\n"
    lines = content.splitlines()
    key_indexes = [
        index for index, line in enumerate(lines) if _CODEX_POLICY_KEY.fullmatch(line)
    ]
    if key_indexes:
        lines[key_indexes[0]] = "  allow_implicit_invocation: false"
    else:
        policy_indexes = [
            index
            for index, line in enumerate(lines)
            if _CODEX_POLICY_HEADER.fullmatch(line)
        ]
        if not policy_indexes:
            if lines and lines[-1]:
                lines.append("")
            lines.extend(["policy:", "  allow_implicit_invocation: false"])
        else:
            lines.insert(policy_indexes[0] + 1, "  allow_implicit_invocation: false")
    return "\n".join(lines).rstrip("\n") + "\n"


def _validate_adapted_candidate(
    destination: Path, selection: SkillSelection, findings: list[Finding]
) -> None:
    skill_content = (destination / "SKILL.md").read_text()
    skill_lines = skill_content.splitlines()
    closing_index = skill_lines.index("---", 1)
    claude_policies = [
        match
        for line in skill_lines[1:closing_index]
        if (match := _CLAUDE_POLICY_KEY.fullmatch(line)) is not None
    ]
    openai_file = destination / "agents" / "openai.yaml"
    openai_lines = openai_file.read_text().splitlines() if openai_file.is_file() else []
    codex_headers = [
        index
        for index, line in enumerate(openai_lines)
        if _CODEX_POLICY_HEADER.fullmatch(line)
    ]
    codex_policies = [
        (index, match)
        for index, line in enumerate(openai_lines)
        if (match := _CODEX_POLICY_KEY.fullmatch(line)) is not None
    ]
    if selection.invocation == "explicit" and (
        len(claude_policies) != 1
        or claude_policies[0].group("value") != "true"
        or len(codex_headers) != 1
        or len(codex_policies) != 1
        or codex_policies[0][1].group("indent") != "  "
        or codex_policies[0][1].group("value") != "false"
        or codex_policies[0][0] <= codex_headers[0]
    ):
        findings.append(
            Finding(
                "error",
                "SNAPSHOT_POLICY_INVALID",
                f"Candidate invocation adapters are incomplete for {selection.name!r}.",
                selection.source,
            )
        )


def _candidate_symlinks_are_internal(root: Path) -> bool:
    resolved_root = root.resolve()
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        for name in (*directory_names, *file_names):
            path = Path(directory) / name
            if not path.is_symlink():
                continue
            target = Path(os.readlink(path))
            if target.is_absolute():
                return False
            try:
                path.resolve(strict=True).relative_to(resolved_root)
            except (FileNotFoundError, RuntimeError, ValueError):
                return False
    return True
