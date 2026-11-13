import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const BROWSERS = {
  edge: {
    label: "Microsoft Edge",
    executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    userData: "Microsoft Edge", port: 9222,
  },
  chrome: {
    label: "Google Chrome",
    executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    userData: "Google/Chrome", port: 9223,
  },
};

export function getBrowserConfig(env = process.env, isolated = false) {
  const browser = env.BROWSER ?? "edge";
  if (!Object.hasOwn(BROWSERS, browser)) throw new Error("Invalid BROWSER (expected edge or chrome)");
  const defaults = BROWSERS[browser];
  const home = env.HOME || homedir();
  const browserRoot = join(home, ".cache", "agent-web", browser);
  const root = isolated ? browserRoot : join(browserRoot, "main");
  const port = isolated ? Number(env.BROWSER_DEBUG_PORT ?? defaults.port) : null;
  if (isolated && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Invalid BROWSER_DEBUG_PORT (expected 1-65535)");
  }
  const executable = isolated ? env.BROWSER_BIN ?? defaults.executable : defaults.executable;
  if (!isAbsolute(executable)) throw new Error("BROWSER_BIN must be an absolute executable path");
  return {
    browser, isolated, mode: isolated ? "isolated" : "main", label: defaults.label,
    executable, host: "127.0.0.1", port, root,
    profileDir: isolated ? join(browserRoot, "profile") : join(home, "Library", "Application Support", defaults.userData),
    stateFile: join(root, "state.json"),
    // 新文件不读取或覆盖原先不区分 tab 的偏好。
    emulationFile: join(root, "tab-emulation.json"),
    logRoot: join(root, "logs"),
  };
}

export function readMainEndpoint(config) {
  const file = join(config.profileDir, "DevToolsActivePort");
  let lines;
  try { lines = readFileSync(file, "utf8").trim().split(/\r?\n/); }
  catch (error) { throw new Error(`Cannot read ${file}; enable remote debugging in ${config.label} and keep it open`, { cause: error }); }
  const port = Number(lines[0]);
  if (lines.length !== 2 || !/^\d+$/.test(lines[0]) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(lines[1])) {
    throw new Error(`Invalid DevToolsActivePort: ${file}`);
  }
  return `ws://127.0.0.1:${port}${lines[1]}`;
}

export function resolveBrowserExecutable(config) {
  try {
    accessSync(config.executable, constants.X_OK);
    if (!statSync(config.executable).isFile()) throw new Error("not a file");
  } catch (error) {
    throw new Error(`${config.label} executable unavailable: ${config.executable}. Set BROWSER_BIN to its executable path.`, { cause: error });
  }
  return config.executable;
}
