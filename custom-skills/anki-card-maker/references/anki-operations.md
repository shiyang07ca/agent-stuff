# Anki 操作说明

卡片发布前，候选 JSON 用于审核；发布后，以 Anki 中的内容为准。新增卡片和维护旧卡是两种不同操作：`publish_anki.py` 只能新增 note，`anki_notes.py` 只能按 Anki note ID 读取或维护已有 note。

## 使用前确认

1. Anki 桌面端已打开并安装 AnkiConnect。
2. 本地接口可访问：`http://127.0.0.1:8765`。
3. 默认牌组 `Mnemosyne` 已存在。
4. Anki 中存在 `Basic` 和 `Cloze` note 类型及其标准字段。

所有命令默认只读或预览。只有用户明确同意当前写入后才能使用 `--write`；一次授权不能自动用于下一次发布、修改、暂停或删除。

## 查询现有卡片

按 Anki 搜索语法查询 note：

```bash
python3 scripts/anki_notes.py find 'deck:Mnemosyne bash'
```

查看一个确定的 note：

```bash
python3 scripts/anki_notes.py show 1234567890
```

为新批次检查重复时，应查询相关牌组和主题，并保留暂停卡片；不要在查询中使用 `-is:suspended`。先比较 Front/Text 测试的知识是否相同，再比较文字。同一个原理只是换了例子、顺序或说法，也按重复处理。

如果查询得到多个可能目标，先展示结果并缩小范围。更新、暂停和删除都必须使用唯一 note ID，不能凭模糊文字选择目标。

## 发布新卡

先运行发布前检查，不写入 Anki：

```bash
python3 scripts/validate_cards.py cards.json --strict-publish
python3 scripts/publish_anki.py cards.json
```

`publish_anki.py` 会执行以下检查：

1. 只选择当前文件中 `status` 为 `approved` 的卡片。
2. 确认牌组和 note 类型字段存在。
3. 读取牌组中所有 note，包括暂停卡片，并拒绝已有相同 Front/Text 的候选卡。
4. 调用 `canAddNotes`，拒绝 Anki 不允许添加的 note。

脚本只能发现相同或规范化后相同的问题。含义相同但措辞不同的卡片，需要在生成草稿前由 Agent 比较。

用户明确允许发布当前批次后执行：

```bash
python3 scripts/publish_anki.py cards.json --write
```

发布只调用 `addNotes`。遇到相似旧卡时停止并报告，不能调用更新接口，也不能删除旧卡后重新创建。成功时报告每张候选卡对应的 Anki note ID；失败项必须明确列出。

## 更新现有 note

先用 `show` 读取 Anki 当前字段，再创建一次性修改文件：

```json
{
  "note_id": 1234567890,
  "fields": {
    "Front": "包含必要背景的新问题",
    "Back": "直接回答问题的新答案"
  }
}
```

`fields` 只写需要修改的字段。先预览：

```bash
python3 scripts/anki_notes.py update change.json
```

向用户展示原字段、新字段和修改理由。用户确认这张 note 后才执行：

```bash
python3 scripts/anki_notes.py update change.json --write
```

更新使用 `updateNoteFields`，不会删除或重新创建 note。脚本拒绝不存在的 note ID、空字段集合和该 note 不具备的字段名。

## 暂停卡片

默认先暂停质量差、价值不确定或暂时不值得复习的卡片，而不是删除：

```bash
python3 scripts/anki_notes.py suspend 1234567890
```

用户确认后执行：

```bash
python3 scripts/anki_notes.py suspend 1234567890 --write
```

写入时给 note 添加 `retired` 标签，并暂停该 note 生成的全部 card。以后检查重复时仍要读取这些卡片，避免再次生成。

## 删除 note

只有明确重复、明显垃圾或用户明确要求永久删除时才使用。先查看并预览：

```bash
python3 scripts/anki_notes.py show 1234567890
python3 scripts/anki_notes.py delete 1234567890
```

真正删除时，`--write` 和 `--confirm-note-id` 缺一不可，且两个 note ID 必须完全相同：

```bash
python3 scripts/anki_notes.py delete 1234567890 --write --confirm-note-id 1234567890
```

不要批量删除，也不要根据旧 JSON 中的候选 `id` 删除 Anki note。

## 失败处理

- AnkiConnect 无法访问、返回 `error` 或返回意外结构时，停止当前操作并报告原因。
- 批次中发现重复或 `canAddNotes` 拒绝任何候选卡时，不执行 `addNotes`。
- 不自动重试写操作。重新执行前先确认 Anki 中的实际状态，避免重复新增或重复操作。
- 只报告 AnkiConnect 实际返回的结果；不能把 dry-run、命令启动或部分成功描述成完整成功。
