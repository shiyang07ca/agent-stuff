from __future__ import annotations

import configparser
import os
import re
import subprocess
import tomllib
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any, TypeGuard, cast

from .git_status import has_meaningful_git_changes
from .models import DesiredState, Finding, SkillSelection, TriggerGroup
from .pi_config import load_pi_config


_FRONTMATTER_FIELD = re.compile(r"^([A-Za-z0-9_-]+):(?:[ \t]*(.*))$")
_CODEX_POLICY_HEADER = re.compile(r"^policy:[ \t]*(?:#.*)?$")
_CODEX_POLICY_KEY = re.compile(
    r"^(?P<indent>[ \t]*)allow_implicit_invocation:[ \t]*"
    r"(?P<value>true|false)[ \t]*(?:#.*)?$"
)


def load_desired_state(
    repo: Path,
    *,
    vendor_overrides: Mapping[str, Path] | None = None,
) -> tuple[DesiredState | None, list[Finding]]:
    repo = repo.resolve()
    findings: list[Finding] = []
    config_path = repo / "config" / "agent-control.toml"
    try:
        with config_path.open("rb") as config_file:
            raw_config = tomllib.load(config_file)
    except FileNotFoundError:
        findings.append(
            Finding(
                "error",
                "CONFIG_MISSING_FILE",
                "Missing authoritative configuration.",
                "config/agent-control.toml",
            )
        )
        return None, findings
    except tomllib.TOMLDecodeError as error:
        findings.append(
            Finding(
                "error",
                "CONFIG_INVALID_TOML",
                f"Invalid TOML: {error}",
                "config/agent-control.toml",
            )
        )
        return None, findings
    except (OSError, UnicodeError) as error:
        findings.append(
            Finding(
                "error",
                "CONFIG_READ_FAILED",
                f"Cannot read authoritative configuration: {error}",
                "config/agent-control.toml",
            )
        )
        return None, findings

    _check_unknown_fields(raw_config, {"governance", "skills"}, "config", findings)
    governance = raw_config.get("governance")
    raw_skills = raw_config.get("skills")
    if not isinstance(governance, Mapping):
        findings.append(
            Finding(
                "error",
                "CONFIG_MISSING_FIELD",
                "The governance table is required.",
                "config.governance",
            )
        )
    if not isinstance(raw_skills, list) or not raw_skills:
        findings.append(
            Finding(
                "error",
                "CONFIG_MISSING_FIELD",
                "At least one skills table is required.",
                "config.skills",
            )
        )
    if not isinstance(governance, Mapping) or not isinstance(raw_skills, list):
        return None, findings

    _check_unknown_fields(
        governance,
        {"implicit_budget", "trigger_groups"},
        "config.governance",
        findings,
    )
    implicit_budget = governance.get("implicit_budget")
    if not _is_non_negative_integer(implicit_budget):
        findings.append(
            Finding(
                "error",
                "CONFIG_INVALID_VALUE",
                "implicit_budget must be a non-negative integer.",
                "config.governance.implicit_budget",
            )
        )

    trigger_groups = _parse_trigger_groups(governance.get("trigger_groups"), findings)
    vendor_roots = _declared_vendor_roots(repo, findings)
    trusted_vendor_overrides: set[str] = set()
    for vendor_name, checkout in (vendor_overrides or {}).items():
        if vendor_name in vendor_roots:
            vendor_roots[vendor_name] = checkout
            trusted_vendor_overrides.add(vendor_name)
    selections = _parse_skill_selections(
        repo,
        raw_skills,
        vendor_roots,
        trusted_vendor_overrides,
        findings,
    )

    selected_names = {selection.name for selection in selections}
    for group in trigger_groups:
        for skill_name in group.skills:
            if skill_name not in selected_names:
                findings.append(
                    Finding(
                        "error",
                        "TRIGGER_GROUP_UNKNOWN_SKILL",
                        f"Trigger group {group.name!r} references unknown skill {skill_name!r}.",
                        f"config.governance.trigger_groups.{group.name}",
                    )
                )

    if isinstance(implicit_budget, int) and not isinstance(implicit_budget, bool):
        _check_governance(implicit_budget, trigger_groups, selections, findings)

    _, _, pi_findings = load_pi_config(repo)
    findings.extend(pi_findings)
    if any(finding.severity == "error" for finding in findings):
        return None, findings
    if not _is_non_negative_integer(implicit_budget):
        return None, findings

    state = DesiredState(
        repo=repo,
        implicit_budget=implicit_budget,
        trigger_groups=tuple(trigger_groups),
        skills=tuple(sorted(selections, key=lambda selection: selection.name)),
    )
    return state, findings


