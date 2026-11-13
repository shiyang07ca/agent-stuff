---
name: librarian
description: "把远程 Git 仓库缓存到 `~/.cache/checkouts/<host>/<org>/<repo>`，后续引用时复用并按需刷新。"
---

当用户给出远程 Git 仓库时使用本技能，包括 GitHub、GitLab、Bitbucket URL、`git@...` 地址或 `owner/repo` 简写。

目标是维护一个可复用的本地检出：

- **路径稳定**：仓库总能在可预测的位置找到。
- **内容较新**：定期执行 `fetch`，并在安全时 fast-forward。
- **节省资源**：使用 `--filter=blob:none` 部分克隆，避免反复完整下载。

## 缓存位置

仓库存放在：

`~/.cache/checkouts/<host>/<org>/<repo>`

示例：

`github.com/openai/openai-python` → `~/.cache/checkouts/github.com/openai/openai-python`

## 命令

```bash
bash checkout.sh <repo> --path-only
```

示例：

```bash
bash checkout.sh openai/openai-python --path-only
bash checkout.sh github.com/openai/openai-python --path-only
bash checkout.sh https://github.com/openai/openai-python --path-only
```

脚本会：

1. 把仓库引用解析为 host/org/repo。
2. 缓存不存在时执行克隆。
3. 已存在时复用原检出。
4. 超过刷新间隔后从 `origin` 执行 `fetch`，默认间隔为 300 秒。
5. 工作区干净且存在上游分支时，尝试 fast-forward。

## 更新策略

默认每五分钟至多刷新一次，避免无意义的网络请求。需要立即刷新时使用：

```bash
bash checkout.sh <repo> --force-update --path-only
```

## 推荐流程

1. 用 `checkout.sh --path-only` 获取稳定路径。
2. 在该路径中搜索、阅读和分析。
3. 后续再次引用同一仓库时重新运行脚本，由脚本检查并刷新缓存。

## 需要修改代码时

不要直接修改共享缓存。基于缓存创建独立 worktree 或副本，再进行任务相关修改。

## 说明

- `owner/repo` 默认解析为 `github.com`。
