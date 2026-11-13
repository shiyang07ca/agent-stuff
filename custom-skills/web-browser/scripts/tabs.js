#!/usr/bin/env node
import { parseCommand, run, withConnection } from "./cli.js";

await run(async () => {
  const { config } = parseCommand();
  await withConnection(config, async (cdp) => {
    for (const { targetId, title, url } of await cdp.getPages()) {
      console.log(JSON.stringify({ targetId, title, url }));
    }
  });
});
