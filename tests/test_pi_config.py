from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from test_agent_control import ControlPlaneFixture
from agent_control import runtime
from agent_control.desired_state import load_desired_state


class PiConfigTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ControlPlaneFixture()
        self.addCleanup(self.fixture.cleanup)
        self.repo = self.fixture.repo.resolve()
        self.home = self.fixture.home
        (self.repo / '.runtime/current').unlink()
        self.source = self.repo / 'config/pi'
        self.source.mkdir()
        self.agent = self.home / '.pi/agent'
        self.agent.mkdir(parents=True)
        self.local = self.home / '.config/agent-stuff/local.json'
        self.local.parent.mkdir(parents=True)
        package = self.repo / 'pi'
        package.mkdir()
        for directory in ('extensions', 'skills', 'themes', 'commands'):
            (package / directory).mkdir()
            (package / directory / 'example.txt').write_text('resource')
        self.write(package / 'package.json', {'name': 'test-pi', 'pi': {
            'extensions': ['./extensions/*'], 'skills': ['./skills'],
            'themes': ['./themes'], 'prompts': ['./commands']}})
        self.write(self.source / 'settings.json', {
            'defaultProvider': 'proxy', 'defaultModel': 'chat',
            'enabledModels': ['proxy/chat', 'deepseek/deepseek-flash'],
            'webSearch': {'model': 'proxy/chat'}, 'theme': 'dark'})
        self.write(self.source / 'models.json', {'providers': {'proxy': {
            'baseUrl': 'https://example.test/v1', 'api': 'openai-responses',
            'models': [{'id': 'chat'}]}}})
        self.write(self.source / 'keybindings.json', {'submit': 'enter'})
        self.write(self.source / 'modes.json', {'version': 1, 'currentMode': 'default',
            'modes': {name: {'provider': 'proxy', 'modelId': 'chat', 'thinkingLevel': 'medium'}
                      for name in ('default', 'dev')}})

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))

    def plan(self):
        state, findings = load_desired_state(self.repo)
        self.assertIsNotNone(state, findings)
        return runtime.build_runtime_plan(state, self.home)

    def apply(self, plan=None):
        with patch.object(runtime.shutil, 'which', return_value='/test/tool'):
            result = runtime.apply_runtime_plan(self.repo, self.home, (plan or self.plan()).fingerprint)
        self.assertFalse(result.has_errors, result.findings)
        return result

    def test_jsonc_migration_preserves_local_state_and_is_idempotent(self):
        (self.agent / 'settings.json').write_text('''{ // comment
          "theme": "old", "lastChangelogVersion": "1.4.0",
          "url": "https://example.test/a//b/*c*/", "packages": ["/old/monte-pi"]
        }''')
        self.write(self.agent / 'modes.json', {'currentMode': 'dev', 'modes': {}})
        for name in ('auth.json', 'trust.json', 'sessions/session.jsonl', 'models-store.json'):
            path = self.agent / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('private local state')
        preserved = {p: p.read_bytes() for p in self.agent.rglob('*') if p.is_file()
                     and p.name not in ('settings.json', 'modes.json')}
        for relative, old in (('.agents/skills', '.runtime/current/skills'),
                              ('.claude/skills', '.runtime/current/skills'),
                              ('.codex/AGENTS.md', 'global/AGENTS.md'),
                              ('.claude/CLAUDE.md', 'global/AGENTS.md')):
            entry = self.home / relative
            entry.parent.mkdir(exist_ok=True)
            entry.symlink_to(self.home / 'code/agents' / old)
        before = self.fixture.observable_tree(self.home)
        plan = self.plan()
        self.assertEqual([e.action for e in plan.entries], ['migrate'] * 4 + ['add'])
        self.assertEqual(before, self.fixture.observable_tree(self.home))
        self.apply(plan)
        self.assertEqual((self.agent / 'AGENTS.md').resolve(), self.repo / 'global/AGENTS.md')
        settings = json.loads((self.agent / 'settings.json').read_text())
        self.assertEqual(settings['lastChangelogVersion'], '1.4.0')
        self.assertEqual(settings['packages'], [str(self.repo / 'pi')])
        self.assertNotIn('url', settings)
        self.assertEqual(json.loads((self.agent / 'modes.json').read_text())['currentMode'], 'dev')
        self.assertTrue(all(path.read_bytes() == value for path, value in preserved.items()))
        before = self.fixture.observable_tree(self.home)
        self.assertFalse(self.apply().changed)
        self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_existing_unmanaged_pi_instructions_block_apply_without_changes(self):
        instructions = self.agent / 'AGENTS.md'
        instructions.write_text('personal instructions\n')
        before = self.fixture.observable_tree(self.home)
        plan = self.plan()
        self.assertTrue(plan.has_errors)
        self.assertEqual(next(e.action for e in plan.entries if e.name == 'pi-instructions'), 'blocked')
        result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertTrue(result.has_errors)
        self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_shared_preferences_restore_and_deleted_keys_disappear(self):
        self.apply()
        settings = json.loads((self.agent / 'settings.json').read_text())
        settings.update(theme='changed-in-ui', lastChangelogVersion='local', extra=True)
        self.write(self.agent / 'settings.json', settings)
        source = json.loads((self.source / 'settings.json').read_text())
        del source['webSearch']
        self.write(self.source / 'settings.json', source)
        self.apply()
        result = json.loads((self.agent / 'settings.json').read_text())
        self.assertEqual(result['theme'], 'dark')
        self.assertEqual(result['lastChangelogVersion'], 'local')
        self.assertNotIn('webSearch', result)
        self.assertNotIn('extra', result)

    def test_source_and_local_changes_expire_plan(self):
        for path in (self.source / 'keybindings.json', self.agent / 'settings.json'):
            with self.subTest(path=path):
                plan = self.plan()
                path.write_text('{"changed": "ctrl+x"}')
                before = self.fixture.observable_tree(self.home)
                result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
                self.assertTrue(result.has_errors)
                self.assertIn('RUNTIME_PLAN_STALE', [f.code for f in result.findings])
                self.assertEqual(before, self.fixture.observable_tree(self.home))
                if path.parent == self.source:
                    self.write(path, {'submit': 'enter'})

    def test_local_base_url_override_changes_models_diff_and_fingerprint(self):
        baseline = self.plan()
        shared = (self.source / 'models.json').read_bytes()
        self.write(self.local, {'providers': {'proxy': {'baseUrl': 'http://127.0.0.1:8080/v1'}}})
        plan = self.plan()
        self.assertFalse(plan.has_errors, plan.findings)
        self.assertNotEqual(plan.fingerprint, baseline.fingerprint)
        models = next(file for file in plan.pi_files if file.path.name == 'models.json')
        expected = json.loads(shared)
        expected['providers']['proxy']['baseUrl'] = 'http://127.0.0.1:8080/v1'
        self.assertEqual(json.loads(models.content), expected)
        self.assertIn('http://127.0.0.1:8080/v1', models.diff)
        self.assertEqual((self.source / 'models.json').read_bytes(), shared)
        for old, new in zip(baseline.pi_files, plan.pi_files):
            if new.path.name != 'models.json':
                self.assertEqual(old, new)
        self.apply(plan)
        self.assertEqual(json.loads((self.agent / 'models.json').read_text()), expected)
        self.assertTrue(self.plan().is_no_op)
        reviewed = self.plan()
        self.write(self.local, {'providers': {'proxy': {'baseUrl': 'https://other.example.test/v1'}}})
        before = self.fixture.observable_tree(self.home)
        outcome = runtime.apply_runtime_plan(self.repo, self.home, reviewed.fingerprint)
        self.assertIn('RUNTIME_PLAN_STALE', [finding.code for finding in outcome.findings])
        self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_missing_local_override_uses_shared_config_and_only_passed_home(self):
        other_home = self.home / 'other-home'
        decoy = other_home / '.config/agent-stuff/local.json'
        decoy.parent.mkdir(parents=True)
        decoy.write_text('invalid JSON in unrelated HOME')
        with patch.dict(os.environ, {'HOME': str(other_home), 'XDG_CONFIG_HOME': str(decoy.parent)}):
            plan = self.plan()
        self.assertFalse(plan.has_errors, plan.findings)
        models = next(file for file in plan.pi_files if file.path.name == 'models.json')
        self.assertEqual(json.loads(models.content), json.loads((self.source / 'models.json').read_text()))
        self.assertFalse(self.local.exists())

    def test_local_override_accepts_dns_ipv4_localhost_and_ipv6_hosts(self):
        urls = ['https://my-models.example.test/v1', 'https://模型.example/v1',
                'http://127.0.0.1:8080/v1', 'http://localhost:8080/v1',
                'http://[::1]:8080/v1', 'https://[2001:db8::1]/v1']
        for url in urls:
            with self.subTest(url=url):
                self.write(self.local, {'providers': {'proxy': {'baseUrl': url}}})
                before = self.fixture.observable_tree(self.home)
                plan = self.plan()
                self.assertFalse(plan.has_errors, plan.findings)
                models = next(file for file in plan.pi_files if file.path.name == 'models.json')
                self.assertEqual(json.loads(models.content)['providers']['proxy']['baseUrl'], url)
                self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_invalid_local_override_structure_blocks_without_writes(self):
        invalid_values = [
            [], {}, {'providers': []},
            {'providers': {}, 'extra': True},
            {'providers': {'missing': {'baseUrl': 'https://example.test/v1'}}},
            {'providers': {'proxy': {}}},
            {'providers': {'proxy': 'https://example.test/v1'}},
            {'providers': {'proxy': {'baseUrl': 'https://example.test/v1', 'extra': True}}},
        ]
        for index, value in enumerate(invalid_values):
            with self.subTest(case=index):
                self.write(self.local, value)
                before = self.fixture.observable_tree(self.home)
                plan = self.plan()
                self.assertTrue(plan.has_errors)
                self.assertIn('PI_LOCAL_CONFIG_INVALID', [finding.code for finding in plan.findings])
                self.assertEqual(next(file.action for file in plan.pi_files
                                      if file.path.name == 'models.json'), 'blocked')
                outcome = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
                self.assertTrue(outcome.has_errors)
                self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_invalid_local_urls_block_plan_doctor_and_apply_without_leaks(self):
        urls = [None, '', ' ', 'ftp://example.test/v1', 'https://',
                'https://example.test:invalid/v1', 'https://example.test/a b',
                'https://exa%mple.test/v1', 'https://-example.test/v1',
                'https://example..test/v1', 'https://999.999.999.999/v1',
                'https://[::1]suffix/v1',
                'https://user:PRIVATE-PASSWORD@example.test/v1',
                'https://example.test/v1?token=PRIVATE-TOKEN',
                'HTTPS://user:PRIVATE-PASSWORD@example.test/v1',
                'https://example.test/v1#PRIVATE-FRAGMENT']
        for index, url in enumerate(urls):
            with self.subTest(case=index):
                self.write(self.local, {'providers': {'proxy': {'baseUrl': url}}})
                before = self.fixture.observable_tree(self.home)
                plan = self.plan()
                self.assertTrue(plan.has_errors)
                for arguments in (('plan',), ('doctor',), ('apply', plan.fingerprint)):
                    result = self.fixture.run(*arguments)
                    self.assertEqual(result.returncode, 1, result.stdout)
                    self.assertIn('PI_LOCAL_CONFIG_INVALID', result.stdout)
                    self.assertNotIn('PRIVATE-', result.stdout + result.stderr)
                self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_malformed_override_omits_content_and_does_not_affect_validate(self):
        self.local.write_text('{"providers": "PRIVATE-CONTENT", invalid}')
        before = self.fixture.observable_tree(self.home)
        result = self.fixture.run('validate')
        self.assertEqual(result.returncode, 0, result.stdout)
        result = self.fixture.run('plan')
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('PI_LOCAL_CONFIG_INVALID', result.stdout)
        self.assertNotIn('PRIVATE-CONTENT', result.stdout + result.stderr)
        self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_credentials_are_redacted_and_missing_auth_blocks_migration(self):
        self.write(self.agent / 'models.json', {'providers': {'proxy': {
            'apiKey': 'TOP-SECRET-KEY', 'models': [{'id': 'chat',
            'headers': {'Authorization': 'NESTED-SECRET'}}]}}})
        result = self.fixture.run('plan')
        self.assertEqual(result.returncode, 1)
        self.assertIn('PI_LOCAL_CONFIG_INVALID', result.stdout)
        self.assertNotIn('TOP-SECRET-KEY', result.stdout + result.stderr)
        self.assertNotIn('NESTED-SECRET', result.stdout + result.stderr)
        before = self.fixture.observable_tree(self.home)
        blocked = self.plan()
        outcome = runtime.apply_runtime_plan(self.repo, self.home, blocked.fingerprint)
        self.assertTrue(outcome.has_errors)
        self.assertEqual(before, self.fixture.observable_tree(self.home))
        self.write(self.agent / 'models.json', {'providers': {'proxy': {'apiKey': 'TOP-SECRET-KEY'}}})
        result = self.fixture.run('plan')
        self.assertIn('PI_AUTH_MIGRATION_REQUIRED', result.stdout)
        self.assertIn('proxy', result.stdout)
        self.assertNotIn('TOP-SECRET-KEY', result.stdout + result.stderr)
        self.write(self.agent / 'auth.json', {'proxy': {'type': 'api_key', 'key': 'LOCAL-SECRET'}})
        result = self.fixture.run('plan')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertNotIn('SECRET', result.stdout + result.stderr)
        self.apply()
        self.assertNotIn('apiKey', (self.agent / 'models.json').read_text())
        self.assertIn('LOCAL-SECRET', (self.agent / 'auth.json').read_text())

    def test_commented_auth_cannot_authorize_removing_old_api_key(self):
        self.write(self.agent / 'models.json', {'providers': {'proxy': {'apiKey': 'fixture-only'}}})
        (self.agent / 'auth.json').write_text('{ // Pi cannot parse this\n"proxy":{"type":"api_key","key":"fixture-only"}}')
        before = self.fixture.observable_tree(self.home)
        plan = self.plan()
        self.assertTrue(any(f.code == 'PI_AUTH_MIGRATION_REQUIRED' for f in plan.findings))
        result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertTrue(result.has_errors)
        self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_provider_auth_cannot_authorize_removing_other_credentials(self):
        self.write(self.agent / 'auth.json', {'proxy': {'type': 'api_key', 'key': 'fixture-only'}})
        for extra in ({'headers': {'X-Gateway-Token': 'private-header'}},
                      {'models': [{'id': 'chat', 'headers': {'Authorization': 'private-header'}}]},
                      {'baseUrl': 'https://user:private-password@example.test/v1'}):
            with self.subTest(extra=next(iter(extra))):
                self.write(self.agent / 'models.json', {'providers': {'proxy': {'apiKey': 'fixture-only', **extra}}})
                before = self.fixture.observable_tree(self.home)
                plan = self.plan()
                self.assertTrue(plan.has_errors)
                self.assertTrue(runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint).has_errors)
                self.assertEqual(before, self.fixture.observable_tree(self.home))
                self.assertNotIn('private-header', str(plan.findings))
                self.assertNotIn('private-password', str(plan.findings))

    def test_mid_write_failure_restores_files_links_and_snapshot(self):
        self.apply()
        skill = self.repo / 'custom-skills/local-skill/SKILL.md'
        skill.write_text(skill.read_text() + '\nnew skill content\n')
        entry = self.home / '.agents/skills'
        entry.unlink()
        entry.symlink_to(self.home / 'code/agents/.runtime/current/skills')
        for name in ('settings.json', 'models.json'):
            path = self.agent / name
            data = json.loads(path.read_text())
            data['old'] = True
            self.write(path, data)
            path.chmod(0o640)
        plan = self.plan()
        before_home = self.fixture.observable_tree(self.home)
        before_runtime = self.fixture.observable_tree(self.repo / '.runtime')
        original = runtime._atomic_write_file
        calls = 0
        def fail_once(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('injected second Pi write failure')
            return original(*args, **kwargs)
        with patch.object(runtime, '_atomic_write_file', side_effect=fail_once):
            result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertTrue(result.has_errors)
        self.assertEqual(before_home, self.fixture.observable_tree(self.home))
        self.assertEqual(before_runtime, self.fixture.observable_tree(self.repo / '.runtime'))
        self.assertEqual((self.agent / 'settings.json').stat().st_mode & 0o777, 0o640)

    def test_invalid_sources_and_unsafe_targets_never_write(self):
        path = self.source / 'settings.json'
        original = path.read_text()
        for invalid in ('{"apiKey":"SECRET"}', '{// source JSONC\n}',
                        '{"defaultProvider":"missing","defaultModel":"no"}',
                        '{"enabledModels":["missing/model"]}',
                        '{"webSearch":{"model":"missing/model"}}'):
            path.write_text(invalid)
            before = self.fixture.observable_tree(self.home)
            result = self.fixture.run('validate')
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertNotIn('SECRET', result.stdout + result.stderr)
            self.assertEqual(before, self.fixture.observable_tree(self.home))
        path.write_text(original)
        (self.agent / 'settings.json').symlink_to(self.home / 'sentinel')
        plan = self.plan()
        self.assertTrue(plan.has_errors)
        before = self.fixture.observable_tree(self.home)
        result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertTrue(result.has_errors)
        self.assertEqual(before, self.fixture.observable_tree(self.home))

    def test_failed_health_check_restores_all_four_files(self):
        from agent_control.models import Finding
        for name in ('settings.json', 'models.json', 'keybindings.json', 'modes.json'):
            (self.agent / name).write_text('{ /* previous exact bytes */ "local": true }')
        plan = self.plan()
        before_home = self.fixture.observable_tree(self.home)
        before_runtime = self.fixture.observable_tree(self.repo / '.runtime')
        with patch.object(runtime, 'inspect_machine', return_value=(
            Finding('error', 'INJECTED_HEALTH_FAILURE', 'injected'),
        )):
            result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertTrue(result.has_errors)
        self.assertEqual(before_home, self.fixture.observable_tree(self.home))
        self.assertEqual(before_runtime, self.fixture.observable_tree(self.repo / '.runtime'))

    def test_rollback_keeps_a_concurrent_user_configuration_change(self):
        self.apply()
        settings = self.agent / 'settings.json'
        settings.write_text('{"old": true}')
        (self.agent / 'models.json').write_text('{}')
        plan = self.plan()
        original = runtime._atomic_write_file
        def write_then_interfere(path, *args):
            if path.name == 'models.json':
                settings.write_text('{"concurrent": true}')
                raise OSError('injected after concurrent change')
            return original(path, *args)
        with patch.object(runtime, '_atomic_write_file', side_effect=write_then_interfere):
            result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertIn('RUNTIME_ROLLBACK_FAILED', [finding.code for finding in result.findings])
        self.assertEqual(json.loads(settings.read_text()), {'concurrent': True})

    def test_malformed_local_json_reports_no_content(self):
        (self.agent / 'models.json').write_text('{"apiKey": "SECRET", invalid SECRET}')
        result = self.fixture.run('plan')
        self.assertEqual(result.returncode, 1)
        self.assertIn('PI_LOCAL_CONFIG_INVALID', result.stdout)
        self.assertNotIn('SECRET', result.stdout + result.stderr)

    def test_initial_write_failure_removes_created_pi_files_and_directories(self):
        self.agent.rmdir()
        self.agent.parent.rmdir()
        plan = self.plan()
        before_home = self.fixture.observable_tree(self.home)
        before_runtime = self.fixture.observable_tree(self.repo / '.runtime')
        original = runtime._atomic_write_file
        def fail_models(path, *args):
            if path.name == 'models.json':
                raise OSError('injected initial write failure')
            return original(path, *args)
        with patch.object(runtime, '_atomic_write_file', side_effect=fail_models):
            result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertTrue(result.has_errors)
        self.assertEqual(before_home, self.fixture.observable_tree(self.home))
        self.assertEqual(before_runtime, self.fixture.observable_tree(self.repo / '.runtime'))

    def test_pi_change_during_candidate_build_expires_review(self):
        plan = self.plan()
        original = runtime.build_candidate_snapshot
        def build_then_change(*args, **kwargs):
            result = original(*args, **kwargs)
            self.write(self.source / 'keybindings.json', {'submit': 'ctrl+enter'})
            return result
        before_home = self.fixture.observable_tree(self.home)
        before_runtime = self.fixture.observable_tree(self.repo / '.runtime')
        with patch.object(runtime, 'build_candidate_snapshot', side_effect=build_then_change):
            result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertIn('RUNTIME_PLAN_STALE', [finding.code for finding in result.findings])
        self.assertEqual(before_home, self.fixture.observable_tree(self.home))
        self.assertEqual(before_runtime, self.fixture.observable_tree(self.repo / '.runtime'))

    def test_auth_readiness_change_expires_review_without_executing_commands(self):
        self.write(self.agent / 'models.json', {'providers': {'proxy': {'apiKey': '!touch forbidden'}}})
        self.write(self.agent / 'auth.json', {'proxy': {'type': 'api_key', 'key': 'ready'}})
        plan = self.plan()
        self.write(self.agent / 'auth.json', {'proxy': {'type': 'api_key', 'key': '!touch forbidden'}})
        before = self.fixture.observable_tree(self.home)
        result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertIn('RUNTIME_PLAN_STALE', [finding.code for finding in result.findings])
        self.assertEqual(before, self.fixture.observable_tree(self.home))
        self.assertTrue(self.plan().has_errors)

    def test_jsonc_lexer_preserves_urls_escaped_quotes_and_comment_markers(self):
        from agent_control.pi_config import parse_object
        value = {'url': 'https://example.test/a//b/*x*/', 'quoted': '\\" // not comment',
                 'slash': '\\\\', 'unicode': '中文'}
        raw = '// before\n' + json.dumps(value) + ' /* after */'
        self.assertEqual(parse_object(raw.encode(), jsonc=True), value)
        with self.assertRaises(ValueError):
            parse_object(b'{"token": "SECRET", /* unclosed', jsonc=True)

    def test_source_and_target_parent_symlinks_are_rejected(self):
        path = self.source / 'models.json'
        original = path.read_bytes()
        path.unlink()
        other = self.repo / 'elsewhere.json'
        other.write_bytes(original)
        path.symlink_to(other)
        state, findings = load_desired_state(self.repo)
        self.assertIsNone(state)
        self.assertTrue(findings)
        path.unlink()
        path.write_bytes(original)
        self.agent.rmdir()
        outside = self.home / 'outside'
        outside.mkdir()
        self.agent.symlink_to(outside)
        before = self.fixture.observable_tree(self.home)
        plan = self.plan()
        self.assertTrue(plan.has_errors)
        result = runtime.apply_runtime_plan(self.repo, self.home, plan.fingerprint)
        self.assertTrue(result.has_errors)
        self.assertEqual(before, self.fixture.observable_tree(self.home))
        self.assertEqual(list(outside.iterdir()), [])

    def test_bad_modes_resource_paths_and_source_credentials_are_rejected(self):
        files = {
            self.source / 'modes.json': {'version': 1, 'modes': {'default': {
                'provider': 'missing', 'modelId': 'missing', 'thinkingLevel': 'medium'}}},
            self.repo / 'pi/package.json': {'name': 'escape', 'pi': {
                key: ['../global'] for key in ('extensions', 'skills', 'themes', 'prompts')}},
            self.source / 'models.json': {'providers': {'proxy': {'models': [{
                'id': 'chat', 'headers': {'Authorization': 'SECRET'}}]}}},
        }
        for path, invalid in files.items():
            with self.subTest(path=path):
                original = path.read_bytes()
                self.write(path, invalid)
                before = self.fixture.observable_tree(self.home)
                result = self.fixture.run('apply', '0' * 64)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn('PI_CONFIG_INVALID', result.stdout)
                self.assertNotIn('SECRET', result.stdout + result.stderr)
                self.assertEqual(before, self.fixture.observable_tree(self.home))
                path.write_bytes(original)

    def test_unknown_old_checkout_link_remains_blocked(self):
        entry = self.home / '.agents/skills'
        entry.parent.mkdir()
        entry.symlink_to(self.home / 'code/other/.runtime/current/skills')
        plan = self.plan()
        self.assertTrue(plan.has_errors)
        self.assertEqual(next(e.action for e in plan.entries if e.name == 'agents-skills'), 'blocked')

    def test_partial_pi_install_is_rejected(self):
        (self.source / 'modes.json').unlink()
        state, findings = load_desired_state(self.repo)
        self.assertIsNone(state)
        self.assertTrue(any(f.code == 'PI_CONFIG_INVALID' for f in findings))


if __name__ == '__main__':
    unittest.main()
