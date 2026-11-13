---
name: tmux
description: "通过发送按键和读取 pane 输出，远程控制 Python、gdb 等交互式 CLI。"
license: Vibecoded
---

# tmux 技能

把 tmux 当作可编程终端复用器，用于自动操作交互式程序。支持 Linux 和 macOS；使用独立 socket，避免依赖或干扰个人 tmux 配置。

## 快速开始

```bash
PI_TMUX_SOCKET_DIR=${TMPDIR:-/tmp}/pi-agent-tmux-sockets
mkdir -p "$PI_TMUX_SOCKET_DIR"
SOCKET="$PI_TMUX_SOCKET_DIR/agent.sock"
SESSION=pi-python
tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION" -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION" -S -200
tmux -S "$SOCKET" kill-session -t "$SESSION"
```

创建会话后，必须立即告诉用户如何观察，并在工具循环结束时再给一次：

```text
你可以这样进入会话：
  tmux -S "$SOCKET" attach -t pi-lldb

也可以只抓取一次输出：
  tmux -S "$SOCKET" capture-pane -p -J -t pi-lldb -S -200
```

## Socket 约定

- socket 必须放在 `PI_TMUX_SOCKET_DIR` 下，默认 `${TMPDIR:-/tmp}/pi-agent-tmux-sockets`。
- 所有命令统一使用 `tmux -S "$SOCKET"`，便于枚举和清理。
- 默认可使用 `SOCKET="$PI_TMUX_SOCKET_DIR/agent.sock"`；确实需要隔离时再创建其他 socket。

## Pane 定位与命名

- target 可写成 `{session}`、`{session}:{window}` 或 `{session}:{window}.{pane}`。
- 本技能默认每个 session 只创建一个 window 和 pane，因此使用 session 名即可定位当前活动 pane，不依赖 `base-index` 或 `pane-base-index` 从 0 还是 1 开始。
- 创建额外 window 或 pane 后，`-t "$SESSION"` 会跟随当前活动 pane，可能不再指向原进程；此时不要继续依赖 session-only target。
- 用 `tmux -S "$SOCKET" list-panes -s -t "$SESSION" -F '#{pane_id}\t#{window_index}.#{pane_index}\t#{window_name}'` 枚举整个 session，再优先使用不会随重编号改变的 `%N` pane ID。
- 名称保持简短且不含空格，例如 `pi-py`、`pi-gdb`。
- 使用 `tmux -S "$SOCKET" list-sessions` 和 `tmux -S "$SOCKET" list-panes -a` 检查状态。
- 不需要用户配置时可通过 `-f /dev/null` 使用干净配置。

## 查找会话

- 列出当前 socket 上的会话：`./scripts/find-sessions.sh -S "$SOCKET"`。
- 使用 `-q partial-name` 按名称筛选。
- 扫描共享目录中的全部 socket：`./scripts/find-sessions.sh --all`。

## 安全发送输入

- 优先使用 literal 模式，避免 shell 拆词：`tmux -S "$SOCKET" send-keys -t target -l -- "$cmd"`。
- 拼接内联命令时使用单引号或 ANSI C quoting，避免提前展开。
- 发送控制键：`tmux ... send-keys -t target C-c`、`C-d`、`C-z`、`Escape`。

## 观察输出

- 获取最近历史并合并换行：`tmux -S "$SOCKET" capture-pane -p -J -t target -S -200`。
- 持续观察时轮询 pane 输出，不要用 `tmux wait-for`，它不会监视 pane 文本。
- 可以临时 attach：`tmux -S "$SOCKET" attach -t "$SESSION"`，按 `Ctrl+b d` 退出。
- 每次向用户说明操作时，都应同时给出可复制的观察命令。

## 启动进程的规则

- 用户要求调试时，默认优先使用 lldb。
- 启动 Python 交互终端时必须设置 `PYTHON_BASIC_REPL=1`，否则增强 console 可能干扰 `send-keys`。

## 同步与等待提示符

通过定时轮询避免与交互程序竞争。例如等待 Python 提示符：

```bash
./scripts/wait-for-text.sh -S "$SOCKET" -t "$SESSION" -p '^>>>' -T 15 -l 4000
```

长任务应等待明确完成文本，例如 `Program exited`，再继续下一步。

## 常见交互程序

- **Python REPL**：启动 `PYTHON_BASIC_REPL=1 python3 -q`，等待 `^>>>`，用 `-l` 发送代码，用 `C-c` 中断。
- **gdb**：运行 `gdb --quiet ./a.out`，执行 `set pagination off`，用 `C-c` 中断，再运行 `bt`、`info locals` 等命令；退出时发送 `quit` 并确认 `y`。
- **其他 TTY 程序**：ipdb、psql、mysql、node、bash 等使用相同模式——启动、等待提示符、literal 发送文本、发送 Enter。

## 清理

```bash
# 删除一个会话
tmux -S "$SOCKET" kill-session -t "$SESSION"

# 删除 socket 上的全部会话
tmux -S "$SOCKET" list-sessions -F '#{session_name}' | xargs -r -n1 tmux -S "$SOCKET" kill-session -t

# 关闭整个私有 tmux server
tmux -S "$SOCKET" kill-server
```

## wait-for-text.sh

`./scripts/wait-for-text.sh` 会轮询 pane，直到匹配正则或固定字符串，支持 Linux/macOS、bash、tmux 和 grep。

```bash
./scripts/wait-for-text.sh -S "$SOCKET" -t session -p 'pattern' [-F] [-T 20] [-i 0.5] [-l 2000]
```

- `-S`/`--socket-path`：与创建会话时相同的 tmux socket 路径；省略时使用 tmux 默认 socket。
- `-t`/`--target`：tmux session 或 pane target，必填。
- `-p`/`--pattern`：匹配正则，必填；增加 `-F` 后按固定字符串匹配。
- `-T`：超时秒数，默认 15。
- `-i`：轮询间隔，默认 0.5 秒。
- `-l`：搜索的历史行数，默认 1000。
- 首次匹配返回 0，超时返回 1；失败时把最后捕获的文本写到标准错误。
