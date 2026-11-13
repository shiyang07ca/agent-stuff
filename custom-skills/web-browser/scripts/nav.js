#!/usr/bin/env node
import { parseCommand, run, withConnection, attachTab } from "./cli.js";

await run(async () => {
  const { config, values, positionals: [url] } = parseCommand({}, { positionals: 1, optionalTab: true });
  new URL(url); // 在创建 tab 前拒绝无效 URL。
  await withConnection(config, async (cdp) => {
    const createData = cdp.extension && !values.tab && url.startsWith("data:");
    const targetId = values.tab ?? (await cdp.send("Target.createTarget", { url: createData ? url : "about:blank" })).targetId;
    console.log(`targetId: ${targetId}`);
    const sessionId = await attachTab(cdp, config, targetId);
    if (!createData) await cdp.navigate(sessionId, url);
    console.log(`✓ Navigated to: ${url}`);
  });
});
