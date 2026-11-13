from __future__ import annotations

import difflib
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .browser_host import native_host_specs, owns_native_host_file
from .desired_state import load_desired_state
from .git_status import has_meaningful_git_changes
from .locking import ChangeLockError, change_lock
from .models import (
    DesiredState,
    Finding,
    PlanAction,
    RuntimeFilePlan,
    RuntimeApplyOutcome,
    RuntimeEntryPlan,
    RuntimePlan,
)
from .pi_config import (
    auth_readiness,
    config_diff,
    credential_providers,
    generated_config,
    json_bytes,
    local_model_config,
    load_pi_config,
    parse_object,
)
from .snapshot import (
    build_candidate_snapshot,
    desired_snapshot_identity,
    expected_snapshot_inventory,
    inventory_identity,
    read_snapshot_inventory,
)


_SNAPSHOT_ID = re.compile(r"^[0-9a-f]{64}$")
_REQUIRED_TOOLS = ("git",)


@dataclass(frozen=True)
class _SymlinkMutation:
    path: Path
    previous_target: str | None
    written_target: str


class _StopRuntimeApply(Exception):
    def __init__(self, outcome: RuntimeApplyOutcome) -> None:
        super().__init__()
        self.outcome = outcome


def build_runtime_plan(state: DesiredState, home: Path) -> RuntimePlan:
    expected_inventory = expected_snapshot_inventory(state)
    desired_snapshot = desired_snapshot_identity(state, inventory=expected_inventory)
    current = state.repo / ".runtime" / "current"
    findings: list[Finding] = []
    dirty, dirty_findings = _desired_inputs_are_dirty(state)
    findings.extend(dirty_findings)
    runtime_root_finding = _runtime_root_finding(state.repo)
    if runtime_root_finding is not None:
        findings.append(runtime_root_finding)
        active_snapshot: str | None = None
        snapshot_action: PlanAction = "blocked"
        active_observation = "runtime-root-unmanaged"
    else:
        active_snapshot, snapshot_action, active_observation, active_findings = (
            _active_snapshot_plan(
                state.repo,
                current,
                desired_snapshot,
                expected_inventory,
            )
        )
        findings.extend(active_findings)

    entry_specs = _entry_specs(state.repo, home)
    home_finding = _home_root_finding(home)
    if home_finding is not None:
        findings.append(home_finding)
        entries = tuple(
            RuntimeEntryPlan(
                name,
                path,
                target,
                "blocked",
                "unmanaged-home",
                home_finding.suggestion,
            )
            for name, path, target, _legacy_target in entry_specs
        )
    else:
        entries = tuple(
            _entry_plan(name, path, target, legacy_target, state.repo, home, findings)
            for name, path, target, legacy_target in entry_specs
        )
    pi_files, pi_identity, auth_state, pi_findings = _pi_file_plans(state.repo, home)
    findings.extend(pi_findings)
    browser_files, browser_extension, browser_findings = _browser_file_plans(state, home)
    findings.extend(browser_findings)
    fingerprint = _plan_fingerprint(
        desired_snapshot=desired_snapshot,
        active_snapshot=active_snapshot,
        active_observation=active_observation,
        snapshot_action=snapshot_action,
        dirty=dirty,
        entries=entries,
        pi_files=pi_files,
        browser_files=browser_files,
        pi_identity=pi_identity,
        auth_state=auth_state,
    )
    return RuntimePlan(
        desired_snapshot=desired_snapshot,
        active_snapshot=active_snapshot,
        snapshot_action=snapshot_action,
        dirty=dirty,
        entries=entries,
        fingerprint=fingerprint,
        findings=tuple(findings),
        pi_files=pi_files,
        browser_files=browser_files,
        browser_extension=browser_extension,
    )


def inspect_machine(state: DesiredState, home: Path) -> tuple[Finding, ...]:
    """检查当前机器是否与已验证的期望状态完全一致。"""
    try:
        plan = build_runtime_plan(state, home)
    except (OSError, UnicodeError, ValueError) as error:
        return (
            Finding(
                "error",
                "MACHINE_RUNTIME_INSPECTION_FAILED",
                f"Cannot inspect machine runtime state: {error}",
            ),
        )

    findings = list(plan.findings)
    if not plan.has_errors:
        if plan.snapshot_action != "no-change":
            findings.append(
                Finding(
                    "error",
                    "MACHINE_SNAPSHOT_DRIFT",
                    "The active runtime snapshot does not match the desired state.",
                    ".runtime/current",
                    "Run plan, review the fingerprint, and apply it explicitly.",
                )
            )
        for entry in (*plan.entries, *plan.pi_files, *plan.browser_files):
            if entry.action == "no-change":
                continue
            findings.append(
                Finding(
                    "error",
                    "MACHINE_ENTRY_DRIFT",
                    f"Runtime entry {entry.path} does not match the desired state.",
                    str(entry.path),
                    "Run plan, review the fingerprint, and apply it explicitly.",
                )
            )
    for tool in _REQUIRED_TOOLS:
        if shutil.which(tool) is not None:
            continue
        findings.append(
            Finding(
                "error",
                "REQUIRED_TOOL_MISSING",
                f"Required tool {tool!r} is not available on PATH.",
                tool,
                f"Install {tool} or add it to PATH, then run doctor again.",
            )
        )
    if plan.pi_files:
        for tool in ("node", "npm", "uv", "tmux"):
            if shutil.which(tool) is None:
                findings.append(Finding("error", "REQUIRED_TOOL_MISSING",
                                        f"Pi resources require {tool!r} on PATH.", tool))
    return tuple(findings)


