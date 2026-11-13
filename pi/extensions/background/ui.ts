import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { currentTasks, resolveTask } from "./model.mjs";
import { ACTIVE_STATUSES as ACTIVE, FINAL_STATUSES as FINAL } from "./shared.mjs";

export interface BackgroundUIAPI {
	list(): Promise<any[]>;
	logs(id: string, lines: number): Promise<{ text?: string; status?: string; truncated?: boolean; logPath?: string }>;
	start(spec: { name: string; command: string; cwd?: string }): Promise<any>;
	stop(id: string): Promise<any>;
	clean(id: string): Promise<any>;
}

const MAX_LOG_LINES = 500;

function text(value: unknown): string {
	return stripTerminalSequences(String(value ?? ""))
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
		.replace(/\t/g, "    ");
}

function line(value: unknown): string { return text(value).replace(/[\r\n\u2028\u2029]/g, " "); }
function reason(error: unknown): string { return line(error instanceof Error ? error.message : error); }
function isUnconfirmed(task: any): boolean { return task.status === "unconfirmed" || task.unconfirmed === true; }
function isFinal(task: any): boolean { return FINAL.has(task.status) && !isUnconfirmed(task); }
function normalExit(task: any): boolean { return task.status === "exited" && !isUnconfirmed(task); }
function identity(task: any): string { return `${line(task.name)} (${line(task.id)})`; }

async function choose(ctx: ExtensionContext, title: string, details: string[], items: SelectItem[], selected?: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		const listTheme = {
			selectedPrefix: (value: string) => theme.fg("accent", value),
			selectedText: (value: string) => theme.fg("accent", value),
			description: (value: string) => theme.fg("muted", value),
			scrollInfo: (value: string) => theme.fg("dim", value),
			noMatch: (value: string) => theme.fg("warning", value),
		};
		let maxVisible = 0;
		let list: SelectList;
		function resize() {
			const count = Math.max(1, Math.min(10, tui.terminal.rows - details.length - 5));
			if (count === maxVisible) return;
			selected = list?.getSelectedItem()?.value ?? selected;
			maxVisible = count;
			list = new SelectList(items, count, listTheme, { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 64 });
			const index = items.findIndex((item) => item.value === selected);
			if (index >= 0) list.setSelectedIndex(index);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
		}
		resize();
		return {
			render(width: number) {
				resize();
				const visibleDetails = details.slice(0, Math.max(0, tui.terminal.rows - maxVisible - 4));
				return [
					theme.fg("accent", title),
					...visibleDetails.map((value) => theme.fg("muted", value)),
					...list.render(width),
					theme.fg("dim", "↑↓ navigate · Enter select · Esc back"),
				].map((value) => truncateToWidth(value, Math.max(0, width), ""));
			},
			invalidate() { list.invalidate(); },
			handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
		};
	});
}

function taskDetails(task: any): string[] {
	const details = [
		`ID: ${line(task.id)}`,
		`Status: ${line(task.status)}${isUnconfirmed(task) ? " (exit not confirmed)" : ""}`,
		`Command: ${line(task.command)}`,
		`Directory: ${line(task.cwd)}`,
		`PID: runner ${line(task.runnerPid) || "unknown"}, command ${line(task.childPid) || "unknown"}`,
		`Created: ${line(task.createdAt) || "unknown"}`,
		`Exit: ${line(task.exitCode) || "unknown"}; signal: ${line(task.signal) || "none"}`,
		`Log: ${line(task.logPath) || "unknown"}`,
	];
	for (const key of ["detail", "error", "warning", "managerNote", "note"]) {
		if (task[key]) details.push(`${key}: ${line(task[key])}`);
	}
	return details;
}

function reportTask(ctx: ExtensionContext, task: any): void {
	ctx.ui.notify(`${identity(task)}: ${line(task.status)}${task.error || task.detail ? ` — ${line(task.error ?? task.detail)}` : ""}`,
		task.status === "failed" ? "error" : isUnconfirmed(task) ? "warning" : "info");
}

export async function startBackgroundTask(ctx: ExtensionContext, api: BackgroundUIAPI): Promise<void> {
	const name = await ctx.ui.input("Task name", "letters, numbers, dots, underscores, hyphens");
	if (name === undefined) return;
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(name.trim()) || name.trim() === "." || name.trim() === "..") {
		throw new Error("Task name must contain 1–64 letters, numbers, dots, underscores or hyphens, and cannot be . or ..");
	}
	const command = await ctx.ui.input("Shell command");
	if (command === undefined) return;
	if (!command.trim()) throw new Error("Command cannot be empty.");
	const cwd = await ctx.ui.input("Working directory (empty uses current directory)", line(ctx.cwd));
	if (cwd === undefined) return;
	reportTask(ctx, await api.start({ name: name.trim(), command, cwd: cwd.trim() || undefined }));
}

