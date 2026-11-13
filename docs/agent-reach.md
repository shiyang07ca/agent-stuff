# Agent Reach 安装与更新

本仓库分别管理 Agent Reach 的 Skill 和工作站 CLI：Skill 由本仓库复制到 Agent 使用位置；1.6 起 CLI 安装在独立的 `uv tool` 环境中。两者使用同一个固定版本的三方仓库，但更新一方不会自动更新另一方。

## Skill

- 上游仓库位于 `vendors/agent-reach`，父仓库记录一个明确的 commit。
- Skill 文件位于 `vendors/agent-reach/agent_reach/skill`。
- Agent 使用上游的中文 `SKILL.md`；同目录的 `SKILL_en.md` 只作参考。
- `expected_name = "agent-reach"` 用来核对上游 `SKILL.md` 中的真实名称。
- `invocation = "explicit"` 表示只有用户点名时才调用。
- 新 Skill 必须经过 `make plan` 和 `make apply PLAN=<fingerprint>` 才会复制到本机使用位置。
- 1.6 的上游 Skill 含 `{{VERSION}}` 和 `{{CHANNEL_TABLE}}` 模板；本仓库保留原文件，不执行上游动态渲染。实际版本和渠道分别通过 `agent-reach version`、`agent-reach channels` 查询。

更新上游版本时一次只处理一个目标：

```bash
make vendor-plan VENDOR=agent-reach TARGET=<ref>
make vendor-apply VENDOR=agent-reach TARGET=<exact-commit> PLAN=<fingerprint>
```

`vendor-apply` 不会启用新 Skill。更新完成后，重新查看 `make plan`，再决定是否执行 `make apply`。

## 工作站 CLI

CLI 使用 Python 3.11，从本仓库固定的源码安装到独立的 `uv tool` 环境。不要从 PyPI 安装同名包，它不是本项目。

```bash
uv tool install --force --python 3.11 "$AGENTS_HOME/vendors/agent-reach"
```

从 1.5 的 pipx 安装迁移时，先移除旧 CLI，再执行上述安装命令；保留 `~/.agent-reach` 中的配置和密钥。以后更新 submodule 后，重新执行上述安装命令。

```bash
pipx uninstall agent-reach
```

然后核对：

```bash
agent-reach version
agent-reach doctor
```

1.6 的命令默认输出 JSON，核对 `ok`、`result` 和 `error.hint`。`doctor` 不安装 Skill；渠道显示 `unverified` 表示尚未实测，缺少依赖时按需执行 `agent-reach add <渠道>`。迁移后可选渠道需要按需重新添加，不代表旧登录状态已验证。

## 不要使用上游安装命令管理 Skill

在本仓库环境中不要运行：

```text
agent-reach install
agent-reach setup
agent-reach update
agent-reach skill link <skills-dir>
agent-reach skill --install
agent-reach skill --uninstall
agent-reach uninstall
npx skills add Panniantong/Agent-Reach@agent-reach
```

这些命令可能直接创建、覆盖或删除 `~/.agents/skills`、`~/.claude/skills`、Agent Reach 配置和 MCP 条目，绕过本仓库的 `make plan` 与 `make apply`。

上游更新指南要求 1.5 用户迁移到 uv 后执行 `setup`。本仓库使用固定源码安装 CLI、按需添加渠道并通过 `make apply` 生成 Skill，以保留本仓库对 Skill 文件的管理。

登录信息、浏览器 Cookie、代理、API Key 和 MCP 配置不会因为启用 Skill 而自动获得使用授权。每次配置或写入外部平台仍以用户当前请求为准；凭证只保存在限制访问权限的本机配置中，不写入仓库、日志或答复。
