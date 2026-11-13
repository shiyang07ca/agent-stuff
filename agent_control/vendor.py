from __future__ import annotations

import configparser
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .desired_state import load_desired_state
from .git_status import has_meaningful_git_changes
from .locking import ChangeLockError, change_lock
from .models import DesiredState, Finding
from .snapshot import validate_candidate_snapshot


_COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
_TARGET_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")


@dataclass(frozen=True)
class VendorChange:
    status: str
    path: str
    categories: tuple[str, ...]


@dataclass(frozen=True)
class VendorPlan:
    vendor: str
    path: str
    current_commit: str
    current_ref: str | None
    target_commit: str
    changes: tuple[VendorChange, ...]
    fingerprint: str


@dataclass(frozen=True)
class VendorPlanOutcome:
    plan: VendorPlan | None
    findings: tuple[Finding, ...] = ()

    @property
    def has_errors(self) -> bool:
        return any(finding.severity == "error" for finding in self.findings)


@dataclass(frozen=True)
class VendorApplyOutcome:
    changed: bool
    findings: tuple[Finding, ...] = ()

    @property
    def has_errors(self) -> bool:
        return any(finding.severity == "error" for finding in self.findings)


@dataclass(frozen=True)
class _DeclaredVendor:
    name: str
    path: str
    checkout: Path


