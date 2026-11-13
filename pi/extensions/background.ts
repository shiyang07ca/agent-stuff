import {
	getAgentDir,
	truncateHead,
	truncateTail,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BackgroundManager } from "./background/manager.mjs";
import { currentTasks, newestFirst, parseCommand, resolveTask } from "./background/model.mjs";
import { ACTIVE_STATUSES } from "./background/shared.mjs";
import { openBackgroundLogs, openBackgroundPanel, startBackgroundTask, type BackgroundUIAPI } from "./background/ui.ts";
import { getBlockedCommandMessage, withUvPath } from "./shared/uv-policy.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "..", "intercepted-commands");

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_FIELD_BYTES = 8 * 1024;
const MAX_LOG_LINES = 500;
const DEFAULT_LOG_LINES = 50;
const ISSUE_STATUSES = new Set(["failed", "unconfirmed"]);

type BackgroundTask = {
	id?: string | null;
	name?: string | null;
	command?: string | null;
	cwd?: string | null;
	projectRoot?: string | null;
	createdAt?: string | null;
	status?: string | null;
	runnerPid?: number | null;
	childPid?: number | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	exitCode?: number | null;
	signal?: string | null;
	stopped?: boolean;
	unconfirmed?: boolean;
	superseded?: boolean;
	logPath?: string | null;
	taskDir?: string | null;
	detail?: string | null;
	error?: string | null;
	warning?: string | null;
	managerNote?: string | null;
	note?: string | null;
};

type BackgroundLogs = {
	id: string;
	name?: string | null;
	status?: string | null;
	text?: string | null;
	truncated?: boolean;
	logPath?: string | null;
};

type TaskDetails = {
	id: string | null;
	name: string | null;
	status: string | null;
	command: string | null;
	cwd: string | null;
	runnerPid: number | null;
	childPid: number | null;
	exitCode: number | null;
	signal: string | null;
	logPath: string | null;
	taskDir: string | null;
	detail: string | null;
	error: string | null;
	warning: string | null;
	managerNote: string | null;
};

type BackgroundDetails =
	| { action: "start"; task: TaskDetails }
	| { action: "list"; total: number; truncated: boolean; tasks: TaskDetails[] }
	| { action: "logs"; id: string; name: string | null; status: string | null; text: string; truncated: boolean; logPath: string | null }
	| { action: "stop"; task: TaskDetails }
	| { action: "clean"; id: string; removed: true };

type BackgroundToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: BackgroundDetails;
};

const taskTarget = Type.String({
	description: "Task name, full UUID, or unique UUID prefix. Names select the active run, otherwise the latest run.",
	minLength: 1,
	maxLength: 64,
});

const taskName = Type.String({
	description: "稳定的任务名称，只允许字母、数字、点、下划线和连字符。",
	minLength: 1,
	maxLength: 64,
	pattern: "^[A-Za-z0-9._-]+$",
});

