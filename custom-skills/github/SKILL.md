---
name: github
description: "使用 `gh` CLI 操作 GitHub，包括 issue、PR、Actions 运行记录和高级查询。"
---

# GitHub 技能

使用 `gh` CLI 与 GitHub 交互。不在 Git 仓库目录中时，始终通过 `--repo owner/repo` 指定仓库，也可以直接使用 URL。

## Pull Request

检查 PR 的 CI 状态：

```bash
gh pr checks 55 --repo owner/repo
```

列出最近的 workflow 运行：

```bash
gh run list --repo owner/repo --limit 10
```

查看某次运行及失败步骤：

```bash
gh run view <run-id> --repo owner/repo
```

只查看失败步骤的日志：

```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## 高级查询

其他子命令无法提供所需数据时，使用 `gh api`：

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## JSON 输出

大部分命令支持 `--json`，可以配合 `--jq` 筛选：

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
