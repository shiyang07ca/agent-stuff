#!/usr/bin/env node
import { parseCommand, run, withConnection, attachTab } from "./cli.js";
import { applyDevicePreset, clearDeviceEmulation, listDevicePresets, resolveDevicePreset } from "./devices.js";
import { writeEmulationPreference } from "./emulation-state.js";

await run(async () => {
  // --list 不连接浏览器；设置和重置都必须指定 tab。
  const list = process.argv.includes("--list");
  const reset = process.argv.includes("--reset");
  const { config, values, positionals: [device] } = parseCommand({
    list: { type: "boolean" }, reset: { type: "boolean" }, landscape: { type: "boolean" },
  }, { tab: !list, positionals: list || reset ? 0 : 1 });
  if ((list && (reset || values.landscape || values.tab)) || (reset && values.landscape)) throw new Error("Incompatible emulation options");
  if (list) {
    for (const p of listDevicePresets()) console.log(`${p.id} ${p.width}x${p.height} @${p.deviceScaleFactor}x (${p.title})`);
    return;
  }
  const preset = reset ? null : resolveDevicePreset(device);
  if (!reset && !preset) throw new Error(`Unknown device preset: ${device}`);
  await withConnection(config, async (cdp) => {
    const sessionId = await attachTab(cdp, config, values.tab, false);
    if (reset) await clearDeviceEmulation(cdp, sessionId);
    else await applyDevicePreset(cdp, sessionId, preset, { landscape: values.landscape });
    try {
      await writeEmulationPreference(config, values.tab, reset ? null : { device: preset.id, landscape: values.landscape === true });
    } catch (error) {
      throw new Error(`Page emulation was ${reset ? "reset" : "applied"}, but its preference could not be saved; retry the command. ${error.message}`, { cause: error });
    }
    console.log(reset ? `✓ Emulation reset for ${values.tab}` : `✓ Saved ${preset.id} for ${config.browser}/${config.mode}/${values.tab}; reapplied by subsequent tab commands`);
  });
});