def _check_unknown_fields(
    mapping: Mapping[str, Any],
    allowed: set[str],
    location: str,
    findings: list[Finding],
) -> None:
    for field in sorted(set(mapping) - allowed):
        findings.append(
            Finding(
                "error",
                "CONFIG_UNKNOWN_FIELD",
                f"Unknown field {field!r}.",
                f"{location}.{field}",
            )
        )


def _is_non_negative_integer(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _parse_trigger_groups(
    raw_groups: object, findings: list[Finding]
) -> list[TriggerGroup]:
    if not isinstance(raw_groups, list):
        findings.append(
            Finding(
                "error",
                "CONFIG_MISSING_FIELD",
                "governance.trigger_groups must be an array of tables.",
                "config.governance.trigger_groups",
            )
        )
        return []

    groups: list[TriggerGroup] = []
    seen_names: set[str] = set()
    for index, raw_group in enumerate(raw_groups):
        location = f"config.governance.trigger_groups[{index}]"
        if not isinstance(raw_group, Mapping):
            findings.append(
                Finding(
                    "error",
                    "TRIGGER_GROUP_INVALID",
                    "Trigger group must be a table.",
                    location,
                )
            )
            continue
        _check_unknown_fields(
            raw_group, {"name", "limit", "skills"}, location, findings
        )
        name = raw_group.get("name")
        limit = raw_group.get("limit")
        skill_names = raw_group.get("skills")
        valid_name = (
            isinstance(name, str) and bool(name.strip()) and name == name.strip()
        )
        valid_limit = _is_non_negative_integer(limit)
        valid_skills = (
            isinstance(skill_names, list)
            and bool(skill_names)
            and all(
                isinstance(skill, str) and bool(skill) and skill.strip() == skill
                for skill in skill_names
            )
            and len(set(skill_names)) == len(skill_names)
        )
        infeasible_limit = (
            _is_non_negative_integer(limit)
            and isinstance(skill_names, list)
            and limit > len(skill_names)
        )
        if (
            not valid_name
            or not valid_limit
            or not valid_skills
            or infeasible_limit
            or (valid_name and name in seen_names)
        ):
            findings.append(
                Finding(
                    "error",
                    "TRIGGER_GROUP_INVALID",
                    "Trigger group requires a unique non-empty name, a feasible non-negative limit, and unique skill names.",
                    location,
                )
            )
            continue
        assert isinstance(name, str)
        assert _is_non_negative_integer(limit)
        assert isinstance(skill_names, list)
        validated_skills = cast(list[str], skill_names)
        seen_names.add(name)
        groups.append(
            TriggerGroup(
                name=name,
                limit=limit,
                skills=tuple(validated_skills),
            )
        )
    return groups


def _declared_vendor_roots(repo: Path, findings: list[Finding]) -> dict[str, Path]:
    gitmodules_path = repo / ".gitmodules"
    if not gitmodules_path.is_file():
        return {}
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(gitmodules_path)
    except (configparser.Error, OSError, UnicodeError) as error:
        findings.append(
            Finding(
                "error",
                "GITMODULES_INVALID",
                f"Invalid .gitmodules file: {error}",
                ".gitmodules",
            )
        )
        return {}

    vendor_roots: dict[str, Path] = {}
    for section in parser.sections():
        raw_path = parser.get(section, "path", fallback="")
        path = PurePosixPath(raw_path)
        if len(path.parts) != 2 or path.parts[0] != "vendors" or path.is_absolute():
            continue
        vendor_roots[raw_path] = repo.joinpath(*path.parts)
    return vendor_roots


def _parse_skill_selections(
    repo: Path,
    raw_skills: list[object],
    vendor_roots: dict[str, Path],
    trusted_vendor_overrides: set[str],
    findings: list[Finding],
) -> list[SkillSelection]:
    selections: list[SkillSelection] = []
    seen_sources: set[str] = set()
    seen_names: set[str] = set()
    checked_vendors: set[str] = set()

    for index, raw_skill in enumerate(raw_skills):
        location = f"config.skills[{index}]"
        if not isinstance(raw_skill, Mapping):
            findings.append(
                Finding(
                    "error",
                    "CONFIG_INVALID_VALUE",
                    "Each skill selection must be a table.",
                    location,
                )
            )
            continue
        _check_unknown_fields(
            raw_skill,
            {"source", "expected_name", "invocation"},
            location,
            findings,
        )
        source = raw_skill.get("source")
        expected_name = raw_skill.get("expected_name")
        invocation = raw_skill.get("invocation")
        if not isinstance(source, str) or not source:
            findings.append(
                Finding(
                    "error",
                    "CONFIG_INVALID_VALUE",
                    "Skill source must be a non-empty repository-relative path.",
                    f"{location}.source",
                )
            )
            continue
        if expected_name is not None and (
            not isinstance(expected_name, str)
            or not expected_name
            or expected_name != expected_name.strip()
        ):
            findings.append(
                Finding(
                    "error",
                    "CONFIG_INVALID_VALUE",
                    "Skill expected_name must be a non-empty trimmed string when present.",
                    f"{location}.expected_name",
                )
            )
            continue
        if invocation not in ("implicit", "explicit"):
            findings.append(
                Finding(
                    "error",
                    "CONFIG_INVALID_VALUE",
                    "Skill invocation must be 'implicit' or 'explicit'.",
                    f"{location}.invocation",
                )
            )
            continue
        if source in seen_sources:
            findings.append(
                Finding(
                    "error",
                    "SKILL_DUPLICATE",
                    f"Skill source {source!r} is selected more than once.",
                    f"{location}.source",
                )
            )
            continue
        seen_sources.add(source)

        source_path, vendor_name = _resolve_source(
            repo,
            source,
            vendor_roots,
            trusted_vendor_overrides,
            location,
            findings,
        )
        if source_path is None:
            continue
        if expected_name is not None and vendor_name is None:
            findings.append(
                Finding(
                    "error",
                    "CONFIG_INVALID_VALUE",
                    "Skill expected_name is only allowed for declared vendor sources.",
                    f"{location}.expected_name",
                )
            )
            continue
        if vendor_name is not None and vendor_name not in checked_vendors:
            _check_vendor_clean(vendor_roots[vendor_name], vendor_name, findings)
            checked_vendors.add(vendor_name)
        if not source_path.is_dir() or not (source_path / "SKILL.md").is_file():
            findings.append(
                Finding(
                    "error",
                    "SKILL_NOT_FOUND",
                    f"Selected source {source!r} is not a skill directory containing SKILL.md.",
                    source,
                )
            )
            continue
        if not _check_skill_symlinks(source_path, source, findings):
            continue

        metadata = _read_skill_metadata(source_path / "SKILL.md", source, findings)
        if metadata is None:
            continue
        name, description, claude_explicit = metadata
        required_name = expected_name or source_path.name
        if name != required_name:
            mismatch = (
                f"expected name {required_name!r}"
                if expected_name is not None
                else f"directory {source_path.name!r}"
            )
            findings.append(
                Finding(
                    "error",
                    "SKILL_NAME_MISMATCH",
                    f"Skill metadata name {name!r} does not match {mismatch}.",
                    f"{source}/SKILL.md",
                )
            )
            continue
        if name in seen_names:
            findings.append(
                Finding(
                    "error",
                    "SKILL_DUPLICATE",
                    f"Skill name {name!r} is selected more than once.",
                    source,
                )
            )
            continue
        seen_names.add(name)

        policy_valid, codex_allows_implicit = _read_codex_policy(
            source_path / "agents" / "openai.yaml", source, findings
        )
        if not policy_valid:
            continue
        codex_explicit = not codex_allows_implicit
        if invocation == "implicit" and (claude_explicit or codex_explicit):
            findings.append(
                Finding(
                    "error",
                    "INVOCATION_POLICY_RELAXED",
                    f"Configuration cannot relax source-enforced explicit invocation for {name!r}.",
                    source,
                )
            )
            continue

        line_count = len((source_path / "SKILL.md").read_text().splitlines())
        selections.append(
            SkillSelection(
                name=name,
                source=source,
                source_path=source_path,
                invocation=invocation,
                description=description,
                line_count=line_count,
            )
        )
    return selections


def _resolve_source(
    repo: Path,
    source: str,
    vendor_roots: dict[str, Path],
    trusted_vendor_overrides: set[str],
    location: str,
    findings: list[Finding],
) -> tuple[Path | None, str | None]:
    path = PurePosixPath(source)
    if (
        path.is_absolute()
        or not path.parts
        or path.as_posix() != source
        or any(part in ("", ".", "..") for part in path.parts)
        or "\\" in source
    ):
        findings.append(
            Finding(
                "error",
                "SOURCE_OUT_OF_BOUNDS",
                f"Source {source!r} must be a normalized repository-relative path.",
                f"{location}.source",
            )
        )
        return None, None

    vendor_name: str | None = None
    if path.parts[0] == "custom-skills" and len(path.parts) >= 2:
        allowed_root = repo / "custom-skills"
        source_path = repo.joinpath(*path.parts)
    elif len(path.parts) >= 3 and "/".join(path.parts[:2]) in vendor_roots:
        vendor_name = "/".join(path.parts[:2])
        allowed_root = vendor_roots[vendor_name]
        source_path = allowed_root.joinpath(*path.parts[2:])
    else:
        findings.append(
            Finding(
                "error",
                "SOURCE_OUT_OF_BOUNDS",
                f"Source {source!r} is outside custom-skills/ and declared vendor roots.",
                f"{location}.source",
            )
        )
        return None, None

    if not source_path.exists() and not source_path.is_symlink():
        return source_path, vendor_name
    try:
        if allowed_root.is_symlink():
            raise ValueError("source root is a symlink")
        resolved_allowed_root = allowed_root.resolve(strict=True)
        if vendor_name not in trusted_vendor_overrides:
            resolved_allowed_root.relative_to(repo)
        source_path.resolve(strict=True).relative_to(resolved_allowed_root)
    except (FileNotFoundError, RuntimeError, ValueError):
        findings.append(
            Finding(
                "error",
                "SOURCE_SYMLINK_ESCAPE",
                f"Source {source!r} resolves outside its allowed root or contains a broken link.",
                f"{location}.source",
            )
        )
        return None, None
    return source_path, vendor_name


def _check_skill_symlinks(
    source_path: Path, source: str, findings: list[Finding]
) -> bool:
    resolved_root = source_path.resolve()
    valid = True
    for directory, directory_names, file_names in os.walk(
        source_path, followlinks=False
    ):
        for name in (*directory_names, *file_names):
            path = Path(directory) / name
            if not path.is_symlink():
                continue
            try:
                if Path(os.readlink(path)).is_absolute():
                    raise ValueError("absolute symlink")
                path.resolve(strict=True).relative_to(resolved_root)
            except (FileNotFoundError, RuntimeError, ValueError):
                findings.append(
                    Finding(
                        "error",
                        "SOURCE_SYMLINK_ESCAPE",
                        f"Symlink {path.relative_to(source_path)!s} escapes skill {source!r} or is broken.",
                        f"{source}/{path.relative_to(source_path)}",
                    )
                )
                valid = False
    return valid


def _read_skill_metadata(
    skill_file: Path, source: str, findings: list[Finding]
) -> tuple[str, str, bool] | None:
    try:
        lines = skill_file.read_text().splitlines()
    except (OSError, UnicodeError) as error:
        findings.append(
            Finding(
                "error",
                "SKILL_METADATA_INVALID",
                f"Cannot read SKILL.md metadata: {error}",
                f"{source}/SKILL.md",
            )
        )
        return None
    if not lines or lines[0] != "---":
        _metadata_finding(
            source, "SKILL.md must start with YAML frontmatter.", findings
        )
        return None
    try:
        closing_index = lines.index("---", 1)
    except ValueError:
        _metadata_finding(source, "SKILL.md frontmatter is not closed.", findings)
        return None

    values: dict[str, str] = {}
    index = 1
    while index < closing_index:
        line = lines[index]
        if not line.strip() or line.startswith((" ", "\t")):
            index += 1
            continue
        match = _FRONTMATTER_FIELD.fullmatch(line)
        if match is None:
            _metadata_finding(source, f"Invalid frontmatter line: {line!r}.", findings)
            return None
        field, raw_value = match.groups()
        if field in values:
            _metadata_finding(
                source, f"Duplicate frontmatter field {field!r}.", findings
            )
            return None
        if raw_value in ("|", "|-", "|+", ">", ">-", ">+"):
            block_lines: list[str] = []
            index += 1
            while index < closing_index and (
                not lines[index].strip() or lines[index].startswith((" ", "\t"))
            ):
                block_lines.append(lines[index].strip())
                index += 1
            values[field] = " ".join(part for part in block_lines if part)
            continue
        values[field] = _unquote_scalar(raw_value)
        index += 1

    name = values.get("name", "").strip()
    description = values.get("description", "").strip()
    disable_value = values.get("disable-model-invocation")
    if not name or not description:
        _metadata_finding(
            source, "Skill name and description must be non-empty.", findings
        )
        return None
    if disable_value is not None and disable_value not in ("true", "false"):
        _metadata_finding(
            source,
            "disable-model-invocation must be true or false when present.",
            findings,
        )
        return None
    return name, description, disable_value == "true"


def _unquote_scalar(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _metadata_finding(source: str, message: str, findings: list[Finding]) -> None:
    findings.append(
        Finding(
            "error",
            "SKILL_METADATA_INVALID",
            message,
            f"{source}/SKILL.md",
        )
    )


def _read_codex_policy(
    openai_file: Path, source: str, findings: list[Finding]
) -> tuple[bool, bool]:
    if not openai_file.exists():
        return True, True
    try:
        lines = openai_file.read_text().splitlines()
    except (OSError, UnicodeError) as error:
        findings.append(
            Finding(
                "error",
                "CODEX_POLICY_INVALID",
                f"Cannot read Codex policy: {error}",
                f"{source}/agents/openai.yaml",
            )
        )
        return False, False

    policy_candidates = [
        index for index, line in enumerate(lines) if line.startswith("policy:")
    ]
    policy_headers = [
        index
        for index in policy_candidates
        if _CODEX_POLICY_HEADER.fullmatch(lines[index])
    ]
    key_candidates = [
        index
        for index, line in enumerate(lines)
        if line.lstrip().startswith("allow_implicit_invocation:")
    ]
    key_matches = [
        (index, _CODEX_POLICY_KEY.fullmatch(lines[index])) for index in key_candidates
    ]
    invalid = (
        len(policy_candidates) != len(policy_headers)
        or len(policy_headers) > 1
        or len(key_candidates) > 1
        or any(match is None for _, match in key_matches)
    )
    if not invalid and key_matches:
        key_index, key_match = key_matches[0]
        invalid = (
            len(policy_headers) != 1
            or key_match is None
            or key_match.group("indent") != "  "
            or key_index <= policy_headers[0]
            or any(
                line and not line.startswith((" ", "\t", "#"))
                for line in lines[policy_headers[0] + 1 : key_index]
            )
        )
    if invalid:
        findings.append(
            Finding(
                "error",
                "CODEX_POLICY_INVALID",
                "Codex policy must contain at most one top-level policy table and one boolean allow_implicit_invocation key.",
                f"{source}/agents/openai.yaml",
            )
        )
        return False, False
    if not key_matches:
        return True, True
    match = key_matches[0][1]
    return True, match is not None and match.group("value") == "true"


def _check_vendor_clean(
    vendor_path: Path, vendor_name: str, findings: list[Finding]
) -> None:
    environment = os.environ.copy()
    environment.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "HOME": os.devnull,
            "XDG_CONFIG_HOME": os.devnull,
            "LC_ALL": "C",
        }
    )
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(vendor_path),
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ],
            env=environment,
            capture_output=True,
        )
    except OSError as error:
        findings.append(
            Finding(
                "error",
                "VENDOR_INVALID",
                f"Cannot inspect declared vendor {vendor_name!r}: {error}",
                vendor_name,
            )
        )
        return
    if result.returncode != 0:
        findings.append(
            Finding(
                "error",
                "VENDOR_INVALID",
                f"Cannot inspect declared vendor {vendor_name!r}: {result.stderr.decode(errors='replace').strip()}",
                vendor_name,
            )
        )
    elif has_meaningful_git_changes(result.stdout):
        findings.append(
            Finding(
                "error",
                "VENDOR_DIRTY",
                f"Declared vendor {vendor_name!r} contains uncommitted changes.",
                vendor_name,
                "Commit, discard, or move vendor changes before validation.",
            )
        )


def _check_governance(
    implicit_budget: int,
    groups: list[TriggerGroup],
    selections: list[SkillSelection],
    findings: list[Finding],
) -> None:
    implicit_names = {
        selection.name for selection in selections if selection.invocation == "implicit"
    }
    if len(implicit_names) > implicit_budget:
        findings.append(
            Finding(
                "error",
                "IMPLICIT_BUDGET_EXCEEDED",
                f"Implicit invocation budget is {implicit_budget}, but {len(implicit_names)} skills are implicit.",
                "config.governance.implicit_budget",
            )
        )
    for group in groups:
        active = sorted(implicit_names.intersection(group.skills))
        if len(active) > group.limit:
            findings.append(
                Finding(
                    "error",
                    "TRIGGER_GROUP_LIMIT_EXCEEDED",
                    f"Trigger group {group.name!r} allows {group.limit} implicit skills, but found {len(active)}: {', '.join(active)}.",
                    f"config.governance.trigger_groups.{group.name}",
                )
            )
