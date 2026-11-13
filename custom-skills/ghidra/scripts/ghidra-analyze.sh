#!/bin/bash
# Ghidra headless 分析的封装脚本
# 负责项目创建/清理，并提供更简单的接口

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 查找 analyzeHeadless
ANALYZE_HEADLESS=$("$SCRIPT_DIR/find-ghidra.sh")
GHIDRA_HOME=$(dirname "$(dirname "$ANALYZE_HEADLESS")")

show_help() {
    cat << 'EOF'
Usage: ghidra-analyze.sh [options] <binary>

Analyze a binary with the Ghidra headless analyzer.

Options:
  -o, --output <dir>       Output directory (default: current directory)
  -s, --script <name>      Script to run after analysis (can be repeated)
  -a, --script-args <args> Arguments for the last specified script
  --script-path <path>     Additional script search path
  -p, --processor <id>     Processor/architecture (e.g. x86:LE:32:default)
  -c, --cspec <id>         Compiler spec (e.g. gcc, windows)
  --no-analysis            Skip automatic analysis
  --timeout <seconds>      Per-file analysis timeout
  --keep-project           Keep the Ghidra project after analysis
  --project-dir <dir>      Ghidra project directory (default: /tmp)
  --project-name <name>    Project name (default: generated automatically)
  -v, --verbose            Print verbose logs
  -h, --help               Show this help

Built-in scripts (use with -s):
  ExportDecompiled.java    Export all functions as decompiled C code
  ExportFunctions.java     Export function list, addresses, and signatures
  ExportStrings.java       Export all strings found in the binary
  ExportCalls.java         Export the function call graph
  ExportSymbols.java       Export all symbols and their addresses

Examples:
  # Basic analysis and export decompiled output
  ghidra-analyze.sh -s ExportDecompiled.java -o ./output myprogram

  # Analyze with a specific architecture
  ghidra-analyze.sh -p ARM:LE:32:v7 firmware.bin

  # Run multiple scripts
  ghidra-analyze.sh -s ExportFunctions.java -s ExportStrings.java binary

  # Keep the project for later use
  ghidra-analyze.sh --keep-project --project-name MyProject binary
EOF
}

# 默认值
OUTPUT_DIR="."
SCRIPTS=()
SCRIPT_ARGS=()
SCRIPT_PATH=""
PROCESSOR=""
CSPEC=""
NO_ANALYSIS=""
TIMEOUT=""
KEEP_PROJECT=false
PROJECT_DIR="/tmp"
PROJECT_NAME=""
VERBOSE=false
BINARY=""

# 解析参数
while [[ $# -gt 0 ]]; do
    case $1 in
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -s|--script)
            SCRIPTS+=("$2")
            shift 2
            ;;
        -a|--script-args)
            # 把参数关联到最后一个脚本
            if [[ ${#SCRIPTS[@]} -gt 0 ]]; then
                SCRIPT_ARGS+=("${#SCRIPTS[@]}:$2")
            fi
            shift 2
            ;;
        --script-path)
            SCRIPT_PATH="$2"
            shift 2
            ;;
        -p|--processor)
            PROCESSOR="$2"
            shift 2
            ;;
        -c|--cspec)
            CSPEC="$2"
            shift 2
            ;;
        --no-analysis)
            NO_ANALYSIS="-noanalysis"
            shift
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --keep-project)
            KEEP_PROJECT=true
            shift
            ;;
        --project-dir)
            PROJECT_DIR="$2"
            shift 2
            ;;
        --project-name)
            PROJECT_NAME="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            BINARY="$1"
            shift
            ;;
    esac
done

if [[ -z "$BINARY" ]]; then
    echo "Error: No binary specified" >&2
    show_help
    exit 1
fi

if [[ ! -f "$BINARY" ]]; then
    echo "Error: Binary not found: $BINARY" >&2
    exit 1
fi

# 按需创建输出目录
mkdir -p "$OUTPUT_DIR"

# 未指定时生成项目名
if [[ -z "$PROJECT_NAME" ]]; then
    PROJECT_NAME="ghidra_$(basename "$BINARY" | tr '.' '_')_$$"
fi

# 构建脚本路径，包含内置脚本
BUILTIN_SCRIPTS="$SCRIPT_DIR/ghidra_scripts"
if [[ -n "$SCRIPT_PATH" ]]; then
    FULL_SCRIPT_PATH="$BUILTIN_SCRIPTS;$SCRIPT_PATH"
else
    FULL_SCRIPT_PATH="$BUILTIN_SCRIPTS"
fi

# 构建命令
CMD=("$ANALYZE_HEADLESS" "$PROJECT_DIR" "$PROJECT_NAME" -import "$BINARY")

# 添加脚本路径
CMD+=(-scriptPath "$FULL_SCRIPT_PATH")

# 添加脚本
for i in "${!SCRIPTS[@]}"; do
    script="${SCRIPTS[$i]}"
    CMD+=(-postScript "$script")

    # 检查该脚本是否有参数
    for arg_entry in "${SCRIPT_ARGS[@]}"; do
        idx="${arg_entry%%:*}"
        args="${arg_entry#*:}"
        if [[ "$idx" -eq $((i + 1)) ]]; then
            # 追加脚本参数
            CMD+=($args)
        fi
    done
done

# 把输出目录作为环境变量提供给脚本
export GHIDRA_OUTPUT_DIR="$OUTPUT_DIR"

# 按需添加 processor
if [[ -n "$PROCESSOR" ]]; then
    CMD+=(-processor "$PROCESSOR")
fi

# 按需添加编译器 spec
if [[ -n "$CSPEC" ]]; then
    CMD+=(-cspec "$CSPEC")
fi

# 按需添加 no-analysis 标志
if [[ -n "$NO_ANALYSIS" ]]; then
    CMD+=($NO_ANALYSIS)
fi

# 按需添加超时
if [[ -n "$TIMEOUT" ]]; then
    CMD+=(-analysisTimeoutPerFile "$TIMEOUT")
fi

# 除非保留项目，否则分析后删除
if [[ "$KEEP_PROJECT" != true ]]; then
    CMD+=(-deleteProject)
fi

# 添加日志文件
LOG_FILE="$OUTPUT_DIR/ghidra_analysis.log"
CMD+=(-log "$LOG_FILE")

# 运行分析
if [[ "$VERBOSE" == true ]]; then
    echo "Running: ${CMD[*]}"
fi

"${CMD[@]}" 2>&1 | tee "$OUTPUT_DIR/ghidra_output.log"

exit_code=${PIPESTATUS[0]}

if [[ $exit_code -eq 0 ]]; then
    echo ""
    echo "Analysis complete. Output files are in: $OUTPUT_DIR"
    ls -la "$OUTPUT_DIR"
else
    echo "Analysis failed with exit code: $exit_code" >&2
    echo "Check the log file: $LOG_FILE" >&2
fi

exit $exit_code