def apply_runtime_plan(
    repo: Path,
    home: Path,
    reviewed_fingerprint: str,
) -> RuntimeApplyOutcome:
    repo = repo.resolve()
    try:
        with change_lock(repo):
            return _apply_runtime_plan_locked(repo, home, reviewed_fingerprint)
    except ChangeLockError as error:
        return _apply_error(
            error.code,
            error.message,
        )


def _apply_runtime_plan_locked(
    repo: Path,
    home: Path,
    reviewed_fingerprint: str,
) -> RuntimeApplyOutcome:
    state, desired_findings = load_desired_state(repo)
    if state is None or any(
        finding.severity == "error" for finding in desired_findings
    ):
        return RuntimeApplyOutcome(False, tuple(desired_findings))
    applied = _apply_loaded_runtime_plan_locked(
        state,
        home,
        reviewed_fingerprint,
    )
    return RuntimeApplyOutcome(
        applied.changed,
        (*desired_findings, *applied.findings),
    )


def _apply_loaded_runtime_plan_locked(
    state: DesiredState,
    home: Path,
    reviewed_fingerprint: str,
) -> RuntimeApplyOutcome:
    try:
        plan = build_runtime_plan(state, home)
    except (OSError, UnicodeError, ValueError) as error:
        return _apply_error(
            "RUNTIME_PLAN_INPUT_INVALID",
            f"Cannot read runtime plan input: {error}",
        )
    if plan.fingerprint != reviewed_fingerprint:
        return _stale_plan(reviewed_fingerprint, plan.fingerprint)
    if plan.has_errors:
        return RuntimeApplyOutcome(False, plan.findings)
    if plan.is_no_op:
        return RuntimeApplyOutcome(False)

    candidate: Path | None = None
    activated: Path | None = None
    candidate_findings: tuple[Finding, ...] = ()
    snapshot_changes = plan.snapshot_action in {"add", "replace"}
    runtime_root: Path | None = None
    created_runtime_root = False
    previous_current: str | None = None
    previous_active: Path | None = None
    current_mutation: _SymlinkMutation | None = None
    entry_mutations: list[_SymlinkMutation] = []
    file_mutations: list[RuntimeFilePlan] = []
    created_directories: list[Path] = []
    mutation_started = False
    outcome: RuntimeApplyOutcome | None = None
    cleanup_findings: list[Finding] = []
    try:
        if snapshot_changes:
            runtime_root = state.repo / ".runtime"
            created_runtime_root = not runtime_root.exists()
            runtime_root.mkdir(exist_ok=True)
            candidate = Path(
                tempfile.mkdtemp(prefix=".candidate-", dir=runtime_root)
            )
            expected_inventory = expected_snapshot_inventory(state)
            _, findings = build_candidate_snapshot(
                state,
                candidate,
                plan.desired_snapshot,
                expected_inventory=expected_inventory,
            )
            candidate_findings = tuple(findings)

        refreshed = build_runtime_plan(state, home)
        if refreshed.fingerprint != reviewed_fingerprint:
            raise _StopRuntimeApply(
                _stale_plan(reviewed_fingerprint, refreshed.fingerprint)
            )
        if refreshed.has_errors:
            raise _StopRuntimeApply(
                RuntimeApplyOutcome(False, refreshed.findings)
            )
        if candidate_findings:
            raise _StopRuntimeApply(
                RuntimeApplyOutcome(False, candidate_findings)
            )

        current = state.repo / ".runtime" / "current"
        previous_current = _symlink_state(current)
        previous_active = _managed_snapshot_from_target(
            state.repo,
            current,
            previous_current,
        )

        if candidate is not None:
            snapshots = state.repo / ".runtime" / "snapshots"
            if not snapshots.exists():
                created_directories.append(snapshots)
            snapshots.mkdir(exist_ok=True)
            activated = snapshots / (
                f"{refreshed.desired_snapshot}-{uuid.uuid4().hex}"
            )
            os.replace(candidate, activated)
            candidate = None
            current_target = Path("snapshots") / activated.name
            current_mutation = _SymlinkMutation(
                current,
                previous_current,
                str(current_target),
            )
            mutation_started = True
            _atomic_replace_symlink(current, current_target)

        for entry in refreshed.entries:
            if entry.action == "no-change":
                continue
            entry_mutations.append(
                _SymlinkMutation(
                    entry.path,
                    _symlink_state(entry.path),
                    str(entry.target),
                )
            )
            mutation_started = True
            _create_entry_parents(entry.path, home, created_directories)
            _apply_runtime_entry(entry, home)

        for file in (*refreshed.pi_files, *refreshed.browser_files):
            if file.action == "no-change":
                continue
            parent_finding = _entry_parent_finding(file.path, home)
            if parent_finding is not None:
                raise OSError(parent_finding.message)
            if _file_observation(file.path)[0] != file.observed:
                raise OSError(f"Runtime file {file.path} changed after planning")
            _create_entry_parents(file.path, home, created_directories)
            file_mutations.append(file)
            mutation_started = True
            _atomic_write_file(file.path, file.content, file.desired_mode)

        health_findings = inspect_machine(state, home)
        if any(finding.severity == "error" for finding in health_findings):
            rollback_findings = _restore_runtime_state(
                home=home,
                current=current,
                current_mutation=current_mutation,
                entries=entry_mutations,
                files=file_mutations,
                activated=activated,
                created_directories=created_directories,
            )
            raise _StopRuntimeApply(
                RuntimeApplyOutcome(
                    False,
                    (*health_findings, *rollback_findings),
                )
            )

        if (
            activated is not None
            and previous_active is not None
            and previous_active != activated
        ):
            try:
                _remove_managed_tree(previous_active)
            except OSError as error:
                raise _StopRuntimeApply(
                    RuntimeApplyOutcome(
                        True,
                        (
                            Finding(
                                "error",
                                "RUNTIME_CLEANUP_FAILED",
                                "The new runtime is healthy, but the retired snapshot "
                                f"could not be fully removed: {error}",
                                str(previous_active),
                                "Keep the current pointer unchanged and remove the "
                                "retired snapshot after reviewing its contents.",
                            ),
                        ),
                    )
                )
    except _StopRuntimeApply as stopped:
        outcome = stopped.outcome
    except (OSError, UnicodeError, ValueError) as error:
        failure = _apply_error(
            "RUNTIME_APPLY_FAILED",
            f"Cannot apply the reviewed runtime plan: {error}",
        )
        if not mutation_started:
            outcome = failure
        else:
            rollback_findings = _restore_runtime_state(
                home=home,
                current=state.repo / ".runtime" / "current",
                current_mutation=current_mutation,
                entries=entry_mutations,
                files=file_mutations,
                activated=activated,
                created_directories=created_directories,
            )
            outcome = RuntimeApplyOutcome(
                False,
                (*failure.findings, *rollback_findings),
            )
    finally:
        if candidate is not None:
            cleanup_finding = _cleanup_managed_tree(candidate)
            if cleanup_finding is not None:
                cleanup_findings.append(cleanup_finding)
        if created_runtime_root and runtime_root is not None:
            try:
                runtime_root.rmdir()
            except OSError as error:
                if error.errno not in {errno.EEXIST, errno.ENOENT, errno.ENOTEMPTY}:
                    cleanup_findings.append(
                        Finding(
                            "error",
                            "RUNTIME_CLEANUP_FAILED",
                            f"Cannot remove temporary runtime root: {error}",
                            str(runtime_root),
                        )
                    )
    if outcome is None:
        outcome = RuntimeApplyOutcome(True)
    if cleanup_findings:
        return RuntimeApplyOutcome(
            outcome.changed,
            (*outcome.findings, *cleanup_findings),
        )
    return outcome


