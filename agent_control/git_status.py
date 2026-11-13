from __future__ import annotations

from pathlib import PurePosixPath


_IGNORED_TEMPORARY_NAMES = {
    "__pycache__",
    ".DS_Store",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
}


def has_meaningful_git_changes(output: bytes | str) -> bool:
    """解析 `git status --porcelain=v1 -z` 并忽略固定临时产物。"""
    text = output.decode(errors="replace") if isinstance(output, bytes) else output
    records = text.split("\0")
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if len(record) < 3:
            return True
        status = record[:2]
        paths = [record[3:]]
        if status[0] in ("R", "C") and index < len(records):
            paths.append(records[index])
            index += 1
        if any(not is_ignored_temporary_path(path) for path in paths):
            return True
    return False


def is_ignored_temporary_path(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return any(part in _IGNORED_TEMPORARY_NAMES for part in parts) or path.endswith(
        ".pyc"
    )
