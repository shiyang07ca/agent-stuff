"""显式拉取固定版本、准备依赖并预览；不应用 HOME 配置。"""
from __future__ import annotations

import shlex
import subprocess
import sys
from pathlib import Path

from .locking import ChangeLockError, change_lock

def _run(repo: Path, *command: str, capture: bool = False) -> str:
    result = subprocess.run(command, cwd=repo, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


def prepare(repo: Path) -> int:
    try:
        for directory in (repo / "pi", repo / "custom-skills/web-browser/scripts"):
            print(f"Installing locked dependencies: {directory.relative_to(repo)}", flush=True)
            _run(directory, "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund")
        return 0
    except (OSError, subprocess.CalledProcessError):
        print("Dependency preparation failed; HOME configuration was not applied.", file=sys.stderr)
        return 1


def update(repo: Path) -> int:
    try:
        with change_lock(repo):
            return _update_locked(repo)
    except ChangeLockError as error:
        print(error.message, file=sys.stderr)
        return 1


def _update_locked(repo: Path) -> int:
    try:
        dirty = _run(repo, "git", "status", "--porcelain", "--untracked-files=normal",
                     "--ignore-submodules=none", capture=True)
        if dirty:
            print("Update stopped: commit or resolve repository changes first.", file=sys.stderr)
            return 1
        _run(repo, "git", "rev-parse", "--verify", "@{upstream}", capture=True)
        _run(repo, "git", "pull", "--ff-only")
        _run(repo, "git", "submodule", "sync", "--recursive")
        _run(repo, "git", "submodule", "update", "--init", "--recursive")
        # 拉取后的实现负责后续步骤，避免继续使用旧版本的配置逻辑。
        _run(repo, sys.executable, "-m", "agent_control", "prepare")
        _run(repo, "make", "check", f"PYTHON={shlex.quote(sys.executable)}")
        _run(repo, sys.executable, "-m", "agent_control", "plan")
        print("Review the plan, then run make apply PLAN=<fingerprint>. No HOME changes were applied.")
        return 0
    except (OSError, subprocess.CalledProcessError):
        print("Update stopped. Check the upstream branch, network and output above. "
              "Already pulled source stays in place; HOME configuration was not applied.", file=sys.stderr)
        return 1
