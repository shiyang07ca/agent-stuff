# Agent Stuff

个人 Agent 配置的统一维护仓库。通用指令、技能、Pi 扩展和 Pi 配置在这里修改，通过 Git 分发到各台 Mac；认证、会话、缓存和进程状态留在本机。

默认模型是 `sub2api/gpt-6.1-sol`，Sub2API 使用本地示例地址 `http://127.0.0.1:8080/v1`；实际地址可通过下文的本机配置覆盖。Pi 开发验证依赖由 `pi/package.json` 和 lockfile 固定，不要求各台 Mac 的宿主 Pi 版本一致。

## 修改哪里

| 内容 | 来源 |
| --- | --- |
| 共享指令 | `global/AGENTS.md` |
| 自维护技能 | `custom-skills/` |
| 第三方技能 | `vendors/` 中固定 commit 的 submodule |
| 技能启用和调用方式 | `config/agent-control.toml` |
| Pi 默认模型、显示、压缩和搜索设置 | `config/pi/settings.json` |
| Pi 模型定义和服务地址 | `config/pi/models.json` |
| Pi 快捷键 | `config/pi/keybindings.json` |
| Pi 模式定义 | `config/pi/modes.json` |
| Pi 扩展、技能、命令和主题 | `pi/`，详见 [资源说明](pi/README.md) |
| 编排角色模型 | `pi/extensions/orchestrate.ts` 的 `CONFIG` 和 `IMPLEMENTERS` |

长期修改写入仓库。Pi 界面中的修改可以临时使用，下次 `apply` 会恢复仓库中的共享配置。需要保留某项界面修改时，查看 `make plan` 的差异，再修改对应源文件；没有自动收录或双向合并。

## 首次安装

需要 Git、Python 3.11+、Node.js 22.19+、npm，以及 Pi。已有环境还依赖 `uv`、`tmux`；按实际使用的技能准备 Chrome、Ghidra、语音模型等工具。

将这个仓库（包含 submodule）克隆到自己的路径后进入目录：

```bash
export AGENTS_HOME="$HOME/code/agent-stuff"
git clone --recurse-submodules https://github.com/shiyang07ca/agent-stuff.git "$AGENTS_HOME"
cd "$AGENTS_HOME"
git submodule update --init --recursive
make prepare
make check
make plan
```

`make prepare` 使用两个已有 lockfile 安装 Pi 包和浏览器技能依赖，不写 HOME 配置。`make check` 使用临时目录检查配置、资源加载和后台任务，不调用模型。

查看完整计划及最后的指纹后执行：

```bash
make apply PLAN=<fingerprint>
make doctor
```

配置工具只依赖 Python 标准库。需要使用 uv 选择 Python 时，可运行 `uv run --no-project python -m agent_control plan`；Make 的 Python 路径可通过 `PYTHON` 覆盖。

每台机器单独准备模型服务连接和 Pi 认证。认证保存在本机 `auth.json`，不会随仓库分发。已有 `models.json` 中的凭据尚未配置到 `auth.json` 时，计划会以 `PI_AUTH_MIGRATION_REQUIRED` 阻断，防止应用后丢失认证。

## 日常更新

先结束正在运行的 Agent 任务，再执行：

```bash
make update
make apply PLAN=<刚刚显示的指纹>
make doctor
```

`update` 要求干净的工作区和已配置的 upstream 分支。它只做 `git pull --ff-only`、按记录更新 submodule、安装锁定依赖、检查并展示计划；不会自动 apply、升级 Pi、追踪第三方最新版或解决 Git 冲突。检查失败时停止，已拉取的源码留在原处。

Pi 本地 package 直接读取 `pi/`，因此拉取后新会话或 `/reload` 就可能加载新代码。更新过程不要启动新 Pi 或 reload；全部完成后再重新加载。配置工具不提供跨进程或跨机器的原子发布。

