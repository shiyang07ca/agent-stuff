#!/usr/bin/env python3
"""验证 anki-card-maker 脚本的关键约束。"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
SKILL_DIR = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import render_review
import anki_notes
import publish_anki
import validate_cards


def card(card_id: str, **overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "id": card_id,
        "type": "basic",
        "front": "为什么制卡前要先理解内容？",
        "back": "因为理解是可靠主动回忆的前提。",
        "source": "conversation:2026-06-23",
        "tags": ["ai_generated", "codex", "date_2026_06_23"],
        "priority": 2,
        "status": "draft",
        "selection_reason": "这个判断会反复决定材料是否值得进入长期记忆。",
    }
    value.update(overrides)
    return value


def messages(findings: list[validate_cards.Finding], level: str) -> list[str]:
    return [finding.message for finding in findings if finding.level == level]


class ValidateCardsTests(unittest.TestCase):
    def test_strict_publish_cli_accepts_a_mixed_status_batch(self) -> None:
        payload = {
            "cards": [
                card("approved-card", status="approved"),
                card("draft-card"),
                card("rejected-card", status="rejected", priority=4),
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "cards.json"
            input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            with contextlib.redirect_stdout(io.StringIO()):
                exit_code = validate_cards.main([str(input_path), "--strict-publish"])

        self.assertEqual(0, exit_code)

    def test_missing_source_is_an_error(self) -> None:
        _, _, findings = validate_cards.validate_payload({"cards": [card("card-1", source="")]})

        self.assertIn("Missing source.", messages(findings, "error"))

    def test_duplicate_id_is_an_error(self) -> None:
        _, _, findings = validate_cards.validate_payload({"cards": [card("card-1"), card("card-1")]})

        self.assertIn("Duplicate id.", messages(findings, "error"))

    def test_invalid_date_tag_is_reported(self) -> None:
        _, _, findings = validate_cards.validate_payload(
            {"cards": [card("card-1", tags=["ai_generated", "codex", "date_2026_13_01"])]}
        )

        self.assertIn("Invalid date tag: date_2026_13_01", messages(findings, "warning"))

    def test_code_prompt_without_domain_or_task_context_is_reported(self) -> None:
        front = "迁移记录每行一个文件名。如何避免 `1.sql` 被 `grep` 误匹配到 `11.sql`？"

        _, _, findings = validate_cards.validate_payload({"cards": [card("card-1", front=front)]})

        self.assertIn(
            "Question with code may not say which technology or tool is being used, or what practical task is being done.",
            messages(findings, "warning"),
        )

    def test_code_prompt_with_domain_and_task_context_passes(self) -> None:
        front = (
            "在 Bash 数据库迁移脚本中，用 `grep` 检查迁移文件名是否已记录时，"
            "怎样避免 `1.sql` 被误匹配到 `11.sql`？"
        )

        _, _, findings = validate_cards.validate_payload({"cards": [card("card-1", front=front)]})

        self.assertNotIn(
            "Question with code may not say which technology or tool is being used, or what practical task is being done.",
            messages(findings, "warning"),
        )

    def test_course_sequence_locator_is_reported(self) -> None:
        front = "在第 12 课中，`grep -x` 解决什么匹配问题？"

        _, _, findings = validate_cards.validate_payload({"cards": [card("card-1", front=front)]})

        self.assertIn(
            "Question mentions only a lesson or module number; state the topic or task instead.",
            messages(findings, "warning"),
        )

    def test_active_card_requires_selection_reason(self) -> None:
        _, _, findings = validate_cards.validate_payload(
            {"cards": [card("card-1", selection_reason="")]}
        )

        self.assertIn(
            "Draft, review, or approved card needs selection_reason explaining why it is worth remembering.",
            messages(findings, "warning"),
        )

    def test_named_framework_list_prompts_are_reported(self) -> None:
        fronts = [
            "阅读陌生 Bash 部署脚本时，‘四遍法’的顺序是什么？",
            "检查 Bash 部署脚本结构时，应优先识别哪六层骨架？",
            "Bash 脚本常见的六层骨架是什么？",
            "调试 Bash 部署脚本时，可以组合使用哪四类手段？",
        ]

        for index, front in enumerate(fronts, start=1):
            with self.subTest(front=front):
                _, _, findings = validate_cards.validate_payload(
                    {"cards": [card(f"card-{index}", front=front)]}
                )
                self.assertIn(
                    "Question asks for a list; ask one useful fact, reason, condition, or decision instead.",
                    messages(findings, "warning"),
                )

    def test_framework_list_answers_are_reported(self) -> None:
        backs = [
            "扫骨架 → 追主干 → 查细节 → 调试验证。",
            "Shebang、严格模式、常量、工具函数、业务函数、main 入口。",
            "bash -x 追踪、stderr 日志、隔离测试、ShellCheck 静态检查。",
        ]

        for index, back in enumerate(backs, start=1):
            with self.subTest(back=back):
                _, _, findings = validate_cards.validate_payload(
                    {"cards": [card(f"card-{index}", back=back)]}
                )
                self.assertIn(
                    "Back looks like a long list; split into smaller cards.",
                    messages(findings, "warning"),
                )

    def test_short_lists_inside_an_explanation_are_not_reported(self) -> None:
        backs = [
            "三位分别对应 owner、group、other；每位由读 r=4、写 w=2、执行 x=1 相加。",
            "if、while、until 的条件命令属于显式测试场景；set -e 对这些条件失败有例外。",
            (
                "它会强制递归删除且不可恢复。DIR 必须非空、已验证为预期范围内的路径，"
                "并拒绝 /、.、.. 等危险目标；始终引用变量。"
            ),
        ]

        for index, back in enumerate(backs, start=1):
            with self.subTest(back=back):
                _, _, findings = validate_cards.validate_payload(
                    {"cards": [card(f"card-{index}", back=back)]}
                )
                self.assertNotIn(
                    "Back looks like a long list; split into smaller cards.",
                    messages(findings, "warning"),
                )


class PublishAnkiTests(unittest.TestCase):
    def test_prepare_publish_payload_selects_only_approved_cards(self) -> None:
        approved = card("approved-card", status="approved")
        draft = card("draft-card")

        deck, cards = publish_anki.prepare_publish_payload({"deck": "Mnemosyne", "cards": [approved, draft]})

        self.assertEqual("Mnemosyne", deck)
        self.assertEqual([approved], cards)

    def test_prepare_publish_payload_rejects_quality_warnings(self) -> None:
        payload = {"cards": [card("card-1", front="是否应该为了凑数量制卡？", status="approved")]}

        with self.assertRaisesRegex(ValueError, "Question can be answered yes or no"):
            publish_anki.prepare_publish_payload(payload)

    def test_prepare_publish_payload_rejects_code_prompt_without_context(self) -> None:
        payload = {
            "cards": [
                card(
                    "card-1",
                    front="迁移记录每行一个文件名。如何避免 `1.sql` 被 `grep` 误匹配到 `11.sql`？",
                    status="approved",
                )
            ]
        }

        with self.assertRaisesRegex(ValueError, "which technology or tool is being used"):
            publish_anki.prepare_publish_payload(payload)

    def test_publish_rejects_existing_prompt_without_adding_a_note(self) -> None:
        payload = {"deck": "Mnemosyne", "cards": [card("existing-card", status="approved")]}

        class FakeAnkiClient:
            added = False

            def ensure_ready(self, deck: str) -> None:
                self.deck = deck

            def list_notes(self, deck: str) -> list[dict[str, object]]:
                return [
                    {
                        "noteId": 123,
                        "modelName": "Basic",
                        "fields": {"Front": {"value": "为什么制卡前要先理解内容？"}},
                        "cards": [456],
                    }
                ]

            def can_add_notes(self, notes: list[dict[str, object]]) -> list[bool]:
                return [True for _ in notes]

            def add_notes(self, notes: list[dict[str, object]]) -> list[int]:
                self.added = True
                return [789 for _ in notes]

        client = FakeAnkiClient()

        with self.assertRaisesRegex(ValueError, "already exists in Anki"):
            publish_anki.publish_payload(payload, client, write=True)

        self.assertFalse(client.added)

    def test_publish_cli_is_read_only_without_write_flag(self) -> None:
        payload = {"deck": "Mnemosyne", "cards": [card("new-card", status="approved")]}

        class FakeAnkiClient:
            added = False

            def ensure_ready(self, deck: str) -> None:
                pass

            def list_notes(self, deck: str) -> list[dict[str, object]]:
                return []

            def can_add_notes(self, notes: list[dict[str, object]]) -> list[bool]:
                return [True for _ in notes]

            def add_notes(self, notes: list[dict[str, object]]) -> list[int]:
                self.added = True
                return [789 for _ in notes]

        client = FakeAnkiClient()
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "cards.json"
            input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            with contextlib.redirect_stdout(io.StringIO()):
                exit_code = publish_anki.main([str(input_path)], client=client)

        self.assertEqual(0, exit_code)
        self.assertFalse(client.added)

    def test_publish_cli_reports_successes_when_another_note_fails(self) -> None:
        payload = {
            "deck": "Mnemosyne",
            "cards": [
                card("card-1", front="为什么制卡前要先理解内容？", status="approved"),
                card("card-2", front="为什么卡片问题需要必要背景？", status="approved"),
            ],
        }

        class FakeAnkiClient:
            def ensure_ready(self, deck: str) -> None:
                pass

            def list_notes(self, deck: str) -> list[dict[str, object]]:
                return []

            def can_add_notes(self, notes: list[dict[str, object]]) -> list[bool]:
                return [True, True]

            def add_notes(self, notes: list[dict[str, object]]) -> list[int | None]:
                return [789, None]

        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "cards.json"
            input_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()

            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = publish_anki.main([str(input_path), "--write"], client=FakeAnkiClient())

        self.assertEqual(1, exit_code)
        self.assertIn("[card-1] Added note 789", stdout.getvalue())
        self.assertIn("[card-2] addNotes returned null", stderr.getvalue())


class AnkiNotesTests(unittest.TestCase):
    def test_update_is_a_dry_run_without_write_authorization(self) -> None:
        class FakeAnkiClient:
            updated = False

            def get_note(self, note_id: int) -> dict[str, object]:
                return {
                    "noteId": note_id,
                    "fields": {
                        "Front": {"value": "旧问题"},
                        "Back": {"value": "旧答案"},
                    },
                    "cards": [456],
                }

            def update_note_fields(self, note_id: int, fields: dict[str, str]) -> None:
                self.updated = True

        client = FakeAnkiClient()

        result = anki_notes.update_note(client, 123, {"Front": "包含必要背景的新问题"}, write=False)

        self.assertFalse(client.updated)
        self.assertEqual({"Front": "旧问题"}, result["before"])
        self.assertEqual({"Front": "包含必要背景的新问题"}, result["after"])

    def test_update_write_targets_the_existing_note_id(self) -> None:
        class FakeAnkiClient:
            update: tuple[int, dict[str, str]] | None = None

            def get_note(self, note_id: int) -> dict[str, object]:
                return {
                    "noteId": note_id,
                    "fields": {"Front": {"value": "旧问题"}, "Back": {"value": "旧答案"}},
                    "cards": [456],
                }

            def update_note_fields(self, note_id: int, fields: dict[str, str]) -> None:
                self.update = (note_id, fields)

        client = FakeAnkiClient()

        result = anki_notes.update_note(client, 123, {"Front": "新问题"}, write=True)

        self.assertEqual((123, {"Front": "新问题"}), client.update)
        self.assertTrue(result["written"])

    def test_suspend_marks_the_note_retired_and_suspends_its_cards(self) -> None:
        class FakeAnkiClient:
            tagged: tuple[list[int], list[str]] | None = None
            suspended: list[int] | None = None

            def get_note(self, note_id: int) -> dict[str, object]:
                return {"noteId": note_id, "fields": {}, "cards": [456, 457]}

            def add_tags(self, note_ids: list[int], tags: list[str]) -> None:
                self.tagged = (note_ids, tags)

            def suspend_cards(self, card_ids: list[int]) -> None:
                self.suspended = card_ids

        client = FakeAnkiClient()

        result = anki_notes.suspend_note(client, 123, write=True)

        self.assertEqual(([123], ["retired"]), client.tagged)
        self.assertEqual([456, 457], client.suspended)
        self.assertTrue(result["written"])

    def test_delete_requires_the_exact_note_id_confirmation(self) -> None:
        class FakeAnkiClient:
            deleted = False

            def get_note(self, note_id: int) -> dict[str, object]:
                return {"noteId": note_id, "fields": {}, "cards": [456]}

            def delete_notes(self, note_ids: list[int]) -> None:
                self.deleted = True

        client = FakeAnkiClient()

        with self.assertRaisesRegex(ValueError, "exact note ID"):
            anki_notes.delete_note(client, 123, write=True, confirmed_note_id=124)

        self.assertFalse(client.deleted)

    def test_delete_with_exact_confirmation_targets_one_note(self) -> None:
        class FakeAnkiClient:
            deleted: list[int] | None = None

            def get_note(self, note_id: int) -> dict[str, object]:
                return {"noteId": note_id, "fields": {}, "cards": [456]}

            def delete_notes(self, note_ids: list[int]) -> None:
                self.deleted = note_ids

        client = FakeAnkiClient()

        result = anki_notes.delete_note(client, 123, write=True, confirmed_note_id=123)

        self.assertEqual([123], client.deleted)
        self.assertTrue(result["written"])

    def test_update_cli_reads_a_change_file_and_defaults_to_dry_run(self) -> None:
        class FakeAnkiClient:
            updated = False

            def get_note(self, note_id: int) -> dict[str, object]:
                return {
                    "noteId": note_id,
                    "fields": {"Front": {"value": "旧问题"}, "Back": {"value": "旧答案"}},
                    "cards": [456],
                }

            def update_note_fields(self, note_id: int, fields: dict[str, str]) -> None:
                self.updated = True

        client = FakeAnkiClient()
        with tempfile.TemporaryDirectory() as directory:
            change_path = Path(directory) / "change.json"
            change_path.write_text(
                json.dumps({"note_id": 123, "fields": {"Front": "包含必要背景的新问题"}}, ensure_ascii=False),
                encoding="utf-8",
            )

            with contextlib.redirect_stdout(io.StringIO()):
                exit_code = anki_notes.main(["update", str(change_path)], client=client)

        self.assertEqual(0, exit_code)
        self.assertFalse(client.updated)


class RenderReviewTests(unittest.TestCase):
    def test_render_includes_learning_goal(self) -> None:
        review = render_review.render(
            {
                "deck": "Mnemosyne",
                "learning_goal": "在设计学习工作流时判断内容是否值得制卡。",
                "cards": [card("card-1")],
            }
        )

        self.assertIn("## 学习目标", review)
        self.assertIn("在设计学习工作流时判断内容是否值得制卡。", review)

    def test_render_shows_front_before_source_metadata(self) -> None:
        review = render_review.render({"deck": "Mnemosyne", "cards": [card("card-1")]})

        self.assertLess(review.index("**Front**"), review.index("- 来源："))

    def test_render_describes_approval_as_publication(self) -> None:
        review = render_review.render({"deck": "Mnemosyne", "cards": [card("card-1")]})

        self.assertIn("只发布 `approved` 卡片", review)
        self.assertNotIn("只同步 `approved` 卡片", review)


class SkillDocumentationTests(unittest.TestCase):
    def test_skill_makes_anki_authoritative_after_publication(self) -> None:
        skill_text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("卡片发布后，以 Anki 中的内容为准", skill_text)
        self.assertIn("## 生成并发布新卡片", skill_text)
        self.assertIn("## 优化 Anki 现有卡片", skill_text)
        self.assertIn("## 暂停或删除卡片", skill_text)

    def test_source_and_card_decision_sections_are_kept(self) -> None:
        skill_text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("## 按来源取舍", skill_text)
        self.assertIn("## 制卡决策", skill_text)

    def test_basic_example_keeps_understand_before_memorizing_rule(self) -> None:
        schema_text = (SKILL_DIR / "references" / "card-schema.md").read_text(encoding="utf-8")

        self.assertIn("为什么制卡前要先确认内容已被理解？", schema_text)
        self.assertIn("理解是可靠主动回忆的前提。", schema_text)

    def test_schema_limits_candidate_files_to_prepublication_review(self) -> None:
        schema_text = (SKILL_DIR / "references" / "card-schema.md").read_text(encoding="utf-8")

        self.assertIn("候选 JSON 只用于发布前审核", schema_text)
        self.assertIn("`id` 不用于更新 Anki 中的旧 note", schema_text)
        self.assertIn("`rejected_candidates` 是可选项", schema_text)

    def test_docs_do_not_use_invented_process_jargon(self) -> None:
        forbidden_phrases = {
            "候选账本",
            "预期答案形状",
            "列表门",
            "语义锚点",
            "必要张力",
            "Front-only test",
            "实践密度",
            "候选门槛",
            "回忆目标",
            "知识域",
            "来源归属",
            "错误代价",
            "高代价边界",
            "单一事实来源",
            "机械换皮",
        }
        paths = [
            SKILL_DIR / "SKILL.md",
            SKILL_DIR / "references" / "card-principles.md",
            SKILL_DIR / "references" / "card-schema.md",
        ]

        for path in paths:
            text = path.read_text(encoding="utf-8")
            for phrase in forbidden_phrases:
                with self.subTest(path=path.name, phrase=phrase):
                    self.assertNotIn(phrase, text)

    def test_atomic_questions_are_defined_in_plain_language(self) -> None:
        principles_text = (SKILL_DIR / "references" / "card-principles.md").read_text(encoding="utf-8")

        self.assertIn("这就是常说的“问题原子化”：每张卡只要求给出一个", principles_text)
        self.assertIn("如果一题中的两部分可能一对一错，就拆开", principles_text)

    def test_principles_cover_review_time_card_improvements(self) -> None:
        principles_text = (SKILL_DIR / "references" / "card-principles.md").read_text(encoding="utf-8")

        self.assertIn("## 复习时怎样改卡", principles_text)
        self.assertIn("以 Anki 中当前显示的内容为起点", principles_text)

    def test_anki_operations_separate_publish_update_suspend_and_delete(self) -> None:
        operations_text = (SKILL_DIR / "references" / "anki-operations.md").read_text(encoding="utf-8")

        self.assertIn("## 发布新卡", operations_text)
        self.assertIn("## 更新现有 note", operations_text)
        self.assertIn("## 暂停卡片", operations_text)
        self.assertIn("## 删除 note", operations_text)
        self.assertIn("--confirm-note-id", operations_text)

    def test_ui_metadata_uses_publication_language(self) -> None:
        metadata_text = (SKILL_DIR / "agents" / "openai.yaml").read_text(encoding="utf-8")

        self.assertIn("发布", metadata_text)
        self.assertIn("优化", metadata_text)
        self.assertNotIn("同步", metadata_text)


if __name__ == "__main__":
    unittest.main()
