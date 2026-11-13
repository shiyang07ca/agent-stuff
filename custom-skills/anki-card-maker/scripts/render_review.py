#!/usr/bin/env python3
"""把卡片 JSON 转成便于逐张确认的 Markdown。"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

STATUS_ORDER = ["approved", "needs_review", "draft", "rejected"]


def load_payload(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Top-level JSON must be an object.")
    cards = data.get("cards")
    if not isinstance(cards, list):
        raise ValueError("cards must be an array.")
    return data


def card_title(card: dict[str, Any]) -> str:
    if card.get("type") == "cloze":
        return str(card.get("text", "")).strip()
    return str(card.get("front", "")).strip()


def render_card(card: dict[str, Any], index: int) -> list[str]:
    lines: list[str] = []
    card_id = str(card.get("id", f"card-{index + 1}"))
    card_type = str(card.get("type", "unknown"))
    priority = card.get("priority", "")
    source = str(card.get("source", "")).strip()
    selection_reason = str(card.get("selection_reason", "")).strip()
    tags = card.get("tags", [])
    tag_text = ", ".join(tags) if isinstance(tags, list) else ""
    lines.append(f"### {card_id}")
    lines.append("")
    if card_type == "cloze":
        lines.append("**Text**")
        lines.append("")
        lines.append(str(card.get("text", "")).strip())
    else:
        lines.append("**Front**")
        lines.append("")
        lines.append(str(card.get("front", "")).strip())
        lines.append("")
        lines.append("**Back**")
        lines.append("")
        lines.append(str(card.get("back", "")).strip())
    extra = str(card.get("extra", "")).strip()
    if extra:
        lines.append("")
        lines.append("**Extra**")
        lines.append("")
        lines.append(extra)
    lines.append("")
    lines.append("**卡片信息**")
    lines.append("")
    lines.append(f"- 类型：`{card_type}`")
    lines.append(f"- 优先级：`{priority}`")
    lines.append(f"- 来源：{source}")
    if selection_reason:
        lines.append(f"- 为什么值得记：{selection_reason}")
    lines.append(f"- 标签：{tag_text}")
    lines.append("")
    lines.append("确认：`approved` / `needs_review` / `rejected`")
    lines.append("")
    return lines


def render_rejected_candidates(payload: dict[str, Any]) -> list[str]:
    candidates = payload.get("rejected_candidates", [])
    if not isinstance(candidates, list) or not candidates:
        return []

    lines = ["## rejected_candidates（仅供审查）", ""]
    for index, candidate in enumerate(candidates, start=1):
        if not isinstance(candidate, dict):
            lines.append(f"{index}. 非法候选：{candidate}")
            continue
        point = str(candidate.get("point", "")).strip()
        reason = str(candidate.get("reason", "")).strip()
        source = str(candidate.get("source", "")).strip()
        lines.append(f"{index}. {point}")
        if reason:
            lines.append(f"   - 拒绝原因：{reason}")
        if source:
            lines.append(f"   - 来源：{source}")
    lines.append("")
    return lines


def render(payload: dict[str, Any]) -> str:
    deck = str(payload.get("deck", "Mnemosyne")).strip() or "Mnemosyne"
    cards = payload["cards"]
    learning_goal = payload.get("learning_goal")
    grouped: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for index, card in enumerate(cards):
        if isinstance(card, dict):
            grouped[str(card.get("status", "draft"))].append((index, card))

    lines: list[str] = [
        f"# Anki 待确认卡片：{deck}",
        "",
        f"共 {len(cards)} 张卡。确认后只发布 `approved` 卡片。",
        "检查时先只看 Front/Text：你应该能看出它在说哪种技术或哪篇资料、正在解决什么事情，以及只需要回答哪一个问题。确认后再看答案和来源。",
        "",
    ]
    if isinstance(learning_goal, str) and learning_goal.strip():
        lines.extend(["## 学习目标", "", learning_goal.strip(), ""])
    for status in STATUS_ORDER:
        items = grouped.get(status, [])
        lines.append(f"## {status}（{len(items)}）")
        lines.append("")
        for index, card in items:
            lines.extend(render_card(card, index))

    lines.extend(render_rejected_candidates(payload))

    unknown_statuses = sorted(set(grouped) - set(STATUS_ORDER))
    for status in unknown_statuses:
        items = grouped[status]
        lines.append(f"## {status}（{len(items)}）")
        lines.append("")
        for index, card in items:
            lines.extend(render_card(card, index))

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Render Anki card review markdown.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", "-o", type=Path, required=True)
    args = parser.parse_args()

    payload = load_payload(args.input)
    args.output.write_text(render(payload), encoding="utf-8")
    print(f"INFO Wrote review markdown to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
