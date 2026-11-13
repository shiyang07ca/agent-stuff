# 工程 Skill 说明

本仓库在 `custom-skills/engineering/` 维护中文工程 Skill。`config/agent-control.toml` 决定启用哪些 Skill，以及它们能否根据用户的自然语言请求自动选择。

## 怎样选择

- 要求清楚、需要直接修改时使用 `implementation`。
- 用户明确要求先写失败测试时，用 `tdd` 代替普通实现流程；它不是 `implementation` 之后的固定步骤。
- 已经出现报错、错误行为或变慢时使用 `debugging`。
- 只有不同理解会改变结果时才使用 `discovery`。
- 已有改动基本工作，用户明确要求检查过度构建或进行消融实验时使用 `simplify`；它不替代一般代码审查或架构评估。
- `spec`、`task-breakdown`、`review`、`simplify`、`architecture`、`prototype`、`conflicts` 和 `handoff` 只在用户点名时使用。
- `project-init` 只在用户要求创建、整理或检查项目级 Agent 说明时使用，按需配置任务记录与领域文档入口，并迁移已确认的旧格式；`triage` 只整理已有任务。

这些 Skill 不是一条必须走完的流程。单个清楚的小改动通常只需要 `implementation`。

## Skill 清单

| 名称 | 调用方式 | 用来做什么 |
| --- | --- | --- |
| `project-init` | implicit | 创建或整理项目 Agent 说明，按需配置任务记录 |
| `discovery` | implicit | 找出需要用户决定的问题并统一术语 |
| `spec` | explicit | 把需求写入 `.scratch/<feature>/PRD.md` |
| `task-breakdown` | explicit | 把规格拆成 `.scratch/<feature>/tasks/` 下的任务 |
| `implementation` | implicit | 完成一项范围清楚的代码或配置改动 |
| `tdd` | implicit | 用户明确要求时，先用失败测试证明问题，再实现目标行为 |
| `debugging` | implicit | 稳定重现问题、找到原因并确认修复 |
| `review` | explicit | 审查指定改动并报告有实际影响的问题 |
| `simplify` | explicit | 审查或消融指定改动中没有当前用途的复杂度 |
| `architecture` | explicit | 找出结构问题并比较可行改法 |
| `research` | implicit | 查找一手资料并回答工程问题 |
| `prototype` | explicit | 用隔离的小原型回答明确问题 |
| `conflicts` | explicit | 看懂并解决 Git 冲突 |
| `triage` | implicit | 判断任务信息、阻塞和下一步 |
| `handoff` | explicit | 写清当前进度，让下一次工作可以继续 |

`implicit` 和 `explicit` 是配置中的固定值。前者允许 Codex 根据 Skill 描述自动选择，后者只在用户点名时使用。

## 文件分工

- `.scratch/` 保存不提交的本地草稿、任务记录、交接和原型；需要长期保留的结论移到 `docs/`、ADR 或项目约定的任务系统。
- PRD 草稿说明为什么做、做什么、不做什么和怎样验收。
- 任务文件保存单项工作的 `Status:`、`Progress:`、`Blocked by:`、完成条件和检查方法。
- 交接文件说明当前做到哪里、运行过哪些检查、下一步从哪里继续。
- `CONTEXT.md` 只保存本项目中反复使用且容易混淆的术语；类名、配置键、命令和内部处理阶段不写进去。
- ADR 只记录难以撤销、存在明显取舍且以后需要解释的决定。

不要为单个小改动创建 PRD、任务目录或交接文件。已有文件能够说明清楚时，不再创建内容重复的索引或总览。

## 修改后检查

修改 Skill 后运行：

```bash
make validate
make audit-skills
make check
make plan
```

`make validate` 检查目录、名称、元数据和调用配置，`make audit-skills` 检查结构和常见风险。不要用固定句子测试锁死 Skill 文案；触发是否准确、执行是否符合预期，应在真实任务中观察，发现问题后再按具体样例调整描述或步骤。
