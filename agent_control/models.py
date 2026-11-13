from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


Severity = Literal["error", "warning"]
Invocation = Literal["implicit", "explicit"]
PlanAction = Literal["add", "replace", "migrate", "blocked", "no-change"]


@dataclass(frozen=True)
class Finding:
    severity: Severity
    code: str
    message: str
    location: str | None = None
    suggestion: str | None = None


@dataclass(frozen=True)
class SkillSelection:
    name: str
    source: str
    source_path: Path
    invocation: Invocation
    description: str
    line_count: int


@dataclass(frozen=True)
class TriggerGroup:
    name: str
    limit: int
    skills: tuple[str, ...]


@dataclass(frozen=True)
class DesiredState:
    repo: Path
    implicit_budget: int
    trigger_groups: tuple[TriggerGroup, ...]
    skills: tuple[SkillSelection, ...]


@dataclass(frozen=True)
class ValidationOutcome:
    state: DesiredState | None
    findings: tuple[Finding, ...]
    candidate_count: int = 0

    @property
    def has_errors(self) -> bool:
        return any(finding.severity == "error" for finding in self.findings)


@dataclass(frozen=True)
class RuntimeEntryPlan:
    name: str
    path: Path
    target: Path
    action: PlanAction
    observed: str
    suggestion: str | None = None


@dataclass(frozen=True)
class RuntimeFilePlan:
    path: Path
    action: PlanAction
    observed: str
    content: bytes = field(repr=False)
    previous: bytes | None = field(default=None, repr=False)
    previous_mode: int = 0o600
    diff: str = ""
    mode: int | None = None

    @property
    def desired_mode(self) -> int:
        return self.previous_mode if self.mode is None else self.mode


@dataclass(frozen=True)
class RuntimePlan:
    desired_snapshot: str
    active_snapshot: str | None
    snapshot_action: PlanAction
    dirty: bool
    entries: tuple[RuntimeEntryPlan, ...]
    fingerprint: str
    findings: tuple[Finding, ...] = ()
    pi_files: tuple[RuntimeFilePlan, ...] = ()
    browser_files: tuple[RuntimeFilePlan, ...] = ()
    browser_extension: Path | None = None

    @property
    def has_errors(self) -> bool:
        return any(finding.severity == "error" for finding in self.findings)

    @property
    def is_no_op(self) -> bool:
        return self.snapshot_action == "no-change" and all(
            entry.action == "no-change"
            for entry in (*self.entries, *self.pi_files, *self.browser_files)
        )


@dataclass(frozen=True)
class RuntimeApplyOutcome:
    changed: bool
    findings: tuple[Finding, ...] = ()

    @property
    def has_errors(self) -> bool:
        return any(finding.severity == "error" for finding in self.findings)