def _file_observation(path: Path) -> tuple[str, bytes | None, int]:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return "missing", None, 0o600
    if not stat.S_ISREG(metadata.st_mode):
        raise OSError(f"Runtime file target must be a regular file: {path}")
    content = path.read_bytes()
    mode = stat.S_IMODE(metadata.st_mode)
    return f"{hashlib.sha256(content).hexdigest()}:{mode:o}", content, mode


def _pi_file_plans(
    repo: Path, home: Path,
) -> tuple[tuple[RuntimeFilePlan, ...], str, dict[str, bool], list[Finding]]:
    config, identity, findings = load_pi_config(repo)
    if config is None:
        return (), identity, {}, findings
    files: list[RuntimeFilePlan] = []
    readiness: dict[str, bool] = {}
    for name, source in config.items():
        path = home / ".pi" / "agent" / name
        parent_finding = _entry_parent_finding(path, home)
        if parent_finding is not None:
            findings.append(parent_finding)
            files.append(RuntimeFilePlan(path, "blocked", "unmanaged-parent", b""))
            continue
        try:
            observed, previous, mode = _file_observation(path)
            existing = parse_object(previous, jsonc=True) if previous is not None else {}
            desired = generated_config(name, source, existing, repo)
            if name == "models.json":
                desired = local_model_config(desired, home)
            content = json_bytes(desired)
            action: PlanAction = "no-change" if previous == content else "add" if previous is None else "replace"
            if name == "models.json":
                readiness = auth_readiness(path.with_name("auth.json"), credential_providers(existing))
                for provider, ready in readiness.items():
                    if not ready:
                        findings.append(Finding(
                            "error", "PI_AUTH_MIGRATION_REQUIRED",
                            f"Provider {provider!r} has credentials in models.json but no ready auth.json entry.",
                            str(path), "Configure local authentication before removing these credentials; values are never copied automatically.",
                        ))
            files.append(RuntimeFilePlan(path, action, observed, content, previous, mode,
                                    config_diff(name, existing, desired)))
        except (OSError, ValueError) as error:
            findings.append(Finding("error", "PI_LOCAL_CONFIG_INVALID", str(error), str(path)))
            files.append(RuntimeFilePlan(path, "blocked", "invalid-local-file", b""))
    return tuple(files), identity, readiness, findings


