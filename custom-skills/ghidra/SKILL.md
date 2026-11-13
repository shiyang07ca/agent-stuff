---
name: ghidra
description: "使用 Ghidra headless analyzer 逆向分析二进制文件，包括反编译、函数、字符串、符号和调用图导出。"
---

# Ghidra headless 逆向分析

通过 Ghidra 的 `analyzeHeadless` 自动导入和分析二进制文件，将函数反编译为 C 伪代码，并导出便于继续检索的数据。

## 快速参考

| 任务 | 命令 |
|------|------|
| 完整分析并导出全部结果 | `ghidra-analyze.sh -s ExportAll.java -o ./output binary` |
| 反编译为 C 伪代码 | `ghidra-analyze.sh -s ExportDecompiled.java -o ./output binary` |
| 列出函数 | `ghidra-analyze.sh -s ExportFunctions.java -o ./output binary` |
| 提取字符串 | `ghidra-analyze.sh -s ExportStrings.java -o ./output binary` |
| 导出调用图 | `ghidra-analyze.sh -s ExportCalls.java -o ./output binary` |
| 导出符号 | `ghidra-analyze.sh -s ExportSymbols.java -o ./output binary` |
| 查找 Ghidra 路径 | `find-ghidra.sh` |

## 前置条件

- 已安装 **Ghidra**。macOS 可运行 `brew install --cask ghidra`。
- 已安装 **Java**，要求 OpenJDK 17 或更高版本。

脚本会自动查找常见安装位置。Ghidra 位于其他目录时，设置 `GHIDRA_HOME`。

## 主包装脚本

```bash
./scripts/ghidra-analyze.sh [options] <binary>
```

该脚本负责创建与清理临时项目，并为 `analyzeHeadless` 提供更简单的 interface。

参数：

- `-o, --output <dir>`：结果目录，默认为当前目录。
- `-s, --script <name>`：分析完成后运行的脚本，可以重复指定。
- `-a, --script-args <args>`：传给最近一个 `--script` 的参数。
- `--script-path <path>`：额外脚本搜索路径。
- `-p, --processor <id>`：处理器或架构，例如 `x86:LE:32:default`。
- `-c, --cspec <id>`：编译器规范，例如 `gcc`、`windows`。
- `--no-analysis`：跳过自动分析，速度更快但信息较少。
- `--timeout <seconds>`：每个文件的分析超时。
- `--keep-project`：分析后保留 Ghidra 项目。
- `--project-dir <dir>`：项目目录，默认 `/tmp`。
- `--project-name <name>`：项目名称，默认自动生成。
- `-v, --verbose`：输出详细日志。

## 内置导出脚本

### ExportAll.java

执行全部导出并生成摘要，适合作为首次分析入口。

输出文件：

- `{name}_summary.txt`：架构、内存区段、函数数量等概览。
- `{name}_decompiled.c`：全部函数的 C 伪代码。
- `{name}_functions.json`：函数、签名和调用关系。
- `{name}_strings.txt`：发现的全部字符串。
- `{name}_interesting.txt`：命中安全相关模式的函数。

```bash
./scripts/ghidra-analyze.sh -s ExportAll.java -o ./analysis firmware.bin
```

### ExportDecompiled.java

把全部函数反编译为 C 伪代码，输出 `{name}_decompiled.c`：

```bash
./scripts/ghidra-analyze.sh -s ExportDecompiled.java -o ./output program.exe
```

### ExportFunctions.java

以 JSON 导出函数地址、签名、参数和调用关系，输出 `{name}_functions.json`：

```json
{
  "program": "example.exe",
  "architecture": "x86",
  "functions": [
    {
      "name": "main",
      "address": "0x00401000",
      "size": 256,
      "signature": "int main(int argc, char **argv)",
      "returnType": "int",
      "callingConvention": "cdecl",
      "isExternal": false,
      "parameters": [{"name": "argc", "type": "int"}],
      "calls": ["printf", "malloc", "process_data"],
      "calledBy": ["_start"]
    }
  ]
}
```

### ExportStrings.java

提取 ASCII 与 Unicode 字符串及其地址，输出 `{name}_strings.json`：

```bash
./scripts/ghidra-analyze.sh -s ExportStrings.java -o ./output malware.exe
```

### ExportCalls.java

输出 `{name}_calls.json`，包含完整函数调用图、无调用者的潜在入口和调用频率最高的函数。

### ExportSymbols.java

输出 `{name}_symbols.json`，包含 import、export 和内部符号。

## 常见流程

### 分析未知二进制

```bash
mkdir -p ./analysis
./scripts/ghidra-analyze.sh -s ExportAll.java -o ./analysis unknown_binary
cat ./analysis/unknown_binary_summary.txt
cat ./analysis/unknown_binary_interesting.txt
grep -A 50 "encrypt" ./analysis/unknown_binary_decompiled.c
```

### 分析固件

```bash
./scripts/ghidra-analyze.sh \
  -p "ARM:LE:32:v7" \
  -s ExportAll.java \
  -o ./firmware_analysis \
  firmware.bin
```

### 快速列出函数

```bash
./scripts/ghidra-analyze.sh --no-analysis -s ExportFunctions.java -o . program
cat program_functions.json | jq '.functions[] | "\(.address): \(.name)"'
```

### 搜索特定模式

```bash
grep -n "password\|secret\|key" output_decompiled.c
grep -n "strcpy\|sprintf\|gets" output_decompiled.c
```

### 批量分析

```bash
for bin in ./samples/*; do
  name=$(basename "$bin")
  ./scripts/ghidra-analyze.sh -s ExportAll.java -o "./results/$name" "$bin"
done
```

## 常见 Processor ID

| 架构 | Processor ID |
|------|--------------|
| x86 32-bit | `x86:LE:32:default` |
| x86 64-bit | `x86:LE:64:default` |
| ARM 32-bit | `ARM:LE:32:v7` |
| ARM 64-bit | `AARCH64:LE:64:v8A` |
| MIPS 32-bit | `MIPS:BE:32:default` 或 `MIPS:LE:32:default` |
| PowerPC | `PowerPC:BE:32:default` |

列出可用处理器：

```bash
ls "$(dirname $(./scripts/find-ghidra.sh))/../Ghidra/Processors/"
```

## 故障排查

### 找不到 Ghidra

```bash
./scripts/find-ghidra.sh
export GHIDRA_HOME=/path/to/ghidra_11.x_PUBLIC
./scripts/ghidra-analyze.sh ...
```

### 分析时间过长

```bash
./scripts/ghidra-analyze.sh --timeout 300 -s ExportAll.java binary
./scripts/ghidra-analyze.sh --no-analysis -s ExportSymbols.java binary
```

### 内存不足

修改 `analyzeHeadless` 脚本，或设置：

```bash
export MAXMEM=4G
```

### 架构识别错误

```bash
./scripts/ghidra-analyze.sh -p "ARM:LE:32:v7" -s ExportAll.java firmware.bin
```

## 使用建议

1. 先运行 `ExportAll.java`，通过摘要建立整体认识。
2. 优先查看 `interesting.txt` 中自动标出的安全相关函数。
3. 使用 `jq` 处理机器可读的 JSON 导出。
4. 反编译结果并不完美，应与反汇编交叉核对。
5. 大型二进制耗时较长，可使用 `--timeout` 或 `--no-analysis` 快速初筛。
