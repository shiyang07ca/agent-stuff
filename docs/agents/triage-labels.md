# 任务状态

任务顶部同时记录 `Status:`、`Progress:` 和 `Blocked by:`。英文值保持原样；三个字段分别回答由谁处理、执行到哪一步、还有什么前置条件。

## Status

| 值 | 含义 |
| --- | --- |
| `needs-triage` | 等待评估 |
| `needs-info` | 等待补充必要信息 |
| `ready-for-agent` | 信息充分且 Agent 可处理；是否能开始另看进度、依赖和授权范围 |
| `ready-for-human` | 仍需人处理，不兼作已完成结果的查看入口 |
| `wontfix` | 决定不处理，通常配合 `Progress: cancelled` |

## Progress

| 值 | 含义 |
| --- | --- |
| `pending` | 尚未开始 |
| `in-progress` | 正在执行 |
| `completed` | 本任务范围已交付并完成必要验证，结果记在 `## Answer` |
| `deferred` | 已决定延后，不进入当前执行队列 |
| `cancelled` | 不再执行 |

完成时只更新进度，不把 `Status` 改为 `claimed` 或 `resolved`。历史完成记录不证明后续版本仍然有效；`ready-for-human` 不额外产生人工批准要求。

## Blocked by

写 `无`，或尚未满足的任务、数据、决定、授权及具体满足条件。跨功能任务使用路径或链接；有误判风险时可以补充说明，例如 `无；仅公共观察，不依赖 06、07 或 10`。

延后、取消不等于完成前置任务；只有依赖交付与明确条件满足，或有依据移除依赖后才能继续。`无` 不扩大已有授权。

调整字段含义时同步 [任务读写规则](task-tracker.md) 和消费这些字段的 Skill。旧格式按 [迁移说明](../../custom-skills/engineering/project-init/references/task-workflow.md) 结合实际记录判断，不把缺少进度当作尚未开始。
