#!/usr/bin/env node
import { parseCommand, run, withConnection, attachTab } from "./cli.js";

await run(async () => {
  const { config, values, positionals: [code] } = parseCommand({}, { tab: true, positionals: 1 });
  await withConnection(config, async (cdp) => {
    const sessionId = await attachTab(cdp, config, values.tab);
    let result;
    try { result = await cdp.evaluate(sessionId, `(async () => { return (${code}); })()`); }
    catch (error) {
      if (!error.message.startsWith("SyntaxError")) throw error;
      result = await cdp.evaluateRepl(sessionId, code);
    }
    console.log(typeof result === "object" ? JSON.stringify(result, null, 2) : result);
  });
});
