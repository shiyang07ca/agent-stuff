#!/usr/bin/env node
import { parseCommand, run, withConnection } from "./cli.js";

await run(async () => {
  const { config, positionals: [action] } = parseCommand({}, { positionals: 1 });
  if (config.isolated || !["status", "pause", "resume"].includes(action)) throw new Error("Usage: connection.js status|pause|resume (daily browser only)");
  await withConnection(config, async (cdp) => {
    console.log(JSON.stringify(await cdp.send(`Agent.${action}`), null, 2));
  });
});
