import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { connectIsolatedEndpoint } from "./cdp.js";

function hasArgument(command, argument) {
  let index = command.indexOf(argument);
  while (index !== -1) {
    const end = index + argument.length;
    if (
      (index === 0 || /\s/.test(command[index - 1])) &&
      (end === command.length || /\s/.test(command[end]))
    ) {
      return true;
    }
    index = command.indexOf(argument, index + 1);
  }
  return false;
}

export function parseBrowserProcesses(
  output,
  userDataDirs,
  browserBinaries = [],
) {
  const binaries = [...new Set(browserBinaries.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );

  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return [];

    const pid = Number(match[1]);
    const command = match[2];
    if (/(?:^|\s)--type=\S+/.test(command)) return [];

    const userDataDir = userDataDirs.find((dir) =>
      hasArgument(command, `--user-data-dir=${dir}`),
    );
    if (!userDataDir) return [];

    const browserBinary = binaries.find(
      (binary) => command === binary || command.startsWith(`${binary} `),
    );
    if (binaries.length > 0 && !browserBinary) return [];

    const portMatch = command.match(
      /(?:^|\s)--remote-debugging-port=(\d+)(?:\s|$)/,
    );
    return [
      {
        pid,
        port: portMatch ? Number(portMatch[1]) : null,
        userDataDir,
        browserBinary,
      },
    ];
  });
}

export function findBrowserProcesses(userDataDirs, browserBinaries = []) {
  return parseBrowserProcesses(
    execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }),
    userDataDirs,
    browserBinaries,
  );
}

function normalizeBrowserInstance(value) {
  if (!value || typeof value !== "object") return null;
  if (!Number.isInteger(value.pid) || !Number.isInteger(value.port)) return null;
  if (typeof value.userDataDir !== "string" || typeof value.browserBinary !== "string") return null;

  return {
    pid: value.pid,
    port: value.port,
    userDataDir: value.userDataDir,
    browserBinary: value.browserBinary,
    headless: value.headless === true,
    extensionsDisabled: value.extensionsDisabled === true,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
  };
}

export function readBrowserState(stateFile) {
  if (!existsSync(stateFile)) return { version: 2, instances: [] };

  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    const values =
      parsed?.version === 2 && Array.isArray(parsed.instances)
        ? parsed.instances
        : [];
    return {
      version: 2,
      instances: values.map(normalizeBrowserInstance).filter(Boolean),
    };
  } catch {
    return { version: 2, instances: [] };
  }
}

export function writeBrowserState(stateFile, state) {
  writeJsonFileAtomic(stateFile, state);
}

function writeJsonFileAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tempFile = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempFile, file);
  } finally {
    rmSync(tempFile, { force: true });
  }
}

export function pruneBrowserState(state, owners) {
  return {
    version: 2,
    instances: state.instances.filter((instance) =>
      owners.some(
        (owner) =>
          owner.pid === instance.pid &&
          owner.port === instance.port &&
          owner.userDataDir === instance.userDataDir,
      ),
    ),
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireBrowserLock(browserRoot) {
  const lockDir = join(browserRoot, ".operation-lock");
  const ownerFile = join(lockDir, "owner.json");
  const token = randomUUID();
  mkdirSync(browserRoot, { recursive: true });

  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(
          ownerFile,
          `${JSON.stringify({ pid: process.pid, token })}\n`,
          "utf8",
        );
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      let owner;
      try {
        owner = JSON.parse(readFileSync(ownerFile, "utf8"));
      } catch {
        throw new Error(`Could not verify browser operation lock: ${lockDir}`);
      }

      if (typeof owner.token !== "string" || !owner.token) {
        throw new Error(`Could not verify browser operation lock: ${lockDir}`);
      }

      if (Number.isInteger(owner.pid) && isProcessAlive(owner.pid)) {
        throw new Error(
          `Browser operation is already in progress (PID ${owner.pid})`,
        );
      }

      // 由 token 推导出的目标目录是永久的 tombstone。观察到这个 stale owner 的
      // 竞争者之后就无法再移动新获得的锁。
      const staleDir = `${lockDir}.stale.${owner.token}`;
      try {
        renameSync(lockDir, staleDir);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        if (
          renameError?.code === "EEXIST" ||
          renameError?.code === "ENOTEMPTY"
        ) {
          continue;
        }
        throw renameError;
      }
    }
  }

  return () => {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
      if (owner.token === token) {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

export async function withBrowserLock(browserRoot, operation) {
  const release = acquireBrowserLock(browserRoot);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function getBrowserPid(cdp) {
  const { processInfo } = await cdp.send(
    "SystemInfo.getProcessInfo",
    {},
    null,
    3000,
  );
  const pid = Number(
    processInfo.find((process) => process.type === "browser")?.id,
  );
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function getDebugBrowserPid(host, port) {
  const cdp = await connectIsolatedEndpoint(host, port);
  try {
    return await getBrowserPid(cdp);
  } finally {
    cdp.close();
  }
}

export async function closeDebugBrowser(host, port, expectedPid) {
  const cdp = await connectIsolatedEndpoint(host, port);
  try {
    const pid = await getBrowserPid(cdp);
    if (pid !== expectedPid) {
      throw new Error(
        `Debug endpoint :${port} belongs to PID ${pid ?? "unknown"}; expected ${expectedPid}`,
      );
    }
    await cdp.send("Browser.close", {}, null, 3000);
  } finally {
    cdp.close();
  }
}
