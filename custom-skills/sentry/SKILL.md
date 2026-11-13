---
name: sentry
description: "通过 Sentry API 查询 issue、event、transaction 和日志，用于定位错误、还原现场并分析根因。"
---

# Sentry 技能

通过 Sentry API 调试和调查 issue。认证 token 从 `~/.sentryclirc` 读取。

## 快速参考

| 任务 | 命令 |
|------|------|
| 查找某天的错误 | `search-events.js --org X --start 2025-12-23T15:00:00 --level error` |
| 列出未解决 issue | `list-issues.js --org X --status unresolved` |
| 获取 issue 详情 | `fetch-issue.js <issue-id-or-url> --latest` |
| 获取 event 详情 | `fetch-event.js <event-id> --org X --project Y` |
| 搜索日志 | `search-logs.js --org X --project Y "level:error"` |

## 常见调试流程

### 指定时间发生了什么？

```bash
# 查询两小时窗口中的全部 event
./scripts/search-events.js --org myorg --project backend \
  --start 2025-12-23T15:00:00 --end 2025-12-23T17:00:00

# 只看错误
./scripts/search-events.js --org myorg --start 2025-12-23T15:00:00 \
  --level error

# 筛选特定 transaction
./scripts/search-events.js --org myorg --start 2025-12-23T15:00:00 \
  --transaction process-incoming-email
```

### 最近发生了哪些错误？

```bash
./scripts/list-issues.js --org myorg --status unresolved --level error --period 24h
./scripts/list-issues.js --org myorg --query "times_seen:>50" --sort freq
./scripts/list-issues.js --org myorg --query "is:unresolved has:user" --sort user
```

### 查看某个 issue 或 event

```bash
./scripts/fetch-issue.js 5765604106 --latest
./scripts/fetch-issue.js https://sentry.io/organizations/myorg/issues/123/ --latest
./scripts/fetch-issue.js MYPROJ-123 --org myorg --latest

./scripts/fetch-event.js abc123def456 --org myorg --project backend --breadcrumbs
```

### 按 tag 查找 event

```bash
./scripts/search-events.js --org myorg --tag thread_id:th_abc123
./scripts/search-events.js --org myorg --query "user.email:*@example.com"
```

## 获取 issue

```bash
./scripts/fetch-issue.js <issue-id-or-url> [options]
```

支持：

- issue ID：`5765604106`
- URL：`https://sentry.io/organizations/myorg/issues/5765604106/`
- 新版 URL：`https://myorg.sentry.io/issues/5765604106/`
- Short ID：`JAVASCRIPT-ABC`，需要同时传 `--org`

参数：

- `--latest`：包含最新 event 和完整 stack trace。
- `--org <org>`：组织 slug，使用 short ID 时必填。
- `--json`：输出原始 JSON。

输出包括标题、culprit、状态、level、首次与最后出现时间、event 数量、受影响用户、tag 和环境信息。增加 `--latest` 后还会包含 stack trace、request、breadcrumb 和 runtime context。

## 获取 event

```bash
./scripts/fetch-event.js <event-id> --org <org> --project <project> [options]
```

参数：

- `--org, -o <org>`：组织 slug，必填。
- `--project, -p <project>`：项目 slug，必填。
- `--breadcrumbs, -b`：显示全部 breadcrumb，默认只显示最后 30 条。
- `--spans`：显示 transaction 的 span tree。
- `--json`：输出原始 JSON。

输出包括时间、项目、标题、消息、tag、runtime/browser/OS/trace context、request、异常 stack trace、breadcrumb，以及可选 span。

## 搜索 event

```bash
./scripts/search-events.js [options]
```

时间参数：

- `--period, -t <period>`：相对时间，例如 `24h`、`7d`、`14d`。
- `--start <datetime>`：ISO 8601 开始时间。
- `--end <datetime>`：ISO 8601 结束时间。

筛选参数：

- `--org, -o <org>`：组织 slug，必填。
- `--project, -p <project>`：项目 slug 或 ID。
- `--query, -q <query>`：Discover 查询。
- `--transaction <name>`：transaction 名称。
- `--tag <key:value>`：tag，可重复。
- `--level <level>`：`error`、`warning`、`info`。
- `--limit, -n <n>`：最大结果数，默认 25，最大 100。
- `--fields <fields>`：逗号分隔的返回字段。

查询示例：

```text
transaction:process-*     transaction 通配匹配
level:error               按 level 筛选
user.email:foo@bar.com    按用户筛选
environment:production    按环境筛选
has:stack.filename        只保留含 stack trace 的 event
```

## 列出 issue

```bash
./scripts/list-issues.js [options]
```

参数：

- `--org, -o <org>`：组织 slug，必填。
- `--project, -p <project>`：项目 slug，可重复。
- `--query, -q <query>`：issue 查询。
- `--status <status>`：`unresolved`、`resolved`、`ignored`。
- `--level <level>`：`error`、`warning`、`info`、`fatal`。
- `--period, -t <period>`：时间范围，默认 `14d`。
- `--limit, -n <n>`：最大结果数，默认 25。
- `--sort <sort>`：`date`、`new`、`priority`、`freq`、`user`。
- `--json`：输出原始 JSON。

查询示例：

```text
is:unresolved             未解决
is:assigned               已分配负责人
assigned:me               分配给当前用户
level:error               error level
firstSeen:+7d             首次出现时间早于七天前
lastSeen:-24h             最近 24 小时内出现
times_seen:>100           event 数超过 100
has:user                  包含用户 context
error.handled:0           仅未处理异常
```

## 搜索日志

```bash
./scripts/search-logs.js [query|url] [options]
```

参数：

- `--org, -o <org>`：组织 slug；传 URL 时可省略。
- `--project, -p <project>`：项目 slug 或 ID。
- `--period, -t <period>`：时间范围，默认 `24h`。
- `--limit, -n <n>`：最大结果数，默认 100，最大 1000。
- `--json`：输出原始 JSON。

查询示例：

```text
level:error              按 level 筛选
message:*timeout*        使用通配符搜索消息
trace:abc123             按 trace ID 筛选
project:my-project       按 project slug 筛选
```

也可以直接传 Sentry Logs Explorer URL：

```bash
./scripts/search-logs.js "https://myorg.sentry.io/explore/logs/?project=123&statsPeriod=7d"
```

## 调试建议

1. 先宽后窄：先按时间范围搜索 event，再深入具体 event。
2. 使用 breadcrumb：`fetch-event.js --breadcrumbs` 可以还原错误发生前的操作。
3. 寻找模式：`list-issues.js --sort freq` 可以找出高频 issue。
4. 查找关联 event：使用相同 transaction 名称或 trace ID 继续搜索。
5. 善用自定义 tag：`thread_id`、`user_id`、`request_id` 等可以串联不同 event。
