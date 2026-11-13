---
name: native-web-search
description: "使用当前 Pi `provider` 和 `model` 的原生网页搜索能力，返回简洁结论和完整来源 URL；兼容 Codex、Anthropic、OpenAI Responses 及 Sub2API standalone search。"
---

# 原生网页搜索

需要查询最新互联网信息，并获得带完整来源 URL 的简明结果时使用。

`provider` 和 `model` 按以下优先级选择：

1. 命令行 `--provider` / `--model`。
2. `~/.pi/agent/settings.json` 的 `webSearch.model`（`provider/model` 格式）。
3. 当前 Pi session 的 `PI_PROVIDER` / `PI_MODEL`。
4. `settings.json` 的默认 `provider` 和 `model`。

当前会话的 `provider` 不支持联网搜索时（例如中转网关丢弃了 hosted search tool），配置固定的搜索模型：

```json
{ "webSearch": { "model": "sub2api/gpt-6.1-sol" } }
```

搜索是独立 HTTP 请求，不影响主会话的模型和 prompt cache；query 会发送给所选搜索 `provider`。

## 快速使用

脚本路径相对本 skill 目录；不在该目录时使用绝对路径运行：

```bash
node search.mjs "latest Python release" --purpose "更新依赖说明"
```

一般不需要显式指定 `provider` 和 `model`。需要临时覆盖时：

```bash
node search.mjs "Ghostty latest release" \
  --provider sub2api --model gpt-6.1-sol
```

查看实际 `provider`、`model` 和 `transport`：

```bash
node search.mjs "test query" --json
```

## 当前 Sub2API 行为

当前 `sub2api/gpt-6.1-sol` 配置为 `openai-responses`。默认 `auto` 模式会：

1. 请求 `<baseUrl>/alpha/search`，即当前配置下的 `/v1/alpha/search`。
2. 只有 endpoint 明确返回不支持（404、405、501 或对应错误）时，才回退到同一 Sub2API `provider` 的 `<baseUrl>/responses`。
3. 401、403、quota、`model` 或参数错误会直接报告，不会静默切换 `provider` 或重复请求。

此规则适用于当前 Sub2API Responses 配置，不依赖旧模型名称；`gpt-6.1-sol` 同样默认直接搜索。需要额外模型搜索并整理摘要时，显式传入 `--transport responses`。其他 provider 保持各自的搜索路径。

## 支持的搜索路径

- `openai-codex`：Codex Responses；GPT-5.6 Lite `model` 优先 standalone alpha search。
- `anthropic` / `anthropic-messages`：Anthropic 原生 `web_search_20250305`；endpoint 为 `<baseUrl>/v1/messages`（baseUrl 已含 `/v1` 时不重复追加），不发送 `temperature`，并续接 `pause_turn`。
- `openai-responses`：标准 hosted `web_search`。
- `alpha-search`：Codex standalone `POST /alpha/search`，适用于 Sub2API 等兼容网关。

`model` 名称本身不能保证支持联网搜索。`provider` 或中转 gateway 必须实现对应的 hosted tool 或 standalone endpoint。

脚本要求响应中有实际搜索证据：Anthropic 需要 `server_tool_use` / `web_search_tool_result`，Responses 需要 `web_search_call`；standalone alpha search 本身即搜索。没有证据时直接报错，不把模型凭训练知识的回答当作联网结果。已知 `4router/claude-opus-5-5` 会静默丢弃 `web_search`，需配置 `webSearch.model`。

## 参数

- `--purpose <text>`：搜索目的，帮助 `model` 聚焦结果。
- `--provider <id>`：临时指定 `provider`。
- `--model <id>`：临时指定 `model`，也支持 `provider/model`。
- `--transport <mode>`：`auto`、`responses`、`alpha-search`、`codex-responses`、`codex-alpha-search`、`anthropic`。
- `--endpoint <url>`：临时指定完整 endpoint；`auto` 回退时只作用于第一次尝试。
- `--timeout <ms>`：请求超时，默认 120000。
- `--json`：输出 `provider`、`model`、实际 `transport`、尝试顺序和结果。

通常保留默认 120 秒请求超时，不要为了缩短工具等待而改为 40–55 秒。需要持续等待时用 `background_start` 运行并通过日志查看结果；若使用普通命令工具，其执行超时必须留出请求、鉴权及可能回退所需的时间。120 秒是每次 HTTP 请求的上限，回退或 Anthropic 续接时总耗时可能更长。超时后先根据错误中的路径和原因判断，不盲目重试。

## 配置与迁移

脚本读取 Pi 已有配置，不引入 standalone search 配置文件：

- `settings.json`：默认 `provider` 和 `model`。
- `models.json`：自定义 `provider` 的 `api`、`baseUrl`、`models`、`headers`。
- `auth.json` / `pi auth`：API key 或 OAuth bearer token。

未来不使用 Sub2API 时：

- 切换到直接 OpenAI Responses：使用 `openai-responses` 作为 `provider`，脚本会使用 hosted `web_search`。
- 切换到 Anthropic：脚本会使用 Anthropic 原生搜索。
- 切换到其他兼容网关：在 `models.json` 中正常配置 `provider`；支持 Responses 时自动使用，支持 standalone search 时可传 `--transport alpha-search`。
- `provider` 完全不支持搜索时，使用 `web-browser` skill 或 standalone search API skill；本 skill 不会把普通 `model` 回答伪装成联网结果。

## 输出要求

`alpha-search` 返回来源链接和搜索片段，由当前 Agent 打开关键原文、核验并总结；不保证直接提供研究摘要。`--purpose` 不保证 standalone endpoint 会对片段进行目的相关的整理。

Responses 和 Anthropic 路径要求模型执行搜索并整理摘要：

- 返回 3–7 条关键发现。
- 每条包含标题、与当前目的的关系和完整规范 URL。
- 标明来源分歧。
- 最后给出优先信任哪些来源的简短建议。

## 故障排查

- `Search failed (...)`：括号内包含实际 provider、model、transport、每次请求超时值和尝试顺序，后面保留原始错误。超时不自动切换路径；先确认是否人为缩短了超时，再判断是否需要重新查询或使用浏览器。
- `No credentials available`：通过 `/login` 或 `models.json` 配置 `provider` credential。
- `No model configured`：设置 Pi 默认 `model`，或传 `--model`。
- 端点不支持（如 404/405/501）：自动路径包含回退时，在同一 provider 内尝试 Responses；模型不存在、参数或配额错误不触发回退。根据最终错误判断失败原因。
- 401/403：检查 API key、账号权限、Sub2API 分组和 `model` routing。
- `did not run a web search`：当前 `provider` 不执行 hosted search；配置 `webSearch.model` 或传 `--provider` / `--model`。
- `returned invalid JSON`：endpoint 可能指向网页而不是 API；用 `--json` 查看实际 `transport`，必要时传 `--endpoint`。

本 skill 会把搜索词和目的发送给当前 `provider`。不要在 query 中放入不必要的 credential 或隐私数据。
