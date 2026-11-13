/**
 * UV 扩展 - 将 Python 工具链重定向到 uv 等价命令
 *
 * 本扩展包装 bash 工具，把 intercepted-commands 前置到 PATH。该目录包含
 * shim 脚本，用于拦截常见的 Python 工具链命令并引导 agent 改用 uv。
 *
 * 被拦截的命令：
 * - pip/pip3：阻止并建议使用 `uv add` 或 `uv run --with`
 * - poetry：阻止并给出 uv 等价命令（uv init、uv add、uv sync、uv run）
 * - python/python3：通过 `uv run` 重定向到真实解释器路径，
 *   并特殊处理以阻止 `python -m pip`、`python -m venv` 和 `python -m py_compile`
 *
 * shim 脚本位于 intercepted-commands 目录，会给出带 uv 等价命令的友好错误信息。
 *
 * 注意：PATH shim 可通过显式解释器路径绕过（例如 `.venv/bin/python`）。
 * 为堵住该缺口，本扩展还会在 bash spawn 时阻止不允许的调用。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { getBlockedCommandMessage, uvCommandPrefix } from "./shared/uv-policy.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "..", "intercepted-commands");

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const bashTool = createBashTool(cwd, {
    commandPrefix: uvCommandPrefix(interceptedCommandsPath),
    spawnHook: (ctx) => {
      const blockedMessage = getBlockedCommandMessage(ctx.command);
      if (blockedMessage) {
        throw new Error(blockedMessage);
      }
      return ctx;
    },
  });

  pi.registerTool(bashTool);
}
