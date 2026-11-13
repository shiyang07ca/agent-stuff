#!/usr/bin/env python3
"""校验卡片批次，并把其中已批准的新卡发布到 Anki。"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path
from typing import Any

from anki_connect import AnkiConnectClient, AnkiConnectError, DEFAULT_ENDPOINT
import validate_cards


def prepare_publish_payload(payload: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """返回通过发布前检查的牌组和 approved 卡片。"""

    deck, cards, findings = validate_cards.validate_payload(payload)
    approved_cards = [
        card for card in cards if isinstance(card, dict) and card.get("status") == "approved"
    ]
    if not approved_cards:
        raise ValueError("Publish input has no approved cards.")

    publish_findings = validate_cards.strict_publish_findings(cards, findings)
    errors = [finding for finding in publish_findings if finding.level == "error"]
    if errors:
        details = "; ".join(f"[{finding.card_id}] {finding.message}" for finding in errors)
        raise ValueError(f"Publish input failed strict validation: {details}")
    return deck, approved_cards


def html_escape(text: str) -> str:
    return html.escape(text, quote=True)


def build_note(deck: str, card: dict[str, Any]) -> dict[str, Any]:
    tags = card.get("tags", [])
    clean_tags = (
        [str(tag).strip() for tag in tags if str(tag).strip()]
        if isinstance(tags, list)
        else []
    )
    source = str(card.get("source", "")).strip()
    extra = str(card.get("extra", "")).strip()
    source_html = f"<hr><div><strong>Source:</strong> {html_escape(source)}</div>" if source else ""

    if card.get("type") == "cloze":
        return {
            "deckName": deck,
            "modelName": "Cloze",
            "fields": {
                "Text": str(card.get("text", "")).strip(),
                "Extra": f"{html_escape(extra)}{source_html}",
            },
            "tags": clean_tags,
        }

    back = html_escape(str(card.get("back", "")).strip())
    if extra:
        back = f"{back}<hr><div>{html_escape(extra)}</div>"
    return {
        "deckName": deck,
        "modelName": "Basic",
        "fields": {
            "Front": str(card.get("front", "")).strip(),
            "Back": f"{back}{source_html}",
        },
        "tags": clean_tags,
    }


def normalized_prompt(value: str) -> str:
    without_html = re.sub(r"<[^>]+>", " ", value)
    return " ".join(html.unescape(without_html).split()).casefold()


def note_prompt(note: dict[str, Any]) -> str:
    fields = note.get("fields")
    if not isinstance(fields, dict):
        return ""
    field_name = "Text" if note.get("modelName") == "Cloze" else "Front"
    field = fields.get(field_name)
    if isinstance(field, dict):
        return str(field.get("value", ""))
    return str(field or "")


def publish_payload(payload: dict[str, Any], client: Any, *, write: bool = False) -> list[int | None]:
    """检查并发布 approved 卡片；遇到已有相同问题时停止。"""

    deck, cards = prepare_publish_payload(payload)
    client.ensure_ready(deck)
    existing_prompts = set()
    for note in client.list_notes(deck):
        prompt = normalized_prompt(note_prompt(note))
        if prompt:
            existing_prompts.add(prompt)
    conflicts = [
        str(card.get("id", "unknown"))
        for card in cards
        if normalized_prompt(
            str(card.get("text" if card.get("type") == "cloze" else "front", ""))
        )
        in existing_prompts
    ]
    if conflicts:
        raise ValueError(f"Card already exists in Anki: {', '.join(conflicts)}")

    notes = [build_note(deck, card) for card in cards]
    can_add = client.can_add_notes(notes)
    blocked = [
        str(cards[index].get("id", f"card-{index + 1}"))
        for index, allowed in enumerate(can_add)
        if not allowed
    ]
    if blocked:
        raise ValueError(f"Anki refused notes before insertion: {', '.join(blocked)}")
    if not write:
        return []

    return client.add_notes(notes)


def load_payload(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc
    if not isinstance(data, dict):
        raise ValueError("Top-level JSON must be an object.")
    return data


def main(argv: list[str] | None = None, *, client: Any | None = None) -> int:
    parser = argparse.ArgumentParser(description="Publish approved new cards through AnkiConnect.")
    parser.add_argument("input", type=Path)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)

    try:
        payload = load_payload(args.input)
        _, approved_cards = prepare_publish_payload(payload)
        active_client = client or AnkiConnectClient(args.endpoint)
        note_ids = publish_payload(payload, active_client, write=args.write)
        if args.write:
            failed = False
            for card, note_id in zip(approved_cards, note_ids, strict=True):
                card_id = card.get("id", "unknown")
                if note_id is None:
                    failed = True
                    print(f"ERROR [{card_id}] addNotes returned null.", file=sys.stderr)
                else:
                    print(f"INFO [{card_id}] Added note {note_id}.")
            return 1 if failed else 0
        else:
            print(
                f"INFO Preflight passed for {len(approved_cards)} approved notes; "
                "no notes were added."
            )
        return 0
    except (OSError, ValueError, AnkiConnectError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