function cleanText(value: unknown): string {
	return stripTerminalSequences(String(value ?? "")).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function boundedText(
	value: unknown,
	maxBytes: number,
	label: string,
	options: { tail?: boolean; maxLines?: number; sourceTruncated?: boolean } = {},
): { text: string; truncated: boolean } {
	const input = cleanText(value);
	const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER;
	const notice = options.tail
		? `\n\n[${label} truncated: keeping only the last ${maxLines} lines and up to ${maxBytes} bytes]\n`
		: `\n\n[${label} truncated: exceeds the ${maxBytes}-byte limit]\n`;
	const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"));
	const result = options.tail
		? truncateTail(input, { maxLines, maxBytes: contentLimit })
		: truncateHead(input, { maxLines, maxBytes: contentLimit });
	const truncated = Boolean(options.sourceTruncated || result.truncated);
	return {
		text: truncated ? `${result.content}${notice}` : result.content,
		truncated,
	};
}

function boundedField(value: unknown, label: string): string | null {
	if (value === undefined || value === null || value === "") return null;
	return boundedText(value, MAX_FIELD_BYTES, label).text;
}

function numericField(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function taskDetails(task: BackgroundTask): TaskDetails {
	return {
		id: boundedField(task.id, "task ID"),
		name: boundedField(task.name, "task name"),
		status: boundedField(task.status, "task status"),
		command: boundedField(task.command, "command"),
		cwd: boundedField(task.cwd, "working directory"),
		runnerPid: numericField(task.runnerPid),
		childPid: numericField(task.childPid),
		exitCode: numericField(task.exitCode),
		signal: boundedField(task.signal, "signal"),
		logPath: boundedField(task.logPath, "log path"),
		taskDir: boundedField(task.taskDir, "task record path"),
		detail: boundedField(task.detail, "task details"),
		error: boundedField(task.error, "error"),
		warning: boundedField(task.warning, "warning"),
		managerNote: boundedField(task.managerNote ?? task.note, "manager note"),
	};
}

function boundedTaskDetails(tasks: BackgroundTask[], outputTruncated = false): { total: number; truncated: boolean; tasks: TaskDetails[] } {
	const selected: TaskDetails[] = [];
	const detailsLimit = MAX_OUTPUT_BYTES - 1_024;
	for (const task of tasks) {
		const candidate = { total: tasks.length, truncated: false, tasks: [...selected, taskDetails(task)] };
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > detailsLimit) break;
		selected.push(candidate.tasks.at(-1)!);
	}
	return { total: tasks.length, truncated: outputTruncated || selected.length < tasks.length, tasks: selected };
}

function toolResult(details: BackgroundDetails, text: string): BackgroundToolResult {
	const cleaned = cleanText(text);
	return {
		content: [{ type: "text", text: Buffer.byteLength(cleaned, "utf8") <= MAX_OUTPUT_BYTES ? cleaned : boundedText(cleaned, MAX_OUTPUT_BYTES, "tool output").text }],
		details,
	};
}

function statusLabel(status: unknown): string {
	const labels: Record<string, string> = {
		starting: "starting",
		running: "running",
		stopping: "stopping",
		exited: "exited",
		failed: "failed",
		unconfirmed: "unconfirmed",
	};
	return labels[String(status)] ?? (cleanText(status) || "unknown");
}

function display(value: unknown, label: string, maxBytes = MAX_FIELD_BYTES): string {
	return boundedText(value, maxBytes, label).text || "not recorded";
}

function formatExit(task: BackgroundTask): string {
	const exitCode = task.exitCode == null ? "not recorded" : display(task.exitCode, "exit code", 256);
	const signal = task.signal == null ? "not recorded" : display(task.signal, "signal", 256);
	return `exit code=${exitCode}, signal=${signal}`;
}

function activeFirst(tasks: BackgroundTask[]): BackgroundTask[] {
	return [...tasks].sort((left, right) => {
		const activeDifference = Number(ACTIVE_STATUSES.has(String(right.status))) - Number(ACTIVE_STATUSES.has(String(left.status)));
		if (activeDifference !== 0) return activeDifference;
		return String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""));
	});
}

function formatTaskList(tasks: BackgroundTask[]): { text: string; truncated: boolean } {
	if (tasks.length === 0) return { text: "No background tasks.", truncated: false };
	const lines = [`Background tasks (${tasks.length} total):`];
	for (const task of activeFirst(tasks)) {
		lines.push(
			`- ${display(task.name, "task name", 512)} | ${statusLabel(task.status)} | ${display(task.id, "task ID", 512)}`,
			`  Command: ${display(task.command, "command")}`,
			`  cwd: ${display(task.cwd, "working directory")}`,
		);
		if (task.detail || task.error || task.warning || task.managerNote || task.note) {
			lines.push(`  Details: ${display(task.detail ?? task.error ?? task.warning ?? task.managerNote ?? task.note, "task details")}`);
		}
	}
	return boundedText(lines.join("\n"), MAX_OUTPUT_BYTES, "task list");
}

function formatLogs(logs: BackgroundLogs): { text: string; truncated: boolean } {
	const header = `Background task logs: name=${display(logs.name, "task name", 512)}, ID=${display(logs.id, "task ID", 512)}, status=${statusLabel(logs.status)}`;
	const remainingBytes = Math.max(1, MAX_OUTPUT_BYTES - Buffer.byteLength(`${header}\n`, "utf8"));
	const output = boundedText(logs.text, remainingBytes, "logs", {
		tail: true,
		maxLines: MAX_LOG_LINES,
		sourceTruncated: logs.truncated === true,
	});
	return { text: `${header}\n${output.text || "(no output)"}`, truncated: output.truncated };
}