async function cleanExited(ctx: ExtensionContext, api: BackgroundUIAPI, tasks: any[]): Promise<void> {
	// Capture IDs before confirmation: tasks created afterward must never join this batch.
	const ids = tasks.filter(normalExit).map((task) => task.id as string);
	if (!ids.length) { ctx.ui.notify("No normally exited tasks to clean.", "info"); return; }
	if (!await ctx.ui.confirm("Clean exited tasks?", `Delete records and logs for ${ids.length} normally exited tasks? Failed and unconfirmed tasks are kept.`)) return;
	let cleaned = 0;
	let skipped = 0;
	const errors: string[] = [];
	for (const id of ids) {
		try {
			const task = (await api.list()).find((candidate) => candidate.id === id);
			if (!task || !normalExit(task)) { skipped++; continue; }
			await api.clean(id);
			cleaned++;
		} catch (error) { errors.push(`${line(id)}: ${reason(error)}`); }
	}
	ctx.ui.notify(`Cleaned ${cleaned}; skipped ${skipped}; failed ${errors.length}.${errors.length ? `\n${errors.join("\n")}` : ""}`, errors.length ? "error" : "info");
}

async function openTask(ctx: ExtensionContext, api: BackgroundUIAPI, id: string): Promise<void> {
	while (true) {
		const task = (await api.list()).find((candidate) => candidate.id === id);
		if (!task) { ctx.ui.notify(`Task ${line(id)} no longer exists.`, "warning"); return; }
		const items: SelectItem[] = [{ value: "logs", label: "Logs" }];
		if (ACTIVE.has(task.status) || isUnconfirmed(task)) items.push({ value: "stop", label: "Stop" });
		if (isFinal(task)) items.push({ value: "start", label: "Start again" }, { value: "clean", label: "Clean record and logs" });
		items.push({ value: "refresh", label: "Refresh" }, { value: "back", label: "Back" });
		const action = await choose(ctx, `Background task: ${line(task.name)}`, taskDetails(task), items);
		if (!action || action === "back") return;
		try {
			if (action === "logs") await openBackgroundLogs(ctx, api, id);
			if (action === "stop") reportTask(ctx, await api.stop(id));
			if (action === "start") {
				const latest = (await api.list()).find((candidate) => candidate.id === id);
				if (!latest || !isFinal(latest)) throw new Error("Task is no longer eligible to start again. Refresh and check its status.");
				// The API supplies the current environment; never reuse a persisted environment.
				reportTask(ctx, await api.start({ name: latest.name, command: latest.command, cwd: latest.cwd }));
			}
			if (action === "clean" && await ctx.ui.confirm("Clean task?", `Delete the record and logs for ${identity(task)}?`)) {
				const latest = (await api.list()).find((candidate) => candidate.id === id);
				if (!latest || !isFinal(latest)) throw new Error("Task is no longer eligible for cleanup. Refresh and check its status.");
				await api.clean(id);
				ctx.ui.notify(`Cleaned ${identity(task)}.`, "info");
				return;
			}
		} catch (error) { ctx.ui.notify(`Background action failed: ${reason(error)}`, "error"); }
	}
}

function elapsed(task: any): string {
	const start = Date.parse(task.startedAt ?? task.createdAt);
	const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
	if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
}

export async function openBackgroundPanel(ctx: ExtensionContext, api: BackgroundUIAPI, history = false): Promise<void> {
	if (ctx.mode !== "tui") { ctx.ui.notify("The background panel requires interactive terminal mode.", "warning"); return; }
	let selected: string | undefined;
	while (true) {
		try {
			const tasks = await api.list();
			const visible = history ? tasks : currentTasks(tasks);
			const items: SelectItem[] = visible.map((task: any) => ({
				value: task.id,
				label: `${line(task.name)} · ${task.status === "unconfirmed" ? "Status unconfirmed" : line(task.status)} · ${elapsed(task)} · ${line(task.id).slice(0, 8)}`,
				description: line(task.command),
			}));
			items.push(
				{ value: "switch", label: history ? "Show current tasks" : "Show history (all records)" },
				{ value: "start", label: "Start a task" },
				...(history ? [{ value: "clean", label: "Clean normally exited tasks", description: `${tasks.filter(normalExit).length} eligible` }] : []),
				{ value: "refresh", label: "Refresh" },
				{ value: "close", label: "Close" },
			);
			const action = await choose(ctx, `Background · ${history ? "History" : "Current"} (${visible.length})`, visible.length ? [] : ["No tasks in this view."], items, selected);
			if (!action || action === "close") return;
			selected = action;
			if (action === "switch") { history = !history; selected = undefined; }
			else if (action === "start") await startBackgroundTask(ctx, api);
			else if (action === "clean") await cleanExited(ctx, api, tasks);
			else if (action !== "refresh") await openTask(ctx, api, action);
		} catch (error) {
			ctx.ui.notify(`Background panel failed: ${reason(error)}`, "error");
			if (!await ctx.ui.confirm("Retry background panel?", "Refresh the task list and try again?")) return;
		}
	}
}

