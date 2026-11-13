# 浏览器技能安装

需要 macOS、Node.js 18 或更高版本、npm，以及 Microsoft Edge 或 Google Chrome。默认连接日常 Edge，`BROWSER=chrome` 选择 Chrome；不自动切换浏览器。浏览器连接和命令说明见 [SKILL.md](SKILL.md)。

在仓库源目录安装锁定依赖并检查：

```bash
cd /path/to/agent-stuff
make prepare
node --test custom-skills/web-browser/scripts/core.test.js
make validate
make audit-skills
make check
make plan
```

浏览器技能只依赖 `ws`，由 `scripts/package-lock.json` 固定；`make prepare` 同时安装 Pi 的锁定依赖。`make validate` 不安装依赖。不要在 `.runtime/` 或 HOME 下的技能副本安装依赖或修改文件。

需要启用且用户已授权时，先查看完整 plan 差异和标识，再执行：

```bash
make apply PLAN=<fingerprint>
make doctor
```

## 主浏览器准备

`make plan` 会展示本扩展的 Edge／Chrome Native Messaging 注册、启动入口和扩展文件。审阅后执行上述 apply／doctor，再在日常 profile 中打开 `edge://extensions/` 或 `chrome://extensions/`，开启开发者模式，选择“加载解压缩的扩展”，加载：

```text
~/Library/Application Support/agent-stuff/web-browser/extension
```

扩展名为 Agent Web Browser，固定 ID 为 `ddgmfcjoimgcdlbeigjpbdaobbnemjfn`。每种浏览器只在一个 profile 中启用，支持该 profile 全部窗口。首次安装接受扩展权限后，无需逐次批准连接；调试提示条仍可能显示。无需开启 inspect 调试，也不需要安装 Codex／ChatGPT。

更新源文件后重新 plan／apply，并在扩展管理页点击本扩展的重新加载。不要加载 `.runtime/current` 下的目录：浏览器会解析链接，旧快照删除后无法重载；上述固定实体目录由配置工具维护，不手工编辑。

```bash
BROWSER=edge ./custom-skills/web-browser/scripts/tabs.js
BROWSER=chrome ./custom-skills/web-browser/scripts/tabs.js
./custom-skills/web-browser/scripts/connection.js status
./custom-skills/web-browser/scripts/connection.js pause
./custom-skills/web-browser/scripts/connection.js resume
```

主模式不使用 `BROWSER_BIN` 和 `BROWSER_DEBUG_PORT`，不修改主 profile 文件。不要为排查连接问题重置用户的日常 profile。

连接失败时先查看扩展弹窗，再运行 `make doctor`。本机 host 名为 `io.agent_stuff.web_browser`，只允许上述扩展；Node 路径在 plan 时确定，GUI 浏览器不依赖终端 PATH。更换 Node 安装位置后重新 plan／apply。暂停状态跨浏览器重启保留，必须显式恢复；桥接意外断线后通信自动重连，失败的页面操作不会重放。

卸载时先在浏览器移除本扩展，再核对并删除本工具生成的两个 `NativeMessagingHosts/io.agent_stuff.web_browser.json` 注册，以及 `~/Library/Application Support/agent-stuff/web-browser/` 下的两个启动入口和扩展目录。不删除浏览器 profile、其他扩展注册或独立模式数据。

## 独立模式准备

```bash
BROWSER=edge ./custom-skills/web-browser/scripts/start.js --isolated --headless
BROWSER=edge ./custom-skills/web-browser/scripts/tabs.js --isolated
BROWSER=edge ./custom-skills/web-browser/scripts/stop.js --isolated
```

Edge 默认端口 `9222`，Chrome 默认 `9223`，数据分别保存在 `~/.cache/agent-web/edge/profile/` 和 `~/.cache/agent-web/chrome/profile/`。独立模式支持 `BROWSER_BIN` 绝对可执行路径和 `BROWSER_DEBUG_PORT` 覆盖；后续独立命令保持相同设置。切换 headless／可见窗口或重置前先停止所选独立实例。生命周期命令必须显式 `--isolated`。

macOS 首次访问钥匙串可能需要系统授权。临时 HOME 下即使 CDP 已连通，HTTP 导航也可能被钥匙串授权阻塞。检查可见窗口中的系统提示；生产启动参数不加入禁用或模拟钥匙串的选项。

旧的 `~/.cache/agent-web/browser/`、顶层 `logs/`、原 `emulation.json` 和旧 watcher 数据保留原样；不迁移、不删除，也不再兼容读取。现有 Edge／Chrome 独立 profile 目录继续使用。新 tab 偏好写入 `tab-emulation.json`，主模式放在对应浏览器缓存的 `main/` 下。
