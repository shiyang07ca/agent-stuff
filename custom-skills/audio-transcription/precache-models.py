#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["huggingface-hub>=0.30"]
# ///
"""预缓存 audio-transcription 技能使用的 MLX Whisper 模型。"""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download

DEFAULT_MODELS = [
    "mlx-community/whisper-large-v3-turbo",
    "mlx-community/whisper-large-v3-mlx",
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-cache MLX Whisper models used by the audio-transcription skill.")
    parser.add_argument(
        "models",
        nargs="*",
        help="Hugging Face model IDs to cache (defaults to the skill's Whisper models)",
    )
    parser.add_argument(
        "--local-only",
        action="store_true",
        help="Only check the local cache; do not download missing files",
    )
    args = parser.parse_args()

    models = args.models or DEFAULT_MODELS
    for model in models:
        print(f"==> {model}")
        path = snapshot_download(model, local_files_only=args.local_only)
        print(f"Cached at: {Path(path)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
