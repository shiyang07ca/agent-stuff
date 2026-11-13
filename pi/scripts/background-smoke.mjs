// Run with: node scripts/background-smoke.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundManager } from "../extensions/background/manager.mjs";
import { currentTasks, parseCommand, resolveTask } from "../extensions/background/model.mjs";

const records = [
	{ id: "abc-1", name: "web", status: "failed", createdAt: "2026-01-01" },
	{ id: "abc-2", name: "web", status: "running", createdAt: "2026-01-02" },
	{ id: "def-1", name: "unknown", status: "unconfirmed", createdAt: "2026-01-01" },
	{ id: "def-2", name: "unknown", status: "exited", createdAt: "2026-01-02" },
];
assert.deepEqual(currentTasks(records).map((t) => t.id), ["abc-2", "def-1"]);
assert.equal(resolveTask(records, "web").id, "abc-2");
assert.equal(resolveTask(records, "abc-1").status, "failed");
assert.throws(() => resolveTask(records, "abc"), /Ambiguous/);
assert.equal(resolveTask(records, "def-2").status, "exited");
assert.deepEqual(parseCommand('start web printf "%s" "hello world" | head -1'), {
	action: "start", name: "web", command: 'printf "%s" "hello world" | head -1',
});

const root = await mkdtemp(join(tmpdir(), "background-smoke-"));
const cwd = join(root, "project");
await mkdir(cwd);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const manager = new BackgroundManager(process.env.PI_CODING_AGENT_DIR);
const jiti = createJiti(import.meta.url);
const tools = new Map();
const commands = new Map();
const events = new Map();
const notices = [];
let backgroundStatus;
const ctx = {
	cwd, mode: "tui",
	ui: {
		theme: { fg: (_color, value) => value },
		setStatus(_name, value) { backgroundStatus = value; },
		notify: (message, level) => notices.push({ message, level }),
		confirm: async () => true,
	},
};
const call = (name, params) => tools.get(name).execute("smoke", params, undefined, undefined, ctx);
async function until(check) {
	for (let i = 0; i < 50; i++) {
		const value = await check();
		if (value) return value;
		await delay(100);
	}
	throw new Error("Timed out waiting for background task.");
}

