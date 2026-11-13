import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { applyDevicePreset, clearDeviceEmulation, resolveDevicePreset } from "./devices.js";
import { withBrowserLock } from "./browser-processes.js";

function readState(config) {
  let text;
  try { text = readFileSync(config.emulationFile, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { version: 1, tabs: {} }; throw error; }
  const state = JSON.parse(text);
  if (state.version !== 1 || !state.tabs || typeof state.tabs !== "object") throw new Error(`Invalid emulation state: ${config.emulationFile}`);
  return state;
}

export function readEmulationPreference(config, targetId) {
  return readState(config).tabs[targetId] ?? null;
}

export async function writeEmulationPreference(config, targetId, preference) {
  await withBrowserLock(config.root, () => {
    const state = readState(config);
    if (preference) state.tabs[targetId] = { ...preference, updatedAt: new Date().toISOString() };
    else delete state.tabs[targetId];
    mkdirSync(config.root, { recursive: true });
    const temp = `${config.emulationFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temp, config.emulationFile);
    } finally { rmSync(temp, { force: true }); }
  });
}

export async function applyActiveEmulation(cdp, sessionId, config, targetId, { clear = false } = {}) {
  const preference = readEmulationPreference(config, targetId);
  if (!preference) {
    if (clear) await clearDeviceEmulation(cdp, sessionId);
    return null;
  }
  const preset = resolveDevicePreset(preference.device);
  if (!preset) throw new Error(`Unknown saved device preset: ${preference.device}`);
  return { preset, ...await applyDevicePreset(cdp, sessionId, preset, { landscape: preference.landscape }) };
}
