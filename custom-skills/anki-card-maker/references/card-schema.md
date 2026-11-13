# 候选卡片 JSON 结构

候选 JSON 只用于发布前审核。卡片发布后，以 Anki 中的字段、标签和复习状态为准；不要把旧 JSON 当成卡片的当前版本，也不要用它覆盖 Anki。

## 顶层结构

```json
{
  "deck": "Mnemosyne",
  "learning_goal": "记住以后会在多个项目中反复使用的判断方法。",
  "cards": [],
  "rejected_candidates": []
}
```

`deck` 省略时按 `Mnemosyne` 处理。`cards` 必须是数组。`learning_goal` 用一句话说明为什么学习这些内容，以及以后会在哪里使用。

`rejected_candidates` 是可选项，只记录看起来可能值得制卡、但检查后被排除的知识。无需列出材料中每个没有制卡的段落。

```json
{
  "point": "文章发布日期",
  "reason": "发布日期只用于查找原文，不需要记忆。",
  "source": "https://example.com/article#introduction"
}
```

## Basic 卡

```json
{
  "id": "anki-card-maker-2026-06-23-001",
  "type": "basic",
  "front": "在 Anki 制卡流程中，为什么制卡前要先确认内容已被理解？",
  "back": "理解是可靠主动回忆的前提。",
  "extra": "未理解时先解释或标为 needs_review。",
  "source": "conversation:2026-06-23",
  "tags": ["ai_generated", "codex", "date_2026_06_23", "anki"],
  "priority": 2,
  "status": "draft",
  "selection_reason": "这是筛选长期记忆内容的高频判断标准。"
}
```

发布为 Anki `Basic` note 时：`Front` <- `front`，`Back` <- `back`；`extra` 和 `source` 追加到 `Back` 下方。

## Cloze 卡

```json
{
  "id": "anki-card-maker-2026-06-23-002",
  "type": "cloze",
  "text": "Anki 卡片的问题应写明{{c1::在说哪种技术或哪篇资料}}和{{c2::正在解决什么事情}}，不能只写课次或文件名。",
  "extra": "这样复习时只看问题也能明白它在问什么。",
  "source": "conversation:2026-06-23",
  "tags": ["ai_generated", "codex", "date_2026_06_23"],
  "priority": 1,
  "status": "draft",
  "selection_reason": "这是防止卡片脱离原材料后变得难以理解的直接检查规则。"
}
```

发布为 Anki `Cloze` note 时：`Text` <- `text`，`Extra` <- `extra`；`source` 追加到 `Extra` 下方。

## 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 当前批次内唯一，用于审核、报错和对应发布结果 |
| `type` | 是 | `basic` 或 `cloze` |
| `front` | Basic 必填 | 通过 `card-principles.md`“只看问题检查”的问题 |
| `back` | Basic 必填 | 直接、简短且可核对的答案 |
| `text` | Cloze 必填 | 含 `{{c1::关键内容}}` 的填空文本 |
| `extra` | 否 | 推理、反例、适用条件、证据说明或容易混淆的情况 |
| `source` | 是 | 能找到材料原文的具体位置；必要时附核对事实的一手资料 |
| `tags` | 是 | 非空字符串数组，含默认标签和有效日期标签 |
| `priority` | 是 | 1 至 4 |
| `status` | 是 | `draft`、`needs_review`、`approved` 或 `rejected` |
| `selection_reason` | 除 rejected 外必填 | 说明它会在哪个场景有用、避免什么问题，或帮助理解什么知识 |

`id` 不用于更新 Anki 中的旧 note，也不会让仓库文件成为 Anki 的副本。优化已发布卡片时，先读取 Anki 当前内容，再使用 Anki note ID 更新。

`draft`、`needs_review` 和 `approved` 都必须填写 `selection_reason`。具体的内容取舍、问题背景和事实核对规则以 `card-principles.md` 为准。

## 发布要求

- 只有 `approved` 卡会被 `publish_anki.py` 选择。
- `approved` 卡必须包含符合 `date_YYYY_MM_DD` 格式的有效日期标签。
- `approved` 卡只使用 `priority: 1` 或 `priority: 2`。如果用户确认保留 `priority: 3` 卡，先重新判断价值并改成合适优先级。
- `priority: 4` 应为 `rejected`，不能发布。
- 候选文件可以同时包含不同状态；发布脚本只选择其中的 `approved` 卡。不要维护累积式 `approved.json`。
