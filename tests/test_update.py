from __future__ import annotations

import contextlib
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_control.update import update


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.upstream = self.root / 'upstream'
        self.repo = self.root / 'checkout'
        self.git(self.root, 'init', '-q', '-b', 'main', str(self.upstream))
        self.commit(self.upstream, 'initial', 'initial')
        self.git(self.root, 'clone', '-q', str(self.upstream), str(self.repo))
        self.commit(self.upstream, 'next', 'next')
        self.real_run = subprocess.run
        self.steps = []
        self.fail_check = False

    def git(self, cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, check=True, text=True,
                              capture_output=True).stdout.strip()

    def commit(self, repo, name, content):
        (repo / name).write_text(content)
        self.git(repo, 'add', name)
        self.git(repo, '-c', 'user.name=Tests', '-c', 'user.email=test@example.test',
                 'commit', '-qm', name)

    def command(self, argv, **kwargs):
        self.steps.append(argv)
        if argv[0] == 'git':
            return self.real_run(argv, **kwargs)
        if self.fail_check and argv[0] == 'make':
            raise subprocess.CalledProcessError(1, argv)
        return subprocess.CompletedProcess(argv, 0)

    def run_update(self):
        with patch('agent_control.update.subprocess.run', side_effect=self.command), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return update(self.repo)

    def test_fast_forward_prepares_checks_and_only_previews(self):
        self.assertEqual(self.run_update(), 0)
        self.assertTrue((self.repo / 'next').exists())
        self.assertEqual([step[-1] for step in self.steps if 'agent_control' in step],
                         ['prepare', 'plan'])
        self.assertFalse(any('apply' in step for step in self.steps))

    def test_dirty_checkout_does_not_pull(self):
        (self.repo / 'initial').write_text('local edit')
        self.assertEqual(self.run_update(), 1)
        self.assertFalse((self.repo / 'next').exists())
        self.assertEqual(len(self.steps), 1)

    def test_diverged_branch_stops_without_merge_or_prepare(self):
        self.commit(self.repo, 'local', 'local commit')
        before = self.git(self.repo, 'rev-parse', 'HEAD')
        self.assertEqual(self.run_update(), 1)
        self.assertEqual(before, self.git(self.repo, 'rev-parse', 'HEAD'))
        self.assertFalse(any('agent_control' in step for step in self.steps))

    def test_failed_check_does_not_preview_or_apply(self):
        self.fail_check = True
        self.assertEqual(self.run_update(), 1)
        self.assertTrue((self.repo / 'next').exists())
        self.assertFalse(any(step[-1] == 'plan' for step in self.steps))