class _VendorFailure(Exception):
    def __init__(self, code: str, message: str, location: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.location = location


def build_vendor_plan(
    repo: Path,
    vendor_name: str,
    target_ref: str,
    *,
    fetch: bool = True,
) -> VendorPlanOutcome:
    repo = repo.resolve()
    try:
        vendor = _find_declared_vendor(repo, vendor_name)
        _require_clean_vendor(vendor)
        current_commit = _resolve_commit(vendor.checkout, "HEAD")
        if current_commit is None:
            raise _VendorFailure(
                "VENDOR_INVALID",
                f"Cannot resolve the current commit for vendor {vendor.name!r}.",
                vendor.path,
            )
        current_ref = _current_symbolic_ref(vendor)
        target_commit = _resolve_target(vendor, target_ref, fetch=fetch)
        state, findings = _validate_target_checkout(repo, vendor, target_commit)
        if state is None or any(
            finding.severity == "error" for finding in findings
        ):
            return VendorPlanOutcome(None, tuple(findings))
        selected_sources = tuple(
            selection.source.removeprefix(f"{vendor.path}/")
            for selection in state.skills
            if selection.source.startswith(f"{vendor.path}/")
        )
        changes = _selected_changes(
            vendor,
            current_commit,
            target_commit,
            selected_sources,
        )
        fingerprint = _vendor_plan_fingerprint(
            repo,
            vendor,
            current_commit,
            current_ref,
            target_commit,
            changes,
        )
    except _VendorFailure as error:
        return VendorPlanOutcome(
            None,
            (
                Finding(
                    "error",
                    error.code,
                    error.message,
                    error.location,
                ),
            ),
        )
    except (OSError, UnicodeError, ValueError) as error:
        return VendorPlanOutcome(
            None,
            (
                Finding(
                    "error",
                    "VENDOR_PLAN_FAILED",
                    f"Cannot build the vendor update plan: {error}",
                ),
            ),
        )

    return VendorPlanOutcome(
        VendorPlan(
            vendor=vendor.name,
            path=vendor.path,
            current_commit=current_commit,
            current_ref=current_ref,
            target_commit=target_commit,
            changes=changes,
            fingerprint=fingerprint,
        ),
        tuple(findings),
    )


def apply_vendor_plan(
    repo: Path,
    vendor_name: str,
    target_commit: str,
    reviewed_fingerprint: str,
) -> VendorApplyOutcome:
    repo = repo.resolve()
    if not _COMMIT.fullmatch(target_commit):
        return _vendor_apply_error(
            "VENDOR_TARGET_NOT_EXACT",
            "Vendor apply requires a full lowercase hexadecimal commit.",
        )
    try:
        with change_lock(repo):
            return _apply_vendor_plan_locked(
                repo,
                vendor_name,
                target_commit,
                reviewed_fingerprint,
            )
    except ChangeLockError as error:
        return _vendor_apply_error(error.code, error.message)


def _apply_vendor_plan_locked(
    repo: Path,
    vendor_name: str,
    target_commit: str,
    reviewed_fingerprint: str,
) -> VendorApplyOutcome:
    planned = build_vendor_plan(
        repo,
        vendor_name,
        target_commit,
        fetch=False,
    )
    if planned.has_errors or planned.plan is None:
        return VendorApplyOutcome(False, planned.findings)
    plan = planned.plan
    if plan.fingerprint != reviewed_fingerprint:
        return _vendor_apply_error(
            "VENDOR_PLAN_STALE",
            "The reviewed vendor plan no longer matches the current checkout or configuration.",
            "Run vendor plan again and review the new fingerprint before applying.",
        )
    if plan.current_commit == plan.target_commit:
        return VendorApplyOutcome(False, planned.findings)

    vendor = _find_declared_vendor(repo, vendor_name)
    switched = _git(
        vendor.checkout,
        "checkout",
        "--quiet",
        "--detach",
        plan.target_commit,
    )
    if switched.returncode != 0:
        return _vendor_apply_error(
            "VENDOR_APPLY_FAILED",
            _git_failure_message(
                f"Cannot switch vendor {vendor.name!r} to {plan.target_commit}",
                switched,
            ),
        )

    try:
        validation_findings = _validate_active_repository(repo)
    except (OSError, UnicodeError, ValueError) as error:
        validation_findings = (
            Finding(
                "error",
                "VENDOR_VALIDATION_FAILED",
                f"Cannot validate the repository after switching vendor checkout: {error}",
                vendor.path,
            ),
        )
    if any(finding.severity == "error" for finding in validation_findings):
        if plan.current_ref is None:
            restored = _git(
                vendor.checkout,
                "checkout",
                "--quiet",
                "--detach",
                plan.current_commit,
            )
        else:
            restored = _git(
                vendor.checkout,
                "checkout",
                "--quiet",
                plan.current_ref.removeprefix("refs/heads/"),
            )
        rollback_findings: tuple[Finding, ...] = ()
        if restored.returncode != 0:
            rollback_findings = (
                Finding(
                    "error",
                    "VENDOR_ROLLBACK_FAILED",
                    _git_failure_message(
                        f"Cannot restore vendor {vendor.name!r} to {plan.current_commit}",
                        restored,
                    ),
                    vendor.path,
                ),
            )
        return VendorApplyOutcome(
            False,
            (*validation_findings, *rollback_findings),
        )
    return VendorApplyOutcome(True, (*planned.findings, *validation_findings))


def _validate_active_repository(repo: Path) -> tuple[Finding, ...]:
    state, findings = load_desired_state(repo)
    if state is not None and not any(
        finding.severity == "error" for finding in findings
    ):
        _count, candidate_findings = validate_candidate_snapshot(state)
        findings.extend(candidate_findings)
    return tuple(findings)


def _vendor_apply_error(
    code: str,
    message: str,
    suggestion: str | None = None,
) -> VendorApplyOutcome:
    return VendorApplyOutcome(
        False,
        (
            Finding(
                "error",
                code,
                message,
                suggestion=suggestion,
            ),
        ),
    )


def _find_declared_vendor(repo: Path, requested: str) -> _DeclaredVendor:
    gitmodules = repo / ".gitmodules"
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read_string(gitmodules.read_text())
    except FileNotFoundError as error:
        raise _VendorFailure(
            "VENDOR_UNKNOWN",
            "No declared vendors are available because .gitmodules is missing.",
            ".gitmodules",
        ) from error
    except (configparser.Error, OSError, UnicodeError) as error:
        raise _VendorFailure(
            "GITMODULES_INVALID",
            f"Invalid .gitmodules file: {error}",
            ".gitmodules",
        ) from error

    matches: list[_DeclaredVendor] = []
    for section in parser.sections():
        raw_path = parser.get(section, "path", fallback="")
        path = PurePosixPath(raw_path)
        if (
            len(path.parts) != 2
            or path.parts[0] != "vendors"
            or path.parts[1] in {".", ".."}
            or path.is_absolute()
            or path.as_posix() != raw_path
            or "\\" in raw_path
        ):
            continue
        section_name = section.removeprefix('submodule "').removesuffix('"')
        aliases = {section_name, raw_path, path.name}
        if requested in aliases:
            matches.append(
                _DeclaredVendor(
                    name=path.name,
                    path=raw_path,
                    checkout=repo.joinpath(*path.parts),
                )
            )
    if len(matches) != 1:
        raise _VendorFailure(
            "VENDOR_UNKNOWN",
            f"Vendor {requested!r} is not one uniquely declared submodule.",
            ".gitmodules",
        )
    vendor = matches[0]
    _validate_declared_vendor(repo, vendor)
    return vendor


def _validate_declared_vendor(repo: Path, vendor: _DeclaredVendor) -> None:
    vendors_root = repo / "vendors"
    try:
        root_mode = vendors_root.lstat().st_mode
        checkout_mode = vendor.checkout.lstat().st_mode
        if stat.S_ISLNK(root_mode) or not stat.S_ISDIR(root_mode):
            raise ValueError("vendors root is not a real directory")
        if stat.S_ISLNK(checkout_mode) or not stat.S_ISDIR(checkout_mode):
            raise ValueError("vendor checkout is not a real directory")
        resolved_root = vendors_root.resolve(strict=True)
        resolved_root.relative_to(repo)
        resolved_checkout = vendor.checkout.resolve(strict=True)
        if resolved_checkout.parent != resolved_root:
            raise ValueError("vendor checkout resolves outside vendors root")
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as error:
        raise _VendorFailure(
            "VENDOR_INVALID",
            f"Declared vendor {vendor.name!r} is not a protected in-repository checkout: {error}",
            vendor.path,
        ) from error

    index_entry = _git(repo, "ls-files", "--stage", "--", vendor.path)
    fields = index_entry.stdout.strip().split(maxsplit=3)
    if (
        index_entry.returncode != 0
        or len(fields) != 4
        or fields[0] != "160000"
        or fields[3] != vendor.path
    ):
        raise _VendorFailure(
            "VENDOR_INVALID",
            f"Declared vendor {vendor.name!r} is not a Git submodule in the repository index.",
            vendor.path,
        )

    top_level = _git(vendor.checkout, "rev-parse", "--show-toplevel")
    try:
        actual_top_level = Path(top_level.stdout.strip()).resolve(strict=True)
    except (FileNotFoundError, OSError, RuntimeError):
        actual_top_level = Path()
    if top_level.returncode != 0 or actual_top_level != resolved_checkout:
        raise _VendorFailure(
            "VENDOR_INVALID",
            f"Declared vendor {vendor.name!r} is not an independent Git checkout.",
            vendor.path,
        )


def _require_clean_vendor(vendor: _DeclaredVendor) -> None:
    result = _git(
        vendor.checkout,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
    )
    if result.returncode != 0:
        raise _VendorFailure(
            "VENDOR_INVALID",
            _git_failure_message(
                f"Cannot inspect vendor {vendor.name!r}",
                result,
            ),
            vendor.path,
        )
    if has_meaningful_git_changes(result.stdout):
        raise _VendorFailure(
            "VENDOR_DIRTY",
            f"Declared vendor {vendor.name!r} contains uncommitted changes.",
            vendor.path,
        )


def _current_symbolic_ref(vendor: _DeclaredVendor) -> str | None:
    result = _git(vendor.checkout, "symbolic-ref", "--quiet", "HEAD")
    if result.returncode == 1 and not result.stdout.strip():
        return None
    reference = result.stdout.strip()
    if result.returncode != 0 or not reference.startswith("refs/heads/"):
        raise _VendorFailure(
            "VENDOR_INVALID",
            _git_failure_message(
                f"Cannot inspect the current checkout for vendor {vendor.name!r}",
                result,
            ),
            vendor.path,
        )
    return reference


def _resolve_target(
    vendor: _DeclaredVendor,
    target_ref: str,
    *,
    fetch: bool,
) -> str:
    if not _is_safe_target_ref(target_ref):
        raise _VendorFailure(
            "VENDOR_TARGET_INVALID",
            f"Target {target_ref!r} is not an accepted explicit Git ref.",
            vendor.path,
        )
    target_commit = _resolve_commit(vendor.checkout, target_ref)
    if target_commit is not None:
        return target_commit
    if not fetch:
        raise _VendorFailure(
            "VENDOR_TARGET_INVALID",
            f"Target {target_ref!r} does not resolve to a local commit.",
            vendor.path,
        )
    fetched = _git(
        vendor.checkout,
        "fetch",
        "--no-tags",
        "--quiet",
        "origin",
        target_ref,
    )
    if fetched.returncode != 0:
        raise _VendorFailure(
            "VENDOR_FETCH_FAILED",
            _git_failure_message(
                f"Cannot fetch target {target_ref!r} for vendor {vendor.name!r}",
                fetched,
            ),
            vendor.path,
        )
    target_commit = _resolve_commit(vendor.checkout, "FETCH_HEAD")
    if target_commit is None:
        raise _VendorFailure(
            "VENDOR_TARGET_INVALID",
            f"Fetched target {target_ref!r} did not resolve to one exact commit.",
            vendor.path,
        )
    return target_commit


def _is_safe_target_ref(value: str) -> bool:
    if _COMMIT.fullmatch(value):
        return True
    if not _TARGET_REF.fullmatch(value):
        return False
    if ".." in value or "//" in value or "@{" in value:
        return False
    if value.endswith((".", "/", ".lock")):
        return False
    return all(
        part and not part.startswith(".") and not part.endswith(".lock")
        for part in value.split("/")
    )


def _resolve_commit(checkout: Path, value: str) -> str | None:
    result = _git(checkout, "rev-parse", "--verify", f"{value}^{{commit}}")
    if result.returncode != 0:
        return None
    commit = result.stdout.strip()
    return commit if _COMMIT.fullmatch(commit) else None


def _validate_target_checkout(
    repo: Path,
    vendor: _DeclaredVendor,
    target_commit: str,
) -> tuple[DesiredState | None, list[Finding]]:
    temporary_root = Path(tempfile.mkdtemp(prefix="agent-control-vendor-"))
    target_checkout = temporary_root / "checkout"
    worktree_added = False
    findings: list[Finding] = []
    state: DesiredState | None = None
    try:
        added = _git(
            vendor.checkout,
            "worktree",
            "add",
            "--detach",
            "--quiet",
            str(target_checkout),
            target_commit,
        )
        if added.returncode != 0:
            raise _VendorFailure(
                "VENDOR_TARGET_CHECKOUT_FAILED",
                _git_failure_message(
                    f"Cannot create a temporary checkout for {target_commit}",
                    added,
                ),
                vendor.path,
            )
        worktree_added = True
        loaded_state, findings = load_desired_state(
            repo,
            vendor_overrides={vendor.path: target_checkout},
        )
        state = loaded_state
        if loaded_state is not None and not any(
            finding.severity == "error" for finding in findings
        ):
            _count, candidate_findings = validate_candidate_snapshot(loaded_state)
            findings.extend(candidate_findings)
    finally:
        if worktree_added:
            removed = _git(
                vendor.checkout,
                "worktree",
                "remove",
                "--force",
                str(target_checkout),
            )
            if removed.returncode != 0:
                findings.append(
                    Finding(
                        "error",
                        "VENDOR_TARGET_CLEANUP_FAILED",
                        _git_failure_message(
                            "Cannot remove the temporary vendor checkout",
                            removed,
                        ),
                        vendor.path,
                    )
                )
        shutil.rmtree(temporary_root, ignore_errors=True)
    return state, findings


def _selected_changes(
    vendor: _DeclaredVendor,
    current_commit: str,
    target_commit: str,
    selected_sources: tuple[str, ...],
) -> tuple[VendorChange, ...]:
    if not selected_sources:
        return ()
    result = _git(
        vendor.checkout,
        "diff",
        "--name-status",
        "--no-renames",
        current_commit,
        target_commit,
        "--",
        *selected_sources,
    )
    if result.returncode != 0:
        raise _VendorFailure(
            "VENDOR_DIFF_FAILED",
            _git_failure_message("Cannot compare selected vendor skills", result),
            vendor.path,
        )
    changes: list[VendorChange] = []
    for line in result.stdout.splitlines():
        fields = line.split("\t", 1)
        if len(fields) != 2:
            raise _VendorFailure(
                "VENDOR_DIFF_FAILED",
                "Git returned an invalid selected-skill change record.",
                vendor.path,
            )
        status, relative = fields
        path = PurePosixPath(relative)
        categories = {"runtime"}
        if path.name == "SKILL.md" or path.as_posix().endswith(
            "agents/openai.yaml"
        ):
            categories.add("metadata")
        if "scripts" in path.parts:
            categories.add("script")
        changes.append(
            VendorChange(
                status=status,
                path=f"{vendor.path}/{path.as_posix()}",
                categories=tuple(sorted(categories)),
            )
        )
    return tuple(changes)


def _vendor_plan_fingerprint(
    repo: Path,
    vendor: _DeclaredVendor,
    current_commit: str,
    current_ref: str | None,
    target_commit: str,
    changes: tuple[VendorChange, ...],
) -> str:
    config_content = (repo / "config" / "agent-control.toml").read_bytes()
    gitmodules_content = (repo / ".gitmodules").read_bytes()
    payload = {
        "vendor": vendor.name,
        "path": vendor.path,
        "current_commit": current_commit,
        "current_ref": current_ref,
        "target_commit": target_commit,
        "config": hashlib.sha256(config_content).hexdigest(),
        "gitmodules": hashlib.sha256(gitmodules_content).hexdigest(),
        "changes": [
            {
                "status": change.status,
                "path": change.path,
                "categories": list(change.categories),
            }
            for change in changes
        ],
    }
    encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def _git(checkout: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        }
    )
    try:
        return subprocess.run(
            ["git", "-C", str(checkout), *arguments],
            env=environment,
            capture_output=True,
            text=True,
        )
    except OSError as error:
        raise _VendorFailure(
            "VENDOR_GIT_FAILED",
            f"Cannot start git for vendor operation: {error}",
            str(checkout),
        ) from error


def _git_failure_message(
    prefix: str,
    result: subprocess.CompletedProcess[str],
) -> str:
    detail = result.stderr.strip() or result.stdout.strip() or "git failed"
    return f"{prefix}: {detail}"
