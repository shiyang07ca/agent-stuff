#!/usr/bin/env node

import { createConnection } from "node:net";
import { parseCommand } from "./cli.js";
import {
  closeDebugBrowser,
  findBrowserProcesses,
  pruneBrowserState,
  readBrowserState,
  withBrowserLock,
  writeBrowserState,
} from "./browser-processes.js";

const { config: selected } = parseCommand({}, { lifecycle: true });

function isSameBrowser(left, right) {
  return (
    left.pid === right.pid &&
    left.port === right.port &&
    left.userDataDir === right.userDataDir &&
    left.browserBinary === right.browserBinary
  );
}

function isDebugPortOccupied(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
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
    socket.once("error", (error) => finish(error?.code !== "ECONNREFUSED"));
  });
}

async function stopMatchingBrowsers(config) {
  const profileDirs = [config.profileDir];
  let state = pruneBrowserState(
    readBrowserState(config.stateFile), findBrowserProcesses(profileDirs),
  );
  const browserBinaries = [...new Set([
    config.executable,
    ...state.instances.map((instance) => instance.browserBinary).filter(Boolean),
  ])];
  const findOwners = () => findBrowserProcesses(profileDirs, browserBinaries);
  const stillOwned = (browser) => findOwners().some((item) => isSameBrowser(item, browser));
  const waitForExit = async (browser, attempts) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!stillOwned(browser)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return !stillOwned(browser);
  };
  const removeClosedProcess = async (browser) => {
    if (await isDebugPortOccupied(config.host, browser.port)) return false;
    if (!stillOwned(browser)) return true;
    try {
      process.kill(browser.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return waitForExit(browser, 20);
  };

  const browsers = findOwners().filter(
    (browser) => Number.isInteger(browser.port) && browser.port === config.port,
  );
  for (const browser of browsers) {
    if (!stillOwned(browser)) continue;
    let closeError;
    try {
      await closeDebugBrowser(config.host, browser.port, browser.pid);
    } catch (error) {
      closeError = error;
    }
    if (!(await waitForExit(browser, 40))) {
      if (await removeClosedProcess(browser)) continue;
      if (closeError) throw closeError;
      throw new Error(
        `Browser PID ${browser.pid} has not exited. Not forcing shutdown to avoid profile corruption.`,
      );
    }
  }
  state = pruneBrowserState(state, findBrowserProcesses(profileDirs));
  writeBrowserState(config.stateFile, state);
  return browsers.length > 0;
}

try {
  const stopped = await withBrowserLock(selected.root, () => stopMatchingBrowsers(selected));
  console.log(stopped
    ? `✓ ${selected.label} skill browser stopped; profile was preserved`
    : `✓ No matching ${selected.label} skill browser is running`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