function taskStartMessage(task: BackgroundTask): string {
	const identity = `Background task "${display(task.name, "task name", 512)}" (${display(task.id, "task ID", 512)})`;
	if (task.status === "failed" || (task.exitCode != null && task.exitCode !== 0)) {
		return `${identity} failed with status ${statusLabel(task.status)}; ${formatExit(task)}.`;
	}
	if (task.status === "exited") return `${identity} exited with status ${statusLabel(task.status)}; ${formatExit(task)}.`;
	if (task.status === "unconfirmed") return `${identity} was created, but its status is unconfirmed; check the task record and logs.`;
	return `${identity} started with status ${statusLabel(task.status)}.`;
}

function taskStopMessage(task: BackgroundTask): string {
	const identity = `Background task "${display(task.name, "task name", 512)}" (${display(task.id, "task ID", 512)})`;
	if (task.stopped && task.status === "exited") return `${identity} stopped; ${formatExit(task)}.`;
	return `${identity} has status ${statusLabel(task.status)}; ${formatExit(task)}.`;
}

function formatStatus(tasks: BackgroundTask[], ctx: ExtensionContext): string | undefined {
	const active = tasks.filter((task) => ACTIVE_STATUSES.has(String(task.status))).length;
	const issues = currentTasks(tasks).filter((task: BackgroundTask) => ISSUE_STATUSES.has(String(task.status))).length;
	if (active === 0 && issues === 0) return undefined;
	const activeText = active > 0 ? ctx.ui.theme.fg("success", `BG ${active}`) : "";
	const issueText = issues > 0 ? ctx.ui.theme.fg("warning", `${active > 0 ? "" : "BG "}Issues ${issues}`) : "";
	return [activeText, issueText].filter(Boolean).join(ctx.ui.theme.fg("warning", " · ")) || undefined;
}

function createStatusController(manager: BackgroundManager, onTasks: (tasks: BackgroundTask[]) => void) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;
	let inFlight: Promise<void> | undefined;
	let inFlightGeneration = -1;
	let queued = false;
	let refreshFailureNotified = false;

	function clear(ctx?: ExtensionContext): void {
		generation++;
		queued = false;
		refreshFailureNotified = false;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (ctx?.mode === "tui") ctx.ui.setStatus("background", undefined);
	}

	async function query(ctx: ExtensionContext, currentGeneration: number): Promise<void> {
		try {
			const tasks = (await manager.list(ctx.cwd)) as BackgroundTask[];
			if (currentGeneration !== generation || ctx.mode !== "tui") return;
			onTasks(tasks);
			refreshFailureNotified = false;
			ctx.ui.setStatus("background", formatStatus(tasks, ctx));
		} catch (error) {
			if (currentGeneration !== generation || ctx.mode !== "tui") return;
			if (!refreshFailureNotified) {
				refreshFailureNotified = true;
				const reason = boundedText(error instanceof Error ? error.message : String(error), MAX_FIELD_BYTES, "status error").text;
				ctx.ui.notify(`Background status refresh failed; keeping the previous status: ${reason}`, "warning");
			}
		}
	}

	function refresh(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") return Promise.resolve();
		queued = true;
		if (inFlight) {
			const existing = inFlight;
			if (inFlightGeneration === generation) return existing;
			return existing.then(() => {
				if (inFlight === existing) {
					inFlight = undefined;
					inFlightGeneration = -1;
				}
				return refresh(ctx);
			});
		}
		const currentGeneration = generation;
		const operation = (async () => {
			while (queued && currentGeneration === generation) {
				queued = false;
				await query(ctx, currentGeneration);
			}
		})();
		inFlight = operation;
		inFlightGeneration = currentGeneration;
		return operation.finally(() => {
			if (inFlight === operation) {
				inFlight = undefined;
				inFlightGeneration = -1;
			}
		});
	}

	function start(ctx: ExtensionContext): void {
		clear(ctx);
		if (ctx.mode !== "tui") return;
		timer = setInterval(() => {
			void refresh(ctx);
		}, 5_000);
		timer.unref?.();
		void refresh(ctx);
	}

	return { clear, refresh, start };
}

