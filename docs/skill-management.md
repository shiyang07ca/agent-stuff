# Skill 管理

处理 Skill 配置、来源或本机副本前，先读本文件。完整命令和首次安装步骤见根 `README.md`。

## 应该修改哪里

- 自己维护的 Skill：`custom-skills/`
- 固定版本的三方 Skill：`.gitmodules` 声明的 `vendors/` 目录
- 启用列表、调用方式和数量限制：`config/agent-control.toml`

不要直接编辑 `.runtime/` 或 HOME 下的 Agent Skill 链接，它们会由上述文件重新生成。仓库也不维护第二份 Skill 清单或另一套 Shell 管理逻辑。

## 修改自己的 Skill

工程类 Skill 放在 `custom-skills/engineering/<name>/`，目录名与 `SKILL.md` 中的 `name` 相同。目录已经表达工程分类，名称不再添加 `engineering-` 前缀。

在配置中逐项启用：

```toml
[[skills]]
source = "custom-skills/engineering/<name>"
invocation = "implicit"
```

- `implicit` 允许模型根据请求自动选择。
- `explicit` 只允许用户点名调用。

每个 Skill 只解决一类明确问题。长任务使用 PRD、任务文件和交接记录继续，不增加一个只负责转发其他 Skill 的总入口。

修改后运行：

```bash
make validate
make audit-skills
make check
make plan
```

需要启用时，先查看 `make plan` 的完整输出和 `Plan fingerprint`，再运行：

```bash
make apply PLAN=<fingerprint>
make doctor
```

文件或本机状态改变后，旧标识不能继续使用。

## 更新三方 Skill

不要直接修改 `vendors/` 中的文件。一次只处理一个 `.gitmodules` 中声明的来源和一个目标 ref：

```bash
make vendor-plan VENDOR=<name> TARGET=<ref>
make vendor-apply VENDOR=<name> TARGET=<exact-commit> PLAN=<fingerprint>
```

`vendor-plan` 可以读取远端 commit，但不会切换 checkout。`vendor-apply` 只切换到确认过的 commit 并检查仓库，不暂存、不提交，也不启用新的 Skill；需要启用时再单独运行 `make plan` 和 `make apply`。

如果上游把 Skill 放在名为 `skill/` 的通用目录中，可以配置 `expected_name`，用它核对 `SKILL.md` 中的实际名称：

```toml
[[skills]]
source = "vendors/example/package/skill"
expected_name = "example-skill"
invocation = "explicit"
```

`expected_name` 只用于三方 Skill，不会重命名它。

## 各检查的范围

- `make validate`：不读 HOME、不访问网络、不改动本机 Skill；在临时目录中验证配置和所有 Skill。
- `make doctor`：只读检查当前机器上的 Skill 副本、链接和必需工具，不自动修复。
- `make audit-skills`：列出需要人工判断的提示，不会更改调用方式或授予操作权限。
- `make check`：运行测试、`make validate` 和 Git diff 格式检查，不调用 `make doctor`。
