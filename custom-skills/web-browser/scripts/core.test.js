import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { getBrowserConfig, readMainEndpoint } from "./browser-config.js";
import { parseBrowserProcesses, readBrowserState, withBrowserLock } from "./browser-processes.js";
import { parseCommand } from "./cli.js";
import { connectWebSocket } from "./cdp.js";
import { readEmulationPreference, writeEmulationPreference, applyActiveEmulation } from "./emulation-state.js";

const scripts = fileURLToPath(new URL(".", import.meta.url));
function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), "agent-web-core-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("main endpoint uses two lines and ignores isolated overrides; browser/mode data are independent", (t) => {
  const home = temporaryHome(t);
  const main = getBrowserConfig({ HOME: home, BROWSER_DEBUG_PORT: "invalid", BROWSER_BIN: "invalid" });
  assert.equal(main.browser, "edge");
  assert.equal(main.port, null);
  mkdirSync(main.profileDir, { recursive: true });
  const file = join(main.profileDir, "DevToolsActivePort");
  writeFileSync(file, "12345\n/devtools/browser/test-id\n");
  assert.equal(readMainEndpoint(main), "ws://127.0.0.1:12345/devtools/browser/test-id");
  writeFileSync(file, "0\n/invalid");
  assert.throws(() => readMainEndpoint(main), /Invalid DevToolsActivePort/);
  const configs = [main, getBrowserConfig({ HOME: home }, true), getBrowserConfig({ HOME: home, BROWSER: "chrome" }), getBrowserConfig({ HOME: home, BROWSER: "chrome" }, true)];
  for (const key of ["root", "profileDir", "emulationFile", "logRoot"]) assert.equal(new Set(configs.map((c) => c[key])).size, 4);
  assert.equal(configs[1].port, 9222);
  assert.equal(configs[3].port, 9223);
  for (const browser of ["", "firefox", "toString"]) assert.throws(() => getBrowserConfig({ BROWSER: browser }), /Invalid BROWSER/);
  for (const port of ["", "0", "65536", "1.5", "abc"]) assert.throws(() => getBrowserConfig({ BROWSER_DEBUG_PORT: port }, true), /Invalid BROWSER_DEBUG_PORT/);
});

test("CLI refuses implicit tabs, lifecycle main mode and removed options before connecting", () => {
  assert.throws(() => parseCommand({}, { args: [], tab: true }), /--tab/);
  assert.throws(() => parseCommand({}, { args: [], lifecycle: true }), /--isolated/);
  assert.throws(() => parseCommand({}, { args: ["--profile"] }), /Unknown option/);
  assert.throws(() => parseCommand({}, { args: ["--tab", ""], optionalTab: true }), /empty/);
  for (const script of ["eval.js", "screenshot.js", "pick.js", "dismiss-cookies.js", "emulate.js", "watch.js", "logs-tail.js", "net-summary.js", "start.js", "stop.js"]) {
    const result = spawnSync(process.execPath, [join(scripts, script)], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.status, 1, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /--tab|--file|--isolated/);
  }
});

test("process identity and operation locks protect each selected profile", async (t) => {
  const home = temporaryHome(t);
  const config = getBrowserConfig({ HOME: home }, true);
  const command = `${config.executable} --user-data-dir=${config.profileDir} --remote-debugging-port=9222`;
  const output = [`11 ${command}`, `12 ${command} --type=renderer`, `13 ${command.replace(config.profileDir, config.profileDir + "-other")}`, `14 /other/browser --user-data-dir=${config.profileDir} --remote-debugging-port=9222`].join("\n");
  assert.deepEqual(parseBrowserProcesses(output, [config.profileDir], [config.executable]), [{ pid: 11, port: 9222, userDataDir: config.profileDir, browserBinary: config.executable }]);
  await withBrowserLock(config.root, async () => {
    await assert.rejects(withBrowserLock(config.root, async () => {}), /already in progress/);
    await withBrowserLock(getBrowserConfig({ HOME: home, BROWSER: "chrome" }, true).root, async () => {});
  });
  const file = join(home, "old.json");
  const old = JSON.stringify({ pid: 11, port: 9222, userDataDir: "/old/profile" });
  writeFileSync(file, old);
  assert.deepEqual(readBrowserState(file).instances, []);
  assert.equal(readFileSync(file, "utf8"), old);
});

