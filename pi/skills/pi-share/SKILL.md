---
name: pi-share
description: "加载并解析 pi.dev、buildwithpi 等 Pi 分享链接中的会话记录，提取对话、系统提示和工具信息。"
---

# Pi 分享会话加载器

从 `shittycodingagent.ai`、`buildwithpi.ai`、`buildwithpi.com` 或 `pi.dev` 的分享链接加载 Pi 会话。

## 适用场景

用户给出以下形式的链接或 ID 时使用：

- `https://shittycodingagent.ai/session/?<gist_id>`
- `https://buildwithpi.ai/session/?<gist_id>`
- `https://buildwithpi.com/session/?<gist_id>`
- `https://pi.dev/session/?<gist_id>`
- `https://pi.dev/session/#<gist_id>`
- 单独的 Gist ID，例如 `46aee35206aefe99257bc5d5e60c6121`
- 带 `#` 的简写，例如 `#46aee35206aefe99257bc5d5e60c6121`

用户想了解人在会话中的操作方式时使用 `--human-summary`，例如：

- 总结用户在 Pi 会话中做了什么。
- 分析用户如何引导或纠正 Agent。
- 观察重复提示、干预方式或提示风格。

人类视角摘要聚焦初始目标、重新提示、纠正、干预和整体表达方式，而不是复述 Agent 完成了什么。

## 工作原理

1. 分享会话保存在 GitHub Gist。
2. URL 的 query 参数或 hash 中包含 Gist ID。
3. Gist 内的 `session.html` 保存 Base64 编码的会话数据。
4. 辅助脚本抓取并解码完整对话。

## 用法

```bash
# 获取完整会话数据（默认）
node ~/.pi/agent/skills/pi-share/fetch-session.mjs "<url-or-gist-id>"

# 只获取 header
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --header

# 以 JSON Lines 输出 entries
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --entries

# 获取 system prompt
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --system

# 获取工具定义
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --tools

# 生成人类视角摘要
node ~/.pi/agent/skills/pi-share/fetch-session.mjs <gist-id> --human-summary
```

## 人类视角摘要

`--human-summary` 会生成约 300 词的摘要，回答：

- 用户最初想完成什么？
- 用户多频繁地重新提示或引导 Agent？
- 用户做了哪些纠正、澄清或其他干预？
- 指令是具体还是模糊？

该功能通过 `pi -p` 使用当前默认 `provider` 和 `model`，并以 `low` thinking 分析压缩后的 session transcript。

## 会话数据结构

```typescript
interface SessionData {
  header: {
    type: "session";
    version: number;
    id: string;           // 会话 UUID
    timestamp: string;    // ISO 时间戳
    cwd: string;          // 工作目录
  };
  entries: SessionEntry[];  // JSON Lines 格式的对话条目
  leafId: string | null;    // 当前分支叶节点
  systemPrompt?: string;    // 系统提示词
  tools?: { name: string; description: string }[];
}
```

常见 entry 类型：

- `message`：用户、assistant、`toolResult` 消息及 content block。
- `model_change`：模型切换。
- `thinking_level_change`：thinking level 变化。
- `compaction`：上下文压缩事件。

常见消息内容块：

- `text`：文本。
- `toolCall`：带 `toolName` 和 `args` 的工具调用。
- `thinking`：模型思考内容。
- `image`：嵌入图片。

## 分析示例

```bash
# 只保留用户消息
node ~/.pi/agent/skills/pi-share/fetch-session.mjs "<url>" --entries | jq 'select(.type == "message" and .message.role == "user")'

# 统计工具调用次数
node ~/.pi/agent/skills/pi-share/fetch-session.mjs "<url>" --entries | jq -s '[.[] | select(.type == "message") | .message.content[]? | select(.type == "toolCall")] | length'
```
