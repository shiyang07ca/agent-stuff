---
name: anki-card-maker
description: Use when turning learning conversations, notes, articles, webpages, PDFs, or papers into reviewed Anki cards; checking card quality; publishing approved new cards; or improving, suspending, and deleting existing Anki notes after explicit approval.
---

# Anki Card Maker

只把已经理解、确实值得长期记住，并能帮助实际工作或理解重要原理的知识制成卡片。卡片不是材料摘要，也不以数量为目标。

候选 JSON 只用于发布前审核。卡片发布后，以 Anki 中的内容为准；以后在 Anki 中修改、暂停或删除，不要求改回来源仓库，也不能用旧候选文件覆盖 Anki。

## 默认配置

- 牌组：`Mnemosyne`
- 标签：`ai_generated`、`codex`、`date_YYYY_MM_DD`
- note 类型：问答用 `Basic`，短定义、公式或固定条件用 `Cloze`
- AnkiConnect：`http://127.0.0.1:8765`
- 候选卡初始状态：`draft`；只有用户逐张或明确批量确认后才改为 `approved`

先判断用户要做哪件事：生成并发布新卡片、优化 Anki 现有卡片，或者暂停或删除卡片。不要把三种操作混在一起。

## 生成并发布新卡片

1. **先理解材料。** 阅读完整内容，说明它解决什么问题、主要概念怎样关联，以及用户以后会在哪里使用。只有材料范围太大、目标不清或不同理解会选出不同卡片时，才先请用户确认知识点。只有学习进度、目录或摘要而没有解释、例子和适用条件时，继续找完整材料；找不到就产出 `0` 张卡或请求材料。

2. **先检查 Anki 中已有内容。** 读取 `references/anki-operations.md`，查询相关牌组和主题的现有 note。比较时包括暂停卡片，并判断知识含义是否重复，不能只比较问题文字。同一个原理只是换了示例或措辞，不再制卡。无法访问 Anki 时可以生成草稿，但必须说明尚未检查重复，而且不能发布。

3. **选择值得记住的知识。** 必读 `references/card-principles.md`。优先保留经常需要做出的判断、忘记后果严重的知识、容易混淆的条件，以及能解释多个实际行为的重要原理。常识、小细节、参数清单、重复卡和使用时查一下更划算的内容不制卡。

4. **核对事实。** 命令行为、重要原理、研究结论和教材中的可疑表述，优先查官方手册、正式规范、维护者文档或原论文。材料与一手资料冲突时按一手资料修正，并在 `extra` 说明差异。无法核实的内容标为 `needs_review` 或拒绝。

5. **生成候选卡。** 按 `references/card-schema.md` 写 JSON。一张卡只问一件事；Front/Text 写清技术、资料或实际任务和必要条件，不能只写课次、文件名、“上述内容”或其他离开原材料就看不懂的说法。Back 直接回答问题，补充解释和证据放在 Extra。

6. **检查并让用户审核。** 执行：

   ```bash
   python3 scripts/validate_cards.py cards.json
   python3 scripts/render_review.py cards.json --output review.md
   ```

   先只看 Front/Text，确认它有足够背景、只问一件事且不能靠猜；再看答案、来源和保留理由。根据用户反馈改为 `approved`、`needs_review` 或 `rejected`。程序零警告不代表卡片一定清楚、有用或正确，仍需逐张阅读。

7. **先做只读发布检查。** 用户批准卡片后执行：

   ```bash
   python3 scripts/validate_cards.py cards.json --strict-publish
   python3 scripts/publish_anki.py cards.json
   ```

   发布脚本会再次读取 Anki，拒绝已有相同问题和 Anki 不允许添加的 note。它只选择当前批次中的 `approved` 卡，不需要生成累积式 `approved.json`。

