#!/usr/bin/env python3
"""校验 anki-card-maker 的卡片 JSON。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

DEFAULT_DECK = "Mnemosyne"
ALLOWED_TYPES = {"basic", "cloze"}
ALLOWED_STATUS = {"draft", "needs_review", "approved", "rejected"}
DEFAULT_TAGS = {"ai_generated", "codex"}
DATE_TAG_PATTERN = re.compile(r"date_\d{4}_\d{2}_\d{2}$")
INLINE_CODE_PATTERN = re.compile(r"`[^`]+`")
COURSE_SEQUENCE_PATTERN = re.compile(
    r"(?:第\s*[0-9一二三四五六七八九十百]+\s*(?:课|讲|单元)|"
    r"\b(?:lesson|lecture|module|week)\s*[-:#]?\s*\d+\b)",
    re.IGNORECASE,
)
CONTEXT_CLAUSE_PATTERN = re.compile(
    r"(?:^|[，。；;])\s*(?:在|当|使用|为了|针对|对于).{2,100}?(?:中|时|下|里|场景|任务|目标)"
)
DOMAIN_OR_TASK_PATTERN = re.compile(
    r"(?:\b[A-Z][A-Za-z0-9.+#-]{1,}\b|"
    r"Bash|Shell|shell|命令行|脚本|程序|代码|函数|服务|系统|项目|流程|部署|调试|测试|"
    r"数据库|接口|配置|日志|论文|文章|研究|作者|模型|算法|协议|规范)"
)


@dataclass
class Finding:
    level: str
    card_id: str
    message: str


def load_payload(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ValueError("Top-level JSON must be an object.")
    return data


def text_value(card: dict[str, Any], key: str) -> str:
    value = card.get(key)
    if isinstance(value, str):
        return value.strip()
    return ""


def card_identity(index: int, card: dict[str, Any]) -> str:
    value = card.get("id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return f"card-{index + 1}"


def is_valid_date_tag(tag: str) -> bool:
    if not DATE_TAG_PATTERN.fullmatch(tag):
        return False
    try:
        datetime.strptime(tag.removeprefix("date_"), "%Y_%m_%d")
    except ValueError:
        return False
    return True


def validate_card(index: int, card: Any, seen_prompts: set[str]) -> list[Finding]:
    findings: list[Finding] = []
    if not isinstance(card, dict):
        return [Finding("error", f"card-{index + 1}", "Card must be an object.")]

    card_id = card_identity(index, card)
    card_type = card.get("type")
    status = card.get("status")
    priority = card.get("priority")
    source = text_value(card, "source")
    tags = card.get("tags")
    selection_reason = card.get("selection_reason")

    if not text_value(card, "id"):
        findings.append(Finding("error", card_id, "Missing id."))
    if card_type not in ALLOWED_TYPES:
        findings.append(Finding("error", card_id, "type must be basic or cloze."))
    if status not in ALLOWED_STATUS:
        findings.append(Finding("error", card_id, "status must be draft, needs_review, approved, or rejected."))
    if not isinstance(priority, int) or priority < 1 or priority > 4:
        findings.append(Finding("error", card_id, "priority must be an integer from 1 to 4."))
    elif status == "approved" and priority == 4:
        findings.append(Finding("warning", card_id, "Approved card has priority 4 and should be rejected instead."))
    elif status == "approved" and priority == 3:
        findings.append(Finding("warning", card_id, "Approved card has priority 3; confirm it is worth publishing."))
    if not source:
        findings.append(Finding("error", card_id, "Missing source."))
    if selection_reason is not None and not isinstance(selection_reason, str):
        findings.append(Finding("warning", card_id, "selection_reason should be a string when present."))
    elif status in {"draft", "needs_review", "approved"} and not text_value(card, "selection_reason"):
        findings.append(
            Finding(
                "warning",
                card_id,
                "Draft, review, or approved card needs selection_reason explaining why it is worth remembering.",
            )
        )
    if not isinstance(tags, list) or not all(isinstance(tag, str) and tag.strip() for tag in tags):
        findings.append(Finding("error", card_id, "tags must be a non-empty string array."))
    else:
        clean_tags = {tag.strip() for tag in tags}
        if not DEFAULT_TAGS.issubset(clean_tags):
            findings.append(Finding("warning", card_id, "Default tags ai_generated and codex should be present."))
        date_tags = [tag for tag in clean_tags if tag.startswith("date_")]
        if status == "approved" and not date_tags:
            findings.append(Finding("warning", card_id, "Approved card should include a date_YYYY_MM_DD tag."))
        for tag in date_tags:
            if not is_valid_date_tag(tag):
                findings.append(Finding("warning", card_id, f"Invalid date tag: {tag}"))
        for tag in clean_tags:
            if not re.fullmatch(r"[a-z0-9_:/-]+", tag):
                findings.append(Finding("warning", card_id, f"Tag has non-standard characters: {tag}"))

    if card_type == "basic":
        front = text_value(card, "front")
        back = text_value(card, "back")
        if not front:
            findings.append(Finding("error", card_id, "Basic card missing front."))
        if not back:
            findings.append(Finding("error", card_id, "Basic card missing back."))
        if front:
            prompt_key = f"basic:{front.casefold()}"
            if prompt_key in seen_prompts:
                findings.append(Finding("warning", card_id, "Duplicate front."))
            seen_prompts.add(prompt_key)
            findings.extend(check_prompt_quality(card_id, front))
        if len(back) > 700:
            findings.append(Finding("error", card_id, "Back is longer than 700 characters."))
        elif len(back) > 300:
            findings.append(Finding("warning", card_id, "Back is longer than 300 characters."))
        if looks_like_large_list(back):
            findings.append(Finding("warning", card_id, "Back looks like a long list; split into smaller cards."))

    if card_type == "cloze":
        text = text_value(card, "text")
        if not text:
            findings.append(Finding("error", card_id, "Cloze card missing text."))
        if text and not re.search(r"\{\{c\d+::[^{}]+}}", text):
            findings.append(Finding("error", card_id, "Cloze text must contain Anki cloze markup."))
        if text:
            prompt_key = f"cloze:{text.casefold()}"
            if prompt_key in seen_prompts:
                findings.append(Finding("warning", card_id, "Duplicate cloze text."))
            seen_prompts.add(prompt_key)
            if len(re.findall(r"\{\{c\d+::", text)) > 2:
                findings.append(Finding("warning", card_id, "Cloze card has more than two blanks."))
            if len(text) > 240:
                findings.append(Finding("warning", card_id, "Cloze text is longer than 240 characters."))
            if cloze_context_is_weak(text):
                findings.append(Finding("warning", card_id, "Cloze text may not provide enough context around the blank."))
            if COURSE_SEQUENCE_PATTERN.search(text):
                findings.append(
                    Finding(
                        "warning",
                        card_id,
                        "Cloze mentions only a lesson or module number; state the topic or task instead.",
                    )
                )

    return findings


def check_prompt_quality(card_id: str, front: str) -> list[Finding]:
    findings: list[Finding] = []
    lowered = front.casefold()
    yes_no_prefixes = (
        "是否",
        "是不是",
        "能否",
        "可否",
        "do ",
        "does ",
        "did ",
        "is ",
        "are ",
        "can ",
        "should ",
        "will ",
    )
    if lowered.startswith(yes_no_prefixes):
        findings.append(
            Finding(
                "warning",
                card_id,
                "Question can be answered yes or no; ask for a reason, condition, example, or counterexample instead.",
            )
        )
    if front.count("？") + front.count("?") > 1:
        findings.append(Finding("warning", card_id, "Question contains multiple question marks."))
    if len(front) > 180:
        findings.append(Finding("warning", card_id, "Front is longer than 180 characters."))
    if re.search(r"(这个|上述|前面|它|该方案|this|that|above|previous)", front, re.IGNORECASE):
        findings.append(
            Finding(
                "warning",
                card_id,
                "Question uses words such as 'this' or 'above', but the referenced content is missing.",
            )
        )
    if code_prompt_context_is_weak(front):
        findings.append(
            Finding(
                "warning",
                card_id,
                "Question with code may not say which technology or tool is being used, or what practical task is being done.",
            )
        )
    if COURSE_SEQUENCE_PATTERN.search(front):
        findings.append(
            Finding(
                "warning",
                card_id,
                "Question mentions only a lesson or module number; state the topic or task instead.",
            )
        )
    if looks_like_collection_prompt(front):
        findings.append(
            Finding(
                "warning",
                card_id,
                "Question asks for a list; ask one useful fact, reason, condition, or decision instead.",
            )
        )
    if looks_like_summary_prompt(front):
        findings.append(
            Finding(
                "warning",
                card_id,
                "Question asks for a summary; ask one fact, reason, condition, or decision instead.",
            )
        )
    if looks_like_multi_part_prompt(front):
        findings.append(
            Finding(
                "warning",
                card_id,
                "Question may ask for several facts; split it into cards that each ask one thing.",
            )
        )
    return findings


def looks_like_large_list(text: str) -> bool:
    numbered = len(re.findall(r"(^|\n)\s*(\d+\.|[-*])\s+", text))
    arrow_separators = text.count("→")
    clauses = re.split(r"[。！？!?；;]", text)
    longest_inline_list = max((clause.count("、") for clause in clauses), default=0)
    short_inline_list = longest_inline_list >= 3 and len(text) <= 100 and not re.search(r"[；;：:]", text)
    return numbered >= 4 or arrow_separators >= 3 or short_inline_list


def looks_like_collection_prompt(text: str) -> bool:
    return bool(
        re.search(
            r"(列出|有哪些|包括哪些|包含哪些|分别是什么|哪几个|多少个|顺序是什么|"
            r"哪[0-9一二三四五六七八九十百]+(?:层|类|步|种|项|个|部分|阶段|手段|原则)|"
            r"[0-9一二三四五六七八九十百]+(?:层|类|步|种|项|个|部分|阶段|手段|原则)"
            r"[\u4e00-\u9fffA-Za-z0-9_-]{0,12}(?:是什么|有哪些|包括哪些|包含哪些)|"
            r"list|what are|name the)",
            text,
            re.IGNORECASE,
        )
    )


def looks_like_summary_prompt(text: str) -> bool:
    return bool(re.search(r"(总结|概括|主要内容|核心内容|main idea|summari[sz]e)", text, re.IGNORECASE))


def looks_like_multi_part_prompt(text: str) -> bool:
    question_mark_count = text.count("？") + text.count("?")
    connector_count = len(re.findall(r"(以及|并且|同时|和|与|、| and | plus )", text, re.IGNORECASE))
    return question_mark_count > 1 or connector_count >= 3


def code_prompt_context_is_weak(front: str) -> bool:
    if not INLINE_CODE_PATTERN.search(front):
        return False
    prose = INLINE_CODE_PATTERN.sub(" ", front)
    return not CONTEXT_CLAUSE_PATTERN.search(prose) and not DOMAIN_OR_TASK_PATTERN.search(prose)


def cloze_context_is_weak(text: str) -> bool:
    matches = list(re.finditer(r"\{\{c\d+::[^{}]+}}", text))
    if not matches:
        return False
    for match in matches:
        before = re.sub(r"\s+", "", text[: match.start()])
        after = re.sub(r"\s+", "", text[match.end() :])
        if len(before) + len(after) < 8:
            return True
    return False


def validate_rejected_candidates(payload: dict[str, Any]) -> list[Finding]:
    value = payload.get("rejected_candidates")
    if value is None:
        return []
    if not isinstance(value, list):
        return [Finding("error", "payload", "rejected_candidates must be an array when present.")]

    findings: list[Finding] = []
    for index, candidate in enumerate(value):
        candidate_id = f"rejected-candidate-{index + 1}"
        if not isinstance(candidate, dict):
            findings.append(Finding("error", candidate_id, "Rejected candidate must be an object."))
            continue
        if not text_value(candidate, "point"):
            findings.append(Finding("warning", candidate_id, "Rejected candidate missing point."))
        if not text_value(candidate, "reason"):
            findings.append(Finding("warning", candidate_id, "Rejected candidate missing reason."))
        if not text_value(candidate, "source"):
            findings.append(Finding("warning", candidate_id, "Rejected candidate missing source."))
    return findings


def validate_payload(payload: dict[str, Any]) -> tuple[str, list[dict[str, Any]], list[Finding]]:
    deck = payload.get("deck", DEFAULT_DECK)
    findings: list[Finding] = []
    if not isinstance(deck, str) or not deck.strip():
        findings.append(Finding("error", "payload", "deck must be a non-empty string."))
        deck = DEFAULT_DECK
    cards = payload.get("cards")
    if not isinstance(cards, list):
        return deck, [], findings + [Finding("error", "payload", "cards must be an array.")]
    findings.extend(validate_rejected_candidates(payload))
    seen_ids: set[str] = set()
    seen_prompts: set[str] = set()
    for index, card in enumerate(cards):
        if isinstance(card, dict) and text_value(card, "id"):
            card_id = card_identity(index, card)
            if card_id in seen_ids:
                findings.append(Finding("error", card_id, "Duplicate id."))
            seen_ids.add(card_id)
        findings.extend(validate_card(index, card, seen_prompts))
    return deck.strip(), cards, findings


def strict_publish_findings(cards: list[dict[str, Any]], findings: list[Finding]) -> list[Finding]:
    """把 approved 卡片的质量警告提升为发布错误。"""

    approved_ids = {
        card_identity(index, card)
        for index, card in enumerate(cards)
        if isinstance(card, dict) and card.get("status") == "approved"
    }
    return [
        Finding("error" if item.card_id in approved_ids and item.level == "warning" else item.level, item.card_id, item.message)
        for item in findings
    ]


def print_findings(findings: list[Finding]) -> None:
    for finding in findings:
        print(f"{finding.level.upper()} [{finding.card_id}] {finding.message}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate Anki card JSON.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--strict-publish", action="store_true")
    args = parser.parse_args(argv)

    try:
        payload = load_payload(args.input)
        deck, cards, findings = validate_payload(payload)
    except ValueError as exc:
        print(f"ERROR [payload] {exc}", file=sys.stderr)
        return 1

    if args.strict_publish:
        findings = strict_publish_findings(cards, findings)

    print_findings(findings)
    errors = [item for item in findings if item.level == "error"]
    approved_cards = [card for card in cards if isinstance(card, dict) and card.get("status") == "approved"]

    print(f"INFO Checked {len(cards)} cards, {len(errors)} errors, {len(findings) - len(errors)} warnings, {len(approved_cards)} approved.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
