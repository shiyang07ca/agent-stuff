#!/usr/bin/env python3
"""AnkiConnect 的小型标准库客户端。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

DEFAULT_ENDPOINT = "http://127.0.0.1:8765"


class AnkiConnectError(RuntimeError):
    """AnkiConnect 返回错误或无法访问时抛出。"""


class AnkiConnectClient:
    def __init__(self, endpoint: str = DEFAULT_ENDPOINT) -> None:
        self.endpoint = endpoint

    def invoke(self, action: str, params: dict[str, Any] | None = None) -> Any:
        payload = json.dumps({"action": action, "version": 6, "params": params or {}}).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, UnicodeError, json.JSONDecodeError) as exc:
            raise AnkiConnectError(f"Cannot use AnkiConnect at {self.endpoint}: {exc}") from exc
        if not isinstance(data, dict):
            raise AnkiConnectError("AnkiConnect returned a non-object response.")
        if data.get("error"):
            raise AnkiConnectError(str(data["error"]))
        return data.get("result")

    def ensure_ready(self, deck: str) -> None:
        self.invoke("version")
        decks = self.invoke("deckNames")
        if not isinstance(decks, list) or deck not in decks:
            raise AnkiConnectError(f"Deck not found: {deck}")
        for model, required_fields in {
            "Basic": {"Front", "Back"},
            "Cloze": {"Text", "Extra"},
        }.items():
            fields = self.invoke("modelFieldNames", {"modelName": model})
            available = {
                field for field in fields if isinstance(field, str)
            } if isinstance(fields, list) else set()
            missing = required_fields - available
            if missing:
                raise AnkiConnectError(f"Model {model} missing fields: {', '.join(sorted(missing))}")

    def find_notes(self, query: str) -> list[int]:
        result = self.invoke("findNotes", {"query": query})
        if not isinstance(result, list):
            raise AnkiConnectError("findNotes returned a non-list result.")
        return [int(note_id) for note_id in result]

    def notes_info(self, note_ids: list[int]) -> list[dict[str, Any]]:
        if not note_ids:
            return []
        result = self.invoke("notesInfo", {"notes": note_ids})
        if not isinstance(result, list) or not all(isinstance(note, dict) for note in result):
            raise AnkiConnectError("notesInfo returned invalid note data.")
        return result

    def list_notes(self, deck: str) -> list[dict[str, Any]]:
        escaped_deck = deck.replace("\\", "\\\\").replace('"', '\\"')
        return self.notes_info(self.find_notes(f'deck:"{escaped_deck}"'))

    def get_note(self, note_id: int) -> dict[str, Any]:
        notes = self.notes_info([note_id])
        if len(notes) != 1 or int(notes[0].get("noteId", 0)) != note_id:
            raise AnkiConnectError(f"Note not found: {note_id}")
        return notes[0]

    def can_add_notes(self, notes: list[dict[str, Any]]) -> list[bool]:
        result = self.invoke("canAddNotes", {"notes": notes})
        if not isinstance(result, list) or len(result) != len(notes):
            raise AnkiConnectError("canAddNotes returned an unexpected result.")
        return [bool(value) for value in result]

    def add_notes(self, notes: list[dict[str, Any]]) -> list[int | None]:
        result = self.invoke("addNotes", {"notes": notes})
        if not isinstance(result, list) or len(result) != len(notes):
            raise AnkiConnectError("addNotes returned an unexpected result.")
        return [int(note_id) if note_id is not None else None for note_id in result]

    def update_note_fields(self, note_id: int, fields: dict[str, str]) -> None:
        self.invoke("updateNoteFields", {"note": {"id": note_id, "fields": fields}})

    def add_tags(self, note_ids: list[int], tags: list[str]) -> None:
        self.invoke("addTags", {"notes": note_ids, "tags": " ".join(tags)})

    def suspend_cards(self, card_ids: list[int]) -> None:
        result = self.invoke("suspend", {"cards": card_ids})
        if result is not True:
            raise AnkiConnectError("Anki did not suspend the requested cards.")

    def delete_notes(self, note_ids: list[int]) -> None:
        self.invoke("deleteNotes", {"notes": note_ids})
