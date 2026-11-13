---
name: web-browser
description: "在 macOS 上通过自有扩展操作日常 Edge 或 Chrome：导航、点击、填写、截图、设备模拟和日志；--isolated 使用技能独立浏览器。"
license: Stolen from Mario
---

# 浏览器技能

默认连接用户正在使用的日常浏览器。使用 `BROWSER=edge|chrome` 选择浏览器，默认 `edge`；连接失败时直接报错，不自动切换浏览器或模式。所有页面操作明确指定 tab，导航默认新建 tab。

文中 `./scripts/...` 相对本技能目录。首次安装或缺少 `ws` 时按 [setup.md](setup.md) 安装；只修改仓库源文件，不直接修改 `.runtime/` 或 HOME 下的技能副本。

## 日常浏览器连接

按 [setup.md](setup.md) 安装 Agent Web Browser 扩展，保持浏览器运行。扩展通过 `chrome.debugger` 操作页面，由浏览器启动本机桥接。主模式不需要启用 inspect 远程调试，也不依赖 Codex／ChatGPT。首次加载并授权扩展后，连续命令不需要逐次批准调试连接；浏览器仍可能显示调试提示条。

每种浏览器只在一个用户选定的 profile 中启用扩展，支持该 profile 的全部窗口；多个 profile 同时连接会报错，不猜选账号环境。点击浏览器调试提示条取消控制会暂停该浏览器的全部技能控制，直到明确恢复。暂停后普通命令不会自动恢复；意外断线会恢复通信，但在途命令失败，页面操作不会重放。

```bash
./scripts/connection.js status
./scripts/connection.js pause
./scripts/connection.js resume
```

也可在扩展弹窗查看状态并暂停／恢复。连接失败先检查浏览器、扩展是否启用，再运行 `make doctor` 检查注册和启动入口。

主模式不启动、停止或重置浏览器，不复制 profile 数据。普通命令结束立即释放执行占用，调试连接继续保留 60 秒；期间新命令复用连接，最后一个使用者退出后重新计时，以减少控制提示反复出现。watch 与页面操作共享同一 tab 的附加，watch 监听期间不会超时释放。暂停或桥接断开立即释放全部调试连接；恢复后由新命令按需连接。状态中的标签页数量包含这 60 秒内保留的附加。不同 tab 可并行，同一 tab 的普通命令冲突会报忙。`BROWSER_BIN`、`BROWSER_DEBUG_PORT` 不影响主模式。

```bash
export BROWSER=edge
./scripts/tabs.js
./scripts/nav.js https://example.com
# nav 输出 targetId；后续明确使用该 ID：
./scripts/eval.js --tab <targetId> 'document.title'
./scripts/nav.js --tab <targetId> https://example.com/about
```

`tabs.js` 每行输出一个含 `targetId`、`title`、`url` 的 JSON 对象。`nav.js <url>` 总是创建新 tab，`nav.js --tab <targetId> <url>` 导航指定现有 tab；没有全局当前页，也不会选择最后一个 tab。导航输出 ID 不代表页面资源已全部加载，必要时用 `eval.js` 检查页面状态。

浏览器重启或 tab 关闭后，重新运行 tabs 获取 ID。主模式支持新建 `data:` 页面，但浏览器阻止将已有 tab 导航到 `data:`；此时省略 `--tab` 新建页面。内部受限页面或其他调试工具占用可能导致附加被拒，命令会保留浏览器错误，不抢占对方控制。

## 技能独立浏览器

需要独立登录环境或 headless 时，在每条命令显式添加 `--isolated`：

```bash
./scripts/start.js --isolated --headless
./scripts/tabs.js --isolated
./scripts/nav.js --isolated https://example.com
./scripts/eval.js --isolated --tab <targetId> 'document.title'
./scripts/stop.js --isolated
```

| 浏览器 | 默认调试端口 | 独立 profile |
| --- | --- | --- |
| `edge` | `9222` | `~/.cache/agent-web/edge/profile/` |
| `chrome` | `9223` | `~/.cache/agent-web/chrome/profile/` |

`start.js`、`stop.js` 和 `start.js --reset-profile` 必须带 `--isolated`。stop 只停止当前浏览器、当前端口和所选技能 profile；没有 `--all`。启动参数一致时复用现有实例，未知端口占用或 profile 正在其他端口使用时拒绝启动和重置。连接与停止会核对 PID、可执行文件及 profile。

独立 profile 保留 Cookie 和网站存储；停止不会清空数据，登录是否有效由网站决定。人工登录或使用 `pick.js` 时启动可见窗口：