在任意一台机器修改源文件、检查并提交推送后，其他机器执行上述流程。仓库地址为 [shiyang07ca/agent-stuff](https://github.com/shiyang07ca/agent-stuff)。未配置 upstream 的 checkout 可以使用 `prepare / check / plan / apply`，`update` 会明确拒绝不完整的 Git 设置。

## 本机文件如何使用

```text
~/.codex/AGENTS.md  -> <repo>/global/AGENTS.md
~/.claude/CLAUDE.md -> <repo>/global/AGENTS.md
~/.pi/agent/AGENTS.md -> <repo>/global/AGENTS.md
~/.agents/skills   -> <repo>/.runtime/current/skills
~/.claude/skills   -> <repo>/.runtime/current/skills

~/.pi/agent/settings.json     <- 生成的普通文件，包含 <repo>/pi 路径
~/.pi/agent/models.json       <- 生成的普通文件，不含凭据
~/.pi/agent/keybindings.json  <- 生成的普通文件
~/.pi/agent/modes.json        <- 生成的普通文件
```

Pi 原生读取 `~/.agents/skills`，无需再配置一份通用技能路径。技能先复制到 `.runtime` 后切换；Pi 资源直接加载 `pi/`。同名技能只维护一份。

Codex、Claude 和 Pi 的全局指令入口均指向 `global/AGENTS.md`。已有未知文件或链接会阻止应用，不会被覆盖。Pi 全局指令入口仅在仓库启用 Pi 配置时管理。

`settings.json` 保留本机 `lastChangelogVersion` 和 `extensionChangelogVersions`，`modes.json` 保留仍有效的本机 `currentMode`。其余共享值按仓库生成，包括删除的配置项。`auth.json`、`trust.json`、`models-store.json`、sessions、background、tmux-subagents、socket 和日志不被日常 apply 修改。

需要本机模型地址时，创建 `~/.config/agent-stuff/local.json`，只覆盖仓库中已有 provider 的 `baseUrl`：

```json
{
  "providers": {
    "sub2api": {
      "baseUrl": "https://models.example.com/v1"
    }
  }
}
```

文件不存在时使用仓库地址。该文件只允许顶层 `providers`，每个 provider 只允许 `baseUrl`；地址须为非空 HTTP(S) URL，不能含凭据、查询参数或片段。覆盖结果会出现在 `make plan` 的 Pi 文件差异和指纹中，格式或取值错误会阻断 plan、doctor 和 apply。`validate` 与 `make check` 不读取这份本机配置。认证仍写入本机 `auth.json`。

## web-browser 本机注册

macOS 上启用 `web-browser` 技能后，`make plan` 会展示 Edge 和 Chrome 的 Native Messaging 注册、启动入口、权限及具体内容差异，并打印稳定的扩展加载目录：

```text
~/Library/Application Support/agent-stuff/web-browser/extension
```

审阅并应用计划后，在要使用的浏览器 profile 中开启扩展开发者模式，选择“加载解压缩的扩展”，使用上述目录。每种浏览器只在一个日常 profile 中加载。扩展 ID 固定为 `ddgmfcjoimgcdlbeigjpbdaobbnemjfn`。更新并应用后，在扩展管理页重新加载扩展。该实体目录由配置工具从 Skill 源码生成；浏览器会解析符号链接，所以不能加载 `.runtime/current` 或历史快照中的扩展目录。

注册文件为 `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/io.agent_stuff.web_browser.json` 和 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.agent_stuff.web_browser.json`。它们仅允许上述扩展，通过 `stdio` 启动 `~/Library/Application Support/agent-stuff/web-browser/native-host-edge` 或 `native-host-chrome`。入口使用计划时找到的 Node 绝对路径和 `.runtime/current` 下的桥接脚本，浏览器无需继承终端 PATH。更换 Node 安装位置后重新运行 plan/apply。

这些文件参与计划指纹和失败恢复。遇到不符合本工具完整生成格式的已有文件或符号链接时停止，不覆盖未知注册。`make doctor` 只检查文件、权限、资源和必要工具；首次尚未加载扩展不会导致 apply 失败，在线连接需由技能的连接诊断命令检查。

停用配置项后不再管理这些注册文件。卸载时先在浏览器移除本扩展，核对上述两个注册文件、两个入口和扩展实体目录确实由当前仓库生成后，仅删除这些文件，再停用技能并按 plan/apply 更新技能副本。保留浏览器 profile、独立模式数据和其他 Native Messaging 注册。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `make prepare` | 安装锁定依赖 |
| `make update` | 拉取、准备、检查、预览 |
| `make validate` | 检查技能、Pi 配置和引用，不读 HOME、不联网 |
| `make plan` | 只读显示本机将发生的全部变化和指纹；凭据脱敏 |
| `make apply PLAN=…` | 应用与预览匹配的变化；过期指纹被拒绝 |
| `make doctor` | 检查本机配置、入口和必要工具，不比较宿主 Pi 版本 |
| `make check` | 运行 Python 测试、配置检查和 Pi 资源验证 |
| `make list-skills` / `make audit-skills` | 查看技能或复核风险提示 |
| `make vendor-plan VENDOR=… TARGET=…` | 预览一个第三方来源的版本更新 |
| `make vendor-apply VENDOR=… TARGET=<commit> PLAN=…` | 更新已审查的来源版本，不自动启用 |

技能维护细节见 [Skill 管理](docs/skill-management.md)。第三方更新不会自动提交或应用。各台 Mac 自行安装和升级宿主 Pi；升级后检查实际资源加载与使用情况，出现错误时针对错误处理。更新仓库开发验证版本时，修改 `pi/package.json` 的开发依赖和 lockfile，并运行 `make check`；检查通过不代表所有宿主版本都兼容。

## 许可证与恢复

本仓库采用 [Apache-2.0](LICENSE)。改写和参考来源见 [第三方许可说明](THIRD_PARTY_NOTICES.md)，`vendors/` 中的 submodule 遵循各自许可证。

应用失败会尝试恢复本次修改前的文件、链接和技能副本。重要本机数据应独立备份；工具不维护永久快照库或额外回滚服务。