def _browser_file_plans(
    state: DesiredState, home: Path,
) -> tuple[tuple[RuntimeFilePlan, ...], Path | None, list[Finding]]:
    selection = next((skill for skill in state.skills if skill.name == "web-browser"), None)
    if sys.platform != "darwin" or selection is None:
        return (), None, []
    # Browsers resolve symlinks when loading unpacked extensions. Keep physical
    # files at a stable path, otherwise retiring a snapshot breaks Reload.
    extension = home / "Library/Application Support/agent-stuff/web-browser/extension"
    findings: list[Finding] = []
    for relative in ("extension/manifest.json", "scripts/native-host.js"):
        source = selection.source_path / relative
        if not source.is_file() or source.is_symlink():
            findings.append(Finding(
                "error", "WEB_BROWSER_RESOURCE_MISSING",
                f"web-browser requires a regular source file: {source}", str(source),
            ))
    node_command = shutil.which("node")
    if node_command is None:
        findings.append(Finding(
            "error", "REQUIRED_TOOL_MISSING",
            "web-browser Native Messaging requires an executable Node.js on PATH.",
            "node", "Install Node.js, then run plan again.",
        ))
        return (), extension, findings
    node = Path(os.path.abspath(node_command))
    files: list[RuntimeFilePlan] = []
    specs = list(native_host_specs(state.repo, home, node))
    extension_previous: dict[Path, bytes] = {}
    for name in ("manifest.json", "background.js", "wire.mjs", "popup.html", "popup.js"):
        source = selection.source_path / "extension" / name
        if not source.is_file() or source.is_symlink():
            findings.append(Finding("error", "WEB_BROWSER_RESOURCE_MISSING", f"Missing extension source: {source}", str(source)))
            continue
        path = extension / name
        specs.append((path, source.read_bytes(), 0o600))
        active_source = state.repo / ".runtime/current/skills/web-browser/extension" / name
        if active_source.is_file():
            extension_previous[path] = active_source.read_bytes()
    for path, content, mode in specs:
        parent_finding = _entry_parent_finding(path, home)
        if parent_finding is not None:
            findings.append(parent_finding)
            files.append(RuntimeFilePlan(path, "blocked", "unmanaged-parent", content, mode=mode))
            continue
        try:
            observed, previous, previous_mode = _file_observation(path)
            owned = (
                previous == content or previous == extension_previous.get(path)
                if path.parent == extension
                else previous is None or owns_native_host_file(path, previous, content)
            )
            if previous is not None and not owned:
                findings.append(Finding(
                    "error", "WEB_BROWSER_HOST_UNMANAGED",
                    f"Native Messaging file is not recognized as owned by this checkout: {path}",
                    str(path), "Review and move the unknown file aside, then run plan again.",
                ))
                files.append(RuntimeFilePlan(path, "blocked", observed, content, previous, previous_mode, mode=mode))
                continue
            action: PlanAction = (
                "no-change" if previous == content and previous_mode == mode
                else "add" if previous is None else "replace"
            )
            diff = "".join(difflib.unified_diff(
                (previous or b"").decode().splitlines(keepends=True),
                content.decode().splitlines(keepends=True),
                fromfile=str(path), tofile=str(path),
            ))
            files.append(RuntimeFilePlan(path, action, observed, content, previous, previous_mode, diff, mode))
        except (OSError, UnicodeError, ValueError) as error:
            findings.append(Finding("error", "WEB_BROWSER_HOST_INVALID", str(error), str(path)))
            files.append(RuntimeFilePlan(path, "blocked", "invalid-local-file", content, mode=mode))
    return tuple(files), extension, findings


