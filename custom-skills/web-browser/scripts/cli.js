import { parseArgs } from "node:util";
import { getBrowserConfig } from "./browser-config.js";
import { connect } from "./cdp.js";
import { applyActiveEmulation } from "./emulation-state.js";

export function parseCommand(options = {}, { args = process.argv.slice(2), tab = false, optionalTab = false, lifecycle = false, positionals = 0 } = {}) {
  const result = parseArgs({ args, options: {
    isolated: { type: "boolean", default: false },
    ...(tab || optionalTab ? { tab: { type: "string" } } : {}), ...options,
  }, allowPositionals: true, strict: true });
  if (tab && !result.values.tab?.trim()) throw new Error("--tab <targetId> is required; use tabs.js to list tabs");
  if (result.values.tab !== undefined && !result.values.tab.trim()) throw new Error("--tab must not be empty");
  if (lifecycle && !result.values.isolated) throw new Error("This command requires --isolated; main browsers are never started, stopped or reset");
  if (result.positionals.length !== positionals) throw new Error(`Expected ${positionals} positional argument(s), received ${result.positionals.length}`);
  return { ...result, config: getBrowserConfig(process.env, result.values.isolated) };
}

export async function withConnection(config, operation, { observer = false } = {}) {
  const cdp = await connect(config);
  cdp.observer = observer;
  try { return await operation(cdp); }
  finally { cdp.close(); }
}

export async function attachTab(cdp, config, targetId, emulate = true) {
  const { targetInfo } = await cdp.send("Target.getTargetInfo", { targetId });
  if (targetInfo.type !== "page") throw new Error(`Target ${targetId} is not a page`);
  const sessionId = await cdp.attachToPage(targetId);
  if (emulate) await applyActiveEmulation(cdp, sessionId, config, targetId);
  return sessionId;
}

export async function run(operation) {
  try { await operation(); }
  catch (error) { console.error(`✗ ${error.message}`); process.exitCode = 1; }
}
