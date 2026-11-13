from __future__ import annotations

import errno
import fcntl
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


class ChangeLockError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@contextmanager
def change_lock(repo: Path) -> Iterator[None]:
    """持有仓库级非阻塞写锁，并在退出时交还给操作系统。"""
    try:
        descriptor = os.open(repo, os.O_RDONLY)
    except OSError as error:
        raise ChangeLockError(
            "RUNTIME_LOCK_FAILED",
            f"Cannot open the control-plane change lock: {error}",
        ) from error
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in {errno.EACCES, errno.EAGAIN}:
                raise ChangeLockError(
                    "RUNTIME_CHANGE_LOCKED",
                    "Another control-plane write operation is already in progress.",
                ) from error
            raise ChangeLockError(
                "RUNTIME_LOCK_FAILED",
                f"Cannot acquire the control-plane change lock: {error}",
            ) from error
        yield
    finally:
        os.close(descriptor)