```bash
./scripts/stop.js --isolated
./scripts/start.js --isolated
# 登录后切回 headless：
./scripts/stop.js --isolated
./scripts/start.js --isolated --headless
# 仅在确实需要清空所选独立 profile 时：
./scripts/stop.js --isolated
./scripts/start.js --isolated --headless --reset-profile
```

headless 禁用扩展。非标准安装路径和端口冲突可使用 `BROWSER_BIN=/absolute/path/to/browser`、`BROWSER_DEBUG_PORT=9333`，后续独立模式命令保持相同设置；不要把可执行路径指向另一种浏览器。连接固定使用本机回环地址，不支持远程 host 覆盖。

## JavaScript 与页面操作

以下示例默认主模式；独立模式在每条命令追加 `--isolated`。

```bash
./scripts/eval.js --tab <targetId> 'document.querySelectorAll("a").length'
./scripts/eval.js --tab <targetId> 'document.querySelector("button")?.click(); "clicked"'
./scripts/eval.js --tab <targetId> 'await Promise.resolve(document.title)'
./scripts/pick.js --tab <targetId> '选择提交按钮'
./scripts/dismiss-cookies.js --tab <targetId>
./scripts/dismiss-cookies.js --tab <targetId> --reject
```

`eval.js` 接受一个带引号的表达式或语句列表，等待 Promise 或顶层 `await`，对象和数组输出 JSON。`pick.js` 需要可见窗口：点击选择，Cmd/Ctrl+Click 多选，Enter 完成，Escape 取消，最多等待 5 分钟。Cookie 命令默认接受，`--reject` 尽可能拒绝。

## 设备模拟与截图

```bash
./scripts/emulate.js --list
./scripts/emulate.js --tab <targetId> iphone-14
./scripts/emulate.js --tab <targetId> pixel-7 --landscape
./scripts/emulate.js --tab <targetId> --reset
./scripts/screenshot.js --tab <targetId>
./scripts/screenshot.js --tab <targetId> --full-page
./scripts/screenshot.js --tab <targetId> --device iphone-14
```

模拟设置包含 viewport、DPR、touch 和 UA。偏好按浏览器、主／独立模式、target ID 保存；后续该 tab 的导航、执行、选择、Cookie、截图和日志命令会重新应用。主模式的调试连接保留期间，模拟效果也可能继续生效；显式 `--reset` 立即清除。没有常驻模拟进程，调试连接释放后浏览器可能恢复部分设置，因此不保证人工操作期间持续模拟。依赖 UA 的页面响应需要重新导航。

`--reset` 清除指定 tab 的模拟和偏好。`screenshot --device` 仅临时使用指定设备，结束前恢复该 tab 的已有偏好；没有偏好时清除模拟。不同 tab 不共享偏好。截图输出临时 PNG 路径，默认截 viewport，`--full-page` 截完整页面。

偏好保存使用跨进程锁；锁被占用时命令报错，不自动重试。若提示页面模拟已应用或重置但偏好未保存，等待其他操作结束后重新执行命令。

长截图在模型显示时可能被缩小，文字难以辨认；需要读内容时优先提取文本，或用 `eval.js` 滚动后分段截图。

## 前台日志监听

```bash
./scripts/watch.js --tab <targetId>
./scripts/watch.js --isolated --tab <targetId> --file /tmp/browser-session.jsonl
# 在另一个终端读取 watch 打印的明确路径：
./scripts/logs-tail.js --file /tmp/browser-session.jsonl --follow
./scripts/net-summary.js --file /tmp/browser-session.jsonl
```

`watch.js` 是普通前台持续命令，只监听指定 tab 的 console、异常和 network 事件。准备完成后打印 JSONL 路径；可指定新文件，已有文件会报错，默认生成唯一新文件。Ctrl+C、SIGTERM、tab 关闭或连接断开时关闭文件并断开连接，绝不关闭浏览器。连接意外断开时以失败状态退出。不保存 PID，不由 start 自动启动；需要后台执行时由调用方管理进程。

`logs-tail.js` 与 `net-summary.js` 必须给出 `--file`，不推断最新日志。两者接受 `--isolated`，但只读取明确文件，不连接浏览器。日志包含页面 URL 和 console 输出，使用后按任务需要保留。

## 数据位置和旧命令

独立模式在 `~/.cache/agent-web/<edge|chrome>/` 保存 `profile/`、`state.json`、`tab-emulation.json` 和 `logs/`；主模式仅在该目录下的 `main/` 保存 `tab-emulation.json` 和 `logs/`，不往主 profile 写入技能状态。

不再支持 `--profile`、`--new`、`stop --all`、自动选择最新日志、全局模拟偏好和后台 watcher 管理。旧缓存、日志、模拟文件及旧实例保留原样，不迁移、不删除。旧实例若需停止，由用户明确选择处理。
