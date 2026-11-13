---
name: update-changelog
description: "更新仓库 CHANGELOG 前必须阅读的操作规范。"
---

把上一个发布版本到当前版本之间尚未记录的重要变更写入仓库 changelog。优先使用 `CHANGELOG.md`，不存在时使用 `CHANGELOG`。

## 操作步骤

### 1. 确定基准版本

用户未指定时，使用最近的 Git tag：

```bash
git describe --tags --abbrev=0
```

### 2. 获取 commit 记录

```bash
git log <baseline-version>..HEAD
```

### 3. 更新 changelog

阅读现有 changelog，确认哪些变化尚未记录，默认添加到 `Unreleased` 章节。不存在该章节时，按照现有格式在顶部创建，例如 `## Unreleased` 或 `## [Unreleased]`。

实际发布时按仓库发布规约操作：先用 `npm version <patch|minor|major> --no-git-tag-version` 更新版本文件，再把本次 `Unreleased` 内容整理到新版本章节并保留空的 `Unreleased`。基准仍是上一次发布标签；完成 changelog 和验证后，才提交并创建新标签。

## 内容规则

- 聚焦影响用户的重要变化：新功能、修复、破坏性变更。
- 有 PR 编号时写 `#NUMBER`，不要写原始 commit SHA。
- 忽略错别字、内部重构和轻微文档更新等不重要变化。
- 相关变化可以合并描述。
- 按重要性排序：破坏性变更、新功能、修复。

## 写作风格

- 使用有效 Markdown。
- 每条使用过去式或明确的描述性短语开头。
- 简洁，但要让读者看懂变化。
- 使用 `*` 或 `-` 列表。
- 代码引用使用反引号，例如 `foo.cleanup`。
- 默认使用中文；项目已有其他语言或风格时保持一致。

## 示例

```markdown
## 2.13.0

* 为 `|sort` 过滤器增加多键支持。#827
* 修复 `strict undefined` 模式下 `not undefined` 的行为。#838
* 增加对 free-threaded Python 的支持。#841

## 2.12.0

* Python 的 item 或 attribute 查找不再吞掉所有异常。#814
* 新增 `|zip` 过滤器。#818
```

好的条目应说明影响，例如：

- `修复 TypeScript SDK 为 CJS 生成错误配置的问题。`
- `支持延长 checkpoint write 的任务认领超时。`
- `改善任务认领过期时的错误信息。`

避免模糊或与用户无关的条目，例如：

- `修复 bug`
- `更新依赖`
- `重构内部代码结构`
- `修复注释错字`

## 说明

- `Unreleased` 已有内容时追加，不要覆盖。
- 保持原有标题、列表、顺序和空行风格。
- 默认分支不是 `main` 时，以项目实际默认分支代表当前版本。
- 无法判断某项变化是否重要时，倾向于保留，但不要夸大影响。