try {
	const { default: extension } = await jiti.import("../extensions/background.ts");
	const { openBackgroundLogs, openBackgroundPanel } = await jiti.import("../extensions/background/ui.ts");
	extension({
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		on: (event, handler) => events.set(event, handler),
	});
	assert.deepEqual(Object.keys(tools.get("background_stop").parameters.properties), ["target"]);
	const background = commands.get("background");
	// Use the real command parser, runner and tool handlers with an isolated project/store.
	const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
	await background.handler(`start web ${node} -e 'console.log("ready"); setInterval(() => console.log("tick"), 100)'`, ctx);
	assert.equal(notices.at(-1)?.level, "info", notices.at(-1)?.message);
	const running = (await call("background_list", {})).details.tasks[0];
	assert.equal(running.name, "web");
	assert.equal(running.status, "running");
	await until(async () => (await call("background_logs", { target: "web", lines: 50 })).details.text.includes("ready"));
	// Exercise the actual UI components without starting a second terminal renderer.
	const uiApi = { list: () => manager.list(cwd), logs: (id, lines) => manager.logs(cwd, id, lines) };
	ctx.ui.custom = async (factory) => {
		let done = false;
		const component = factory({ terminal: { rows: 24 }, requestRender() {} }, ctx.ui.theme, {}, () => { done = true; });
		assert.match(component.render(100).join("\n"), /Background · Current.*web/s);
		component.handleInput("\x1b");
		assert.ok(done);
	};
	await openBackgroundPanel(ctx, uiApi);
	ctx.ui.custom = async (factory) => {
		let done = false;
		const keys = { matches: (data, name) => ({ "tui.select.cancel": "\x1b", "tui.select.up": "\x1b[A" })[name] === data };
		const component = factory({ terminal: { rows: 24 }, requestRender() {} }, ctx.ui.theme, keys, () => { done = true; });
		try {
			await until(() => component.render(100).join("\n").includes("ready"));
			component.handleInput("\x1b[A");
			const paused = component.render(100).join("\n");
			assert.match(paused, /PAUSED/);
			await delay(1100);
			assert.equal(component.render(100).join("\n"), paused);
			component.handleInput("f");
			assert.match(component.render(100).join("\n"), /FOLLOWING/);
			component.handleInput("\x1b");
			assert.ok(done);
		} finally { component.dispose(); }
	};
	await openBackgroundLogs(ctx, uiApi, running.id);
	assert.ok(!notices.some((notice) => notice.level === "error"), JSON.stringify(notices));
	assert.ok(background.getArgumentCompletions("logs w").some((item) => item.value === "logs web"));
	await assert.rejects(() => manager.clean(cwd, running.id), /only confirmed completed/i);
	await call("background_stop", { target: running.id.slice(0, 8) });
	assert.equal((await call("background_list", {})).details.total, 0);
	const history = (await call("background_list", { history: true })).details.tasks;
	assert.equal(history.length, 1);
	assert.equal(history[0].status, "exited");
	// Starting again creates a fresh ID and keeps the old record/logs.
	const next = (await call("background_start", { name: history[0].name, command: history[0].command, cwd: history[0].cwd })).details.task;
	assert.notEqual(next.id, running.id);
	assert.equal((await call("background_list", { history: true })).details.total, 2);
	await call("background_stop", { target: "web" });
	await background.handler(`clean ${next.id}`, ctx);
	assert.equal(notices.at(-1)?.level, "info", notices.at(-1)?.message);
	await background.handler(`clean ${running.id}`, ctx);
	assert.equal((await manager.list(cwd)).length, 0);
	const longLine = `BEGIN${Array.from({ length: 90 }, (_, i) => `[${i}]路径🙂`).join("")}TAIL`;
	await background.handler(`start broken ${node} -e 'console.log(${JSON.stringify(longLine)}); process.exit(2)'`, ctx);
	await until(async () => (await manager.list(cwd)).find((task) => task.status === "failed"));
	const failed = (await call("background_list", {})).details.tasks[0];
	assert.equal(failed.status, "failed");
	assert.match(backgroundStatus, /Issues 1/);
	// Long Unicode lines remain readable through scrolling, including after resizing.
	ctx.ui.custom = async (factory) => {
		const terminal = { rows: 12 };
		const component = factory({ terminal, requestRender() {} }, ctx.ui.theme, getKeybindings(), () => {});
		try {
			await until(() => component.render(80).join("\n").includes("TAIL"));
			component.handleInput("\x1b[5~");
			for (const width of [80, 30]) {
				const body = () => {
					const output = component.render(width);
					assert.ok(output.every((value) => visibleWidth(value) <= width));
					return output.slice(2, -2).map(stripTerminalSequences);
				};
				for (let i = 0; i < longLine.length; i++) {
					const before = body();
					component.handleInput("\x1b[5~");
					if (body().join("\n") === before.join("\n")) break;
				}
				const recovered = body();
				assert.ok(recovered[0].startsWith("BEGIN"));
				for (let i = 0; i < longLine.length; i++) {
					const before = body();
					component.handleInput("\x1b[B");
					const after = body();
					if (after.join("\n") === before.join("\n")) break;
					recovered.push(after.at(-1));
				}
				assert.equal(recovered.join(""), longLine);
			}
			component.handleInput("f");
			assert.match(component.render(80).join("\n"), /TAIL/);
			component.handleInput("\x1b");
		} finally { component.dispose(); }
	};
	await openBackgroundLogs(ctx, uiApi, failed.id);
	assert.ok(!notices.some((notice) => notice.level === "error"), JSON.stringify(notices));
	// Single cleanup must not revive old failures, even in a fresh manager/session.
	const recovered = (await call("background_start", { name: "broken", command: "exit 0" })).details.task;
	assert.equal(recovered.status, "exited");
	await background.handler(`clean ${recovered.id}`, ctx);
	assert.equal(notices.at(-1)?.level, "info", notices.at(-1)?.message);
	const reloaded = new BackgroundManager(process.env.PI_CODING_AGENT_DIR);
	assert.deepEqual(currentTasks(await reloaded.list(cwd)), []);
	assert.equal((await call("background_list", {})).details.total, 0);
	assert.equal(backgroundStatus, undefined);
	assert.deepEqual((await call("background_list", { history: true })).details.tasks.map((task) => task.id), [failed.id]);
	assert.equal((await call("background_logs", { target: failed.id })).details.text, longLine);
	// A new failure must still appear; bulk cleanup keeps both old failures in History.
	const olderSuccess = (await call("background_start", { name: "broken", command: "exit 0" })).details.task;
	const latestFailure = (await call("background_start", { name: "broken", command: "exit 3" })).details.task;
	assert.equal(latestFailure.status, "failed");
	await background.handler(`clean ${olderSuccess.id}`, ctx);
	assert.equal(notices.at(-1)?.level, "info", notices.at(-1)?.message);
	assert.deepEqual((await call("background_list", {})).details.tasks.map((task) => task.id), [latestFailure.id]);
	assert.match(backgroundStatus, /Issues 1/);
	await call("background_start", { name: "broken", command: "exit 0" });
	await call("background_start", { name: "broken", command: "exit 0" });
	let cleanSelected = false;
	ctx.ui.custom = async (factory) => {
		let selected;
		const component = factory({ terminal: { rows: 24 }, requestRender() {} }, ctx.ui.theme, getKeybindings(), (value) => { selected = value; });
		if (!cleanSelected) {
			for (let i = 0; i < 20; i++) {
				if (component.render(100).join("\n").includes("→ Clean normally exited tasks")) {
					component.handleInput("\r");
					cleanSelected = true;
					return selected;
				}
				component.handleInput("\x1b[B");
			}
		}
		component.handleInput("\x1b");
		return selected;
	};
	ctx.ui.confirm = async (title) => {
		assert.equal(title, "Clean exited tasks?");
		return true;
	};
	await openBackgroundPanel(ctx, { ...uiApi, clean: (id) => manager.clean(cwd, id) }, true);
	assert.ok(cleanSelected);
	assert.ok(!notices.some((notice) => notice.level === "error"), JSON.stringify(notices));
	assert.deepEqual(currentTasks(await reloaded.list(cwd)), []);
	assert.equal((await call("background_list", {})).details.total, 0);
	assert.equal(backgroundStatus, undefined);
	assert.deepEqual(new Set((await call("background_list", { history: true })).details.tasks.map((task) => task.id)), new Set([failed.id, latestFailure.id]));
	const retained = await reloaded.list(cwd);
	// The marker must never hide active or unconfirmed states.
	assert.equal(currentTasks(retained.map((task) => ({ ...task, status: "unconfirmed" }))).length, retained.length);
	assert.equal(currentTasks(retained.map((task) => ({ ...task, status: "running" }))).length, retained.length);
	console.log("PASS: selection, command parsing, tool migration, panel, log pause/follow/wrapping/resize, real start/logs/stop/start-again/clean, persistent failure visibility after single/bulk cleanup.");
} finally {
	events.get("session_shutdown")?.({}, ctx);
	for (const task of await manager.list(cwd)) {
		if (["starting", "running", "stopping", "unconfirmed"].includes(task.status)) await manager.stop(cwd, task.id);
	}
	await rm(root, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
