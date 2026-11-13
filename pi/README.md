# Monte Pi

这是 Agent Stuff 内的个人 [Pi Coding Agent](https://buildwithpi.ai/) 资源包，用于维护 extensions、skills、prompt commands、themes 和辅助脚本。统一配置、安装和更新入口见[仓库说明](../README.md)。

仓库以“先使用、再裁剪、持续小步迭代”为原则，不作为 npm 公共包发布。Pi 通过 [package.json](package.json) 加载以下资源：

- [`extensions`](extensions)：运行时扩展
- [`skills`](skills)：Agent 技能及辅助脚本
- [`themes`](themes)：终端主题
- [`commands`](commands)：prompt commands

## 安装与学习

扩展的开发验证依赖由 `package.json` 和 lockfile 固定，运行根目录 `make prepare` 安装。Pi 加载扩展时使用宿主提供的 API，不要求各台 Mac 的宿主版本与开发依赖一致；仓库检查通过不代表所有宿主版本都兼容。

从工程根目录应用配置，工具会自动写入本资源包路径：

```bash
make plan
make apply PLAN=<fingerprint>
make doctor
```

使用配置界面启用或禁用单项资源：

```bash
pi config
```

只体验单个 skill：

```bash
pi --no-skills --skill ./skills/native-web-search
```

只体验单个 extension：

```bash
pi --no-extensions -e ./extensions/files.ts
```

## 提示命令（Prompt Commands）

Prompt commands 位于 [`commands`](commands)：

- [`/explain`](commands/explain.md)：临时讲解助手。解释当前卡点、公式、截图、Anki 卡片、文档或代码，支持自然追问；不主动组织课程或保存学习进度。例如：`/explain 为什么标准化要除以标准差？`。也可以附上材料或文件路径；不带参数时结合当前对话确定解释对象。后续直接说“没懂”“举个例子”或“展开推导”即可，无需重复调用。
- [`/onboard`](commands/onboard.md)：只读快速入门。无参数时介绍当前工程的业务与主要架构；有参数时只介绍指定的主题、模块或路径及必要背景，例如：`/onboard 权限和数据模型`、`/onboard extensions/orchestration`。
- [`/plan`](commands/plan.md)：规划访谈模式。先检查项目，再通过短轮次问题把粗略想法整理为可执行计划；只规划，不实施。

### workflow 快捷命令

[`workflow-shortcuts.ts`](extensions/workflow-shortcuts.ts) 提供三个中文 workflow 命令，实现参考 [dannote/dot-pi](https://github.com/dannote/dot-pi/blob/master/extensions/workflow-shortcuts.ts)：

- `/next [1-20] [big|b|coarse]`：简述当前状态并给出下一步。未指定数量时列出 1 至 5 个必要步骤；指定数量时严格按数量输出。`big`、`b` 和 `coarse` 使用粗粒度工作块，也接受 `/next 3 big`。
- `/discuss [主题]`：在行动前核实必要事实，讨论选项、权衡和风险，并给出明确推荐；只允许读取和查询，不修改、提交或推送。
- `/recap [关注点]`：从整个会话恢复原始目标、当前状态、决策、未完成事项、计划变化和最佳下一步；默认不调用工具。

这三个命令在 Pi 空闲时立即执行；运行启动中或执行中调用时，作为 follow-up 排队，在当前运行结束后执行。

## 技能（Skills）

本仓库保留以下 5 个技能，位于 [`skills`](skills)。每个技能都包含一个中文 `SKILL.md`，复杂技能还会附带辅助脚本。

- [`orchestration`](skills/orchestration)：说明 `/orchestrate` 会话级编排模式、角色化委派、验收和高风险终审规则。
- [`native-web-search`](skills/native-web-search)：跟随当前 `provider` 和 `model` 调用原生网页搜索；兼容 Sub2API standalone search，并可回退到 OpenAI Responses hosted search。
- [`pi-share`](skills/pi-share)：加载并解析 Pi 分享链接中的会话记录。
- [`summarize`](skills/summarize)：把 URL 或本地文档转换为 Markdown，并可生成聚焦摘要。
- [`update-changelog`](skills/update-changelog)：按仓库历史和现有风格更新 changelog。

`audio-transcription`、`commit`、`ghidra`、`github`、`librarian`、`sentry`、`tmux`、`uv` 和 `web-browser` 等通用技能位于 [`custom-skills/`](../custom-skills/)，其中 `commit` 位于 `engineering/commit/`。这些技能按[根目录安装说明](../README.md)统一启用，`uv` 扩展位于本资源包。`make prepare` 同时准备浏览器技能依赖。Pi 原生读取 `~/.agents/skills`，无需额外路径配置。

`telegram-knowledge` 位于 [`custom-skills/telegram-knowledge`](../custom-skills/telegram-knowledge)，同样由全局配置分发。上述技能的缓存、模型、凭据及服务配置保存在本机。

## 扩展（Extensions）

Pi extensions 位于 [`extensions`](extensions)：

- [`answer.ts`](extensions/answer.ts)：`/answer` 和 `ctrl+.`，从上一条 Agent 回复提取问题并提供交互式回答流程。
- [`btw.ts`](extensions/btw.ts)：`/btw` 旁路对话窗口，用于快速讨论临时问题，并支持恢复与重置。
- [`background.ts`](extensions/background.ts)：提供四个 background 任务工具和 `/background` 命令，用于管理跨 Pi 会话的非交互开发服务。
- [`continue.ts`](extensions/continue.ts)：Agent 停止时，按 `shift+option+enter` 发送 `continue`。
- [`control.ts`](extensions/control.ts)：通过 session-control socket、`send_to_session` 和 `list_sessions` 协调多个 Pi 会话。
- [`files.ts`](extensions/files.ts)：`/files` 文件树和变更列表，提供源码、Markdown、Git diff 预览与代码选区引用；支持外部编辑器、Cursor diff 和 Quick Look。
- [`goal.ts`](extensions/goal.ts)：`/goal` 长期目标模式会持续运行直到完成、阻塞、出错或达到限制，并支持预算统计；使用 `/goal --auto <目标>` 可在服务额度恢复后自动续跑。
- [`orchestrate.ts`](extensions/orchestrate.ts)：提供 `/orchestrate`、`/orchestrate off` 和 `/orchestrate status`；主会话支持 `CONFIG.plannerModels` 中的模型，启用及恢复时保留当前支持的模型，互切保持编排开启，切换到其他模型或 virtual model 则关闭；可直接完成局部低风险任务，较大任务按角色串行委派，独立终审和决策咨询使用 `CONFIG.reviewer`；关闭时委派工具不会暴露给普通模型。
- [`unified-edit.ts`](extensions/unified-edit.ts)：替换内置 `edit`，使用完整 patch 修改文件，并在写入前预检。
- [`no-sleep.ts`](extensions/no-sleep.ts)：在 macOS 上通过 `caffeinate` 防止 Agent 运行时休眠。
- [`notify.ts`](extensions/notify.ts)：Agent 完成并等待输入时发送终端桌面通知。
- [`prompt-editor.ts`](extensions/prompt-editor.ts)：`/mode`、`ctrl+shift+m` 和 `ctrl+space` 模型模式选择器。
- [`review.ts`](extensions/review.ts)：`/review` 与 `/end-review`，审查未提交变更、分支、commit、PR 或目录 snapshot。
- [`session-breakdown.ts`](extensions/session-breakdown.ts)：以 TUI 查看最近 7、30、90 天的会话、token、模型和费用统计。
- [`split-fork.ts`](extensions/split-fork.ts)：在 macOS Ghostty 右侧新建 split，并 fork 当前会话。
- [`subagent.ts`](extensions/subagent.ts)：通过 tmux 串行运行一个可观察、运行期间可重新 attach 的 Pi subagent；结束后保留状态、结果和子会话记录并删除 tmux 会话。
- [`todos.ts`](extensions/todos.ts)：`/todos` TUI 和 `todo` 工具，使用 `.pi/todos` 或 `PI_TODO_PATH` 保存任务。
- [`trust-github-repos.ts`](extensions/trust-github-repos.ts)：自动信任 GitHub owner 为 `shiyang07ca` 的仓库。
- [`uv.ts`](extensions/uv.ts)：替换 bash 工具，注入 `uv` 命令 shim，并阻止常见的非 `uv` Python workflow；background 任务复用同一份拦截和 PATH 策略。
- [`whimsical.ts`](extensions/whimsical.ts)：把 Agent 工作状态替换为随机中文创意提示语。
- [`workflow-shortcuts.ts`](extensions/workflow-shortcuts.ts)：提供 `/next`、`/discuss` 和 `/recap` workflow 快捷命令。

编排实现委派只要求 `objective`、`files`、`verification`；`interfaces`、`constraints`、`reasoning`、`profile` 按需填写。新实现及调查省略 `profile` 时使用 `extensions/orchestrate.ts` 的 `CONFIG.defaultImplementationProfile`；显式 `profile` 直接来自 `CONFIG.implementers` 的键。续接的 model 配置沿用原记录，不使用默认值。`reasoning` 是委派理由，不是思考强度；`provider`、`model`、`thinking` 在 `CONFIG` 中固定配置，不支持逐任务覆盖或自动降级。新子会话按 Pi 项目信任规则加载项目说明，不继承主聊天历史。编排子任务（含续接）默认按 Pi 发现及信任规则提供适用 skills；skills 不扩大任务范围或授权。调查、实现和终审的新任务及实现续接共用当前 `CONFIG.tools`：`read`、`grep`、`find`、`ls`、`inspect_worktree`、`bash`、`edit`、`write`。

编排子任务保留 `--no-extensions`，全部显式加载 `subagent.ts` 上报扩展和同目录 `unified-edit.ts`，工具仍名为 `edit`，参数为 `{ text: "*** Begin Patch ... *** End Patch" }`。启动及输入时校验实际工具来源及 patch schema，加载缺失或不兼容时明确失败，不静默回退内置 `edit`；不加载其他扩展，通用 `subagent` 行为不变。

调查与终审可运行脚本、联网取证、验证、临时材料和临时服务，交回前须停止服务，复用现有进程清理。它们不自行修复产品源码、已跟踪测试或 snapshot，终审不能边修边审。允许范围内的公开搜索和已授权只读系统查询；外部写入、生产变更或上传私有代码需要授权。职责边界是提示规则，不是安全沙箱，不增加命令过滤或审批机制。调查返回 `FACTS`、`RISKS`、`UNKNOWN`、`CHANGES`，后者报告实际持久变更及必要临时产物，无变更才写 `none`；有执行时补充 `VERIFICATION`，列出关键命令及退出码。`review_work` 始终新建独立会话，使用 `CONFIG.reviewer` 的模型与 `thinking`：`kind: "change"`（默认）审查改动，返回 `ship`、`fix-first` 或 `rethink`；`kind: "decision"` 在执行前评估方案，返回 `proceed`、`gather-info` 或 `rethink`；均附证据，并报告关键命令、退出码、持久变更和必要临时产物。实现报告包含 `DECISIONS_MADE`，结果附带委派前后比较得出的 `Worktree: changed | unchanged | unknown`。

同一实现返工使用 `continue_implementation(run_id, requirements)`，仅续接当前 parent session 内已确认停止的实现，固定复用原 JSONL session history、工作目录、`profile`、`provider`、`model` 和 `thinking`；每次生成独立运行记录和结果。执行 tools 使用当前 `CONFIG.tools`，extensions 和 skills 策略使用当前版本。续接请求由编排入口携带当前 tools，服务校验其为非空显式 tool name 列表后覆盖原列表；tools 字段不是 session history 有效性的前提。调查不续接，终审始终使用新 session。编排规则由 `context_with_system` 注入每个请求的首条系统消息（不写入 session），覆盖 Goal 续跑和自定义 `SYSTEM.md`，与返回完整 `systemPrompt` 的扩展不兼容；用户及扩展消息发起的运行另附不显示的简短 worktree 状态消息，终审初始材料也只附简短状态；通过 `inspect_worktree` 的 `paths` 按需读取字面路径的 staged、unstaged diff，`include_diff: false` 不查询 diff。untracked 文件须显式读取，截断或 Git 不可用不能视为验收通过。

子任务排队、运行、取消清理或停止未确认时，当前主 session 只放行 `read`、`grep`、`find`、`ls`、`inspect_worktree`、编排工具和声明 `annotations.readOnlyHint: true` 的工具，其他工具（含 MCP、codemode）和 Pi 用户 shell 命令会在执行前被阻止。编排工具为 `exposure: "model-only"`，codemode 脚本不能调用。活动子任务期间关闭编排或切换 model 时，写保护保留到子任务确认停止。服务缺失时委派明确失败，写入也保守阻止。受理后的执行和取消由服务负责，取消须等待停止确认；重新加载会根据已记录的 PID identity 和 tmux pane 状态保守恢复已停止的旧记录，仍有活动进程时继续阻止。保护不是跨 session 锁或文件沙箱，`files` 只是范围约定，同一 worktree 不得同时运行其他写入者。编排只增量管理自己的四个委派工具和冲突的通用 `subagent`，保留启用前的其他活动工具；关闭时恢复启用前设置，即使原 model 不可用也会保持关闭。

运行目录保存 `state.json`、`activity.json`、`spec.json`、`session.json` 和本次 `result.json`，保留最终 pane、原始报告及 child session JSONL 路径；tmux 通过短启动命令执行运行目录脚本，运行期间支持观察和 attach，结束后删除 session。正常运行结束不等于实现完成或工程验收通过，只有最终 assistant 正常结束时运行状态才可为 `completed`；报告缺少有效 status 时为 `unconfirmed`，parent session 核对实际 diff、验证命令及退出码后独立验收。高风险或用户要求时独立终审，无有效 `VERDICT` 明确失败。不自动切换 model、重试或增加费用统计。具体边界见 [编排规则](skills/orchestration/SKILL.md)。

扩展修改不会自动应用到已运行会话，待其任务结束后再手动 `/reload`。

background 用于跨 Pi 实例、跨会话和 `/reload` 持续运行的非交互开发服务；常规构建和测试使用 `bash`。面板、状态和提示统一为英文。

| 命令 | 行为 |
| --- | --- |
| `/background` | 打开 Current 任务面板，选择任务后查看详情、日志或停止 |
| `/background history` | 打开所有运行记录，可再次启动、单条清理或批量清理正常结束记录 |
| `/background start` | 引导填写名称、shell 命令和项目内工作目录 |
| `/background start web npm run dev` | 在当前目录直接启动；名称后的内容原样作为 shell 命令 |
| `/background logs web` | 打开日志视图，自动跟随最新输出 |
| `/background stop web` | 停止任务并等待进程退出 |
| `/background clean web` | 确认后删除已结束任务的记录和日志 |

命令支持子命令、任务名称和完整 ID 补全。目标可使用名称、完整 UUID 或唯一 UUID 前缀；名称优先选择活动运行，否则选择最近一次运行。歧义前缀会列出候选，选中任务后的操作固定该次运行，不会随着同名新任务启动而改变目标。

Current 展示所有活动任务、每个名称最新一次运行的失败，以及所有状态待确认记录；旧失败在再次启动成功后只保留在 History，清理较新的运行记录后也不会重新成为当前异常。状态栏 `BG N` 和 `Issues N` 使用同样的规则，没有活动或异常时隐藏。面板提供 Refresh 更新列表。已结束任务的 Start again 沿用名称、命令和工作目录，使用当前 Pi 环境并创建新的运行记录；旧日志保留，同名活动任务存在时拒绝启动。首版没有独立重启操作或项目级服务配置。

日志视图每秒刷新：`↑` / `PgUp` 暂停跟随并冻结快照，`↓` / `PgDn` 翻阅，`End` / `f` 恢复跟随，`Esc` 返回而不停止任务。长行按终端宽度折行，滚动和位置指示以折行后的屏幕行为单位，调整窗口宽度会重新折行。每次最多读取末尾 500 行、50 KiB；runner 日志总量最多 20 MiB。单条清理需确认，History 的批量清理只删除确认正常结束的记录，保留失败及状态待确认记录；活动任务必须先停止。非 TUI 模式的列表和日志返回文本快照，清理需要进入 TUI 确认。

Agent 保留四个工具：`background_start({ name, command, cwd? })`、`background_list({ history? })`、`background_logs({ target, lines? })`、`background_stop({ target })`。列表默认只返回 Current，`history: true` 返回所有记录；Agent 按需读取日志快照，不提供持续跟随、清理或重启工具。**迁移：logs/stop 的 `id` 参数已移除，统一改为 `target`，不保留旧参数兼容。** 已有任务的参数和状态文件格式不变，无需转换或重启现有进程；清理时会在同名较早记录中添加 `.superseded` 标记，避免旧失败在跨会话或 `/reload` 后再次出现。更新后执行 `/reload` 加载新版工具和界面。

核心链路验证：`node scripts/background-smoke.mjs`，使用临时项目和独立任务目录运行真实进程并清理。人工排查可查看 `<agent-dir>/background/<project-root-sha256>/<task-id>/output.log`、`output.log.1`、`params.json` 和 `state.json`。

### 文件浏览

`/files` 或 `ctrl+shift+o` 打开文件浏览器。Git 项目从仓库根目录展示，有变更时默认显示变更列表；非 Git 目录使用渐进扫描。文件搜索覆盖整个索引。

浏览器使用 Emacs 风格按键：`C-` 表示 Ctrl，`M-` 表示 Alt/Option；`C-c d` 表示先按 Ctrl+C，再按 d。快捷键只在浏览器内生效，不修改 Pi 全局配置。Ghostty 的 Option 键需向终端发送 Alt；若被 macOS 截获，可设置 `macos-option-as-alt = left`。`C-SPC` 若与输入法切换冲突，可用 `C-@`。

| 按键 | 操作 |
| --- | --- |
| `C-n/C-p`、`↓/↑` | 向下、向上移动；外部操作菜单中同样有效 |
| `Enter`、`C-f`、`→` | 打开文件或展开目录 |
| `C-b`、`←` | 折叠目录或回到父目录 |
| `C-v/M-v`、`PgDn/PgUp` | 向下、向上翻页 |
| `M-</M->`、`Home/End` | 跳到首尾 |
| `C-s/C-r` | 向前、向后增量搜索；重复按键跳转匹配，`Enter` 确认，`C-g` 恢复搜索前的位置和条件 |
| `C-c c` | 切换文件树与变更列表 |
| `C-c d` | 切换源码与 `HEAD → 工作区` 总 diff |
| `C-c m` | 切换 Markdown 渲染与原文 |
| `C-SPC`、`C-@` | 源码行选择，移动扩展选区；其他视图先切换到源码 |
| `M-w` | 将选区或文件路径加入 Pi 输入框，不修改系统剪贴板 |
| `M-n/M-p` | 下一个、上一个变更文件 |
| `M-x` | 外部操作菜单 |
| `g` | 刷新列表和当前预览 |
| `C-g`、`Esc` | 取消当前搜索、菜单、前缀或选区；否则返回列表或退出 |
| `q` | 返回列表或退出 |

选区引用包含路径、原始行号和源码，追加到现有草稿后回到对话。引用前会核对文件内容，发生变化时提示刷新重选。文本预览上限为 1 MiB、30,000 行，选区上限为 32 KiB；二进制和复杂文档通过 Quick Look 或系统应用查看。非 Git 扫描最多收集 50,000 项，并显示未读目录或部分列表状态。

外部编辑器使用 `$VISUAL`、`$EDITOR`，未设置时使用 `cursor -w`，直接打开真实文件。Agent 忙碌时先确认，编辑器返回后刷新预览。Cursor diff 视图使用 HEAD 与当前文件的临时只读 snapshot，关闭后清理。文件浏览依赖 Pi 自带渲染和 Git。

## 主题

主题位于 [`themes`](themes)：

- [`dayowl.json`](themes/dayowl.json)：明亮的 Day Owl 风格。
- [`modern-dark.json`](themes/modern-dark.json)：深色橙色与蓝灰色主题。
- [`nightowl.json`](themes/nightowl.json)：Night Owl 风格深色主题。

## 辅助文件

- [`intercepted-commands`](intercepted-commands)：`pip`、`pip3`、`poetry`、`python` 和 `python3` 的命令 shim，配合 `extensions/uv.ts` 引导使用 `uv`。
- [`analyze-edits.py`](analyze-edits.py)：分析 Pi session JSONL 中 `edit` tool 使用情况的 `uv run` 脚本。
- [`CHANGELOG.md`](CHANGELOG.md)：版本历史和当前未发布变更。

## 开发说明

安装依赖：

```bash
npm install
```

Pi 会直接加载 [package.json](package.json) 中声明的 TypeScript extension，不需要单独构建。

## 许可证与来源

本资源包采用根目录的 [Apache-2.0 许可证](../LICENSE)。改写和参考来源见[第三方许可说明](../THIRD_PARTY_NOTICES.md)。

参考上游更新资源时，按当前需要选择内容，保留本仓库的资源选择和配置。