function emitCommandOutput(pi: ExtensionAPI, ctx: ExtensionContext, text: string, type: "info" | "error" = "info"): void {
	const cleaned = cleanText(text);
	const output = Buffer.byteLength(cleaned, "utf8") <= MAX_OUTPUT_BYTES ? cleaned : boundedText(cleaned, MAX_OUTPUT_BYTES, "command output").text;
	if (ctx.mode === "tui") {
		ctx.ui.notify(output, type);
		return;
	}
	if (ctx.mode === "print") {
		process.stderr.write(`${output}\n`);
		return;
	}
	pi.sendMessage(
		{
			customType: "background-command",
			content: output,
			display: true,
			details: { type, output },
		},
		{ triggerTurn: false },
	);
}

export default function (pi: ExtensionAPI) {
	const manager = new BackgroundManager(getAgentDir());
	let cachedTasks: BackgroundTask[] = [];
	const status = createStatusController(manager, (tasks) => { cachedTasks = tasks; });
	function api(ctx: ExtensionContext): BackgroundUIAPI {
		return {
			async list() {
				const tasks = await manager.list(ctx.cwd);
				cachedTasks = tasks;
				return newestFirst(tasks);
			},
			logs: (id, lines) => manager.logs(ctx.cwd, id, lines),
			async start(spec) {
				const blocked = getBlockedCommandMessage(spec.command);
				if (blocked) throw new Error(blocked);
				const task = await manager.start(ctx.cwd, spec, withUvPath(process.env, interceptedCommandsPath), ctx.signal);
				await status.refresh(ctx);
				return task;
			},
			async stop(id) {
				const task = await manager.stop(ctx.cwd, id, ctx.signal);
				await status.refresh(ctx);
				return task;
			},
			async clean(id) {
				const result = await manager.clean(ctx.cwd, id);
				await status.refresh(ctx);
				return result;
			},
		};
	}

	pi.registerTool({
		name: "background_start",
		label: "Start background task",
		description: "启动一个持久化的项目内 background 命令，任务状态、进程和日志会跨 Pi 会话保存。",
		promptSnippet: "启动持久化 background 开发服务",
		promptGuidelines: ["background_start 用于需要跨回合保留的非交互开发服务；常规构建和测试使用 bash。"],
		executionMode: "sequential",
		parameters: Type.Object({
			name: taskName,
			command: Type.String({ description: "要在 background 运行的非交互 shell 命令。", minLength: 1, maxLength: 100_000 }),
			cwd: Type.Optional(Type.String({ description: "项目内任务工作目录，相对于当前会话目录；默认使用当前会话目录。" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Background task start was cancelled.");
			const blockedMessage = getBlockedCommandMessage(params.command);
			if (blockedMessage) throw new Error(blockedMessage);
			const env = withUvPath(process.env, interceptedCommandsPath);
			const task = (await manager.start(ctx.cwd, { name: params.name, command: params.command, cwd: params.cwd }, env, signal)) as BackgroundTask;
			await status.refresh(ctx);
			return toolResult({ action: "start", task: taskDetails(task) }, `${taskStartMessage(task)}\nWorking directory: ${display(task.cwd, "working directory")}\nLog: ${display(task.logPath, "log path")}`);
		},
	});

	pi.registerTool({
		name: "background_list",
		label: "List background tasks",
		description: "List current project background tasks, including other Pi instances. Defaults to active tasks and latest failures; history includes all runs with commands and working directories for starting again.",
		promptSnippet: "查看 background 任务状态",
		annotations: { readOnlyHint: true },
		executionMode: "sequential",
		parameters: Type.Object({ history: Type.Optional(Type.Boolean({ description: "Include all past runs. Defaults to false." })) }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Background task query was cancelled.");
			const allTasks = await api(ctx).list();
			const tasks = (params.history ? allTasks : currentTasks(allTasks)) as BackgroundTask[];
			const output = formatTaskList(tasks);
			await status.refresh(ctx);
			return toolResult({ action: "list", ...boundedTaskDetails(tasks, output.truncated) }, output.text);
		},
	});

	pi.registerTool({
		name: "background_logs",
		label: "Read background logs",
		description: "读取持久化 background 任务日志的末尾内容，最多 500 行和 50 KiB，并清理终端控制序列。",
		promptSnippet: "读取 background 任务最近日志",
		annotations: { readOnlyHint: true },
		executionMode: "sequential",
		parameters: Type.Object({
			target: taskTarget,
			lines: Type.Optional(Type.Integer({ description: "读取末尾日志行数，范围为 1 到 500。", minimum: 1, maximum: MAX_LOG_LINES })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Background log query was cancelled.");
			const task = resolveTask(await api(ctx).list(), params.target);
			const logs = (await manager.logs(ctx.cwd, task.id, params.lines ?? DEFAULT_LOG_LINES)) as BackgroundLogs;
			const output = formatLogs(logs);
			const logId = cleanText(logs.id);
			const logName = boundedField(logs.name, "task name");
			const logStatus = boundedField(logs.status, "task status");
			const logPath = boundedField(logs.logPath, "log path");
			const detailPrefix = { action: "logs" as const, id: logId, name: logName, status: logStatus, text: "", truncated: false, logPath };
			const detailTextLimit = Math.max(1, MAX_OUTPUT_BYTES - Buffer.byteLength(JSON.stringify(detailPrefix), "utf8") - 128);
			const text = boundedText(logs.text, detailTextLimit, "logs", {
				tail: true,
				maxLines: MAX_LOG_LINES,
				sourceTruncated: logs.truncated === true,
			}).text;
			await status.refresh(ctx);
			return toolResult(
				{
					...detailPrefix,
					text,
					truncated: output.truncated,
				},
				output.text,
			);
		},
	});

	pi.registerTool({
		name: "background_stop",
		label: "Stop background task",
		description: "停止 background 任务，并等待 runner 与命令进程组确认退出。",
		promptSnippet: "安全停止 background 任务",
		executionMode: "sequential",
		parameters: Type.Object({ target: taskTarget }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Background task stop was cancelled.");
			const selected = resolveTask(await api(ctx).list(), params.target);
			const task = (await manager.stop(ctx.cwd, selected.id, signal)) as BackgroundTask;
			await status.refresh(ctx);
			return toolResult({ action: "stop", task: taskDetails(task) }, taskStopMessage(task));
		},
	});

	pi.registerCommand("background", {
		description: "Manage background tasks: panel, history, start, logs, stop, clean.",
		getArgumentCompletions(prefix) {
			const match = /^(logs|stop|clean)\s+(.*)$/.exec(prefix);
			const values = match
				? [...new Set(cachedTasks.flatMap((task) => [task.name, task.id]).filter((value): value is string => !!value))]
					.filter((value) => value.startsWith(match[2])).map((value) => `${match[1]} ${value}`)
				: ["history", "start", "logs", "stop", "clean"].filter((value) => value.startsWith(prefix));
			return values.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			try {
				const command = parseCommand(args);
				const actions = api(ctx);
				if (command.action === "panel" || command.action === "history") {
					if (ctx.mode === "tui") await openBackgroundPanel(ctx, actions, command.action === "history");
					else {
						const tasks = await actions.list();
						emitCommandOutput(pi, ctx, formatTaskList(command.action === "history" ? tasks : currentTasks(tasks)).text);
					}
					return;
				}
				if (command.action === "start") {
					if (command.name) emitCommandOutput(pi, ctx, taskStartMessage(await actions.start({ name: command.name, command: command.command! })));
					else if (ctx.mode === "tui") await startBackgroundTask(ctx, actions);
					else throw new Error("Use /background start <name> <command> in non-interactive mode.");
					return;
				}
				const task = resolveTask(await actions.list(), command.target!);
				if (command.action === "logs") {
					if (ctx.mode === "tui") await openBackgroundLogs(ctx, actions, task.id);
					else emitCommandOutput(pi, ctx, formatLogs(await actions.logs(task.id, DEFAULT_LOG_LINES) as BackgroundLogs).text);
					return;
				}
				if (command.action === "stop") {
					emitCommandOutput(pi, ctx, taskStopMessage(await actions.stop(task.id)));
					return;
				}
				if (ctx.mode !== "tui") throw new Error("Cleanup requires confirmation in interactive terminal mode.");
				if (task.status !== "exited" && task.status !== "failed") throw new Error("Only confirmed completed tasks can be cleaned up.");
				if (!await ctx.ui.confirm("Clean task?", `Delete records and logs for ${cleanText(task.name)} (${task.id})?`)) return;
				const result = await actions.clean(task.id);
				emitCommandOutput(pi, ctx, `Background task "${cleanText(result.id)}" cleaned up.`);
			} catch (error) {
				emitCommandOutput(pi, ctx, `Background command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		status.start(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		status.clear(ctx);
	});
}