def _atomic_write_file(path: Path, content: bytes, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(content)
            file.flush()
            os.fchmod(file.fileno(), mode)
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _stale_plan(reviewed: str, actual: str) -> RuntimeApplyOutcome:
    return _apply_error(
        "RUNTIME_PLAN_STALE",
        f"Reviewed plan {reviewed} no longer matches current plan {actual}.",
        "Run plan again and review the new fingerprint before applying.",
    )


def _apply_error(
    code: str,
    message: str,
    suggestion: str | None = None,
) -> RuntimeApplyOutcome:
    return RuntimeApplyOutcome(
        False,
        (Finding("error", code, message, suggestion=suggestion),),
    )


def _apply_runtime_entry(entry: RuntimeEntryPlan, home: Path) -> None:
    if entry.action == "no-change":
        return
    if entry.action not in {"add", "migrate"}:
        raise OSError(f"Runtime entry {entry.path} is not authorized for mutation")

    parent_finding = _entry_parent_finding(entry.path, home)
    if parent_finding is not None:
        raise OSError(parent_finding.message)
    if entry.action == "add":
        entry.path.symlink_to(entry.target)
        return

    observed_prefix = "legacy-symlink:"
    expected_observation = entry.observed.removeprefix(observed_prefix)
    if (
        not entry.observed.startswith(observed_prefix)
        or not entry.path.is_symlink()
        or os.readlink(entry.path) != expected_observation
    ):
        raise OSError(f"Runtime entry {entry.path} changed after planning")
    _atomic_replace_symlink(entry.path, entry.target)


def _atomic_replace_symlink(path: Path, target: Path) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.symlink_to(target)
    try:
        os.replace(temporary, path)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def _symlink_state(path: Path) -> str | None:
    if path.is_symlink():
        return os.readlink(path)
    if path.exists():
        raise OSError(f"Managed runtime path {path} is no longer a symlink")
    return None


def _managed_snapshot_from_target(
    repo: Path,
    current: Path,
    raw_target: str | None,
) -> Path | None:
    if raw_target is None:
        return None
    target = _absolute_link_target(current, raw_target)
    snapshots = _normalized_path(repo / ".runtime" / "snapshots")
    if _normalized_path(target.parent) != snapshots:
        return None
    if not target.is_dir() or target.is_symlink():
        return None
    return target


def _restore_runtime_state(
    *,
    home: Path,
    current: Path,
    current_mutation: _SymlinkMutation | None,
    entries: list[_SymlinkMutation],
    files: list[RuntimeFilePlan],
    activated: Path | None,
    created_directories: list[Path],
) -> tuple[Finding, ...]:
    errors: list[str] = []
    for file in reversed(files):
        try:
            parent_finding = _entry_parent_finding(file.path, home)
            if parent_finding is not None:
                raise OSError(parent_finding.message)
            observed, content, mode = _file_observation(file.path)
            if observed == file.observed:
                continue
            if content != file.content or mode != file.desired_mode:
                raise OSError("Runtime file changed after this transaction wrote it")
            if file.previous is None:
                file.path.unlink()
            else:
                _atomic_write_file(file.path, file.previous, file.previous_mode)
        except OSError as error:
            errors.append(f"{file.path}: {error}")
    for mutation in reversed(entries):
        try:
            _restore_owned_symlink(mutation)
        except OSError as error:
            errors.append(f"{mutation.path}: {error}")
    if current_mutation is not None:
        try:
            _restore_owned_symlink(current_mutation)
        except OSError as error:
            errors.append(f"{current}: {error}")
    if activated is not None and activated.exists():
        try:
            candidate_is_active = _symlink_resolves_to(current, activated)
        except OSError as error:
            candidate_is_active = True
            errors.append(f"{current}: {error}")
        if not candidate_is_active:
            try:
                _remove_managed_tree(activated)
            except OSError as error:
                errors.append(f"{activated}: {error}")
    for directory in sorted(
        set(created_directories),
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        try:
            directory.rmdir()
        except FileNotFoundError:
            continue
        except OSError as error:
            errors.append(f"{directory}: {error}")
    if not errors:
        return ()
    return (
        Finding(
            "error",
            "RUNTIME_ROLLBACK_FAILED",
            "Cannot fully restore the previous runtime state: " + "; ".join(errors),
        ),
    )


def _restore_owned_symlink(mutation: _SymlinkMutation) -> None:
    path = mutation.path
    if path.is_symlink():
        current_target: str | None = os.readlink(path)
    elif path.exists():
        raise OSError("rollback target is occupied by non-symlink state")
    else:
        current_target = None
    if current_target == mutation.previous_target:
        return
    if current_target != mutation.written_target:
        raise OSError("runtime entry changed after this transaction wrote it")
    if mutation.previous_target is None:
        path.unlink()
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_replace_symlink(path, Path(mutation.previous_target))


def _symlink_resolves_to(path: Path, target: Path) -> bool:
    if not path.is_symlink():
        return False
    return _absolute_link_target(path, os.readlink(path)) == _normalized_path(target)


def _missing_parents(path: Path, home: Path) -> tuple[Path, ...]:
    missing: list[Path] = []
    current = path.parent
    while current != home and not current.exists() and not current.is_symlink():
        missing.append(current)
        current = current.parent
    return tuple(missing)


def _create_entry_parents(
    path: Path,
    home: Path,
    created_directories: list[Path],
) -> None:
    for directory in reversed(_missing_parents(path, home)):
        try:
            directory.mkdir()
        except FileExistsError:
            mode = directory.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise OSError(
                    f"Runtime entry parent {directory} is not a managed directory."
                )
        else:
            created_directories.append(directory)


def _cleanup_managed_tree(root: Path) -> Finding | None:
    try:
        _remove_managed_tree(root)
    except OSError as primary_error:
        try:
            shutil.rmtree(root)
        except FileNotFoundError:
            return None
        except OSError as fallback_error:
            return Finding(
                "error",
                "RUNTIME_CLEANUP_FAILED",
                "Cannot remove temporary runtime content after two cleanup "
                f"strategies failed: {primary_error}; {fallback_error}",
                str(root),
            )
    return None


def _remove_managed_tree(root: Path) -> None:
    root_mode = root.lstat().st_mode
    root.chmod(root_mode | stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    for directory, directory_names, file_names in os.walk(
        root,
        topdown=True,
        followlinks=False,
    ):
        directory_path = Path(directory)
        for name in directory_names:
            path = directory_path / name
            if path.is_symlink():
                continue
            mode = path.lstat().st_mode
            path.chmod(mode | stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
        for name in file_names:
            path = directory_path / name
            if path.is_symlink():
                continue
            mode = path.lstat().st_mode
            path.chmod(mode | stat.S_IRUSR | stat.S_IWUSR)
    shutil.rmtree(root)


def _runtime_root_finding(repo: Path) -> Finding | None:
    for path in (repo / ".runtime", repo / ".runtime" / "snapshots"):
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        except OSError as error:
            return Finding(
                "error",
                "RUNTIME_ROOT_UNMANAGED",
                f"Cannot verify internal runtime path {path}: {error}",
                str(path),
                "Move the unknown state aside and run plan again.",
            )
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            return Finding(
                "error",
                "RUNTIME_ROOT_UNMANAGED",
                f"Internal runtime path {path} is not a managed directory.",
                str(path),
                "Move the unknown state aside and run plan again.",
            )
    return None


def _active_snapshot_plan(
    repo: Path,
    current: Path,
    desired_snapshot: str,
    expected_inventory: dict[str, tuple[str, str, bool]],
) -> tuple[str | None, PlanAction, str, list[Finding]]:
    if not current.exists() and not current.is_symlink():
        return None, "add", "missing", []
    if not current.is_symlink():
        return None, "blocked", "not-a-symlink", [_unmanaged_current_finding()]
    try:
        raw_target = os.readlink(current)
    except OSError as error:
        return (
            None,
            "blocked",
            f"read-error:{error}",
            [
                Finding(
                    "error",
                    "RUNTIME_CURRENT_READ_FAILED",
                    f"Cannot read the current runtime pointer: {error}",
                    ".runtime/current",
                )
            ],
        )

    target = _absolute_link_target(current, raw_target)
    snapshots_root = repo / ".runtime" / "snapshots"
    managed_parent = not snapshots_root.is_symlink() and _normalized_path(
        target.parent
    ) == _normalized_path(snapshots_root)
    if not managed_parent:
        return None, "blocked", f"outside:{raw_target}", [_unmanaged_current_finding()]
    if not target.exists():
        return None, "replace", f"broken:{raw_target}", []
    if not target.is_dir() or target.is_symlink():
        return (
            None,
            "blocked",
            f"invalid-target:{raw_target}",
            [_unmanaged_current_finding()],
        )

    marker_path = target / ".snapshot-id"
    try:
        marker = (
            marker_path.read_text().strip()
            if marker_path.is_file() and not marker_path.is_symlink()
            else ""
        )
        actual_inventory = read_snapshot_inventory(target)
    except (OSError, UnicodeError) as error:
        return (
            None,
            "blocked",
            f"snapshot-read-error:{error}",
            [
                Finding(
                    "error",
                    "RUNTIME_SNAPSHOT_READ_FAILED",
                    f"Cannot inspect the active runtime snapshot: {error}",
                    str(target),
                )
            ],
        )

    active_snapshot = marker if _SNAPSHOT_ID.fullmatch(marker) else None
    observation = json.dumps(
        {
            "target": raw_target,
            "marker": marker,
            "directory": target.name,
            "inventory": inventory_identity(actual_inventory),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    matches = (
        active_snapshot == desired_snapshot
        and (target / "skills").is_dir()
        and not (target / "skills").is_symlink()
        and actual_inventory == expected_inventory
    )
    return active_snapshot, "no-change" if matches else "replace", observation, []


def _unmanaged_current_finding() -> Finding:
    return Finding(
        "error",
        "RUNTIME_CURRENT_UNMANAGED",
        "The current runtime pointer is not a recognized managed snapshot.",
        ".runtime/current",
        "Move the unknown state aside and run plan again.",
    )


def _desired_inputs_are_dirty(state: DesiredState) -> tuple[bool, list[Finding]]:
    paths = {
        "AGENTS.md",
        "CLAUDE.md",
        "config/agent-control.toml",
        "global/AGENTS.md",
        "config/pi",
        "pi/package.json",
    }
    for selection in state.skills:
        parts = PurePosixPath(selection.source).parts
        if parts[0] == "vendors":
            paths.add("/".join(parts[:2]))
        else:
            paths.add(selection.source)
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
                str(state.repo),
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=dirty",
                "--",
                *sorted(paths),
            ],
            env=environment,
            capture_output=True,
        )
    except OSError as error:
        return False, [
            Finding(
                "error",
                "REPOSITORY_STATUS_FAILED",
                f"Cannot inspect desired input status: {error}",
            )
        ]
    if result.returncode != 0:
        message = result.stderr.decode(errors="replace").strip()
        return False, [
            Finding(
                "error",
                "REPOSITORY_STATUS_FAILED",
                f"Cannot inspect desired input status: {message}",
            )
        ]
    return has_meaningful_git_changes(result.stdout), []


def _entry_specs(repo: Path, home: Path) -> tuple[tuple[str, Path, Path, Path], ...]:
    current = repo / ".runtime" / "current"
    entries = (
        (
            "codex-instructions",
            home / ".codex" / "AGENTS.md",
            repo / "global" / "AGENTS.md",
            repo / "AGENTS.md",
        ),
        (
            "claude-instructions",
            home / ".claude" / "CLAUDE.md",
            repo / "global" / "AGENTS.md",
            repo / "AGENTS.md",
        ),
        (
            "agents-skills",
            home / ".agents" / "skills",
            current / "skills",
            repo / "skills",
        ),
        (
            "claude-skills",
            home / ".claude" / "skills",
            current / "skills",
            repo / "skills",
        ),
    )
    if (repo / "config" / "pi").is_dir():
        entries += ((
            "pi-instructions",
            home / ".pi" / "agent" / "AGENTS.md",
            repo / "global" / "AGENTS.md",
            repo / "AGENTS.md",
        ),)
    return entries


def _entry_plan(
    name: str,
    path: Path,
    target: Path,
    legacy_target: Path,
    repo: Path,
    home: Path,
    findings: list[Finding],
) -> RuntimeEntryPlan:
    parent_finding = _entry_parent_finding(path, home)
    if parent_finding is not None:
        findings.append(parent_finding)
        return RuntimeEntryPlan(
            name,
            path,
            target,
            "blocked",
            "unmanaged-parent",
            parent_finding.suggestion,
        )
    if not path.exists() and not path.is_symlink():
        return RuntimeEntryPlan(name, path, target, "add", "missing")
    if path.is_symlink():
        try:
            raw_target = os.readlink(path)
        except OSError as error:
            return _blocked_entry(name, path, target, f"read-error:{error}", findings)
        observed_target = _absolute_link_target(path, raw_target)
        if _targets_same_directly(observed_target, target, repo):
            return RuntimeEntryPlan(
                name,
                path,
                target,
                "no-change",
                f"symlink:{raw_target}",
            )
        old_repo_target = home / "code" / "agents" / (
            ".runtime/current/skills" if name.endswith("-skills") else "global/AGENTS.md"
        )
        if (
            _targets_same_directly(observed_target, legacy_target, repo)
            or observed_target == _normalized_path(old_repo_target)
        ):
            return RuntimeEntryPlan(
                name,
                path,
                target,
                "migrate",
                f"legacy-symlink:{raw_target}",
            )
        return _blocked_entry(
            name,
            path,
            target,
            f"unknown-symlink:{raw_target}",
            findings,
        )
    return _blocked_entry(name, path, target, "unknown", findings)


def _entry_parent_finding(path: Path, home: Path) -> Finding | None:
    home_finding = _home_root_finding(home)
    if home_finding is not None:
        return home_finding
    try:
        relative = path.relative_to(home)
    except ValueError:
        return Finding(
            "error",
            "RUNTIME_ENTRY_PARENT_UNMANAGED",
            f"Runtime entry {path} is outside HOME.",
            str(path),
            "Move the unknown state aside and run plan again.",
        )

    current = home
    for part in relative.parts[:-1]:
        current /= part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            break
        except OSError as error:
            return Finding(
                "error",
                "RUNTIME_ENTRY_PARENT_UNMANAGED",
                f"Cannot verify runtime entry parent {current}: {error}",
                str(current),
                "Move the unknown state aside and run plan again.",
            )
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            return Finding(
                "error",
                "RUNTIME_ENTRY_PARENT_UNMANAGED",
                f"Runtime entry parent {current} is not a managed directory.",
                str(current),
                "Move the unknown state aside and run plan again.",
            )
    return None


def _home_root_finding(home: Path) -> Finding | None:
    suggestion = "Set HOME to an existing absolute directory and run plan again."
    if not home.is_absolute():
        return Finding(
            "error",
            "RUNTIME_HOME_UNMANAGED",
            f"HOME path {home} is not absolute.",
            str(home),
            suggestion,
        )
    try:
        mode = home.lstat().st_mode
    except OSError as error:
        return Finding(
            "error",
            "RUNTIME_HOME_UNMANAGED",
            f"Cannot verify HOME path {home}: {error}",
            str(home),
            suggestion,
        )
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        return Finding(
            "error",
            "RUNTIME_HOME_UNMANAGED",
            f"HOME path {home} is not a managed directory.",
            str(home),
            suggestion,
        )
    return None


def _blocked_entry(
    name: str,
    path: Path,
    target: Path,
    observed: str,
    findings: list[Finding],
) -> RuntimeEntryPlan:
    findings.append(
        Finding(
            "error",
            "RUNTIME_ENTRY_UNMANAGED",
            f"Runtime entry {path} is not recognized as managed or legacy state.",
            str(path),
            "Move the unknown state aside and run plan again.",
        )
    )
    return RuntimeEntryPlan(
        name,
        path,
        target,
        "blocked",
        observed,
        "Move the unknown state aside and run plan again.",
    )


def _absolute_link_target(path: Path, raw_target: str) -> Path:
    target = Path(raw_target)
    if not target.is_absolute():
        target = path.parent / target
    return _normalized_path(target)


def _normalized_path(path: Path) -> Path:
    return Path(os.path.abspath(os.path.normpath(path)))


def _targets_same_directly(actual: Path, expected: Path, repo: Path) -> bool:
    actual = _normalized_path(actual)
    expected = _normalized_path(expected)
    if actual == expected:
        return True
    try:
        relative = expected.relative_to(repo)
    except ValueError:
        return False
    if len(actual.parts) < len(relative.parts):
        return False
    if actual.parts[-len(relative.parts) :] != relative.parts:
        return False
    prefix_parts = actual.parts[: -len(relative.parts)]
    prefix = Path(*prefix_parts) if prefix_parts else Path(".")
    try:
        return prefix.resolve(strict=True) == repo
    except (FileNotFoundError, OSError, RuntimeError):
        return False


def _plan_fingerprint(
    *,
    desired_snapshot: str,
    active_snapshot: str | None,
    active_observation: str,
    snapshot_action: PlanAction,
    dirty: bool,
    entries: tuple[RuntimeEntryPlan, ...],
    pi_files: tuple[RuntimeFilePlan, ...],
    browser_files: tuple[RuntimeFilePlan, ...],
    pi_identity: str,
    auth_state: dict[str, bool],
) -> str:
    payload = {
        "desired_snapshot": desired_snapshot,
        "active_snapshot": active_snapshot,
        "active_observation": active_observation,
        "snapshot_action": snapshot_action,
        "dirty": dirty,
        "pi_identity": pi_identity,
        "auth_readiness": auth_state,
        "pi_files": [
            {"path": str(file.path), "action": file.action,
             "observed": file.observed,
             "desired": hashlib.sha256(file.content).hexdigest()}
            for file in pi_files
        ],
        "browser_files": [
            {"path": str(file.path), "action": file.action,
             "observed": file.observed, "mode": file.desired_mode,
             "desired": hashlib.sha256(file.content).hexdigest()}
            for file in browser_files
        ],
        "entries": [
            {
                "name": entry.name,
                "path": str(entry.path),
                "target": str(entry.target),
                "action": entry.action,
                "observed": entry.observed,
            }
            for entry in entries
        ],
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()
