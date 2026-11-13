---
name: summarize
description: "把 URL 或本地 PDF、DOCX、PPTX、HTML 等内容转换为 Markdown，并可按目的生成摘要。"
---

把网页、PDF、Word、PowerPoint、HTML 和文本文件等内容转换为 **Markdown**，以便像普通文本一样检查、引用和处理。

`markitdown` 可以自行抓取 URL；本 skill 主要封装保存与摘要流程。PDF 输入需要 `markitdown[pdf]`，下方包装脚本会自动使用该 extra。

## 适用场景

- 将网页保存成便于分析的 Markdown。
- 把 PDF、DOCX、PPTX 等二进制文档转成 Markdown。
- 深入处理长文档前，先生成聚焦的短摘要。

## 快速使用

### 转换 URL 或文件

先进入本技能目录，再运行：

```bash
uvx --from 'markitdown[pdf]' markitdown <url-or-path>
```

使用包装脚本写入临时文件并输出路径：

```bash
node to-markdown.mjs <url-or-path> --tmp
```

生成摘要时，脚本始终会把完整 Markdown 写入临时 `.md` 文件，并在最后一行 `Hint` 中输出路径，方便继续检查全文。

写入指定文件：

```bash
uvx --from 'markitdown[pdf]' markitdown <url-or-path> > /tmp/doc.md
```

### 转换并摘要

摘要必须说明要提取什么，以及面向谁或用于什么目的：

```bash
node to-markdown.mjs <url-or-path> --summary --prompt "重点总结 X，读者是 Y，并提取 Z。"
```

或：

```bash
node to-markdown.mjs <url-or-path> --summary --prompt "聚焦安全影响和后续行动。"
```

脚本会：

1. 通过 `uvx --from 'markitdown[pdf]' markitdown` 转换内容。
2. 保存完整 Markdown，并通过 `Hint` 输出临时文件路径。
3. 使用 Pi 当前默认 `provider` 和 `model`，并以 `low` thinking 在无 tool、无 session 模式下按 prompt 生成摘要。
