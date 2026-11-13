# 变更日志

本文件记录 Monte Pi 的重要变化。历史版本条目来自上游仓库，`Unreleased` 记录当前个人仓库的调整。

## Unreleased

* 将 `audio-transcription`、`commit`、`ghidra`、`github`、`librarian`、`sentry`、`tmux`、`uv` 和 `web-browser` 迁至 agents 全局技能配置并移除本仓库副本；使用前需启用 agents 配置，浏览器技能需先在新源目录安装 npm 依赖，随后重新加载 Pi。`summarize`、`update-changelog` 和三个 Pi 专用技能继续保留，缓存及凭据位置不变。
* 重构 background 交互：`/background` 打开英文任务面板，支持启动引导、历史记录、再次启动、停止和确认清理；日志支持滚动、暂停及自动跟随，命令支持名称和 ID 补全，旧失败不再累积到当前异常状态。
* 调整 background 工具接口：logs/stop 的 `id` 参数替换为 `target`，支持名称、完整 UUID 和唯一 UUID 前缀，不保留旧参数兼容；list 默认展示当前任务，使用 `history: true` 查询所有运行记录。
* 修复 background 清理较新运行后旧失败重新出现在 Current 和状态栏的问题，跨会话保留旧失败已被取代的标记；日志长行按终端宽度折行，支持滚动查看完整内容及窗口缩放。
* 适配 Pi 1.2.0：修复 Goal 自动续跑重复注入目标状态，保留其他扩展消息触发运行时的状态注入；`/next`、`/discuss` 和 `/recap` 在运行启动中或执行中自动排队为 follow-up。
* 将本地 Pi 开发依赖固定到 1.2.0，并将三个主题的 schema 引用更新为官方发布地址。
* 统一面向用户的 TUI 和 CLI 文案为英文，并汉化文档、代码注释与提示词，同时保留英文技术术语。
* 删除不再使用的 `apple-mail`、`frontend-design` 和 `google-workspace` skills。
* 新增持久化 background 任务扩展：提供 `background_start`、`background_list`、`background_logs`、`background_stop` 四个工具及 `/background` 的列表、日志、停止和清理命令，支持跨 Pi 实例和 `/reload` 管理非交互开发服务；日志总量最多 20 MiB，每次读取最多 50 KiB、500 行，交互 TUI 显示 `BG` 与 `Issues` 状态，background 命令复用 UV 约束。
* 新增 `/onboard` 只读快速入门命令：无参数时介绍工程业务与主要架构，有参数时按指定主题、模块或路径限定调查和讲解范围。
* 新增 `/next`、`/discuss` 和 `/recap` workflow 快捷命令，并将原有规划访谈命令改名为 `/plan`。
* 新增会话级 `/orchestrate` 编排模式：由配置的规划模型负责需求澄清、架构决定和最终验收，支持直接完成小型低风险任务，并按需委派 K3/Luna subagent 串行调查或实现；新任务的默认 `profile` 由 `CONFIG.defaultImplementationProfile` 手动配置，同一实现可通过 `continue_implementation` 续接原会话历史，worktree diff 按需查询，高风险改动启动独立终审。模式包含子任务受理确认、停止确认前的写入保护和模型完成状态核验，并使用短启动命令避免默认 shell 截断。
* 改进 `/orchestrate`：编排规则改为在每个请求中注入首条系统消息的 `orchestration` section，Goal 续跑等扩展消息触发的运行和自定义 `SYSTEM.md` 下同样生效，规则自身不再随轮次增删；每轮 worktree 状态改为不显示的 custom message；子任务活动期间写保护改为只读白名单加 `readOnlyHint`，覆盖 MCP、codemode 等工具；编排工具改为 `model-only`。
* `/orchestrate` 新增独立 `CONFIG.reviewer`，`review_work` 支持 `kind: "decision"` 决策咨询；实现报告新增 `DECISIONS_MADE`，结果附带 `Worktree: changed | unchanged | unknown` 变化标记；选中 virtual model 时明确关闭编排。
* `/goal` 的 active goal 状态改为不显示的 `goal-context` 消息，不再覆盖整个系统提示，可与 `/orchestrate` 同时生效。
* 将 `edit` 工具收敛为单一完整 patch 格式，移除容易与 patch 混用的行脚本执行路径。
* 简化 `/goal` 命令：Goal 默认持续运行直到完成、阻塞、出错或达到限制；仅 `/goal --auto <目标>` 会在服务额度恢复后自动续跑，优先采用可用的 `Retry-After`，否则从错误信息推断或默认等待 5 小时，并避免将后续服务错误误判为额度不足。
* 让 `native-web-search` 跟随当前 Pi provider/model，兼容 Sub2API 的 standalone `alpha/search`，并在 endpoint 不支持时回退同 provider 的 Responses hosted search。
* 让 `/answer`、session-control 摘要、`summarize` 和 `pi-share` 使用当前或默认 Pi 模型，不再硬编码 Codex/Anthropic Haiku。

