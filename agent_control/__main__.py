from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

from .desired_state import load_desired_state
from .models import DesiredState, Finding, ValidationOutcome
from .runtime import apply_runtime_plan, build_runtime_plan
from .snapshot import validate_candidate_snapshot
from .vendor import apply_vendor_plan, build_vendor_plan


_RISK_WORDS = re.compile(
    r"\b(?:credential|api[ -]?key|post|publish|delete|remove|transfer|withdraw|"
    r"order|buy|sell|redeem|subscribe|sync|write)\b",
    re.IGNORECASE,
)
_PLAN_FINGERPRINT = re.compile(r"^[0-9a-f]{64}$")
_EXACT_COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-control")
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help=argparse.SUPPRESS,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate", help="Validate repository desired state")
    subparsers.add_parser("list-skills", help="List selected skills")
    subparsers.add_parser("audit-skills", help="Audit skill governance")
    subparsers.add_parser("doctor", help="Inspect machine runtime health")
    subparsers.add_parser("plan", help="Plan runtime changes")
    subparsers.add_parser("prepare", help="Install locked local package dependencies")
    subparsers.add_parser("update", help="Pull a clean checkout, check it and show the plan")
    apply_parser = subparsers.add_parser("apply", help="Apply a reviewed runtime plan")
    apply_parser.add_argument("plan_fingerprint", type=_parse_plan_fingerprint)
    vendor_parser = subparsers.add_parser("vendor", help="Manage one vendor checkout")
    vendor_subparsers = vendor_parser.add_subparsers(
        dest="vendor_command",
        required=True,
    )
    vendor_plan_parser = vendor_subparsers.add_parser(
        "plan",
        help="Plan one explicit vendor target",
    )
    vendor_plan_parser.add_argument("vendor")
    vendor_plan_parser.add_argument("target_ref")
    vendor_apply_parser = vendor_subparsers.add_parser(
        "apply",
        help="Apply one reviewed vendor target",
    )
    vendor_apply_parser.add_argument("vendor")
    vendor_apply_parser.add_argument("target_commit", type=_parse_exact_commit)
    vendor_apply_parser.add_argument(
        "plan_fingerprint",
        type=_parse_plan_fingerprint,
    )
    namespace = parser.parse_args(arguments)

    if namespace.command in {"prepare", "update"}:
        from .update import prepare, update
        return (prepare if namespace.command == "prepare" else update)(namespace.repo)
    if namespace.command == "validate":
        return _validate(namespace.repo)
    if namespace.command == "list-skills":
        return _list_skills(namespace.repo)
    if namespace.command == "plan":
        return _plan(namespace.repo)
    if namespace.command == "doctor":
        return _doctor(namespace.repo)
    if namespace.command == "apply":
        return _apply(namespace.repo, namespace.plan_fingerprint)
    if namespace.command == "vendor":
        if namespace.vendor_command == "plan":
            return _vendor_plan(namespace.repo, namespace.vendor, namespace.target_ref)
        return _vendor_apply(
            namespace.repo,
            namespace.vendor,
            namespace.target_commit,
            namespace.plan_fingerprint,
        )
    return _audit_skills(namespace.repo)


def _parse_plan_fingerprint(value: str) -> str:
    if not _PLAN_FINGERPRINT.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "plan fingerprint must contain exactly 64 lowercase hexadecimal characters"
        )
    return value


def _parse_exact_commit(value: str) -> str:
    if not _EXACT_COMMIT.fullmatch(value):
        raise argparse.ArgumentTypeError(
            "target commit must be a full lowercase hexadecimal object id"
        )
    return value


def _load(repo: Path, *, build_candidate: bool) -> ValidationOutcome:
    state, findings = load_desired_state(repo)
    candidate_count = 0
    if state is not None and build_candidate:
        candidate_count, candidate_findings = validate_candidate_snapshot(state)
        findings.extend(candidate_findings)
    return ValidationOutcome(state, tuple(findings), candidate_count)


def _validate(repo: Path) -> int:
    outcome = _load(repo, build_candidate=True)
    _print_findings(outcome.findings)
    if outcome.has_errors or outcome.state is None:
        return 1
    implicit = sum(
        selection.invocation == "implicit" for selection in outcome.state.skills
    )
    explicit = len(outcome.state.skills) - implicit
    print(
        f"Validation succeeded: {len(outcome.state.skills)} skills "
        f"({implicit} implicit, {explicit} explicit)."
    )
    print(f"Candidate snapshot verified: {outcome.candidate_count} skills.")
    return 0


def _list_skills(repo: Path) -> int:
    outcome = _load(repo, build_candidate=False)
    _print_findings(outcome.findings)
    if outcome.has_errors or outcome.state is None:
        return 1
    print("name\tsource\tinvocation")
    for selection in outcome.state.skills:
        print(f"{selection.name}\t{selection.source}\t{selection.invocation}")
    return 0


