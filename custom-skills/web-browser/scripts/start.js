#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  closeDebugBrowser,
  findBrowserProcesses,
  getDebugBrowserPid,
  pruneBrowserState,
  readBrowserState,
  withBrowserLock,
  writeBrowserState,
} from "./browser-processes.js";

import { resolveBrowserExecutable } from "./browser-config.js";
import { parseCommand } from "./cli.js";

const { config, values: args } = parseCommand({ headless: { type: "boolean" }, "reset-profile": { type: "boolean" } }, { lifecycle: true });
const {
  host: DEBUG_HOST,
  port: DEBUG_PORT,
  root: BROWSER_ROOT,
  stateFile: STATE_FILE,
  profileDir: userDataDir,
} = config;
const PROFILE_DIRS = [userDataDir];
const headless = args.headless === true;
const resetProfile = args["reset-profile"] === true;

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function isDebugPortOccupied() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: DEBUG_HOST, port: DEBUG_PORT });
    let settled = false;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };

    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (error) =>
      finish(error?.code !== "ECONNREFUSED"),
    );
  });
}

const browserBinary = resolveBrowserExecutable(config);
const browserBinaries = [browserBinary];

function fail(...lines) {
  throw new Error(lines.join("\n"));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !isProcessAlive(pid);
}

async function stopSpawnedBrowser(pid) {
  if (!pid) return true;
  try {
    await closeDebugBrowser(DEBUG_HOST, DEBUG_PORT, pid);
  } catch {
    // endpoint 可能尚未启动。SIGTERM 只是对本次调用所启动的
    // 那个进程的尽力清理。
  }
  if (await waitForProcessExit(pid)) return true;

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
  return waitForProcessExit(pid);
}

async function failAfterLaunch(pid, ...lines) {
  if (!(await stopSpawnedBrowser(pid))) {
    lines.push(
      `  Cleanup failed: ${config.label} PID ${pid} is still running with profile ${userDataDir}.`,
      "  Stop the process before retrying; the profile remains protected.",
    );
  }
  fail(...lines);
}

async function startBrowser() {
  const allOwners = findBrowserProcesses(PROFILE_DIRS);
  const owners = allOwners.filter(
    (owner) => owner.userDataDir === userDataDir,
  );
  const trustedOwners = findBrowserProcesses(PROFILE_DIRS, browserBinaries);
  let state = pruneBrowserState(readBrowserState(STATE_FILE), allOwners);
  writeBrowserState(STATE_FILE, state);

  if (await isDebugPortOccupied()) {
    let endpointPid = null;
    try {
      endpointPid = await getDebugBrowserPid(DEBUG_HOST, DEBUG_PORT);
    } catch {
      // 无法证明自身进程身份的 endpoint 一律不复用。
    }
    const runningState = state.instances.find(
      (instance) =>
        instance.userDataDir === userDataDir &&
        instance.port === DEBUG_PORT,
    );
    const owner = trustedOwners.find(
      (process) =>
        process.userDataDir === userDataDir && process.port === DEBUG_PORT,
    );

    if (
      owner &&
      endpointPid === owner.pid &&
      runningState?.pid === owner.pid
    ) {
      const runningHeadless = runningState.headless === true;
      const runningExtensionsDisabled =
        runningState.extensionsDisabled === true;
      if (
        !resetProfile &&
        runningState.userDataDir === userDataDir &&
        runningState.port === DEBUG_PORT &&
        owner.browserBinary === browserBinary &&
        runningState.browserBinary === browserBinary &&
        runningHeadless === headless &&
        runningExtensionsDisabled === headless
      ) {
        console.log(
          `✓ ${config.label} is already running on :${DEBUG_PORT} (${headless ? "headless" : "headed"})`,
        );
        return;
      }

      fail(
        `✗ ${config.label} is already running on :${DEBUG_PORT} (${runningHeadless ? "headless" : "headed"})`,
        "  Run stop.js --isolated before switching modes or resetting the profile.",
      );
    }

    fail(
      `✗ Debug endpoint :${DEBUG_PORT} is already in use`,
      "  Refusing to reuse an unknown instance to avoid attaching to your everyday profile.",
      `  Stop the process using :${DEBUG_PORT}, or use a different BROWSER_DEBUG_PORT.`,
    );
  }

  if (owners.length > 0) {
    fail(
      `✗ Profile is in use: ${userDataDir}`,
      ...owners.map(
        (owner) =>
          `  PID ${owner.pid}, debug port ${owner.port ?? "unknown"}`,
      ),
      "  Run stop.js --isolated first. Changing ports does not isolate the profile.",
    );
  }

  if (resetProfile) {
    rmSync(userDataDir, { recursive: true, force: true });
  }
  ensureDir(userDataDir);

  for (const staleFile of ["DevToolsActivePort", "DevToolsActivePort.lock"]) {
    rmSync(join(userDataDir, staleFile), { force: true });
  }

  const browserArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--profile-directory=Default",
    "--disable-search-engine-choice-screen",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--disable-features=ProfilePicker",
    "--enable-automation",
  ];

  if (headless) {
    browserArgs.push("--headless", "--disable-extensions");
  }

  const chromeProc = spawn(browserBinary, browserArgs, {
    detached: true,
    stdio: "ignore",
  });
  let spawnError;
  chromeProc.once("error", (error) => { spawnError = error; });
  chromeProc.unref();
  if (!chromeProc.pid) {
    await new Promise((resolve) => setImmediate(resolve));
    throw spawnError ?? new Error(`${config.label} did not provide a process ID`);
  }

  let connected = false;
  for (let i = 0; i < 30; i++) {
    let endpointPid = null;
    try {
      endpointPid = await getDebugBrowserPid(DEBUG_HOST, DEBUG_PORT);
    } catch {
      // 浏览器可能仍在启动中。
    }
    if (endpointPid && endpointPid !== chromeProc.pid) {
      await failAfterLaunch(
        chromeProc.pid,
        `✗ Debug endpoint :${DEBUG_PORT} belongs to another browser process`,
      );
    }
    if (endpointPid === chromeProc.pid) {
      connected = true;
      break;
    }
    if (!isProcessAlive(chromeProc.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!connected) {
    await failAfterLaunch(
      chromeProc.pid,
      `✗ Could not connect to ${config.label} on :${DEBUG_PORT}`,
      `  Executable used: ${browserBinary}`,
    );
  }

  const launchedBrowser = findBrowserProcesses(
    [userDataDir],
    [browserBinary],
  ).find(
    (process) =>
      process.pid === chromeProc.pid && process.port === DEBUG_PORT,
  );
  if (!launchedBrowser) {
    await failAfterLaunch(
      chromeProc.pid,
      `✗ Could not verify the ${config.label} process on :${DEBUG_PORT}`,
    );
  }

  const instance = {
    pid: launchedBrowser.pid,
    headless,
    extensionsDisabled: headless,
    userDataDir,
    port: DEBUG_PORT,
    browserBinary,
    startedAt: new Date().toISOString(),
  };
  state = {
    version: 2,
    instances: [
      ...state.instances.filter(
        (current) =>
          current.userDataDir !== userDataDir || current.port !== DEBUG_PORT,
      ),
      instance,
    ],
  };
  writeBrowserState(STATE_FILE, state);

  console.log(
    `✓ ${config.label} started on :${DEBUG_PORT}, mode ${headless ? "headless" : "headed"}`,
  );
  console.log(`  Profile directory: ${userDataDir}`);
}

try {
  await withBrowserLock(BROWSER_ROOT, startBrowser);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