test("emulation preferences isolate tabs, browsers and modes; restore applies saved device or clears", async (t) => {
  const home = temporaryHome(t);
  const main = getBrowserConfig({ HOME: home });
  await writeEmulationPreference(main, "a", { device: "iphone-14", landscape: false });
  await writeEmulationPreference(main, "b", { device: "pixel-7", landscape: true });
  assert.equal(readEmulationPreference(main, "a").device, "iphone-14");
  assert.equal(readEmulationPreference(main, "b").device, "pixel-7");
  assert.equal(readEmulationPreference(getBrowserConfig({ HOME: home }, true), "a"), null);
  assert.equal(readEmulationPreference(getBrowserConfig({ HOME: home, BROWSER: "chrome" }), "a"), null);
  const calls = [];
  const cdp = { send: async (method, params) => calls.push({ method, params }) };
  await applyActiveEmulation(cdp, "session", main, "a", { clear: true });
  assert.equal(calls[0].params.width, 390);
  calls.length = 0;
  await applyActiveEmulation(cdp, "session", main, "absent", { clear: true });
  assert.equal(calls[0].method, "Emulation.clearDeviceMetricsOverride");
  await writeEmulationPreference(main, "a", null);
  assert.equal(readEmulationPreference(main, "a"), null);
  assert.equal(readEmulationPreference(main, "b").device, "pixel-7");
});

test("emulation writes and resets reject another process's lock without losing saved tabs", async (t) => {
  const config = getBrowserConfig({ HOME: temporaryHome(t) });
  await writeEmulationPreference(config, "a", { device: "iphone-14" });
  const before = readFileSync(config.emulationFile, "utf8");
  await withBrowserLock(config.root, async () => {
    for (const preference of [{ device: "pixel-7" }, null]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { writeEmulationPreference } from ${JSON.stringify(new URL("./emulation-state.js", import.meta.url).href)};
        await writeEmulationPreference(${JSON.stringify(config)}, "a", ${JSON.stringify(preference)});
      `], { encoding: "utf8", timeout: 2000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /already in progress/);
      assert.equal(readFileSync(config.emulationFile, "utf8"), before);
    }
  });
  await writeEmulationPreference(config, "b", { device: "pixel-7" });
  assert.equal(readEmulationPreference(config, "a").device, "iphone-14");
  assert.equal(readEmulationPreference(config, "b").device, "pixel-7");
  await writeEmulationPreference(config, "a", null);
  assert.equal(readEmulationPreference(config, "a"), null);
  assert.equal(readEmulationPreference(config, "b").device, "pixel-7");
});

// watch transport/disconnect behavior is exercised against the installed extension
// by the end-to-end acceptance run; main mode no longer uses DevToolsActivePort.
test("CDP rejects timeouts, protocol errors and all pending calls on disconnect; Browser.close is blocked", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  let peer;
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.method === "Bad.command") socket.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Unknown method" } }));
    });
  });
  const cdp = await connectWebSocket(`ws://127.0.0.1:${server.address().port}`, 1000);
  try {
    await assert.rejects(cdp.send("Browser.close"), /restricted/);
    await assert.rejects(cdp.send("Bad.command"), /-32601.*Unknown method/);
    await assert.rejects(cdp.send("No.reply", {}, null, 20), /CDP timeout: No.reply/);
    const pending = assert.rejects(cdp.send("Pending", {}, null, 30000), /disconnected/);
    peer.terminate();
    await pending;
    assert.equal(cdp.callbacks.size, 0);
    await assert.rejects(cdp.send("After.close"), /disconnected/);
  } finally { cdp.close(); await new Promise((resolve) => server.close(resolve)); }
});
