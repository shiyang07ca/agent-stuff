# 任务配置与迁移

仅在接入、检查或整理任务工作方式时阅读。以下是没有现有约定时的默认方案；已有正确配置优先，外部任务系统保留其字段与状态映射，不另建第二套任务记录。

## 项目文件

- `docs/agents/task-tracker.md`：记录任务存放位置、正文要求、选择任务、开始与收尾规则。
- `docs/agents/triage-labels.md`：集中定义下面三个字段；其他说明引用它，不重复状态表。
- 根 `AGENTS.md`：用几行说明“拆分、整理或执行任务前读取上述文件”。

只有实际采用本地临时记录时才确保 `.gitignore` 忽略 `.scratch/`。默认 PRD 为 `.scratch/<feature>/PRD.md`，任务为 `.scratch/<feature>/tasks/<NN>-<slug>.md`，编号从 `01` 起，沿用已有编号。需要共享、审计或长期保留的记录使用项目约定的版本化文档目录或任务系统，不能只存被忽略的 `.scratch/`。

## 三个字段

| 字段 | 含义 | 默认值 |
| --- | --- | --- |
| `Status` | 信息是否充分、由谁处理 | `needs-triage` 待评估；`needs-info` 待补信息；`ready-for-agent` 信息充分且 Agent 可处理；`ready-for-human` 仍需人处理；`wontfix` 决定不处理 |
| `Progress` | 实际执行进度 | `pending` 未开始；`in-progress` 执行中；`completed` 本任务已交付并完成必要验证；`deferred` 延后；`cancelled` 不再执行 |
| `Blocked by` | 尚未满足的具体前置条件 | `无`，或任务引用、数据、决定、授权及其满足条件 |

这是一套本地约定，不是工具自动解析的标准。默认写 `Blocked by: 无`；确有误判风险时可以写 `无；仅公共观察，不依赖 06、07 或 10`。跨功能依赖使用路径或链接，不能只写编号。

选择新任务时检查 `Progress: pending`、`Status: ready-for-agent`、前置已满足且在当前授权范围内。按用户指定顺序或业务优先级选择，条件相同时再按编号。续做 `in-progress` 任务先读已有交接，不能当作无人处理的新任务。

开始时改为 `in-progress`；需要协作或交接时在 `## Comments` 记录承担者与时间。完成时在 `## Answer` 写交付、验证结果和限制，再改为 `completed`；不改动原分诊角色。延后和取消不会满足下游依赖，需重新判断并记录依赖是否仍成立。`wontfix` 通常与 `cancelled` 配套。

`ready-for-human` 不表示“请人看看已完成结果”，也不额外制造批准要求。`Blocked by: 无` 不扩大已有授权。历史完成记录只覆盖当时的任务范围与验证版本，不证明后续改动仍然有效。

## 任务正文

每项任务写目标与必要范围边界、可观察的验收条件和检查方法。三字段放在标题下；有结果再添加 `## Answer`，有讨论或交接再添加 `## Comments`。交接只补已完成、未完成与下一步，不重复维护一份进度表。沿用已有正文标题，不为语言或排版机械迁移。

## 旧配置迁移

- `.scratch/<feature>/issues/` 确认是这套方式的旧任务目录时，源存在且 `tasks/` 不存在才移动，并同步项目内引用。两边同时存在或编号冲突时保留原状，报告具体路径，不覆盖或自动合并。
- 从单字段状态改为三字段时，先读状态定义、实际任务和消费它们的说明。`claimed`、`resolved` 只有在记录支持时才能分别转为 `in-progress`、`completed`；分诊角色从已有事实恢复，无法判断则保留该任务并报告，不猜值。
- 其他旧状态同样结合记录判断进度；没有 `Progress` 不等于尚未开始。目录、状态与引用迁移分别判断，不能靠批量替换宣称完成。
- 同步范围内的任务读写说明。若依赖目标项目之外的 Skill 或工具仍写旧字段，报告具体不兼容处，不修改外部安装副本，也不宣称已完整接入。

## 设计依据

2026-09-10 核验；这里采用的是适合个人项目的三字段方案，未将上游模板视为必须遵循的标准。

- [Matt Pocock setup skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/SKILL.md)：任务系统、状态词汇和领域文档分别配置，保留已有说明。
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)：分层指令与自动发现规则，普通文档需要明确阅读入口。
- [Anthropic 长任务实践](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)：用可恢复记录和实际验证支撑进度；不引入其示例中的自动提交或额外脚本。