* 将项目从上游个人包整理为私有的 `monte-pi` 日常工具仓库。
* 删除不使用的 `anachb`、`oebb-scotty` 和 `openscad` skills。
* 删除向 npm 公开发布的 workflow，并将 package 标记为 private。
* 自动信任范围改为只包含 GitHub owner `shiyang07ca`。
* 清理原作者姓名、绝对路径、仓库示例和专属语音提示。
* 将 README、Agent 说明、prompt command 和保留的 skill 文档改为中文。
* 将 `whimsical` extension 的工作状态词库替换为原创中文提示语。
* 修复 notify extension 在全屏 prompt editor 中泄漏 OSC 8 超链接文本的问题。
* 修复 `native-web-search` 对 Claude 家族模型的兼容：Anthropic endpoint 补齐 `/v1/messages`，不再发送 Opus 4.7+ 不支持的 `temperature`，`max_tokens` 提高到 8000 并续接 `pause_turn`；所有 hosted search 路径要求响应包含实际搜索证据，否则报错而不返回模型凭训练知识的回答；新增 `settings.json` 的 `webSearch.model` 固定搜索模型；清理 alpha search 结果中的内部引用标记。
* 补充 `web-browser` 脚本路径和长页面截图的使用说明。
* 修复 subagent 停止流程：按 shell 进程组跟踪子进程，短命 shell 留下的 `cmd &`、`nohup` 孤儿进程会凭进程组 manifest 认定归属并一并清理，不再卡住队列；子进程 bash 沿用 `shellPath` 和 `shellCommandPrefix` 设置。
* 修复 `/review` PR checkout：支持 `/files`、`/changes`、`/commits`、`www`、`http` 和 `#123` 等常见链接形式并核对仓库身份，工作区检查失败时给出提示。
* 修复 `btw` side session 的模型认证与上下文转换，OAuth 凭据不再被固定为 token 快照。
* 修复 `/goal` token 计数重复扣除缓存命中、运行中途创建 goal 时漏记用量的问题。
* 修复 background 启动取消、session-control 连接清理、notify 只在 TUI 空闲时提醒、`edit` 父子路径冲突与部分写入提示，以及 librarian 对异常仓库路径的校验。
* 明确发布流程：`npm version --no-git-tag-version`，整理 changelog 并验证后再提交和打标签。

## 1.6.0

* 重新设计 `btw` extension，增加 side chat Markdown 渲染、工具可见性、延迟创建会话和主上下文改进。
* 新增 `/split-fork` Ghostty fork 命令，用于打开分屏会话。
* 为 `google-workspace` skill 增加基于邮箱的多账号认证。
* 在 todo 详情窗口增加左右方向键翻页。#15
* 为 review 工作流增加共享的自定义说明开关。
* 适配新的 command 和 API key interface，包括带 namespace 的快捷键和 `sourceInfo`。
* 改进 `multi-edit` extension，支持同文件顺序编辑、跳过冗余编辑，并改善 patch 模式 diff 输出。
* 修复 `web-browser` skill 和会话 fork 后 session-control 的刷新行为。#16
* 修复 `intercepted-commands/python` 与 `python3` 的递归 `uv` 启动问题，为 `uv run --python` 解析由 uv 管理的非 shim Python。