export async function openBackgroundLogs(ctx: ExtensionContext, api: BackgroundUIAPI, id: string): Promise<void> {
	if (ctx.mode !== "tui") { ctx.ui.notify("The background log viewer requires interactive terminal mode.", "warning"); return; }
	let dispose = () => {};
	try {
		// Resolve once, then pin the UUID even if a newer run reuses the name.
		const task = resolveTask(await api.list(), id);
		if (!task) throw new Error(`No background task matches ${line(id)}.`);
		const taskId = task.id;
		await ctx.ui.custom<void>((tui, theme, keys, done) => {
			let closed = false;
			let busy = false;
			let following = true;
			let generation = 0;
			let lines: string[] = [];
			let wrappedLines: string[] = [];
			let wrappedWidth = -1;
			let top = 0;
			let height = 1;
			let status = line(task.status);
			let logPath = line(task.logPath);
			let truncated = false;
			let error = "";
			let loaded = false;
			async function refresh(): Promise<void> {
				if (closed || busy || !following) return;
				busy = true;
				const requestGeneration = generation;
				try {
					const result = await api.logs(taskId, MAX_LOG_LINES);
					if (closed || !following || generation !== requestGeneration) return;
					const cleaned = text(result.text).replace(/\n$/, "");
					const incoming = cleaned ? cleaned.split("\n") : [];
					lines = incoming.slice(-MAX_LOG_LINES);
					wrappedWidth = -1;
					truncated = result.truncated === true || incoming.length > MAX_LOG_LINES;
					status = line(result.status ?? status);
					logPath = line(result.logPath ?? logPath);
					loaded = true;
					error = "";
				} catch (failure) {
					if (!closed && generation === requestGeneration) error = `Log refresh failed: ${reason(failure)}`;
				} finally {
					busy = false;
					if (!closed) tui.requestRender();
				}
			}
			const timer = setInterval(() => { void refresh(); }, 1_000);
			timer.unref?.();
			dispose = () => { closed = true; generation++; clearInterval(timer); };
			void refresh();
			return {
				dispose,
				invalidate() {},
				render(width: number) {
					const contentWidth = Math.max(1, width);
					if (wrappedWidth !== contentWidth) {
						wrappedLines = lines.flatMap((value) => wrapTextWithAnsi(value, contentWidth));
						wrappedWidth = contentWidth;
					}
					height = Math.max(1, Math.min(25, tui.terminal.rows - 7));
					const bottom = Math.max(0, wrappedLines.length - height);
					top = following ? bottom : Math.min(top, bottom);
					const body = wrappedLines.slice(top, top + height);
					if (!body.length) body.push(loaded ? "(no output)" : "Loading logs…");
					while (body.length < height) body.push("");
					return [
						theme.fg("accent", `Logs: ${line(task.name)} · ${line(taskId)}`),
						theme.fg("muted", `${status} · ${following ? "FOLLOWING" : "PAUSED (frozen snapshot)"} · rows ${wrappedLines.length ? top + 1 : 0}–${Math.min(top + height, wrappedLines.length)}/${wrappedLines.length}${truncated ? " · tail truncated" : ""}`),
						...body,
						theme.fg(error ? "error" : "dim", error || `Log: ${logPath || "unknown"}`),
						theme.fg("dim", "↑/PgUp pause · ↓/PgDn scroll · End/f follow · Esc back"),
					].map((value) => truncateToWidth(value, Math.max(0, width), ""));
				},
				handleInput(data: string) {
					if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) { dispose(); done(); return; }
					if (matchesKey(data, "end") || data === "f") {
						following = true;
						void refresh();
					} else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.pageUp")) {
						if (following) { following = false; generation++; top = Math.max(0, wrappedLines.length - height); }
						top = Math.max(0, top - (keys.matches(data, "tui.select.pageUp") ? height : 1));
					} else if (keys.matches(data, "tui.select.down") || keys.matches(data, "tui.select.pageDown")) {
						top = Math.min(Math.max(0, wrappedLines.length - height), top + (keys.matches(data, "tui.select.pageDown") ? height : 1));
					}
					tui.requestRender();
				},
			};
		});
	} catch (error) { ctx.ui.notify(`Background logs failed: ${reason(error)}`, "error"); }
	finally { dispose(); }
}
