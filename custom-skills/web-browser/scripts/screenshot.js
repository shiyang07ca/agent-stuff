#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseCommand, run, withConnection, attachTab } from "./cli.js";
import { applyDevicePreset, resolveDevicePreset } from "./devices.js";
import { applyActiveEmulation } from "./emulation-state.js";

await run(async () => {
  const { config, values } = parseCommand({
    "full-page": { type: "boolean" }, device: { type: "string" }, landscape: { type: "boolean" },
  }, { tab: true });
  const preset = values.device ? resolveDevicePreset(values.device) : null;
  if (values.device && !preset) throw new Error(`Unknown device preset: ${values.device}`);
  if (values.landscape && !preset) throw new Error("--landscape requires --device");
  await withConnection(config, async (cdp) => {
    const sessionId = await attachTab(cdp, config, values.tab, !preset);
    try {
      if (preset) await applyDevicePreset(cdp, sessionId, preset, { landscape: values.landscape });
      const params = { format: "png" };
      if (values["full-page"]) {
        const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
        const size = metrics.cssContentSize || metrics.contentSize;
        if (!size) throw new Error("Could not determine page dimensions");
        Object.assign(params, { fromSurface: true, captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.max(1, Math.ceil(size.width)), height: Math.max(1, Math.ceil(size.height)), scale: 1 } });
      }
      const { data } = await cdp.send("Page.captureScreenshot", params, sessionId, 20000);
      const path = join(tmpdir(), `screenshot-${randomUUID()}.png`);
      writeFileSync(path, Buffer.from(data, "base64"));
      console.log(path);
    } finally {
      if (preset) await applyActiveEmulation(cdp, sessionId, config, values.tab, { clear: true });
    }
  });
});
