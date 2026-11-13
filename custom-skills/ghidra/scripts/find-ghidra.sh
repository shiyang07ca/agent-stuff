#!/bin/bash
# 定位 Ghidra 安装和 analyzeHeadless 脚本
# 搜索常见安装路径，并输出 analyzeHeadless 的路径

set -e

# 搜索 Ghidra 的常见位置
SEARCH_PATHS=(
    # Apple Silicon 上的 Homebrew
    "/opt/homebrew/Caskroom/ghidra"
    # Intel 上的 Homebrew
    "/usr/local/Caskroom/ghidra"
    # 手动安装位置
    "/opt/ghidra"
    "/usr/local/ghidra"
    "$HOME/ghidra"
    "$HOME/Applications/ghidra"
    "/Applications/ghidra"
    # Linux 常见路径
    "/usr/share/ghidra"
    "/usr/local/share/ghidra"
)

# 优先检查 GHIDRA_HOME 环境变量
if [[ -n "$GHIDRA_HOME" ]]; then
    HEADLESS="$GHIDRA_HOME/support/analyzeHeadless"
    if [[ -x "$HEADLESS" ]]; then
        echo "$HEADLESS"
        exit 0
    fi
fi

# 搜索常见路径
for base_path in "${SEARCH_PATHS[@]}"; do
    if [[ -d "$base_path" ]]; then
        # 在目录树中查找 analyzeHeadless（兼容带版本号的路径）
        HEADLESS=$(find "$base_path" -name "analyzeHeadless" -type f 2>/dev/null | head -n 1)
        if [[ -n "$HEADLESS" && -x "$HEADLESS" ]]; then
            echo "$HEADLESS"
            exit 0
        fi
    fi
done

# 最后尝试在系统范围内查找
HEADLESS=$(find /opt /usr/local /Applications "$HOME" -name "analyzeHeadless" -type f 2>/dev/null | head -n 1)
if [[ -n "$HEADLESS" && -x "$HEADLESS" ]]; then
    echo "$HEADLESS"
    exit 0
fi

echo "Error: Could not find Ghidra's analyzeHeadless script." >&2
echo "Set the GHIDRA_HOME environment variable or install Ghidra." >&2
exit 1
