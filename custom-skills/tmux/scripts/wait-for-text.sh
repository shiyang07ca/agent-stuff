#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh [-S socket-path] -t session-or-pane -p pattern [options]

Poll text in a tmux pane and exit when it matches.

Options:
  -S, --socket-path  tmux socket path (default: tmux default socket)
  -t, --target       tmux session or pane target (required)
  -p, --pattern      Pattern to search for (required)
  -F, --fixed        Treat the pattern as a fixed string (grep -F)
  -T, --timeout      Timeout in seconds (integer, default: 15)
  -i, --interval     Polling interval in seconds (default: 0.5)
  -l, --lines         Number of history lines to check (integer, default: 1000)
  -h, --help         Show this help
USAGE
}

target=""
socket_path=""
pattern=""
grep_flag="-E"
timeout=15
interval=0.5
lines=1000

while [[ $# -gt 0 ]]; do
  case "$1" in
    -S|--socket-path)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Socket path cannot be empty" >&2
        exit 1
      fi
      socket_path="$2"; shift 2 ;;
    -t|--target)   target="${2-}"; shift 2 ;;
    -p|--pattern)  pattern="${2-}"; shift 2 ;;
    -F|--fixed)    grep_flag="-F"; shift ;;
    -T|--timeout)  timeout="${2-}"; shift 2 ;;
    -i|--interval) interval="${2-}"; shift 2 ;;
    -l|--lines)    lines="${2-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$target" || -z "$pattern" ]]; then
  echo "Both target and pattern are required" >&2
  usage
  exit 1
fi

if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "timeout must be an integer number of seconds" >&2
  exit 1
fi

if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
  echo "lines must be an integer" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

tmux_cmd=(tmux)
if [[ -n "$socket_path" ]]; then
  tmux_cmd+=(-S "$socket_path")
fi

# 截止时间（epoch 秒，整数即可满足轮询需要）
start_epoch=$(date +%s)
deadline=$((start_epoch + timeout))
capture_error=""

while true; do
  # -J 合并折行，-S 使用负索引读取最后 N 行
  if ! pane_text="$("${tmux_cmd[@]}" capture-pane -p -J -t "$target" -S "-${lines}" 2>&1)"; then
    capture_error="$pane_text"
    pane_text=""
  else
    capture_error=""
  fi

  if printf '%s\n' "$pane_text" | grep $grep_flag -- "$pattern" >/dev/null 2>&1; then
    exit 0
  fi

  now=$(date +%s)
  if (( now >= deadline )); then
    printf 'Timed out waiting for pattern (%ss): %s\n' "$timeout" "$pattern" >&2
    printf 'tmux socket: %s\n' "${socket_path:-default}" >&2
    printf 'tmux target: %s\n' "$target" >&2
    if [[ -n "$capture_error" ]]; then
      printf 'Last capture error: %s\n' "$capture_error" >&2
    fi
    printf 'Last %s lines captured:\n' "$lines" >&2
    printf '%s\n' "$pane_text" >&2
    exit 1
  fi

  sleep "$interval"
done