## 1.5.0

* 新增替换 `edit` 的 `multi-edit` extension，支持批量 `multi` 编辑和 Codex 风格 `patch`。
* 在 `multi-edit` 修改文件前增加预检。
* 为 `/session-breakdown` 增加 cwd、星期和时段视图。
* 为 `pi-share` 增加 `pi.dev` URL 和 `#session_id` 输入支持。
* 改进 `/session-breakdown` 的日期渲染。
* 修复 `summarize` skill 的 PDF 处理。
* 阻止绕过 pip/poetry 限制，强化 `uv` 命令处理。
* 修复 `web-browser` 启动时误杀用户 Chrome 的问题。
* 更新 README 中的 extension 说明，加入 `pi-extensions/multi-edit.ts`。

## 1.4.0

* 新增 prompt editor extension，用于创建、重命名、删除、编辑并持久化 prompt mode。
* 为 `/review` 增加循环修复模式，改善 blocking finding 检测、branch/commit 筛选和相关 review 流程。#10
* 新增原生网页搜索、仓库缓存 `librarian`、Google Workspace 和 Apple Mail skills。
* 为 session control 增加 CLI interface，并要求通过 `--session-control` 启用相关工具。
* 新增 `go-to-bed` 深夜保护及自动停用行为。
* 在 `/files` 标签中增加 Git 状态。
* 阻止 `py_compile` 并推荐基于 AST 的语法检查，改善 `uv` 命令处理。

## 1.3.0

* 新增 `/session-breakdown`，通过交互式 TUI 展示最近 7、30、90 天的会话、消息、token、费用和 GitHub 风格贡献日历。
* 增加消息/token 统计和大数字缩写。
* 分析会话时显示进度。
* 为 `/review` 增加目录快照审查模式。
* 根据 Codex 的经验改进 review rubric。
* 新增 `summarize` skill，通过 `markitdown` 把文件或 URL 转为 Markdown。

## 1.2.0

* 更新 Pi extensions，适配新的 `ToolDefinition.execute` 参数顺序。
* 修复 notify extension 的纯 Markdown 通知渲染。

## 1.1.1

* 删除已废弃的 `qna` extension。
* 新增 `uv` extension 和 skill。

## 1.1.0

* 增加项目 review guidelines，并在导航时保存 review 状态。
* 为统一文件浏览器增加 `/diff`，合并 diff/file 工作流。
* 新增 commit、changelog 和 frontend design skills。
* 扩充 whimsical 思考提示语。
* 增加 Pi prompts 目录配置。
* 修复 reveal 快捷键冲突，并改进 PR review 编辑流程。

## 1.0.5

* 修复 npm package 的发布 CI。

## 1.0.4

* 新增 session control extension，包括 socket 渲染、输出获取和复制 todo 文本操作。
* 支持会话名称和自定义消息类型。
* 改进 control socket 渲染和重连行为。
* 增加 control extension 文档。

## 1.0.3

* 增加 todo 分配和 ID 校验。
* 增加 todo 文本复制并改进更新体验。
* answer 工具优先使用 Codex mini，并改进 prompt refinement。
* 补充 todo 文档并更新 README。

## 1.0.2

* 新增 todo manager extension，支持 list、list-all、update、delete 和 garbage collection。
* 使用 `TODO-` 前缀 ID，并改进 todo 操作菜单。
* 改进 todo 渲染和 refinement 流程顺序。
* 支持不提供正文的 append-only 更新。
* 删除未使用的 codex-tuning extension。

## 1.0.1

* 新增 `/answer`、`/review`、`/files`、`/reveal`、`/loop` 和 cwd history 等核心 extensions。
* 新增 Sentry、GitHub、web browser、tmux、Ghidra、pi-share 和交通查询等 skills。
* 新增 Night Owl 等 Pi themes。
* 增加并改进 commit extension 和 review 工作流。
* 改进 package 结构和初始配置。
