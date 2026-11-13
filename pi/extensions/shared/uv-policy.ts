import { delimiter } from "node:path";

/** 返回针对不得直接运行的命令的既有 UV 引导。 */
export function getBlockedCommandMessage(command: string): string | null {
  // 匹配 shell 片段开头的命令（start/换行/; /&& /|| /|）
  const pipCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip\s*(?:$|\s)/m;
  const pip3CommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip3\s*(?:$|\s)/m;
  const poetryCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?poetry\s*(?:$|\s)/m;

  // 匹配 python 调用，包括 .venv/bin/python 这类显式路径
  // 以及 .venv/bin/python3.12。
  const pythonPipPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*pip\b|\s-mpip\b)/m;
  const pythonVenvPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*venv\b|\s-mvenv\b)/m;
  const pythonPyCompilePattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*py_compile\b|\s-mpy_compile\b)/m;

  if (pipCommandPattern.test(command)) {
    return [
      "Error: pip is disabled; use uv instead:",
      "",
      "  Install a package for a script: uv run --with PACKAGE python script.py",
      "  Add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (pip3CommandPattern.test(command)) {
    return [
      "Error: pip3 is disabled; use uv instead:",
      "",
      "  Install a package for a script: uv run --with PACKAGE python script.py",
      "  Add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (poetryCommandPattern.test(command)) {
    return [
      "Error: poetry is disabled; use uv instead:",
      "",
      "  Initialize a project: uv init",
      "  Add a dependency: uv add PACKAGE",
      "  Sync dependencies: uv sync",
      "  Run a command: uv run COMMAND",
      "",
    ].join("\n");
  }

  if (pythonPipPattern.test(command)) {
    return [
      "Error: 'python -m pip' is disabled; use uv instead:",
      "",
      "  Install a package for a script: uv run --with PACKAGE python script.py",
      "  Add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (pythonVenvPattern.test(command)) {
    return [
      "Error: 'python -m venv' is disabled; use uv instead:",
      "",
      "  Create a virtual environment: uv venv",
      "",
    ].join("\n");
  }

  if (pythonPyCompilePattern.test(command)) {
    return [
      "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
      "",
      "  Check syntax without generating bytecode: uv run python -m ast path/to/file.py >/dev/null",
      "",
    ].join("\n");
  }

  return null;
}

/** 保持 bash 工具的 PATH 前缀与既有 UV 扩展一致。 */
export function uvCommandPrefix(interceptedCommandsPath: string): string {
  return `export PATH="${interceptedCommandsPath}:$PATH"`;
}

/** 复制进程环境，并把拦截 shim 放到 PATH 最前面。 */
export function withUvPath(
  baseEnv: NodeJS.ProcessEnv,
  interceptedCommandsPath: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  env.PATH = env.PATH ? `${interceptedCommandsPath}${delimiter}${env.PATH}` : interceptedCommandsPath;
  return env;
}