8. **获得写入许可后发布。** 只有用户明确允许写入 Anki，才执行：

   ```bash
   python3 scripts/publish_anki.py cards.json --write
   ```

   只报告 AnkiConnect 实际返回的新增 note ID 和失败项。发布流程只能新增 note；遇到相似旧卡时停止并报告，不能自动更新旧卡。

## 优化 Anki 现有卡片

适用于复习时发现问题缺少背景、表述难懂、答案冗长，或成立条件没有说清。

1. 读取 `references/anki-operations.md`，通过 `find` 找到卡片，再用 `show` 确认唯一 note ID 和 Anki 当前内容。
2. 判断需要修改 Front、Back、Text 还是 Extra。涉及事实变化时回到原材料或一手资料核实，但不要求修改来源仓库。
3. 展示修改前后内容；Front 只补回答所需的技术、任务和条件，不复述整段材料。
4. 把 note ID 和准备修改的字段写入一次性 JSON，先运行 `anki_notes.py update` 查看计划。
5. 只有用户确认这次修改后才加 `--write`。必须按 note ID 更新字段，不能删除后重新创建，也不能顺手修改其他卡片。

## 暂停或删除卡片

- 卡片价值不确定、质量差或暂时不适合继续复习时，默认暂停并添加 `retired` 标签。以后检查重复时仍要把它算作已有卡片。
- 只有明确的重复卡、垃圾卡或用户明确要求删除的卡才删除。先用 `show` 展示目标；真正删除时除 `--write` 外，还必须用 `--confirm-note-id` 再写一次相同 note ID。
- 没有明确写入许可时只运行预览。不要批量暂停或删除，也不要从“清理卡片”等概括说法推定删除许可。

## 按来源取舍

- **AI 会话、笔记或课程**：保留以后还能用于其他场景的原理、判断条件、反例和关键区别；不把待办、临时决定、学习进度或当时环境状态制成卡片。
- **文章或网页**：先说明阅读目的，再保留有证据、值得长期记住的观点。观点卡在 Front 中写明作者或文章，不能把作者观点写成公认事实。
- **论文或技术资料**：第一次阅读只做少量术语、研究问题、方法、主要观点和限制卡；深入阅读后，再补确实会用到的证据、成立条件和方法区别。不要按段落机械拆卡。

## 制卡决策

- 用 `basic` 询问原因、成立条件、区别、反例，或者实际工作中需要做出的一个选择。
- 用 `cloze` 记短定义、公式、固定措辞或稳定限制；每张只挖 1 到 2 个空，挖空后的句子仍要单独看得懂。
- 判断题通常改问“为什么”“什么条件下成立”“举一个例子”或“什么反例”，不要让用户只回答“是”或“否”。
- 不制卡：尚未理解的内容、长摘要、清单、没有证据的推测、常识、小细节，以及使用时查一下就够的信息。
- 问题应写明所用技术或资料、正在解决的事情和一个明确问题。课次、学习日期和文件位置只写入 `source`，不要出现在问题中。
- `source` 用来找到原文，不能代替 Front/Text 中的必要背景。Back 保持简短，补充解释、例外和证据放在 Extra。
- 命令和流程卡只帮助记住使用时机、关键选择和容易犯的错误，不能代替动手练习；不要把一整套操作步骤塞进卡片。

## 资源

- `references/card-principles.md`：生成或审查卡片时必读；说明哪些知识值得做卡、怎样核对事实，以及怎样写出脱离原材料也能理解的问题。
- `references/card-schema.md`：生成或修改候选卡片 JSON 时读取。
- `references/anki-operations.md`：查询 Anki，或在获得相应许可后发布、更新、暂停和删除时读取。
- `scripts/validate_cards.py`：检查候选 JSON 和程序能够发现的卡片问题。
- `scripts/render_review.py`：生成先显示问题、再显示答案和来源的待确认文档。
- `scripts/publish_anki.py`：检查 Anki 中已有问题，并只发布当前批次中批准的新卡。
- `scripts/anki_notes.py`：读取 note，或按明确 note ID 预览和执行更新、暂停、删除。
