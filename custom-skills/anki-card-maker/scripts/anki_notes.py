#!/usr/bin/env python3
"""读取或维护 Anki 中已经存在的 note。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from anki_connect import AnkiConnectClient, AnkiConnectError, DEFAULT_ENDPOINT


def update_note(
    client: Any,
    note_id: int,
    fields: dict[str, str],
    *,
    write: bool = False,
) -> dict[str, Any]:
    """预览或更新一个 note 的指定字段。"""

    if note_id <= 0:
        raise ValueError("note_id must be a positive integer.")
    if not fields or not all(
        isinstance(name, str) and name and isinstance(value, str)
        for name, value in fields.items()
    ):
        raise ValueError("fields must be a non-empty string mapping.")

    note = client.get_note(note_id)
    existing_fields = note.get("fields")
    if not isinstance(existing_fields, dict):
        raise ValueError(f"Anki note {note_id} has no readable fields.")
    unknown_fields = sorted(set(fields) - set(existing_fields))
    if unknown_fields:
        raise ValueError(f"Anki note {note_id} has no fields: {', '.join(unknown_fields)}")

    before = {}
    for name in fields:
        field = existing_fields[name]
        before[name] = str(field.get("value", "")) if isinstance(field, dict) else str(field)

    if write:
        client.update_note_fields(note_id, fields)
    return {"note_id": note_id, "before": before, "after": fields, "written": write}


def suspend_note(client: Any, note_id: int, *, write: bool = False) -> dict[str, Any]:
    """预览或暂停一个 note 生成的全部卡片，并添加 retired 标签。"""

    if note_id <= 0:
        raise ValueError("note_id must be a positive integer.")
    note = client.get_note(note_id)
    raw_card_ids = note.get("cards")
    if not isinstance(raw_card_ids, list) or not raw_card_ids:
        raise ValueError(f"Anki note {note_id} has no cards to suspend.")
    card_ids = [int(card_id) for card_id in raw_card_ids]

    if write:
        client.suspend_cards(card_ids)
        client.add_tags([note_id], ["retired"])
    return {"note_id": note_id, "card_ids": card_ids, "tag": "retired", "written": write}


def delete_note(
    client: Any,
    note_id: int,
    *,
    write: bool = False,
    confirmed_note_id: int | None = None,
) -> dict[str, Any]:
    """预览或删除一个 note；真正删除时必须再次提供同一个 note ID。"""

    if note_id <= 0:
        raise ValueError("note_id must be a positive integer.")
    note = client.get_note(note_id)
    if write and confirmed_note_id != note_id:
        raise ValueError("Delete requires the exact note ID as confirmation.")
    if write:
        client.delete_notes([note_id])
    return {"note_id": note_id, "note": note, "written": write}


def load_change(path: Path) -> tuple[int, dict[str, str]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc
    if not isinstance(data, dict):
        raise ValueError("Update input must be an object.")
    note_id = data.get("note_id")
    fields = data.get("fields")
    if not isinstance(note_id, int) or note_id <= 0:
        raise ValueError("Update input needs a positive integer note_id.")
    if not isinstance(fields, dict) or not fields:
        raise ValueError("Update input needs a non-empty fields object.")
    if not all(
        isinstance(name, str) and name and isinstance(value, str)
        for name, value in fields.items()
    ):
        raise ValueError("Update fields must map field names to strings.")
    return note_id, fields


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read or maintain existing Anki notes.")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    commands = parser.add_subparsers(dest="command", required=True)

    find_parser = commands.add_parser("find", help="Find notes with an Anki search query.")
    find_parser.add_argument("query")

    show_parser = commands.add_parser("show", help="Show one note by note ID.")
    show_parser.add_argument("note_id", type=int)

    update_parser = commands.add_parser("update", help="Preview or apply field updates from JSON.")
    update_parser.add_argument("change", type=Path)
    update_parser.add_argument("--write", action="store_true")

    suspend_parser = commands.add_parser("suspend", help="Preview or suspend one note's cards.")
    suspend_parser.add_argument("note_id", type=int)
    suspend_parser.add_argument("--write", action="store_true")

    delete_parser = commands.add_parser("delete", help="Preview or delete one note.")
    delete_parser.add_argument("note_id", type=int)
    delete_parser.add_argument("--write", action="store_true")
    delete_parser.add_argument("--confirm-note-id", type=int)
    return parser


def main(argv: list[str] | None = None, *, client: Any | None = None) -> int:
    args = build_parser().parse_args(argv)
    active_client = client or AnkiConnectClient(args.endpoint)

    try:
        if args.command == "find":
            notes = active_client.notes_info(active_client.find_notes(args.query))
            result: Any = notes
        elif args.command == "show":
            result = active_client.get_note(args.note_id)
        elif args.command == "update":
            note_id, fields = load_change(args.change)
            result = update_note(active_client, note_id, fields, write=args.write)
        elif args.command == "suspend":
            result = suspend_note(active_client, args.note_id, write=args.write)
        else:
            result = delete_note(
                active_client,
                args.note_id,
                write=args.write,
                confirmed_note_id=args.confirm_note_id,
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, AnkiConnectError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
