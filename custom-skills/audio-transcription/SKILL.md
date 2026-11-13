---
name: audio-transcription
description: "使用本地缓存的 MLX Whisper 模型转写音频、视频和 Apple 语音备忘录，并处理低质量录音。"
---

用户要求转写音频、视频、语音备忘录、口述、讲座、会议录音或低质量录音时使用本技能。

## 核心规则

1. **立即保存临时输入。** 位于 `~/Library/Containers/com.apple.VoiceMemos/Data/tmp/.com.apple.uikit.itemprovider...` 的语音备忘录分享路径可能随时消失。探测或试验前，先复制到稳定的 `/private/tmp/audio-transcription-inputs/`。
2. **使用本地缓存模型，不使用云端转写接口。** 优先通过 `uvx --from mlx-whisper mlx_whisper` 使用 MLX Whisper；Hugging Face 模型必须缓存在 `~/.cache/huggingface/hub/`。
3. **已知语言时明确指定。** 不要根据文件名猜测语言；语言已知时传入正确的 `--language`，未知时才使用 `auto`。
4. **低质量录音启用抗幻觉参数。** 使用 `--condition-on-previous-text False`、`--word-timestamps True` 和 `--hallucination-silence-threshold 2`。
5. **交付清理后的尽力转写。** 对照时间戳和 JSON 检查结果，删除明显的 Whisper 循环；无法确定的片段标记为 `[听不清]`，不要猜词。

## 快速使用

在本技能目录中运行：

```bash
./transcribe-audio.py "/path/to/audio.m4a" --language zh --quality balanced
```

脚本会：

- 把输入复制到 `/private/tmp/audio-transcription-inputs/`。
- 确认所选模型已缓存，只在缺失时下载。
- 把 `txt`、`srt`、`vtt`、`tsv` 和 `json` 写入 `/private/tmp/audio-transcriptions/<name>-<timestamp>/`。
- 检测明显的幻觉循环；在 `balanced` 模式下，必要时使用完整模型重新运行。

常用变体：

```bash
# 快速草稿，使用最快的缓存模型
./transcribe-audio.py audio.m4a --language zh --quality fast

# 重要或低质量录音，使用较慢的完整模型，并提供上下文词汇
./transcribe-audio.py audio.m4a --language zh --quality best \
  --prompt "关于人工智能、数据中心和项目规划的中文口述。"

# 只有语言确实未知时才自动检测
./transcribe-audio.py audio.m4a --language auto --quality balanced
```

## 缓存模型

默认模型：

- `fast`/`balanced`：`mlx-community/whisper-large-v3-turbo`
- `best` 回退：`mlx-community/whisper-large-v3-mlx`

预缓存或刷新两个模型：

```bash
./precache-models.py
```

手动检查缓存：

```bash
find ~/.cache/huggingface/hub -maxdepth 1 -type d -name 'models--mlx-community--whisper-large-v3*' -print
```

模型已缓存时，`mlx_whisper` 的 `Fetching 4 files: 100%` 应几乎立即完成。

## 手动命令模板

辅助脚本不适用时，可以直接运行：

```bash
mkdir -p /private/tmp/audio-transcriptions/manual
uvx --from mlx-whisper mlx_whisper "/stable/copy/of/audio.m4a" \
  --model mlx-community/whisper-large-v3-turbo \
  --language zh \
  --condition-on-previous-text False \
  --word-timestamps True \
  --hallucination-silence-threshold 2 \
  --output-format all \
  --output-dir /private/tmp/audio-transcriptions/manual \
  --output-name transcript \
  --verbose False
```

录音特别差时，把模型替换为 `mlx-community/whisper-large-v3-mlx`。

## 质量检查

先查看 `.txt`，再检查可疑位置对应的 `.srt` 和 `.json`。以下情况需要重跑或清理：

- 同一句话连续重复多行。
- 大量零时长片段。
- JSON 中 `avg_logprob` 为 `NaN`，或压缩率异常高。
- 文本与 prompt 中明确给出的 context vocabulary 矛盾。

最终结果可以适度补标点、分段，但不要过度改写不确定内容。