def _plan(repo: Path) -> int:
    outcome = _load(repo, build_candidate=False)
    _print_findings(outcome.findings)
    if outcome.has_errors or outcome.state is None:
        return 1
    try:
        plan = build_runtime_plan(outcome.state, Path.home())
    except (OSError, UnicodeError, ValueError) as error:
        _print_findings(
            (
                Finding(
                    "error",
                    "RUNTIME_PLAN_INPUT_INVALID",
                    f"Cannot read runtime plan input: {error}",
                ),
            )
        )
        return 1
    _print_findings(plan.findings)
    print(f"Desired snapshot: {plan.desired_snapshot}")
    print(f"Active snapshot: {plan.active_snapshot or 'none'}")
    print(f"Dirty inputs: {'yes' if plan.dirty else 'no'}")
    print(f"Snapshot action: {plan.snapshot_action}")
    for entry in plan.entries:
        print(f"Entry {entry.name}: {entry.action}")
        print(f"  Observed: {entry.observed}")
        print(f"  {entry.path} -> {entry.target}")
    for file in plan.pi_files:
        print(f"Pi file {file.path.name}: {file.action}")
        print(f"  {file.path}")
        if file.diff:
            print(file.diff, end="")
    if plan.browser_extension is not None:
        print(f"web-browser extension load directory: {plan.browser_extension}")
        print("  Load in one profile per browser; reload the extension after applying updates.")
    for file in plan.browser_files:
        print(f"web-browser host file {file.path.name}: {file.action}")
        print(f"  {file.path}")
        previous_mode = "missing" if file.previous is None else f"{file.previous_mode:03o}"
        print(f"  Mode: {previous_mode} -> {file.desired_mode:03o}")
        if file.diff:
            print(file.diff, end="")
    result = "blocked" if plan.has_errors else "no-op" if plan.is_no_op else "changes"
    print(f"Plan result: {result}")
    print(f"Plan fingerprint: {plan.fingerprint}")
    return 1 if plan.has_errors else 0


def _doctor(repo: Path) -> int:
    outcome = _load(repo, build_candidate=True)
    _print_findings(outcome.findings)
    if outcome.has_errors or outcome.state is None:
        return 1

    from .runtime import inspect_machine

    findings = inspect_machine(outcome.state, Path.home())
    _print_findings(findings)
    if any(finding.severity == "error" for finding in findings):
        return 1
    print("Machine doctor succeeded.")
    return 0


def _apply(repo: Path, plan_fingerprint: str) -> int:
    applied = apply_runtime_plan(repo, Path.home(), plan_fingerprint)
    _print_findings(applied.findings)
    if applied.has_errors:
        return 1
    print(f"Apply result: {'changes' if applied.changed else 'no-op'}")
    print(
        "New skills and instructions are guaranteed only for new or reloaded "
        "Agent sessions."
    )
    return 0


def _vendor_plan(repo: Path, vendor: str, target_ref: str) -> int:
    outcome = build_vendor_plan(repo, vendor, target_ref)
    _print_findings(outcome.findings)
    if outcome.has_errors or outcome.plan is None:
        return 1
    plan = outcome.plan
    print(f"Vendor: {plan.vendor}")
    print(f"Vendor path: {plan.path}")
    print(f"Current commit: {plan.current_commit}")
    print(f"Current ref: {plan.current_ref or 'detached'}")
    print(f"Target commit: {plan.target_commit}")
    print("Selected skill changes:")
    if not plan.changes:
        print("  none")
    for change in plan.changes:
        categories = ", ".join(change.categories)
        print(f"  {change.status} {change.path} [{categories}]")
    print(f"Vendor plan fingerprint: {plan.fingerprint}")
    return 0


def _vendor_apply(
    repo: Path,
    vendor: str,
    target_commit: str,
    plan_fingerprint: str,
) -> int:
    outcome = apply_vendor_plan(
        repo,
        vendor,
        target_commit,
        plan_fingerprint,
    )
    _print_findings(outcome.findings)
    if outcome.has_errors:
        return 1
    print(f"Vendor apply result: {'changes' if outcome.changed else 'no-op'}")
    print(
        "Runtime skills remain unchanged until a separate runtime plan is reviewed "
        "and applied."
    )
    return 0


def _audit_skills(repo: Path) -> int:
    outcome = _load(repo, build_candidate=False)
    _print_findings(outcome.findings)
    if outcome.has_errors or outcome.state is None:
        return 1

    state = outcome.state
    advisory = _advisory_findings(state)
    _print_findings(advisory)
    invocation_counts = Counter(selection.invocation for selection in state.skills)
    source_counts = Counter(
        _source_family(selection.source) for selection in state.skills
    )
    print(f"Configured skills: {len(state.skills)}")
    print(
        "Invocation policies: "
        f"implicit={invocation_counts['implicit']}, explicit={invocation_counts['explicit']}"
    )
    print(f"Implicit invocation budget: {state.implicit_budget}")
    print("Source families:")
    for source, count in sorted(source_counts.items()):
        print(f"  {source}: {count}")
    print("Hard governance checks: ok")
    return 0


def _advisory_findings(state: DesiredState) -> tuple[Finding, ...]:
    findings: list[Finding] = []
    for selection in state.skills:
        evidence = [selection.name, selection.description]
        for folder_name in ("references", "scripts"):
            folder = selection.source_path / folder_name
            if not folder.is_dir():
                continue
            for path in folder.rglob("*"):
                if path.is_file() and not path.is_symlink():
                    evidence.append(path.relative_to(selection.source_path).as_posix())
                    try:
                        evidence.append(path.read_text(errors="ignore"))
                    except OSError:
                        evidence.append("")
        matches = sorted(
            {
                match.group(0).lower()
                for match in _RISK_WORDS.finditer("\n".join(evidence))
            }
        )
        if matches:
            findings.append(
                Finding(
                    "warning",
                    "RISK_SIGNAL",
                    f"Advisory risk terms for {selection.name!r}: {', '.join(matches)}.",
                    selection.source,
                    "Review authorization and side-effect boundaries manually.",
                )
            )
    return tuple(findings)


def _source_family(source: str) -> str:
    parts = source.split("/")
    if parts[0] == "custom-skills":
        return "custom-skills"
    return "/".join(parts[:2])


def _print_findings(findings: tuple[Finding, ...]) -> None:
    for finding in findings:
        location = f" [{finding.location}]" if finding.location else ""
        print(f"{finding.severity.upper()} {finding.code}{location}: {finding.message}")
        if finding.suggestion:
            print(f"  Suggestion: {finding.suggestion}")


if __name__ == "__main__":
    sys.exit(main())
