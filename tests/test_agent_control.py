from __future__ import annotations

import hashlib
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Any
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


class ControlPlaneFixture:
    def __init__(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary_directory.name) / "repo"
        self.home = Path(self.temporary_directory.name) / "home"
        self.repo.mkdir()
        self.home.mkdir()
        (self.repo / "config").mkdir()
        (self.repo / "custom-skills").mkdir()
        (self.repo / "global").mkdir()
        (self.repo / "vendors" / "example").mkdir(parents=True)
        (self.repo / ".runtime").mkdir()
        (self.repo / ".runtime" / "current").write_text("active-state\n")
        (self.home / "sentinel").write_text("home-state\n")
        (self.repo / "global" / "AGENTS.md").write_text("global instructions\n")
        (self.repo / "AGENTS.md").write_text("project instructions\n")
        (self.repo / "CLAUDE.md").write_text("@AGENTS.md\n")
        (self.repo / ".gitmodules").write_text(
            '[submodule "vendors/example"]\n'
            "\tpath = vendors/example\n"
            "\turl = https://example.test/example.git\n"
        )

        self.create_skill(self.repo / "custom-skills" / "local-skill", "local-skill")
        self.create_skill(
            self.repo / "vendors" / "example" / "manual-skill", "manual-skill"
        )
        self.commit_vendor()
        self.write_config()
        self.commit_repo()

    def cleanup(self) -> None:
        self.temporary_directory.cleanup()

    @staticmethod
    def create_skill(path: Path, name: str, description: str = "Use for tests") -> None:
        path.mkdir(parents=True, exist_ok=True)
        (path / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"
        )

    def commit_vendor(self) -> None:
        vendor = self.repo / "vendors" / "example"
        subprocess.run(["git", "init", "-q", str(vendor)], check=True)
        subprocess.run(["git", "-C", str(vendor), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(vendor),
                "-c",
                "user.name=Tests",
                "-c",
                "user.email=tests@example.test",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
            capture_output=True,
        )

    def commit_repo(self) -> None:
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(self.repo),
                "add",
                ".gitmodules",
                "AGENTS.md",
                "CLAUDE.md",
                "config",
                "custom-skills",
                "global",
                "vendors/example",
            ],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(self.repo),
                "-c",
                "user.name=Tests",
                "-c",
                "user.email=tests@example.test",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )

    def create_vendor_target(self) -> tuple[str, str]:
        vendor = self.repo / "vendors" / "example"
        current = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        skill = vendor / "manual-skill"
        skill_file = skill / "SKILL.md"
        skill_file.write_text(skill_file.read_text() + "\nReviewed metadata change.\n")
        scripts = skill / "scripts"
        scripts.mkdir()
        executable = scripts / "update.py"
        executable.write_text("#!/usr/bin/env python3\nprint('updated')\n")
        executable.chmod(0o755)
        subprocess.run(["git", "-C", str(vendor), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(vendor),
                "-c",
                "user.name=Tests",
                "-c",
                "user.email=tests@example.test",
                "commit",
                "-qm",
                "vendor target",
            ],
            check=True,
        )
        target = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ["git", "-C", str(vendor), "checkout", "-q", "--detach", current],
            check=True,
        )
        return current, target

    def write_config(
        self,
        *,
        implicit_budget: int = 1,
        group_limit: int = 1,
        group_skills: tuple[str, ...] = ("local-skill", "manual-skill"),
        skills: tuple[tuple[str, str], ...] = (
            ("custom-skills/local-skill", "implicit"),
            ("vendors/example/manual-skill", "explicit"),
        ),
        expected_names: dict[str, str] | None = None,
        extra: str = "",
    ) -> None:
        quoted_group_skills = ", ".join(f'"{name}"' for name in group_skills)
        parts = [
            "[governance]",
            f"implicit_budget = {implicit_budget}",
            "",
            "[[governance.trigger_groups]]",
            'name = "test-group"',
            f"limit = {group_limit}",
            f"skills = [{quoted_group_skills}]",
        ]
        for source, invocation in skills:
            parts.extend(["", "[[skills]]", f'source = "{source}"'])
            if expected_names and source in expected_names:
                parts.append(f'expected_name = "{expected_names[source]}"')
            parts.append(f'invocation = "{invocation}"')
        if extra:
            parts.extend(["", extra])
        (self.repo / "config" / "agent-control.toml").write_text(
            "\n".join(parts) + "\n"
        )

    def run(
        self,
        *arguments: str,
        environment_overrides: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["HOME"] = str(self.home)
        environment["PYTHONPATH"] = str(ROOT)
        if environment_overrides:
            environment.update(environment_overrides)
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "agent_control",
                "--repo",
                str(self.repo),
                *arguments,
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
        )

    def run_make(
        self,
        *arguments: str,
        environment_overrides: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment["HOME"] = str(self.home)
        environment["PYTHONPATH"] = str(ROOT)
        if environment_overrides:
            environment.update(environment_overrides)
        return subprocess.run(
            [
                "make",
                "--no-print-directory",
                "-s",
                "-f",
                str(ROOT / "Makefile"),
                f"PYTHON={shlex.quote(sys.executable)}",
                *arguments,
            ],
            cwd=self.repo,
            env=environment,
            capture_output=True,
            text=True,
        )

    @staticmethod
    def output_value(result: subprocess.CompletedProcess[str], label: str) -> str:
        prefix = f"{label}: "
        return next(
            line.removeprefix(prefix)
            for line in result.stdout.splitlines()
            if line.startswith(prefix)
        )

    @staticmethod
    def observable_tree(root: Path) -> tuple[tuple[str, str, bytes | str], ...]:
        observations: list[tuple[str, str, bytes | str]] = []
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                observations.append((relative, "symlink", os.readlink(path)))
            elif path.is_dir():
                observations.append((relative, "directory", ""))
            else:
                observations.append((relative, "file", path.read_bytes()))
        return tuple(observations)

    def install_matching_runtime(self) -> str:
        repo = self.repo.resolve()
        current = self.repo / ".runtime" / "current"
        if current.exists() or current.is_symlink():
            current.unlink()
        initial_plan = self.run("plan")
        if initial_plan.returncode != 0:
            raise AssertionError(initial_plan.stdout + initial_plan.stderr)
        snapshot_id = self.output_value(initial_plan, "Desired snapshot")
        snapshot = self.repo / ".runtime" / "snapshots" / snapshot_id
        skills = snapshot / "skills"
        skills.mkdir(parents=True)
        shutil.copytree(
            self.repo / "custom-skills" / "local-skill",
            skills / "local-skill",
            symlinks=True,
        )
        manual = skills / "manual-skill"
        shutil.copytree(
            self.repo / "vendors" / "example" / "manual-skill",
            manual,
            symlinks=True,
        )
        skill_file = manual / "SKILL.md"
        lines = skill_file.read_text().splitlines()
        lines.insert(lines.index("---", 1), "disable-model-invocation: true")
        skill_file.write_text("\n".join(lines) + "\n")
        agents = manual / "agents"
        if not agents.exists():
            agents.mkdir()
        openai_file = agents / "openai.yaml"
        if openai_file.exists():
            openai_lines = openai_file.read_text().splitlines()
            key_indexes = [
                index
                for index, line in enumerate(openai_lines)
                if line.lstrip().startswith("allow_implicit_invocation:")
            ]
            if key_indexes:
                openai_lines[key_indexes[0]] = "  allow_implicit_invocation: false"
            else:
                policy_indexes = [
                    index
                    for index, line in enumerate(openai_lines)
                    if line.startswith("policy:")
                ]
                if policy_indexes:
                    openai_lines.insert(
                        policy_indexes[0] + 1,
                        "  allow_implicit_invocation: false",
                    )
                else:
                    if openai_lines and openai_lines[-1]:
                        openai_lines.append("")
                    openai_lines.extend(
                        ["policy:", "  allow_implicit_invocation: false"]
                    )
            openai_file.write_text("\n".join(openai_lines).rstrip("\n") + "\n")
        else:
            openai_file.write_text("policy:\n  allow_implicit_invocation: false\n")
        (snapshot / ".snapshot-id").write_text(f"{snapshot_id}\n")
        current.symlink_to(Path("snapshots") / snapshot_id)

        entries = (
            (self.home / ".codex" / "AGENTS.md", repo / "global" / "AGENTS.md"),
            (
                self.home / ".claude" / "CLAUDE.md",
                repo / "global" / "AGENTS.md",
            ),
            (
                self.home / ".agents" / "skills",
                repo / ".runtime" / "current" / "skills",
            ),
            (
                self.home / ".claude" / "skills",
                repo / ".runtime" / "current" / "skills",
            ),
        )
        for entry, target in entries:
            entry.parent.mkdir(parents=True, exist_ok=True)
            entry.symlink_to(target)
        return snapshot_id


class AuthoritativeStateTests(unittest.TestCase):
    def test_instructions_define_separate_global_and_project_scopes(self) -> None:
        global_instructions = (ROOT / "global" / "AGENTS.md").read_text()
        project_instructions = (ROOT / "AGENTS.md").read_text()
        claude_project_entry = (ROOT / "CLAUDE.md").read_text()

        self.assertNotEqual(global_instructions, project_instructions)
        self.assertIn("跨仓库长期适用", global_instructions)
        self.assertNotIn("跨仓库长期适用", project_instructions)
        self.assertIn("本仓库维护个人 Agent 指令", project_instructions)
        self.assertEqual(claude_project_entry, "@AGENTS.md\n")

    def test_cross_repository_commit_defaults_are_global_only(self) -> None:
        global_instructions = (ROOT / "global" / "AGENTS.md").read_text()
        project_instructions = (ROOT / "AGENTS.md").read_text()

        self.assertIn("只有用户明确要求时才创建提交", global_instructions)
        self.assertNotIn("只有用户明确要求时才创建提交", project_instructions)
        self.assertNotIn("Co-Authored-By: Codex", global_instructions)
        self.assertIn(
            "优先遵循项目提交规范；项目未规定时",
            global_instructions,
        )
        self.assertNotIn("Co-Authored-By: Codex", project_instructions)

    def test_toml_preserves_the_current_skill_selection_and_invocation_intent(
        self,
    ) -> None:
        with (ROOT / "config" / "agent-control.toml").open("rb") as file:
            config = tomllib.load(file)

        skills = config["skills"]
        invocation_counts = {
            invocation: sum(skill["invocation"] == invocation for skill in skills)
            for invocation in ("implicit", "explicit")
        }

        self.assertEqual(len(skills), 48)
        self.assertEqual(invocation_counts, {"implicit": 21, "explicit": 27})
        self.assertNotIn("root", config)
        extended_selections = [
            skill for skill in skills if set(skill) != {"source", "invocation"}
        ]
        self.assertEqual(
            extended_selections,
            [
                {
                    "source": "vendors/agent-reach/agent_reach/skill",
                    "expected_name": "agent-reach",
                    "invocation": "explicit",
                }
            ],
        )

        obsidian_selections = [
            skill
            for skill in skills
            if skill["source"].startswith("vendors/obsidian-skills/")
        ]
        self.assertEqual(
            obsidian_selections,
            [
                {
                    "source": "vendors/obsidian-skills/skills/obsidian-markdown",
                    "invocation": "implicit",
                },
                {
                    "source": "vendors/obsidian-skills/skills/obsidian-cli",
                    "invocation": "explicit",
                },
            ],
        )

        sources = {skill["source"] for skill in skills}
        self.assertFalse(any(source.startswith("vendors/mattpocock-skills/") for source in sources))
        self.assertNotIn("vendors/mattpocock-skills", (ROOT / ".gitmodules").read_text())
        expected_engineering = {
            f"custom-skills/engineering/{name}"
            for name in (
                "commit",
                "project-init",
                "discovery",
                "spec",
                "task-breakdown",
                "implementation",
                "tdd",
                "debugging",
                "review",
                "simplify",
                "architecture",
                "research",
                "prototype",
                "conflicts",
                "triage",
                "handoff",
            )
        }
        self.assertEqual(
            {source for source in sources if source.startswith("custom-skills/engineering/")},
            expected_engineering,
        )

        removed_vendors = (
            "awesome-finance-skills",
            "eodhd-claude-skills",
            "financial-services",
            "obra-superpowers",
            "okx-agent-skills",
            "sports-skills",
            "surf-skills",
        )
        gitmodules = (ROOT / ".gitmodules").read_text()
        for vendor in removed_vendors:
            source_root = f"vendors/{vendor}"
            self.assertFalse(any(source.startswith(source_root) for source in sources))
            self.assertNotIn(source_root, gitmodules)

        self.assertEqual(
            hashlib.sha256(
                "".join(
                    f'{skill["source"]}\t{skill["invocation"]}\n'
                    for skill in skills
                ).encode()
            ).hexdigest(),
            "deb5d0e960b31dee43725001ad78ce5a1c1d6f4b2c1f1622ac71df2510669978",
        )

    def test_agent_reach_selection_uses_the_upstream_chinese_skill(self) -> None:
        with (ROOT / "config" / "agent-control.toml").open("rb") as file:
            config = tomllib.load(file)

        selection = next(
            skill
            for skill in config["skills"]
            if skill["source"].startswith("vendors/agent-reach/")
        )
        self.assertEqual(
            selection,
            {
                "source": "vendors/agent-reach/agent_reach/skill",
                "expected_name": "agent-reach",
                "invocation": "explicit",
            },
        )

        source = ROOT / selection["source"]
        chinese_skill = (source / "SKILL.md").read_text()
        english_skill = (source / "SKILL_en.md").read_text()
        self.assertIn("# Agent Reach", chinese_skill)
        self.assertIn("只读读取各平台内容", chinese_skill)
        self.assertIn("Read-only access to platform content", english_skill)
        self.assertNotEqual(chinese_skill, english_skill)

    def test_repository_has_only_the_python_control_path(self) -> None:
        removed_paths = (
            "scripts/manage.sh",
            "tests/manage_test.sh",
            "config/enabled-skills.tsv",
            "config/skill-governance.tsv",
            ".generated",
            "skills",
        )

        for relative in removed_paths:
            self.assertFalse((ROOT / relative).exists(), relative)
            self.assertFalse((ROOT / relative).is_symlink(), relative)

    def test_linux_ci_checks_a_fresh_clone_with_fixed_submodules(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "check.yml").read_text()

        self.assertIn("runs-on: ubuntu-latest", workflow)
        self.assertIn("submodules: recursive", workflow)
        self.assertIn("python-version: '3.11'", workflow)
        self.assertIn("run: make check", workflow)
        self.assertNotIn("macos-", workflow)
        self.assertNotIn("matrix:", workflow)

    def test_make_check_is_hermetic_and_excludes_machine_doctor(self) -> None:
        result = subprocess.run(
            ["make", "--no-print-directory", "-n", "check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("unittest discover -s tests", result.stdout)
        self.assertIn(
            "unittest discover -s custom-skills/anki-card-maker/tests",
            result.stdout,
        )
        self.assertIn("agent_control", result.stdout)
        self.assertIn("validate", result.stdout)
        self.assertIn("git diff --check", result.stdout)
        self.assertNotIn("doctor", result.stdout)
        self.assertNotIn("./scripts/manage.sh", result.stdout)
        self.assertNotIn("HOME", result.stdout)

    def test_make_check_ignores_personal_git_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            repo = root / "repo"
            home = root / "home"
            repo.mkdir()
            attributes = home / ".config" / "git" / "attributes"
            attributes.parent.mkdir(parents=True)
            attributes.write_text("*.txt whitespace=-blank-at-eol\n")
            (home / ".gitconfig").write_text("[codex]\n\tprobe = personal\n")
            git_environment = {
                **os.environ,
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_SYSTEM": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_ATTR_NOSYSTEM": "1",
                "HOME": os.devnull,
                "XDG_CONFIG_HOME": os.devnull,
            }
            subprocess.run(
                ["git", "init", "-q", str(repo)],
                check=True,
                env=git_environment,
            )
            tracked = repo / "tracked.txt"
            tracked.write_text("clean\n")
            subprocess.run(
                ["git", "-C", str(repo), "add", "tracked.txt"],
                check=True,
                env=git_environment,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "-c",
                    "user.name=Tests",
                    "-c",
                    "user.email=tests@example.test",
                    "commit",
                    "-qm",
                    "fixture",
                ],
                check=True,
                env=git_environment,
            )
            makefile = root / "Makefile"
            makefile.write_text(
                f"include {ROOT / 'Makefile'}\n"
                "\n"
                "test:\n"
                "\t@test \"$$HOME\" = /dev/null\n"
                "\t@test \"$$XDG_CONFIG_HOME\" = /dev/null\n"
                "\t@test \"$$GIT_CONFIG_GLOBAL\" = /dev/null\n"
                "\t@test \"$$GIT_CONFIG_SYSTEM\" = /dev/null\n"
                "\t@test \"$$GIT_CONFIG_NOSYSTEM\" = 1\n"
                "\t@test \"$$GIT_CONFIG_COUNT\" = 0\n"
                "\t@test \"$$GIT_ATTR_NOSYSTEM\" = 1\n"
                "\t@test \"$$GIT_OPTIONAL_LOCKS\" = 0\n"
                "\t@test -z \"$$(git config --global --get codex.probe || true)\"\n"
                "\n"
                "validate:\n"
                "\t@:\n"
                "check-pi:\n"
                "\t@:\n"
            )

            clean_result = subprocess.run(
                ["make", "--no-print-directory", "-s", "-f", str(makefile), "check"],
                cwd=repo,
                env={**os.environ, "HOME": str(home)},
                capture_output=True,
                text=True,
            )
            tracked.write_text("trailing whitespace  \n")
            whitespace_result = subprocess.run(
                ["make", "--no-print-directory", "-s", "-f", str(makefile), "check"],
                cwd=repo,
                env={**os.environ, "HOME": str(home)},
                capture_output=True,
                text=True,
            )

        self.assertEqual(
            clean_result.returncode,
            0,
            clean_result.stdout + clean_result.stderr,
        )
        self.assertEqual(whitespace_result.returncode, 2)
        self.assertIn("trailing whitespace", whitespace_result.stdout)


class PublicCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = ControlPlaneFixture()

    def tearDown(self) -> None:
        self.fixture.cleanup()

    def assert_hard_finding(
        self, result: subprocess.CompletedProcess[str], code: str
    ) -> None:
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"ERROR {code}", result.stdout)

    def test_make_runtime_targets_proxy_the_public_cli(self) -> None:
        current = self.fixture.repo / ".runtime" / "current"
        current.unlink()

        help_result = self.fixture.run_make()
        validate = self.fixture.run_make("validate")
        listing = self.fixture.run_make("list-skills")
        audit = self.fixture.run_make("audit-skills")
        plan = self.fixture.run_make("plan")
        fingerprint = self.fixture.output_value(plan, "Plan fingerprint")
        apply = self.fixture.run_make("apply", f"PLAN={fingerprint}")
        doctor = self.fixture.run_make("doctor")

        for result in (help_result, validate, listing, audit, plan, apply, doctor):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Usage: make <target>", help_result.stdout)
        self.assertIn("Validation succeeded: 2 skills", validate.stdout)
        self.assertIn("local-skill\tcustom-skills/local-skill\timplicit", listing.stdout)
        self.assertIn("Invocation policies: implicit=1, explicit=1", audit.stdout)
        self.assertIn("Plan result: changes", plan.stdout)
        self.assertIn("Apply result: changes", apply.stdout)
        self.assertIn("Machine doctor succeeded.", doctor.stdout)

    def test_make_vendor_targets_proxy_the_public_cli(self) -> None:
        current, target = self.fixture.create_vendor_target()

        plan = self.fixture.run_make(
            "vendor-plan",
            "VENDOR=example",
            f"TARGET={target}",
        )
        fingerprint = self.fixture.output_value(plan, "Vendor plan fingerprint")
        apply = self.fixture.run_make(
            "vendor-apply",
            "VENDOR=example",
            f"TARGET={target}",
            f"PLAN={fingerprint}",
        )

        for result in (plan, apply):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"Current commit: {current}", plan.stdout)
        self.assertIn(f"Target commit: {target}", plan.stdout)
        self.assertIn("Vendor apply result: changes", apply.stdout)

    def test_make_rejects_missing_write_arguments_without_side_effects(self) -> None:
        runtime_before = self.fixture.observable_tree(
            self.fixture.repo / ".runtime"
        )
        home_before = self.fixture.observable_tree(self.fixture.home)
        vendor_before = subprocess.run(
            [
                "git",
                "-C",
                str(self.fixture.repo / "vendors" / "example"),
                "rev-parse",
                "HEAD",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

        cases = (
            (("apply",), "PLAN is required"),
            (("vendor-plan",), "VENDOR is required"),
            (("vendor-plan", "VENDOR=example"), "TARGET is required"),
            (("vendor-apply",), "VENDOR is required"),
            (("vendor-apply", "VENDOR=example"), "TARGET is required"),
            (
                (
                    "vendor-apply",
                    "VENDOR=example",
                    f"TARGET={'0' * 40}",
                ),
                "PLAN is required",
            ),
        )
        for arguments, message in cases:
            with self.subTest(arguments=arguments):
                result = self.fixture.run_make(*arguments)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn(message, result.stderr)

        vendor_after = subprocess.run(
            [
                "git",
                "-C",
                str(self.fixture.repo / "vendors" / "example"),
                "rev-parse",
                "HEAD",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(
            self.fixture.observable_tree(self.fixture.repo / ".runtime"),
            runtime_before,
        )
        self.assertEqual(self.fixture.observable_tree(self.fixture.home), home_before)
        self.assertEqual(vendor_after, vendor_before)

    def test_validate_builds_a_hermetic_candidate_without_touching_runtime(
        self,
    ) -> None:
        skill = self.fixture.repo / "custom-skills" / "local-skill"
        (skill / "scripts").mkdir()
        executable = skill / "scripts" / "run.sh"
        executable.write_text("#!/bin/sh\nprintf 'ok\\n'\n")
        executable.chmod(0o755)
        (skill / "references").mkdir()
        (skill / "references" / "guide.md").write_text("guide\n")
        (skill / "guide-link").symlink_to("references/guide.md")

        result = self.fixture.run("validate")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "Validation succeeded: 2 skills (1 implicit, 1 explicit).", result.stdout
        )
        self.assertIn("Candidate snapshot verified: 2 skills.", result.stdout)
        self.assertEqual(
            (self.fixture.repo / ".runtime" / "current").read_text(), "active-state\n"
        )
        self.assertEqual((self.fixture.home / "sentinel").read_text(), "home-state\n")
        self.assertEqual(
            list(self.fixture.home.iterdir()), [self.fixture.home / "sentinel"]
        )

    def test_plan_reports_a_read_only_initial_install(self) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        runtime_before = sorted(self.fixture.repo.joinpath(".runtime").rglob("*"))
        home_before = sorted(self.fixture.home.rglob("*"))

        result = self.fixture.run("plan")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Snapshot action: add", result.stdout)
        self.assertIn("Entry codex-instructions: add", result.stdout)
        self.assertIn("Entry claude-instructions: add", result.stdout)
        self.assertIn("Entry agents-skills: add", result.stdout)
        self.assertIn("Entry claude-skills: add", result.stdout)
        self.assertRegex(result.stdout, r"Desired snapshot: [0-9a-f]{64}")
        self.assertRegex(result.stdout, r"Plan fingerprint: [0-9a-f]{64}")
        self.assertEqual(
            sorted(self.fixture.repo.joinpath(".runtime").rglob("*")),
            runtime_before,
        )
        self.assertEqual(sorted(self.fixture.home.rglob("*")), home_before)

    def test_doctor_reports_a_healthy_machine_without_changing_it(self) -> None:
        self.fixture.install_matching_runtime()
        runtime_before = self.fixture.observable_tree(
            self.fixture.repo / ".runtime"
        )
        home_before = self.fixture.observable_tree(self.fixture.home)

        result = self.fixture.run("doctor")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Machine doctor succeeded.", result.stdout)
        self.assertEqual(
            self.fixture.observable_tree(self.fixture.repo / ".runtime"),
            runtime_before,
        )
        self.assertEqual(self.fixture.observable_tree(self.fixture.home), home_before)

    def test_doctor_stops_after_repository_validation_failure(self) -> None:
        (self.fixture.repo / "config" / "agent-control.toml").write_text(
            "invalid = [\n"
        )

        result = self.fixture.run("doctor")

        self.assert_hard_finding(result, "CONFIG_INVALID_TOML")
        self.assertNotIn("MACHINE_", result.stdout)
        self.assertNotIn("RUNTIME_CURRENT_", result.stdout)

    def test_doctor_reports_missing_and_unmanaged_runtime_state(self) -> None:
        current = self.fixture.repo / ".runtime" / "current"
        current.unlink()

        missing = self.fixture.run("doctor")

        self.assert_hard_finding(missing, "MACHINE_SNAPSHOT_DRIFT")
        self.assertIn("ERROR MACHINE_ENTRY_DRIFT", missing.stdout)

        outside = Path(self.fixture.temporary_directory.name) / "outside-snapshot"
        outside.mkdir()
        current.symlink_to(outside, target_is_directory=True)
        unmanaged = self.fixture.run("doctor")

        self.assert_hard_finding(unmanaged, "RUNTIME_CURRENT_UNMANAGED")

    def test_agent_reach_drift_requires_a_separate_plan_and_apply(self) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        self.fixture.create_skill(
            self.fixture.repo / "custom-skills" / "agent-reach",
            "agent-reach",
        )
        self.fixture.write_config(
            implicit_budget=2,
            group_limit=2,
            group_skills=("agent-reach", "local-skill", "manual-skill"),
            skills=(
                ("custom-skills/agent-reach", "implicit"),
                ("custom-skills/local-skill", "implicit"),
                ("vendors/example/manual-skill", "explicit"),
            ),
        )
        initial_plan = self.fixture.run("plan")
        initial_apply = self.fixture.run(
            "apply",
            self.fixture.output_value(initial_plan, "Plan fingerprint"),
        )
        current = self.fixture.repo / ".runtime" / "current"
        active_agent_reach = current.resolve(strict=True) / "skills" / "agent-reach"
        self.assertTrue(active_agent_reach.is_dir())
        (active_agent_reach / "unplanned.txt").write_text("runtime drift\n")
        runtime_before = self.fixture.observable_tree(
            self.fixture.repo / ".runtime"
        )

        diagnosis = self.fixture.run("doctor")

        for result in (initial_plan, initial_apply):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_hard_finding(diagnosis, "MACHINE_SNAPSHOT_DRIFT")
        self.assertEqual(
            self.fixture.observable_tree(self.fixture.repo / ".runtime"),
            runtime_before,
        )

        repair_plan = self.fixture.run("plan")
        repair_apply = self.fixture.run(
            "apply",
            self.fixture.output_value(repair_plan, "Plan fingerprint"),
        )
        healthy = self.fixture.run("doctor")

        for result in (repair_plan, repair_apply, healthy):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(
            (current.resolve(strict=True) / "skills" / "agent-reach" / "unplanned.txt").exists()
        )

    def test_vendor_plan_reviews_one_exact_target_without_switching_checkout(
        self,
    ) -> None:
        current, target = self.fixture.create_vendor_target()
        runtime_before = self.fixture.observable_tree(
            self.fixture.repo / ".runtime"
        )
        home_before = self.fixture.observable_tree(self.fixture.home)
        parent_status_before = subprocess.run(
            ["git", "-C", str(self.fixture.repo), "status", "--porcelain=v1"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout

        result = self.fixture.run("vendor", "plan", "example", target)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"Current commit: {current}", result.stdout)
        self.assertIn(f"Target commit: {target}", result.stdout)
        self.assertIn(
            "M vendors/example/manual-skill/SKILL.md [metadata, runtime]",
            result.stdout,
        )
        self.assertIn(
            "A vendors/example/manual-skill/scripts/update.py [runtime, script]",
            result.stdout,
        )
        self.assertRegex(result.stdout, r"Vendor plan fingerprint: [0-9a-f]{64}")
        checkout = subprocess.run(
            [
                "git",
                "-C",
                str(self.fixture.repo / "vendors" / "example"),
                "rev-parse",
                "HEAD",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(checkout, current)
        self.assertEqual(
            self.fixture.observable_tree(self.fixture.repo / ".runtime"),
            runtime_before,
        )
        self.assertEqual(self.fixture.observable_tree(self.fixture.home), home_before)
        self.assertEqual(
            subprocess.run(
                ["git", "-C", str(self.fixture.repo), "status", "--porcelain=v1"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout,
            parent_status_before,
        )

    def test_vendor_apply_switches_only_the_reviewed_checkout(self) -> None:
        self.fixture.install_matching_runtime()
        current, target = self.fixture.create_vendor_target()
        runtime_before = self.fixture.observable_tree(
            self.fixture.repo / ".runtime"
        )
        home_before = self.fixture.observable_tree(self.fixture.home)
        plan = self.fixture.run("vendor", "plan", "example", target)
        fingerprint = self.fixture.output_value(plan, "Vendor plan fingerprint")

        result = self.fixture.run(
            "vendor",
            "apply",
            "example",
            target,
            fingerprint,
        )

        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Vendor apply result: changes", result.stdout)
        vendor = self.fixture.repo / "vendors" / "example"
        checkout = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(checkout, target)
        self.assertNotEqual(checkout, current)
        self.assertEqual(
            subprocess.run(
                ["git", "-C", str(self.fixture.repo), "diff", "--cached", "--name-only"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout,
            "",
        )
        self.assertEqual(
            self.fixture.observable_tree(self.fixture.repo / ".runtime"),
            runtime_before,
        )
        self.assertEqual(self.fixture.observable_tree(self.fixture.home), home_before)

        diagnosis = self.fixture.run("doctor")
        self.assert_hard_finding(diagnosis, "MACHINE_SNAPSHOT_DRIFT")

    def test_vendor_apply_rejects_a_stale_review_before_checkout(self) -> None:
        current, target = self.fixture.create_vendor_target()
        plan = self.fixture.run("vendor", "plan", "example", target)
        config = self.fixture.repo / "config" / "agent-control.toml"
        config.write_text(config.read_text() + "\n")
        runtime_before = self.fixture.observable_tree(
            self.fixture.repo / ".runtime"
        )
        home_before = self.fixture.observable_tree(self.fixture.home)

        result = self.fixture.run(
            "vendor",
            "apply",
            "example",
            target,
            self.fixture.output_value(plan, "Vendor plan fingerprint"),
        )

        self.assert_hard_finding(result, "VENDOR_PLAN_STALE")
        checkout = subprocess.run(
            [
                "git",
                "-C",
                str(self.fixture.repo / "vendors" / "example"),
                "rev-parse",
                "HEAD",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(checkout, current)
        self.assertEqual(
            self.fixture.observable_tree(self.fixture.repo / ".runtime"),
            runtime_before,
        )
        self.assertEqual(self.fixture.observable_tree(self.fixture.home), home_before)

    def test_vendor_apply_restores_checkout_after_validation_failure(self) -> None:
        current, target = self.fixture.create_vendor_target()
        plan = self.fixture.run("vendor", "plan", "example", target)
        fingerprint = self.fixture.output_value(plan, "Vendor plan fingerprint")

        from agent_control import vendor as vendor_module
        from agent_control.__main__ import main
        from agent_control.models import Finding

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                vendor_module,
                "_validate_active_repository",
                return_value=(
                    Finding(
                        "error",
                        "INJECTED_VENDOR_VALIDATION_FAILURE",
                        "Injected repository validation failure.",
                    ),
                ),
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "vendor",
                    "apply",
                    "example",
                    target,
                    fingerprint,
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn(
            "ERROR INJECTED_VENDOR_VALIDATION_FAILURE",
            output.getvalue(),
        )
        vendor = self.fixture.repo / "vendors" / "example"
        checkout = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(checkout, current)

        retried = self.fixture.run(
            "vendor",
            "apply",
            "example",
            target,
            fingerprint,
        )
        self.assertEqual(retried.returncode, 0, retried.stdout + retried.stderr)

    def test_vendor_apply_failure_restores_the_original_branch_checkout(self) -> None:
        current, target = self.fixture.create_vendor_target()
        vendor = self.fixture.repo / "vendors" / "example"
        subprocess.run(
            ["git", "-C", str(vendor), "branch", "original", current],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(vendor), "checkout", "-q", "original"],
            check=True,
        )
        plan = self.fixture.run("vendor", "plan", "example", target)

        from agent_control import vendor as vendor_module
        from agent_control.__main__ import main
        from agent_control.models import Finding

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                vendor_module,
                "_validate_active_repository",
                return_value=(
                    Finding(
                        "error",
                        "INJECTED_BRANCH_VALIDATION_FAILURE",
                        "Injected repository validation failure.",
                    ),
                ),
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "vendor",
                    "apply",
                    "example",
                    target,
                    self.fixture.output_value(plan, "Vendor plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        branch = subprocess.run(
            ["git", "-C", str(vendor), "symbolic-ref", "--short", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        checkout = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(branch, "original")
        self.assertEqual(checkout, current)

    def test_vendor_validation_exception_restores_the_original_checkout(self) -> None:
        current, target = self.fixture.create_vendor_target()
        vendor = self.fixture.repo / "vendors" / "example"
        subprocess.run(
            ["git", "-C", str(vendor), "branch", "original", current],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(vendor), "checkout", "-q", "original"],
            check=True,
        )
        plan = self.fixture.run("vendor", "plan", "example", target)

        from agent_control import vendor as vendor_module
        from agent_control.__main__ import main

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                vendor_module,
                "_validate_active_repository",
                side_effect=OSError("injected vendor validation exception"),
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "vendor",
                    "apply",
                    "example",
                    target,
                    self.fixture.output_value(plan, "Vendor plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR VENDOR_VALIDATION_FAILED", output.getvalue())
        branch = subprocess.run(
            ["git", "-C", str(vendor), "symbolic-ref", "--short", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        checkout = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(branch, "original")
        self.assertEqual(checkout, current)

    def test_vendor_commands_reject_unknown_dirty_and_inexact_inputs(self) -> None:
        unknown = self.fixture.run("vendor", "plan", "missing", "main")
        self.assert_hard_finding(unknown, "VENDOR_UNKNOWN")

        current, target = self.fixture.create_vendor_target()
        vendor = self.fixture.repo / "vendors" / "example"
        (vendor / "uncommitted.txt").write_text("dirty\n")
        dirty = self.fixture.run("vendor", "plan", "example", target)
        self.assert_hard_finding(dirty, "VENDOR_DIRTY")
        checkout = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(checkout, current)

        inexact = self.fixture.run(
            "vendor",
            "apply",
            "example",
            "main",
            "0" * 64,
        )
        self.assertEqual(inexact.returncode, 2, inexact.stdout + inexact.stderr)

    def test_vendor_plan_rejects_a_target_ref_that_git_could_parse_as_an_option(
        self,
    ) -> None:
        result = self.fixture.run(
            "vendor",
            "plan",
            "example",
            "--",
            "--upload-pack=/bin/false",
        )

        self.assert_hard_finding(result, "VENDOR_TARGET_INVALID")

    def test_vendor_plan_rejects_a_declared_checkout_that_escapes_via_symlink(
        self,
    ) -> None:
        vendor = self.fixture.repo / "vendors" / "example"
        outside = Path(self.fixture.temporary_directory.name) / "outside-vendor"
        vendor.rename(outside)
        vendor.symlink_to(outside, target_is_directory=True)

        result = self.fixture.run("vendor", "plan", "example", "HEAD")

        self.assert_hard_finding(result, "VENDOR_INVALID")

    def test_vendor_plan_ignores_fixed_temporary_artifacts(self) -> None:
        _current, target = self.fixture.create_vendor_target()
        vendor = self.fixture.repo / "vendors" / "example"
        (vendor / ".DS_Store").write_text("finder metadata\n")
        cache = vendor / "manual-skill" / "__pycache__"
        cache.mkdir()
        (cache / "module.cpython-311.pyc").write_bytes(b"cache")

        result = self.fixture.run("vendor", "plan", "example", target)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_vendor_plan_fetches_an_explicit_remote_ref_without_checkout(self) -> None:
        vendor = self.fixture.repo / "vendors" / "example"
        current = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        remote = Path(self.fixture.temporary_directory.name) / "vendor-remote.git"
        producer = Path(self.fixture.temporary_directory.name) / "vendor-producer"
        subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
        subprocess.run(
            ["git", "-C", str(vendor), "remote", "add", "origin", str(remote)],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(vendor), "push", "-q", "origin", "HEAD:main"],
            check=True,
        )
        subprocess.run(
            ["git", "clone", "-q", "--branch", "main", str(remote), str(producer)],
            check=True,
        )
        skill_file = producer / "manual-skill" / "SKILL.md"
        skill_file.write_text(skill_file.read_text() + "\nRemote reviewed change.\n")
        subprocess.run(["git", "-C", str(producer), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(producer),
                "-c",
                "user.name=Tests",
                "-c",
                "user.email=tests@example.test",
                "commit",
                "-qm",
                "remote target",
            ],
            check=True,
        )
        target = subprocess.run(
            ["git", "-C", str(producer), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ["git", "-C", str(producer), "push", "-q", "origin", "HEAD:review"],
            check=True,
        )

        result = self.fixture.run(
            "vendor",
            "plan",
            "example",
            "refs/heads/review",
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"Target commit: {target}", result.stdout)
        checkout = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(checkout, current)

    def test_vendor_plan_validates_the_target_with_the_current_configuration(
        self,
    ) -> None:
        vendor = self.fixture.repo / "vendors" / "example"
        current = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.fixture.create_skill(vendor / "new-skill", "new-skill")
        subprocess.run(["git", "-C", str(vendor), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(vendor),
                "-c",
                "user.name=Tests",
                "-c",
                "user.email=tests@example.test",
                "commit",
                "-qm",
                "add selected skill",
            ],
            check=True,
        )
        target = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ["git", "-C", str(vendor), "checkout", "-q", "--detach", current],
            check=True,
        )
        self.fixture.write_config(
            group_skills=("local-skill", "new-skill"),
            skills=(
                ("custom-skills/local-skill", "implicit"),
                ("vendors/example/new-skill", "explicit"),
            ),
        )
        self.assert_hard_finding(self.fixture.run("validate"), "SKILL_NOT_FOUND")

        plan = self.fixture.run("vendor", "plan", "example", target)

        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assertIn(
            "A vendors/example/new-skill/SKILL.md [metadata, runtime]",
            plan.stdout,
        )
        applied = self.fixture.run(
            "vendor",
            "apply",
            "example",
            target,
            self.fixture.output_value(plan, "Vendor plan fingerprint"),
        )
        self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)

    def test_vendor_plan_preserves_checkout_when_target_validation_fails(
        self,
    ) -> None:
        current, target = self.fixture.create_vendor_target()
        vendor = self.fixture.repo / "vendors" / "example"
        subprocess.run(
            ["git", "-C", str(vendor), "checkout", "-q", "--detach", target],
            check=True,
        )
        skill_file = vendor / "manual-skill" / "SKILL.md"
        skill_file.write_text(skill_file.read_text().replace(
            "name: manual-skill",
            "name: wrong-name",
            1,
        ))
        subprocess.run(["git", "-C", str(vendor), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(vendor),
                "-c",
                "user.name=Tests",
                "-c",
                "user.email=tests@example.test",
                "commit",
                "-qm",
                "invalid target",
            ],
            check=True,
        )
        invalid_target = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ["git", "-C", str(vendor), "checkout", "-q", "--detach", current],
            check=True,
        )

        result = self.fixture.run("vendor", "plan", "example", invalid_target)

        self.assert_hard_finding(result, "SKILL_NAME_MISMATCH")
        checkout = subprocess.run(
            ["git", "-C", str(vendor), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertEqual(checkout, current)

    def test_vendor_apply_shares_the_control_plane_write_lock(self) -> None:
        _current, target = self.fixture.create_vendor_target()
        plan = self.fixture.run("vendor", "plan", "example", target)
        fingerprint = self.fixture.output_value(plan, "Vendor plan fingerprint")
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import fcntl, os, sys\n"
                    "descriptor = os.open(sys.argv[1], os.O_RDONLY)\n"
                    "fcntl.flock(descriptor, fcntl.LOCK_EX)\n"
                    "print('locked', flush=True)\n"
                    "sys.stdin.read()\n"
                ),
                str(self.fixture.repo),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert holder.stdout is not None
            self.assertEqual(holder.stdout.readline().strip(), "locked")
            blocked = self.fixture.run(
                "vendor",
                "apply",
                "example",
                target,
                fingerprint,
            )
            self.assert_hard_finding(blocked, "RUNTIME_CHANGE_LOCKED")
        finally:
            if holder.stdin is not None:
                holder.stdin.close()
            try:
                holder.wait(timeout=5)
            finally:
                if holder.stdout is not None:
                    holder.stdout.close()
                if holder.stderr is not None:
                    holder.stderr.close()

        applied = self.fixture.run(
            "vendor",
            "apply",
            "example",
            target,
            fingerprint,
        )
        self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)

    def test_apply_activates_an_isolated_snapshot_and_installs_entries(self) -> None:
        current = self.fixture.repo / ".runtime" / "current"
        current.unlink()
        plan = self.fixture.run("plan")
        fingerprint = self.fixture.output_value(plan, "Plan fingerprint")
        source_skill = (
            self.fixture.repo / "custom-skills" / "local-skill" / "SKILL.md"
        )
        source_content = source_skill.read_text()

        result = self.fixture.run("apply", fingerprint)

        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(current.is_symlink())
        active = current.resolve(strict=True)
        self.assertEqual(
            active.parent,
            (self.fixture.repo / ".runtime" / "snapshots").resolve(),
        )
        self.assertEqual(
            (active / ".snapshot-id").read_text().strip(),
            self.fixture.output_value(plan, "Desired snapshot"),
        )
        active_skill = active / "skills" / "local-skill" / "SKILL.md"
        self.assertFalse((active / "skills").is_symlink())
        self.assertFalse((active / "skills" / "local-skill").is_symlink())
        self.assertEqual(active_skill.read_text(), source_content)

        source_skill.write_text(source_content + "\nSource changed after apply.\n")
        self.assertEqual(active_skill.read_text(), source_content)

        expected_entries = (
            (
                self.fixture.home / ".codex" / "AGENTS.md",
                self.fixture.repo / "global" / "AGENTS.md",
            ),
            (
                self.fixture.home / ".claude" / "CLAUDE.md",
                self.fixture.repo / "global" / "AGENTS.md",
            ),
            (self.fixture.home / ".agents" / "skills", active / "skills"),
            (self.fixture.home / ".claude" / "skills", active / "skills"),
        )
        for entry, expected_target in expected_entries:
            self.assertTrue(entry.is_symlink())
            self.assertEqual(entry.resolve(strict=True), expected_target.resolve())
        self.assertIn("Apply result: changes", result.stdout)
        self.assertIn("new or reloaded Agent sessions", result.stdout)

    def test_apply_rejects_a_stale_plan_before_runtime_writes(self) -> None:
        shutil.rmtree(self.fixture.repo / ".runtime")
        plan = self.fixture.run("plan")
        fingerprint = self.fixture.output_value(plan, "Plan fingerprint")
        skill_file = self.fixture.repo / "custom-skills" / "local-skill" / "SKILL.md"
        skill_file.write_text(skill_file.read_text() + "\nChanged after review.\n")
        home_before = sorted(self.fixture.home.rglob("*"))

        result = self.fixture.run("apply", fingerprint)

        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assert_hard_finding(result, "RUNTIME_PLAN_STALE")
        self.assertFalse((self.fixture.repo / ".runtime").exists())
        self.assertEqual(sorted(self.fixture.home.rglob("*")), home_before)
        self.assertEqual((self.fixture.home / "sentinel").read_text(), "home-state\n")

    def test_apply_removes_candidate_state_if_plan_turns_stale_during_build(
        self,
    ) -> None:
        runtime_root = self.fixture.repo / ".runtime"
        shutil.rmtree(runtime_root)
        read_only = (
            self.fixture.repo / "custom-skills" / "local-skill" / "read-only"
        )
        read_only.mkdir()
        (read_only / "resource.txt").write_text("managed content\n")
        read_only.chmod(0o555)
        self.addCleanup(
            lambda: read_only.chmod(0o755) if read_only.exists() else None
        )
        plan = self.fixture.run("plan")
        fingerprint = self.fixture.output_value(plan, "Plan fingerprint")
        authority = self.fixture.repo / "global" / "AGENTS.md"
        home_before = sorted(self.fixture.home.rglob("*"))

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main

        original_builder = runtime_module.build_candidate_snapshot

        def build_then_change_authority(*args: Any, **kwargs: Any) -> Any:
            result = original_builder(*args, **kwargs)
            authority.write_text(authority.read_text() + "changed during apply\n")
            return result

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "build_candidate_snapshot",
                side_effect=build_then_change_authority,
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    fingerprint,
                ]
            )

        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR RUNTIME_PLAN_STALE", output.getvalue())
        self.assertFalse(runtime_root.exists())
        self.assertEqual(sorted(self.fixture.home.rglob("*")), home_before)

    def test_apply_preserves_active_state_when_candidate_validation_fails(
        self,
    ) -> None:
        self.fixture.install_matching_runtime()
        current = self.fixture.repo / ".runtime" / "current"
        old_active = current.resolve(strict=True)
        active_skill = old_active / "skills" / "local-skill" / "SKILL.md"
        active_skill.write_text(active_skill.read_text() + "\nRuntime drift.\n")
        entries = (
            self.fixture.home / ".codex" / "AGENTS.md",
            self.fixture.home / ".claude" / "CLAUDE.md",
            self.fixture.home / ".agents" / "skills",
            self.fixture.home / ".claude" / "skills",
        )
        entry_targets = tuple(os.readlink(entry) for entry in entries)
        plan = self.fixture.run("plan")

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main
        from agent_control.models import Finding

        original_builder = runtime_module.build_candidate_snapshot

        def build_then_reject(*args: Any, **kwargs: Any) -> Any:
            count, findings = original_builder(*args, **kwargs)
            return count, [
                *findings,
                Finding(
                    "error",
                    "INJECTED_CANDIDATE_FAILURE",
                    "Injected candidate validation failure.",
                ),
            ]

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "build_candidate_snapshot",
                side_effect=build_then_reject,
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    self.fixture.output_value(plan, "Plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR INJECTED_CANDIDATE_FAILURE", output.getvalue())
        self.assertEqual(current.resolve(strict=True), old_active)
        self.assertEqual(
            tuple(os.readlink(entry) for entry in entries),
            entry_targets,
        )
        runtime_paths = list((self.fixture.repo / ".runtime").rglob("*"))
        self.assertFalse(
            any(path.name.startswith(".candidate-") for path in runtime_paths)
        )

    def test_candidate_cleanup_error_preserves_the_original_hard_finding(
        self,
    ) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        plan = self.fixture.run("plan")

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main
        from agent_control.models import Finding

        original_builder = runtime_module.build_candidate_snapshot
        original_remove = runtime_module._remove_managed_tree

        def build_then_reject(*args: Any, **kwargs: Any) -> Any:
            count, findings = original_builder(*args, **kwargs)
            return count, [
                *findings,
                Finding(
                    "error",
                    "INJECTED_CANDIDATE_FAILURE",
                    "Injected candidate validation failure.",
                ),
            ]

        def fail_managed_candidate_cleanup(root: Path) -> None:
            if root.name.startswith(".candidate-"):
                raise OSError("injected managed cleanup failure")
            original_remove(root)

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "build_candidate_snapshot",
                side_effect=build_then_reject,
            ),
            patch.object(
                runtime_module,
                "_remove_managed_tree",
                side_effect=fail_managed_candidate_cleanup,
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    self.fixture.output_value(plan, "Plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR INJECTED_CANDIDATE_FAILURE", output.getvalue())
        self.assertFalse(
            any(
                path.name.startswith(".candidate-")
                for path in (self.fixture.repo / ".runtime").rglob("*")
            )
        )

    def test_apply_lock_conflicts_immediately_and_releases_on_process_exit(
        self,
    ) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        plan = self.fixture.run("plan")
        fingerprint = self.fixture.output_value(plan, "Plan fingerprint")
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import fcntl, os, sys\n"
                    "descriptor = os.open(sys.argv[1], os.O_RDONLY)\n"
                    "fcntl.flock(descriptor, fcntl.LOCK_EX)\n"
                    "print('locked', flush=True)\n"
                    "sys.stdin.read()\n"
                ),
                str(self.fixture.repo),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert holder.stdout is not None
            self.assertEqual(holder.stdout.readline().strip(), "locked")

            blocked = self.fixture.run("apply", fingerprint)

            self.assert_hard_finding(blocked, "RUNTIME_CHANGE_LOCKED")
            self.assertIsNone(holder.poll())
        finally:
            if holder.stdin is not None:
                holder.stdin.close()
            try:
                holder.wait(timeout=5)
            finally:
                if holder.stdout is not None:
                    holder.stdout.close()
                if holder.stderr is not None:
                    holder.stderr.close()

        applied = self.fixture.run("apply", fingerprint)

        self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)
        self.assertTrue((self.fixture.repo / ".runtime" / "current").is_symlink())

    def test_apply_blocks_a_symlinked_home_root(self) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        linked_home = Path(self.fixture.temporary_directory.name) / "linked-home"
        linked_home.symlink_to(self.fixture.home, target_is_directory=True)
        environment = {"HOME": str(linked_home)}
        home_before = sorted(self.fixture.home.rglob("*"))
        runtime_before = sorted(self.fixture.repo.joinpath(".runtime").rglob("*"))
        plan = self.fixture.run("plan", environment_overrides=environment)
        fingerprint = self.fixture.output_value(plan, "Plan fingerprint")

        result = self.fixture.run(
            "apply",
            fingerprint,
            environment_overrides=environment,
        )

        self.assert_hard_finding(plan, "RUNTIME_HOME_UNMANAGED")
        self.assert_hard_finding(result, "RUNTIME_HOME_UNMANAGED")
        self.assertEqual(sorted(self.fixture.home.rglob("*")), home_before)
        self.assertEqual(
            sorted(self.fixture.repo.joinpath(".runtime").rglob("*")),
            runtime_before,
        )

    def test_apply_migrates_only_reviewed_legacy_entries(self) -> None:
        self.fixture.install_matching_runtime()
        repo = self.fixture.repo.resolve()
        current = self.fixture.repo / ".runtime" / "current"
        current_target = os.readlink(current)
        snapshots = self.fixture.repo / ".runtime" / "snapshots"
        snapshots_before = sorted(path.name for path in snapshots.iterdir())
        entries = (
            (
                self.fixture.home / ".codex" / "AGENTS.md",
                repo / "AGENTS.md",
                repo / "global" / "AGENTS.md",
            ),
            (
                self.fixture.home / ".claude" / "CLAUDE.md",
                repo / "AGENTS.md",
                repo / "global" / "AGENTS.md",
            ),
            (
                self.fixture.home / ".agents" / "skills",
                repo / "skills",
                current / "skills",
            ),
            (
                self.fixture.home / ".claude" / "skills",
                repo / "skills",
                current / "skills",
            ),
        )
        for entry, legacy_target, _expected_target in entries:
            entry.unlink()
            entry.symlink_to(legacy_target)
        plan = self.fixture.run("plan")

        result = self.fixture.run(
            "apply", self.fixture.output_value(plan, "Plan fingerprint")
        )

        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for entry, _legacy_target, expected_target in entries:
            self.assertTrue(entry.is_symlink())
            self.assertEqual(entry.resolve(strict=True), expected_target.resolve())
        self.assertEqual(os.readlink(current), current_target)
        self.assertEqual(
            sorted(path.name for path in snapshots.iterdir()), snapshots_before
        )

    def test_apply_restores_entries_when_a_later_entry_change_fails(self) -> None:
        self.fixture.install_matching_runtime()
        repo = self.fixture.repo.resolve()
        current = self.fixture.repo / ".runtime" / "current"
        current_target = os.readlink(current)
        entries = (
            (self.fixture.home / ".codex" / "AGENTS.md", repo / "AGENTS.md"),
            (self.fixture.home / ".claude" / "CLAUDE.md", repo / "AGENTS.md"),
            (self.fixture.home / ".agents" / "skills", repo / "skills"),
            (self.fixture.home / ".claude" / "skills", repo / "skills"),
        )
        for entry, legacy_target in entries:
            entry.unlink()
            entry.symlink_to(legacy_target)
        plan = self.fixture.run("plan")

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main

        original_apply_entry = runtime_module._apply_runtime_entry

        def apply_entry_with_failure(*args: Any, **kwargs: Any) -> Any:
            entry = args[0]
            if entry.name == "agents-skills":
                raise OSError("injected entry failure")
            return original_apply_entry(*args, **kwargs)

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "_apply_runtime_entry",
                side_effect=apply_entry_with_failure,
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    self.fixture.output_value(plan, "Plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR RUNTIME_APPLY_FAILED", output.getvalue())
        self.assertEqual(os.readlink(current), current_target)
        for entry, legacy_target in entries:
            self.assertEqual(os.readlink(entry), str(legacy_target))

    def test_apply_rollback_preserves_concurrent_user_entry_changes(self) -> None:
        self.fixture.install_matching_runtime()
        repo = self.fixture.repo.resolve()
        entries = (
            (self.fixture.home / ".codex" / "AGENTS.md", repo / "AGENTS.md"),
            (self.fixture.home / ".claude" / "CLAUDE.md", repo / "AGENTS.md"),
            (self.fixture.home / ".agents" / "skills", repo / "skills"),
            (self.fixture.home / ".claude" / "skills", repo / "skills"),
        )
        for entry, legacy_target in entries:
            entry.unlink()
            entry.symlink_to(legacy_target)
        plan = self.fixture.run("plan")
        user_codex = Path(self.fixture.temporary_directory.name) / "user-codex"
        user_agents = Path(self.fixture.temporary_directory.name) / "user-agents"
        user_codex.mkdir()
        user_agents.mkdir()

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main

        original_apply_entry = runtime_module._apply_runtime_entry
        agents_entry = self.fixture.home / ".agents" / "skills"

        def apply_entry_with_concurrent_changes(*args: Any, **kwargs: Any) -> Any:
            entry = args[0]
            if entry.name == "codex-instructions":
                result = original_apply_entry(*args, **kwargs)
                entry.path.unlink()
                entry.path.symlink_to(user_codex)
                return result
            if entry.name == "claude-instructions":
                agents_entry.unlink()
                agents_entry.symlink_to(user_agents)
                raise OSError("injected entry failure after user changes")
            return original_apply_entry(*args, **kwargs)

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "_apply_runtime_entry",
                side_effect=apply_entry_with_concurrent_changes,
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    self.fixture.output_value(plan, "Plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR RUNTIME_APPLY_FAILED", output.getvalue())
        self.assertIn("ERROR RUNTIME_ROLLBACK_FAILED", output.getvalue())
        self.assertEqual(os.readlink(entries[0][0]), str(user_codex))
        self.assertEqual(os.readlink(agents_entry), str(user_agents))

    def test_apply_rollback_preserves_a_concurrently_created_parent_directory(
        self,
    ) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        plan = self.fixture.run("plan")
        user_parent = self.fixture.home / ".codex"

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main

        original_create_parents = runtime_module._create_entry_parents
        original_apply_entry = runtime_module._apply_runtime_entry

        def create_parents_after_user(*args: Any, **kwargs: Any) -> Any:
            path = args[0]
            if path == user_parent / "AGENTS.md" and not user_parent.exists():
                user_parent.mkdir()
            return original_create_parents(*args, **kwargs)

        def fail_second_entry(*args: Any, **kwargs: Any) -> Any:
            entry = args[0]
            if entry.name == "claude-instructions":
                raise OSError("injected entry failure")
            return original_apply_entry(*args, **kwargs)

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "_create_entry_parents",
                side_effect=create_parents_after_user,
            ),
            patch.object(
                runtime_module,
                "_apply_runtime_entry",
                side_effect=fail_second_entry,
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    self.fixture.output_value(plan, "Plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertTrue(user_parent.is_dir())
        self.assertEqual(list(user_parent.iterdir()), [])

    def test_apply_preserves_an_unknown_entry_from_a_matching_blocked_plan(
        self,
    ) -> None:
        self.fixture.install_matching_runtime()
        current = self.fixture.repo / ".runtime" / "current"
        current_target = os.readlink(current)
        entry = self.fixture.home / ".codex" / "AGENTS.md"
        entry.unlink()
        entry.write_text("user-owned instructions\n")
        plan = self.fixture.run("plan")
        fingerprint = self.fixture.output_value(plan, "Plan fingerprint")
        snapshots_before = sorted(
            path.name
            for path in (self.fixture.repo / ".runtime" / "snapshots").iterdir()
        )

        result = self.fixture.run("apply", fingerprint)

        self.assert_hard_finding(plan, "RUNTIME_ENTRY_UNMANAGED")
        self.assert_hard_finding(result, "RUNTIME_ENTRY_UNMANAGED")
        self.assertEqual(entry.read_text(), "user-owned instructions\n")
        self.assertEqual(os.readlink(current), current_target)
        self.assertEqual(
            sorted(
                path.name
                for path in (self.fixture.repo / ".runtime" / "snapshots").iterdir()
            ),
            snapshots_before,
        )

    def test_apply_repeats_matching_desired_state_as_a_no_op(self) -> None:
        current = self.fixture.repo / ".runtime" / "current"
        current.unlink()
        initial_plan = self.fixture.run("plan")
        initial_apply = self.fixture.run(
            "apply", self.fixture.output_value(initial_plan, "Plan fingerprint")
        )
        repeated_plan = self.fixture.run("plan")
        snapshots = self.fixture.repo / ".runtime" / "snapshots"
        snapshots_before = sorted(path.name for path in snapshots.iterdir())
        current_before = os.readlink(current)
        entries = (
            self.fixture.home / ".codex" / "AGENTS.md",
            self.fixture.home / ".claude" / "CLAUDE.md",
            self.fixture.home / ".agents" / "skills",
            self.fixture.home / ".claude" / "skills",
        )
        entry_targets_before = tuple(os.readlink(entry) for entry in entries)

        repeated_apply = self.fixture.run(
            "apply",
            self.fixture.output_value(repeated_plan, "Plan fingerprint"),
        )

        for result in (initial_plan, initial_apply, repeated_plan, repeated_apply):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Plan result: no-op", repeated_plan.stdout)
        self.assertIn("Apply result: no-op", repeated_apply.stdout)
        self.assertEqual(
            sorted(path.name for path in snapshots.iterdir()), snapshots_before
        )
        self.assertEqual(os.readlink(current), current_before)
        self.assertEqual(
            tuple(os.readlink(entry) for entry in entries), entry_targets_before
        )

    def test_apply_atomically_switches_away_from_a_drifted_snapshot(self) -> None:
        self.fixture.install_matching_runtime()
        current = self.fixture.repo / ".runtime" / "current"
        old_active = current.resolve(strict=True)
        active_skill = old_active / "skills" / "local-skill" / "SKILL.md"
        active_skill.write_text(active_skill.read_text() + "\nRuntime drift.\n")
        plan = self.fixture.run("plan")

        result = self.fixture.run(
            "apply", self.fixture.output_value(plan, "Plan fingerprint")
        )

        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assertIn("Snapshot action: replace", plan.stdout)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(current.is_symlink())
        new_active = current.resolve(strict=True)
        self.assertNotEqual(new_active, old_active)
        self.assertEqual(
            (new_active / "skills" / "local-skill" / "SKILL.md").read_text(),
            (
                self.fixture.repo
                / "custom-skills"
                / "local-skill"
                / "SKILL.md"
            ).read_text(),
        )
        self.assertFalse(old_active.exists())

    def test_old_snapshot_cleanup_failure_keeps_the_healthy_new_state_active(
        self,
    ) -> None:
        self.fixture.install_matching_runtime()
        current = self.fixture.repo / ".runtime" / "current"
        old_active = current.resolve(strict=True)
        active_skill = old_active / "skills" / "local-skill" / "SKILL.md"
        active_skill.write_text(active_skill.read_text() + "\nRuntime drift.\n")
        plan = self.fixture.run("plan")

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main

        original_remove = runtime_module._remove_managed_tree

        def fail_old_snapshot_cleanup(root: Path) -> None:
            if root == old_active:
                (root / "skills" / "local-skill" / "SKILL.md").unlink()
                raise OSError("injected old snapshot cleanup failure")
            original_remove(root)

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "_remove_managed_tree",
                side_effect=fail_old_snapshot_cleanup,
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    self.fixture.output_value(plan, "Plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR RUNTIME_CLEANUP_FAILED", output.getvalue())
        new_active = current.resolve(strict=True)
        self.assertNotEqual(new_active, old_active)
        self.assertTrue(
            (new_active / "skills" / "local-skill" / "SKILL.md").is_file()
        )
        healthy = self.fixture.run("doctor")
        self.assertEqual(healthy.returncode, 0, healthy.stdout + healthy.stderr)

    def test_apply_restores_the_previous_runtime_after_post_switch_failure(
        self,
    ) -> None:
        self.fixture.install_matching_runtime()
        current = self.fixture.repo / ".runtime" / "current"
        old_active = current.resolve(strict=True)
        active_skill = old_active / "skills" / "local-skill" / "SKILL.md"
        active_skill.write_text(active_skill.read_text() + "\nRuntime drift.\n")
        entries = (
            self.fixture.home / ".codex" / "AGENTS.md",
            self.fixture.home / ".claude" / "CLAUDE.md",
            self.fixture.home / ".agents" / "skills",
            self.fixture.home / ".claude" / "skills",
        )
        entry_targets = tuple(os.readlink(entry) for entry in entries)
        plan = self.fixture.run("plan")

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main
        from agent_control.models import Finding

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "inspect_machine",
                return_value=(
                    Finding(
                        "error",
                        "INJECTED_POST_SWITCH_FAILURE",
                        "Injected machine health failure.",
                    ),
                ),
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    self.fixture.output_value(plan, "Plan fingerprint"),
                ]
            )

        self.assertEqual(plan.returncode, 0, plan.stdout + plan.stderr)
        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR INJECTED_POST_SWITCH_FAILURE", output.getvalue())
        self.assertEqual(current.resolve(strict=True), old_active)
        self.assertEqual(
            tuple(os.readlink(entry) for entry in entries),
            entry_targets,
        )
        self.assertEqual(
            sorted(
                path.resolve()
                for path in (self.fixture.repo / ".runtime" / "snapshots").iterdir()
            ),
            [old_active],
        )

        retried = self.fixture.run(
            "apply",
            self.fixture.output_value(plan, "Plan fingerprint"),
        )
        self.assertEqual(retried.returncode, 0, retried.stdout + retried.stderr)
        self.assertFalse(old_active.exists())

    def test_failed_initial_apply_leaves_no_partial_installation(self) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        runtime_before = self.fixture.observable_tree(
            self.fixture.repo / ".runtime"
        )
        home_before = self.fixture.observable_tree(self.fixture.home)
        plan = self.fixture.run("plan")

        from agent_control import runtime as runtime_module
        from agent_control.__main__ import main
        from agent_control.models import Finding

        output = StringIO()
        with (
            patch.dict(os.environ, {"HOME": str(self.fixture.home)}),
            patch.object(
                runtime_module,
                "inspect_machine",
                return_value=(
                    Finding(
                        "error",
                        "INJECTED_INITIAL_HEALTH_FAILURE",
                        "Injected initial-install health failure.",
                    ),
                ),
            ),
            redirect_stdout(output),
            redirect_stderr(output),
        ):
            return_code = main(
                [
                    "--repo",
                    str(self.fixture.repo),
                    "apply",
                    self.fixture.output_value(plan, "Plan fingerprint"),
                ]
            )

        self.assertEqual(return_code, 1, output.getvalue())
        self.assertIn("ERROR INJECTED_INITIAL_HEALTH_FAILURE", output.getvalue())
        self.assertEqual(
            self.fixture.observable_tree(self.fixture.repo / ".runtime"),
            runtime_before,
        )
        self.assertEqual(self.fixture.observable_tree(self.fixture.home), home_before)

    def test_plan_marks_visible_custom_skill_changes_dirty(self) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        before = self.fixture.run("plan")
        skill_file = self.fixture.repo / "custom-skills" / "local-skill" / "SKILL.md"
        skill_file.write_text(skill_file.read_text() + "\nVisible change\n")

        after = self.fixture.run("plan")

        self.assertEqual(before.returncode, 0, before.stdout + before.stderr)
        self.assertEqual(after.returncode, 0, after.stdout + after.stderr)
        self.assertIn("Dirty inputs: no", before.stdout)
        self.assertIn("Dirty inputs: yes", after.stdout)
        before_snapshot = next(
            line
            for line in before.stdout.splitlines()
            if line.startswith("Desired snapshot:")
        )
        after_snapshot = next(
            line
            for line in after.stdout.splitlines()
            if line.startswith("Desired snapshot:")
        )
        self.assertNotEqual(after_snapshot, before_snapshot)

    def test_plan_identity_includes_visible_config_and_instruction_content(
        self,
    ) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        config = self.fixture.repo / "config" / "agent-control.toml"
        instructions = self.fixture.repo / "global" / "AGENTS.md"
        original_config = config.read_text()
        original_instructions = instructions.read_text()
        baseline = self.fixture.run("plan")

        config.write_text(original_config + "\n# reviewed locally\n")
        config_result = self.fixture.run("plan")
        config.write_text(original_config)
        instructions.write_text(original_instructions + "\nLocal instruction\n")
        instruction_result = self.fixture.run("plan")

        for result in (baseline, config_result, instruction_result):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Dirty inputs: no", baseline.stdout)
        self.assertIn("Dirty inputs: yes", config_result.stdout)
        self.assertIn("Dirty inputs: yes", instruction_result.stdout)
        snapshots = [
            next(
                line
                for line in result.stdout.splitlines()
                if line.startswith("Desired snapshot:")
            )
            for result in (baseline, config_result, instruction_result)
        ]
        self.assertEqual(len(set(snapshots)), 3)
        fingerprints = [
            self.fixture.output_value(result, "Plan fingerprint")
            for result in (baseline, config_result, instruction_result)
        ]
        self.assertEqual(len(set(fingerprints)), 3)

    def test_plan_reports_no_op_for_matching_managed_runtime(self) -> None:
        snapshot_id = self.fixture.install_matching_runtime()

        result = self.fixture.run("plan")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"Desired snapshot: {snapshot_id}", result.stdout)
        self.assertIn(f"Active snapshot: {snapshot_id}", result.stdout)
        self.assertIn("Snapshot action: no-change", result.stdout)
        self.assertIn("Entry codex-instructions: no-change", result.stdout)
        self.assertIn("Entry claude-instructions: no-change", result.stdout)
        self.assertIn("Entry agents-skills: no-change", result.stdout)
        self.assertIn("Entry claude-skills: no-change", result.stdout)
        self.assertIn("Plan result: no-op", result.stdout)

    def test_plan_reports_a_stable_finding_for_missing_instruction_authority(
        self,
    ) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        (self.fixture.repo / "global" / "AGENTS.md").unlink()

        self.assert_hard_finding(self.fixture.run("plan"), "RUNTIME_PLAN_INPUT_INVALID")

    def test_snapshot_identity_ignores_temporary_metadata_but_tracks_runtime_bits(
        self,
    ) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        skill = self.fixture.repo / "custom-skills" / "local-skill"
        baseline = self.fixture.run("plan")
        skill_file = skill / "SKILL.md"
        os.utime(skill_file, ns=(1_800_000_000_000_000_000,) * 2)
        (skill / ".DS_Store").write_text("temporary metadata\n")
        cache = skill / "__pycache__"
        cache.mkdir()
        (cache / "module.cpython-311.pyc").write_bytes(b"cache")
        metadata_only = self.fixture.run("plan")

        scripts = skill / "scripts"
        scripts.mkdir()
        executable = scripts / "run.sh"
        executable.write_text("#!/bin/sh\n")
        executable.chmod(0o644)
        non_executable = self.fixture.run("plan")
        executable.chmod(0o755)
        executable_result = self.fixture.run("plan")

        baseline_id = self.fixture.output_value(baseline, "Desired snapshot")
        self.assertEqual(
            self.fixture.output_value(metadata_only, "Desired snapshot"), baseline_id
        )
        self.assertIn("Dirty inputs: no", metadata_only.stdout)
        self.assertNotEqual(
            self.fixture.output_value(non_executable, "Desired snapshot"),
            self.fixture.output_value(executable_result, "Desired snapshot"),
        )

    def test_snapshot_identity_tracks_internal_symlink_targets(self) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        skill = self.fixture.repo / "custom-skills" / "local-skill"
        (skill / "first.md").write_text("same content\n")
        (skill / "second.md").write_text("same content\n")
        link = skill / "guide.md"
        link.symlink_to("first.md")
        first = self.fixture.run("plan")
        link.unlink()
        link.symlink_to("second.md")
        second = self.fixture.run("plan")

        self.assertNotEqual(
            self.fixture.output_value(first, "Desired snapshot"),
            self.fixture.output_value(second, "Desired snapshot"),
        )

    def test_snapshot_identity_matches_sequential_adapters_for_a_shared_alias(
        self,
    ) -> None:
        manual = self.fixture.repo / "vendors" / "example" / "manual-skill"
        agents = manual / "agents"
        agents.mkdir()
        (agents / "openai.yaml").symlink_to("../SKILL.md")
        self.fixture.commit_vendor()
        validation = self.fixture.run("validate")
        self.assertEqual(
            validation.returncode, 0, validation.stdout + validation.stderr
        )
        self.fixture.install_matching_runtime()

        result = self.fixture.run("plan")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Snapshot action: no-change", result.stdout)
        self.assertIn("Plan result: no-op", result.stdout)

    def test_snapshot_identity_resolves_a_symlinked_adapter_parent(
        self,
    ) -> None:
        manual = self.fixture.repo / "vendors" / "example" / "manual-skill"
        (manual / "policies").mkdir()
        (manual / "agents").symlink_to("policies", target_is_directory=True)
        self.fixture.commit_vendor()
        validation = self.fixture.run("validate")
        self.assertEqual(
            validation.returncode, 0, validation.stdout + validation.stderr
        )
        self.fixture.install_matching_runtime()

        result = self.fixture.run("plan")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Snapshot action: no-change", result.stdout)
        self.assertIn("Plan result: no-op", result.stdout)

    def test_plan_replaces_a_drifted_managed_snapshot(self) -> None:
        snapshot_id = self.fixture.install_matching_runtime()
        baseline = self.fixture.run("plan")
        active_skill = (
            self.fixture.repo
            / ".runtime"
            / "snapshots"
            / snapshot_id
            / "skills"
            / "local-skill"
            / "SKILL.md"
        )
        active_skill.write_text(active_skill.read_text() + "\nRuntime drift\n")

        changed = self.fixture.run("plan")

        self.assertEqual(changed.returncode, 0, changed.stdout + changed.stderr)
        self.assertIn(f"Active snapshot: {snapshot_id}", changed.stdout)
        self.assertIn("Snapshot action: replace", changed.stdout)
        self.assertIn("Plan result: changes", changed.stdout)
        self.assertNotEqual(
            self.fixture.output_value(baseline, "Plan fingerprint"),
            self.fixture.output_value(changed, "Plan fingerprint"),
        )

    def test_plan_fingerprint_tracks_legacy_entry_migration(self) -> None:
        self.fixture.install_matching_runtime()
        baseline = self.fixture.run("plan")
        entry = self.fixture.home / ".codex" / "AGENTS.md"
        entry.unlink()
        entry.symlink_to(self.fixture.repo.resolve() / "AGENTS.md")

        migration = self.fixture.run("plan")

        self.assertEqual(migration.returncode, 0, migration.stdout + migration.stderr)
        self.assertIn("Entry codex-instructions: migrate", migration.stdout)
        self.assertIn("Plan result: changes", migration.stdout)
        self.assertNotEqual(
            self.fixture.output_value(baseline, "Plan fingerprint"),
            self.fixture.output_value(migration, "Plan fingerprint"),
        )

    def test_plan_blocks_unknown_entry_without_replacing_it(self) -> None:
        self.fixture.install_matching_runtime()
        entry = self.fixture.home / ".codex" / "AGENTS.md"
        entry.unlink()
        entry.write_text("user-owned instructions\n")

        result = self.fixture.run("plan")

        self.assert_hard_finding(result, "RUNTIME_ENTRY_UNMANAGED")
        self.assertIn("Entry codex-instructions: blocked", result.stdout)
        self.assertNotIn("Entry codex-instructions: replace", result.stdout)
        self.assertIn("Move the unknown state aside", result.stdout)
        self.assertEqual(entry.read_text(), "user-owned instructions\n")

    def test_plan_blocks_an_unrecognized_current_pointer(self) -> None:
        current = self.fixture.repo / ".runtime" / "current"

        result = self.fixture.run("plan")

        self.assert_hard_finding(result, "RUNTIME_CURRENT_UNMANAGED")
        self.assertIn("Snapshot action: blocked", result.stdout)
        self.assertEqual(current.read_text(), "active-state\n")

    def test_plan_blocks_a_symlinked_internal_runtime_root(self) -> None:
        runtime = self.fixture.repo / ".runtime"
        shutil.rmtree(runtime)
        outside = Path(self.fixture.temporary_directory.name) / "outside-runtime"
        outside.mkdir()
        sentinel = outside / "sentinel"
        sentinel.write_text("outside state\n")
        runtime.symlink_to(outside, target_is_directory=True)

        result = self.fixture.run("plan")

        self.assert_hard_finding(result, "RUNTIME_ROOT_UNMANAGED")
        self.assertIn("Snapshot action: blocked", result.stdout)
        self.assertEqual(sentinel.read_text(), "outside state\n")
        self.assertEqual(sorted(outside.iterdir()), [sentinel])

    def test_plan_blocks_a_missing_entry_below_a_symlinked_home_parent(
        self,
    ) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        outside = Path(self.fixture.temporary_directory.name) / "outside-home"
        outside.mkdir()
        (self.fixture.home / ".codex").symlink_to(outside, target_is_directory=True)

        result = self.fixture.run("plan")

        self.assert_hard_finding(result, "RUNTIME_ENTRY_PARENT_UNMANAGED")
        self.assertIn("Entry codex-instructions: blocked", result.stdout)
        self.assertEqual(list(outside.iterdir()), [])

    def test_plan_classifies_all_legacy_entries_for_migration(self) -> None:
        (self.fixture.repo / ".runtime" / "current").unlink()
        repo = self.fixture.repo.resolve()
        entries = (
            (self.fixture.home / ".codex" / "AGENTS.md", repo / "AGENTS.md"),
            (self.fixture.home / ".claude" / "CLAUDE.md", repo / "AGENTS.md"),
            (self.fixture.home / ".agents" / "skills", repo / "skills"),
            (self.fixture.home / ".claude" / "skills", repo / "skills"),
        )
        for entry, target in entries:
            entry.parent.mkdir(parents=True, exist_ok=True)
            entry.symlink_to(target)

        result = self.fixture.run("plan")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Entry codex-instructions: migrate", result.stdout)
        self.assertIn("Entry claude-instructions: migrate", result.stdout)
        self.assertIn("Entry agents-skills: migrate", result.stdout)
        self.assertIn("Entry claude-skills: migrate", result.stdout)

    def test_validate_rejects_unknown_fields_at_every_config_level(self) -> None:
        cases = (
            "unexpected = true",
            "[extra]\nvalue = true",
        )
        for extra in cases:
            with self.subTest(extra=extra):
                self.fixture.write_config(extra=extra)
                self.assert_hard_finding(
                    self.fixture.run("validate"), "CONFIG_UNKNOWN_FIELD"
                )

    def test_validate_rejects_duplicate_selection_and_illegal_invocation(self) -> None:
        self.fixture.write_config(
            skills=(
                ("custom-skills/local-skill", "implicit"),
                ("custom-skills/local-skill", "explicit"),
            )
        )
        self.assert_hard_finding(self.fixture.run("validate"), "SKILL_DUPLICATE")

        self.fixture.write_config(skills=(("custom-skills/local-skill", "model-only"),))
        self.assert_hard_finding(self.fixture.run("validate"), "CONFIG_INVALID_VALUE")

    def test_validate_rejects_invalid_and_unknown_trigger_group_skills(self) -> None:
        self.fixture.write_config(group_limit=3)
        self.assert_hard_finding(self.fixture.run("validate"), "TRIGGER_GROUP_INVALID")

        self.fixture.write_config(group_skills=("local-skill", "unknown-skill"))
        self.assert_hard_finding(
            self.fixture.run("validate"), "TRIGGER_GROUP_UNKNOWN_SKILL"
        )

        self.fixture.write_config(group_skills=("local-skill", ""))
        self.assert_hard_finding(self.fixture.run("validate"), "TRIGGER_GROUP_INVALID")

    def test_validate_rejects_sources_outside_declared_boundaries(self) -> None:
        outside = self.fixture.repo / "outside-skill"
        self.fixture.create_skill(outside, "outside-skill")
        self.fixture.write_config(skills=(("outside-skill", "implicit"),))

        self.assert_hard_finding(self.fixture.run("validate"), "SOURCE_OUT_OF_BOUNDS")

        self.fixture.write_config(skills=(("custom-skills//local-skill", "implicit"),))
        self.assert_hard_finding(self.fixture.run("validate"), "SOURCE_OUT_OF_BOUNDS")

    def test_validate_rejects_source_and_content_symlink_escape(self) -> None:
        source = self.fixture.repo / "custom-skills" / "local-skill"
        outside = self.fixture.repo / "outside-skill"
        self.fixture.create_skill(outside, "local-skill")
        shutil.rmtree(source)
        source.symlink_to(outside)
        self.assert_hard_finding(self.fixture.run("validate"), "SOURCE_SYMLINK_ESCAPE")

        source.unlink()
        self.fixture.create_skill(source, "local-skill")
        (source / "escape").symlink_to(outside / "SKILL.md")
        self.assert_hard_finding(self.fixture.run("validate"), "SOURCE_SYMLINK_ESCAPE")

    def test_validate_rejects_a_symlinked_trusted_source_root(self) -> None:
        source_root = self.fixture.repo / "custom-skills"
        outside_root = Path(self.fixture.temporary_directory.name) / "outside-custom"
        source_root.rename(outside_root)
        source_root.symlink_to(outside_root)

        self.assert_hard_finding(self.fixture.run("validate"), "SOURCE_SYMLINK_ESCAPE")

    def test_validate_rejects_absolute_symlinks_even_when_target_is_internal(
        self,
    ) -> None:
        skill = self.fixture.repo / "custom-skills" / "local-skill"
        target = skill / "reference.md"
        target.write_text("reference\n")
        (skill / "absolute-link").symlink_to(target.resolve())

        self.assert_hard_finding(self.fixture.run("validate"), "SOURCE_SYMLINK_ESCAPE")

    def test_validate_accepts_expected_name_for_nested_vendor_skill(self) -> None:
        source = "vendors/example/agent_reach/skill"
        self.fixture.create_skill(
            self.fixture.repo / source,
            "agent-reach",
        )
        self.fixture.commit_vendor()
        self.fixture.write_config(
            group_skills=("local-skill", "agent-reach"),
            skills=(
                ("custom-skills/local-skill", "implicit"),
                (source, "explicit"),
            ),
            expected_names={source: "agent-reach"},
        )

        validation = self.fixture.run("validate")
        listing = self.fixture.run("list-skills")

        for result in (validation, listing):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "agent-reach\tvendors/example/agent_reach/skill\texplicit",
            listing.stdout,
        )

    def test_validate_rejects_expected_name_for_custom_skill(self) -> None:
        source = "custom-skills/local-skill"
        self.fixture.write_config(expected_names={source: "local-skill"})

        result = self.fixture.run("validate")

        self.assert_hard_finding(result, "CONFIG_INVALID_VALUE")
        self.assertIn("config.skills[0].expected_name", result.stdout)

    def test_validate_rejects_missing_or_invalid_skill_metadata(self) -> None:
        skill_file = self.fixture.repo / "custom-skills" / "local-skill" / "SKILL.md"
        skill_file.unlink()
        self.assert_hard_finding(self.fixture.run("validate"), "SKILL_NOT_FOUND")

        skill_file.write_text(
            "---\nname: different-name\ndescription: Use for tests\n---\n"
        )
        self.assert_hard_finding(self.fixture.run("validate"), "SKILL_NAME_MISMATCH")

        skill_file.write_text("---\nname: local-skill\ndescription:\n---\n")
        self.assert_hard_finding(self.fixture.run("validate"), "SKILL_METADATA_INVALID")

    def test_validate_rejects_invocation_policy_relaxation(self) -> None:
        skill = self.fixture.repo / "custom-skills" / "local-skill"
        skill_file = skill / "SKILL.md"
        skill_file.write_text(
            "---\nname: local-skill\ndescription: Use for tests\n"
            "disable-model-invocation: true\n---\n"
        )
        self.assert_hard_finding(
            self.fixture.run("validate"), "INVOCATION_POLICY_RELAXED"
        )

        skill_file.write_text(
            "---\nname: local-skill\ndescription: Use for tests\n---\n"
        )
        agents = skill / "agents"
        agents.mkdir()
        (agents / "openai.yaml").write_text(
            "policy:\n  allow_implicit_invocation: false\n"
        )
        self.assert_hard_finding(
            self.fixture.run("validate"), "INVOCATION_POLICY_RELAXED"
        )

    def test_validate_rejects_duplicate_managed_policy_keys(self) -> None:
        skill = self.fixture.repo / "custom-skills" / "local-skill"
        skill_file = skill / "SKILL.md"
        self.fixture.write_config(
            implicit_budget=0,
            group_limit=0,
            group_skills=("local-skill",),
            skills=(("custom-skills/local-skill", "explicit"),),
        )
        skill_file.write_text(
            "---\nname: local-skill\ndescription: Use for tests\n"
            "disable-model-invocation: true\n"
            "disable-model-invocation: false\n---\n"
        )
        self.assert_hard_finding(self.fixture.run("validate"), "SKILL_METADATA_INVALID")

        skill_file.write_text(
            "---\nname: local-skill\ndescription: Use for tests\n---\n"
        )
        agents = skill / "agents"
        agents.mkdir()
        (agents / "openai.yaml").write_text(
            "policy:\n"
            "  allow_implicit_invocation: false\n"
            "  allow_implicit_invocation: true\n"
        )
        self.assert_hard_finding(self.fixture.run("validate"), "CODEX_POLICY_INVALID")

    def test_validate_rejects_dirty_vendor(self) -> None:
        skill_file = (
            self.fixture.repo / "vendors" / "example" / "manual-skill" / "SKILL.md"
        )
        skill_file.write_text(skill_file.read_text() + "\nChanged\n")

        self.assert_hard_finding(self.fixture.run("validate"), "VENDOR_DIRTY")

    def test_validate_ignores_fixed_vendor_temporary_artifacts(self) -> None:
        vendor = self.fixture.repo / "vendors" / "example"
        (vendor / ".DS_Store").write_text("finder metadata\n")
        cache = vendor / "manual-skill" / "__pycache__"
        cache.mkdir()
        (cache / "module.cpython-311.pyc").write_bytes(b"cache")

        result = self.fixture.run("validate")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_validate_reports_stable_findings_for_boundary_read_failures(self) -> None:
        config_path = self.fixture.repo / "config" / "agent-control.toml"
        config_path.write_bytes(b"\xff")
        self.assert_hard_finding(self.fixture.run("validate"), "CONFIG_READ_FAILED")

        self.fixture.write_config()
        (self.fixture.repo / ".gitmodules").write_bytes(b"\xff")
        self.assert_hard_finding(self.fixture.run("validate"), "GITMODULES_INVALID")

    def test_validate_reports_a_stable_finding_when_git_cannot_start(self) -> None:
        self.assert_hard_finding(
            self.fixture.run("validate", environment_overrides={"PATH": ""}),
            "VENDOR_INVALID",
        )

    def test_validate_enforces_only_configured_hard_governance(self) -> None:
        self.fixture.write_config(implicit_budget=0)
        self.assert_hard_finding(
            self.fixture.run("validate"), "IMPLICIT_BUDGET_EXCEEDED"
        )

        self.fixture.write_config(group_limit=0)
        self.assert_hard_finding(
            self.fixture.run("validate"), "TRIGGER_GROUP_LIMIT_EXCEEDED"
        )

    def test_audit_keeps_risk_words_advisory(self) -> None:
        skill = self.fixture.repo / "custom-skills" / "local-skill"
        self.fixture.create_skill(skill, "local-skill", "Post and delete remote data")
        (skill / "scripts").mkdir()
        (skill / "scripts" / "write_remote.py").write_text("print('write')\n")

        result = self.fixture.run("audit-skills")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("WARNING RISK_SIGNAL", result.stdout)
        self.assertIn("Hard governance checks: ok", result.stdout)

    def test_list_skills_reports_source_and_invocation(self) -> None:
        result = self.fixture.run("list-skills")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("local-skill\tcustom-skills/local-skill\timplicit", result.stdout)
        self.assertIn(
            "manual-skill\tvendors/example/manual-skill\texplicit", result.stdout
        )

    def test_cli_uses_exit_code_two_for_usage_errors(self) -> None:
        result = self.fixture.run("validate", "--json")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

        result = self.fixture.run("unknown-command")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
