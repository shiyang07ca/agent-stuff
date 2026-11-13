#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { openSync, closeSync, writeSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseCommand, run, withConnection, attachTab } from "./cli.js";

await run(async () => {
  const { config, values } = parseCommand({ file: { type: "string" } }, { tab: true });
  const path = resolve(values.file || join(config.logRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${values.tab}-${randomUUID()}.jsonl`));
  await withConnection(config, async (cdp) => {
    const sessionId = await attachTab(cdp, config, values.tab);
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx", 0o600);
    let done;
    let failure;
    const finished = new Promise((resolve) => { done = resolve; });
    const finish = () => done();
    const unsubscribers = [];
    const write = (payload) => {
      if (failure) return;
      try { writeSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), browser: config.browser, mode: config.mode, targetId: values.tab, ...payload })}\n`); }
      catch (error) { failure = error; done(); }
    };
    const listen = (event, callback) => unsubscribers.push(cdp.on(event, callback));
    const record = (event, transform) => listen(event, (params, session) => {
      if (session === sessionId) write(transform(params));
    });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    try {
      listen("disconnect", ({ error }) => { failure = error; done(); });
      listen("Target.detachedFromTarget", (params) => { if (params.sessionId === sessionId) done(); });
      listen("Inspector.detached", (_, session) => { if (session === sessionId) done(); });
      record("Runtime.consoleAPICalled", (p) => ({ type: "console", level: p.type, args: p.args.map((a) => ({ type: a.type, value: a.value ?? a.unserializableValue ?? a.description })), stack: p.stackTrace }));
      record("Runtime.exceptionThrown", (p) => ({ type: "exception", ...p.exceptionDetails }));
      record("Log.entryAdded", (p) => ({ type: "log", ...p.entry }));
      record("Network.requestWillBeSent", (p) => ({ type: "network.request", requestId: p.requestId, method: p.request.method, url: p.request.url, initiator: p.initiator?.type, hasPostData: !!p.request.hasPostData }));
      record("Network.responseReceived", (p) => ({ type: "network.response", requestId: p.requestId, url: p.response.url, status: p.response.status, mimeType: p.response.mimeType, fromDiskCache: !!p.response.fromDiskCache, fromServiceWorker: !!p.response.fromServiceWorker }));
      record("Network.loadingFailed", (p) => ({ type: "network.failure", requestId: p.requestId, errorText: p.errorText, canceled: !!p.canceled }));
      for (const domain of ["Runtime", "Log", "Network", "Inspector"]) await cdp.send(`${domain}.enable`, {}, sessionId);
      write({ type: "target.attached" });
      console.log(path);
      await finished;
      if (failure) throw failure;
    } finally {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      for (const unsubscribe of unsubscribers) unsubscribe();
      closeSync(fd);
    }
  }, { observer: true });
});
