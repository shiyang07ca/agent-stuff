import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createBashToolDefinition,
	createLocalBashOperations,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	isSubagentInvocation,
	isSubagentContinuation,
	SUBAGENT_SERVICE_CHANNEL,
	type SubagentInvocation,
	type SubagentRunDetails,
	type SubagentRunResult,
	type SubagentServiceRequest,
	type SubagentServiceState,
	type SubagentStatusRequest,
	type ThinkingLevel,
} from "./orchestration/protocol.ts";
import { registerInspectWorktree } from "./orchestration/worktree.ts";
import { ProcessTracker, SerialQueue, parseChildResult, processSnapshot, readProcessGroups, type ProcessIdentity, type RunStatus } from "./orchestration/lifecycle.ts";

const ATTACH_FLAG = "attach-subagent";
const CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";
const RESULT_ENV = "PI_TMUX_SUBAGENT_RESULT";
const SPEC_ENV = "PI_TMUX_SUBAGENT_SPEC";
const ORCHESTRATION_CHILD_ENV = "PI_MONTE_ORCHESTRATION_CHILD";
const RUNS_DIR = "tmux-subagents";
const POLL_INTERVAL_MS = 500;
const PANE_PREVIEW_LINES = 18;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
const EXTENSION_PATH = fileURLToPath(import.meta.url);
const UNIFIED_EDIT_PATH = path.join(path.dirname(EXTENSION_PATH), "unified-edit.ts");

export type { RunStatus } from "./orchestration/lifecycle.ts";

interface ChildResult {
	version: 1;
	runId?: string;
	status: "completed" | "failed";
	output: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	finishedAt: number;
}

export type RunDetails = SubagentRunDetails;

interface RunSpec {
	runId: string;
	childSessionId: string;
	resumedFrom?: string;
	sessionFile?: string;
	profile?: SubagentInvocation["profile"];
	task: string;
	cwd: string;
	attachmentId: string;
	tmuxSession: string;
	tmuxTarget: string;
	attachCommand: string;
	captureCommand: string;
	killCommand: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	trusted: boolean;
	role?: SubagentInvocation["role"];
	tools?: string[];
	orchestrationChild?: boolean;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function tmuxSocketPath(): string {
	return path.join(getAgentDir(), "tmux-subagents.sock");
}

function tmuxSessionName(sessionId: string): string {
	return `pi-agent-${sessionId}`;
}

function currentTmuxSocket(): string | undefined {
	const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
	return socket || undefined;
}

function attachFlagValue(argv: string[]): string | undefined {
	const flag = `--${ATTACH_FLAG}`;
	for (let index = 2; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--") break;
		if (argument === flag) {
			const value = argv[index + 1];
			return !value || value.startsWith("--") ? "" : value;
		}
		if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
	}
	return undefined;
}

function tmuxCommandPrefix(): string {
	return `tmux -S ${shellQuote(tmuxSocketPath())}`;
}

function tmuxArgs(...args: string[]): string[] {
	return ["-S", tmuxSocketPath(), ...args];
}

async function tmuxSessionExists(pi: ExtensionAPI, session: string): Promise<boolean> {
	const result = await pi.exec("tmux", tmuxArgs("list-sessions", "-F", "#{session_name}"), { timeout: 5_000 });
	if (result.killed) throw new Error("Timed out while checking tmux session.");
	if (result.code === 0) return result.stdout.split(/\r?\n/).includes(session);
	try {
		await stat(tmuxSocketPath());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	throw new Error(`Could not verify tmux session state: ${result.stderr.trim() || result.stdout.trim() || "query failed"}`);
}

async function removeTmuxSession(pi: ExtensionAPI, session: string): Promise<void> {
	const result = await pi.exec("tmux", tmuxArgs("kill-session", "-t", session), { timeout: 5_000 });
	if (result.killed) throw new Error("Timed out while removing tmux session.");
	if (await tmuxSessionExists(pi, session)) {
		throw new Error(result.stderr.trim() || `tmux session ${session} still exists after cleanup.`);
	}
}

async function tmuxPaneState(pi: ExtensionAPI, session: string): Promise<"missing" | "live" | "dead"> {
	if (!(await tmuxSessionExists(pi, session))) return "missing";
	const result = await pi.exec("tmux", tmuxArgs("display-message", "-p", "-t", session, "#{pane_dead}"), { timeout: 5_000 });
	if (result.killed || result.code !== 0) {
		throw new Error(`Could not check tmux session ${session}: ${result.stderr.trim() || "query failed"}`);
	}
	const state = result.stdout.trim();
	if (state === "0") return "live";
	if (state === "1") return "dead";
	throw new Error(`Could not parse tmux pane state for ${session}: ${JSON.stringify(state)}`);
}

function updateTmuxCommands(spec: RunSpec): void {
	const tmux = tmuxCommandPrefix();
	spec.attachCommand = `pi --${ATTACH_FLAG} ${shellQuote(spec.attachmentId)}`;
	spec.captureCommand = `${tmux} capture-pane -p -J -t ${shellQuote(spec.tmuxTarget)}`;
	spec.killCommand = `${tmux} kill-session -t ${shellQuote(spec.tmuxSession)}`;
}

function attachToSubagentAndExit(rawTarget: string): never {
	const target = rawTarget.trim();
	if (!target) {
		console.error(`Error: --${ATTACH_FLAG} requires a session id printed by the subagent tool.`);
		process.exit(2);
	}

	let socket = tmuxSocketPath();
	let session: string;
	if (target.startsWith("v1.")) {
		// 对在 session-id target 之前启动的 session，保持 attachment 可用。
		try {
			const legacy = JSON.parse(Buffer.from(target.slice(3), "base64url").toString("utf8")) as {
				s?: unknown;
				p?: unknown;
			};
			if (typeof legacy.s !== "string" || !legacy.s || typeof legacy.p !== "string" || !legacy.p) {
				throw new Error("Missing tmux session or socket");
			}
			session = legacy.s;
			socket = legacy.p;
		} catch (error) {
			console.error(`Error: Invalid legacy subagent target: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(2);
		}
	} else {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) {
			console.error(`Error: Invalid subagent session id: ${target}`);
			process.exit(2);
		}
		session = tmuxSessionName(target);
	}

	const sameServer = currentTmuxSocket() === socket;
	const args = ["-S", socket, sameServer ? "switch-client" : "attach-session", "-t", session];
	const env = { ...process.env };
	if (!sameServer) {
		delete env.TMUX;
		delete env.TMUX_PANE;
	}
	const result = spawnSync("tmux", args, { stdio: "inherit", env });
	if (result.error) console.error(`Failed to run tmux: ${result.error.message}`);
	process.exit(result.status ?? 1);
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return [process.execPath];
	}

	return ["pi"];
}

function textFromAssistant(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text)
		.join("\n");
}

function findLastAssistant(ctx: ExtensionContext, previousEntries: Set<string> | undefined): Record<string, unknown> | undefined {
	if (!previousEntries) return undefined;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (previousEntries.has(entry.id)) break;
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string): void {
	const processDir = path.join(path.dirname(resultPath), "processes");
	const operations: ReturnType<typeof createLocalBashOperations> = {
		async exec(command, cwd, options) {
			const localBash = createLocalBashOperations({ shellPath: pi.getSettings().shellPath });
			await mkdir(processDir, { recursive: true, mode: 0o700 });
			const manifest = path.join(processDir, `${randomUUID()}.process`);
			// Pi 的本地 bash backend 以独立进程组启动 shell。在执行用户命令
			// 之前落盘身份，避免短命 shell 在父进程下一次采样前退出。
			const record = `LC_ALL=C ps -p "$$" -o pid=,ppid=,pgid=,stat=,lstart= > ${shellQuote(`${manifest}.tmp`)} && mv ${shellQuote(`${manifest}.tmp`)} ${shellQuote(manifest)} || exit 125`;
			return localBash.exec(`${record}\n${command}`, cwd, options);
		},
	};
	pi.registerTool(createBashToolDefinition(process.cwd(), {
		operations,
		spawnHook: (context) => {
			const prefix = pi.getSettings().shellCommandPrefix;
			return { ...context, command: prefix ? `${prefix}\n${context.command}` : context.command };
		},
	}));
	// user_bash 的 commandPrefix 已由 AgentSession.executeBash 应用。
	pi.on("user_bash", () => ({ operations }));
	// 当前运行显式的 --tools allowlist 决定是否启用。
	if (process.env[ORCHESTRATION_CHILD_ENV] === "1") registerInspectWorktree(pi);
	let reported = false;
	let previousEntries: Set<string> | undefined;
	let expected: RunSpec | undefined;
	let startupError: string | undefined;
	const sessionPath = path.join(path.dirname(resultPath), "session.json");
	const activityPath = path.join(path.dirname(resultPath), "activity.json");
	let activityWrite = Promise.resolve();
	pi.on("tool_execution_end", (event) => {
		const activity = { lastToolAt: Date.now(), lastTool: event.toolName };
		activityWrite = activityWrite.then(() => writeJsonAtomic(activityPath, activity)).catch((error) => {
			console.error(`[tmux-subagent] Failed to save tool activity: ${String(error)}`);
		});
	});

	const report = async (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
		if (reported) return;
		reported = true;

		const assistant = findLastAssistant(ctx, previousEntries);
		const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
		const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
		const failed = !assistant || stopReason !== "stop" || Boolean(fallbackError);
		const output = assistant ? textFromAssistant(assistant) : "";
		const completionError = !assistant
			? "Subagent exited without an assistant response."
			: stopReason !== "stop"
				? `Subagent did not finish normally (stop reason: ${stopReason ?? "unknown"}); completion is unconfirmed.`
				: undefined;
		const result: ChildResult = {
			version: 1,
			runId: expected?.runId,
			status: failed ? "failed" : "completed",
			output,
			error: fallbackError ?? assistantError ?? completionError,
			stopReason,
			sessionFile: ctx.sessionManager.getSessionFile(),
			provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
			model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
			thinking: pi.getThinkingLevel(),
			finishedAt: Date.now(),
		};

		try {
			await activityWrite;
			await writeJsonAtomic(resultPath, result);
		} catch (error) {
			console.error(`[tmux-subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const configurationError = (ctx: ExtensionContext): string | undefined => {
		if (!expected) return process.env[ORCHESTRATION_CHILD_ENV] === "1" ? "Missing child process startup spec." : undefined;
		if (ctx.cwd !== expected.cwd || ctx.sessionManager.getSessionId() !== expected.childSessionId ||
			(expected.sessionFile && ctx.sessionManager.getSessionFile() !== expected.sessionFile)) {
			return "Child process resumed in a different working directory or session; refusing fallback.";
		}
		if (expected.orchestrationChild && (ctx.model?.provider !== expected.provider || ctx.model?.id !== expected.model ||
			pi.getThinkingLevel() !== expected.thinking)) {
			return `Child process configuration mismatch: expected ${expected.provider}/${expected.model} (${expected.thinking}), got ${ctx.model?.provider}/${ctx.model?.id} (${pi.getThinkingLevel()}); refusing fallback.`;
		}
		if (expected.orchestrationChild) {
			const edit = pi.getAllTools().find((tool) => tool.name === "edit");
			const schema = edit?.parameters as {
				type?: unknown;
				required?: unknown;
				properties?: Record<string, { type?: unknown }>;
			} | undefined;
			if (edit?.sourceInfo?.path !== UNIFIED_EDIT_PATH || schema?.type !== "object" ||
				schema.properties?.text?.type !== "string" || Object.keys(schema.properties).length !== 1 ||
				!Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== "text") {
				return `Orchestration child requires the patch edit tool from ${UNIFIED_EDIT_PATH}; extension is missing or incompatible, refusing to fall back to built-in edit.`;
			}
		}
		if (expected.orchestrationChild && (!ctx.model || !ctx.modelRegistry.hasConfiguredAuth(ctx.model))) {
			return "Authentication is unavailable in the child process.";
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// 在本次运行的输入之前 snapshot entry identity，包括旧的 assistant。
		previousEntries = new Set(ctx.sessionManager.getEntries().map((entry) => entry.id));
		try {
			const specPath = process.env[SPEC_ENV];
			// 已在运行的父进程仍可启动 pre-spec 的通用协议。
			if (!specPath && process.env[ORCHESTRATION_CHILD_ENV] !== "1") return;
			if (!specPath) throw new Error(`Missing ${SPEC_ENV}.`);
			expected = JSON.parse(await readFile(specPath, "utf8")) as RunSpec;
			await writeJsonAtomic(sessionPath, {
				runId: expected.runId, childSessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(), boundaryLeafId: ctx.sessionManager.getLeafId(),
				cwd: ctx.cwd, provider: ctx.model?.provider, model: ctx.model?.id, thinking: pi.getThinkingLevel(),
			});
			startupError = configurationError(ctx);
		} catch (error) { startupError = String(error); }
		if (startupError) {
			await report(ctx, startupError);
			ctx.shutdown();
		}
	});
	pi.on("input", async (_event, ctx) => {
		const error = startupError ?? configurationError(ctx);
		if (reported || error) {
			await report(ctx, error ?? "Child process run was already reported.");
			ctx.shutdown();
			return { action: "handled" };
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!expected?.orchestrationChild) return;
		const guidance = [
			"使用可用的相关 skills；skills 和项目说明不扩大你的任务 scope 或授权。向主进程报告不可用的能力；不要继续委派。",
			"在 scope 内，你可以运行脚本、联网查询、verification 以及临时材料/服务。允许公开搜索和已授权的只读系统查询；外部写入、生产变更或上传私有代码需要授权。交回前停止临时服务，并报告关键命令、退出码、持久变更和必要的临时产物。",
			"可用时使用 inspect_worktree，按字面 paths 检查 status 和已暂存/未暂存 diff。未跟踪文件必须显式 read；证据截断时缩小 paths。Git 证据不可用不等于 worktree 干净。",
			"使用 edit，参数为 { text: 一个完整的 *** Begin Patch ... *** End Patch payload }。",
			...(expected.role === "investigation" || expected.role === "review"
				? ["investigation 和 review 收集证据；不要修复产品源码、已跟踪测试或 snapshot。向主进程报告问题，审查期间绝不修改。这些是角色指令，不是安全沙箱（sandbox）。"] : []),
		];
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance.join("\n")}` };
	});

	// agent_settled 晚于旧的 peer 类型声明加入，但本扩展针对的
	// Pi runtime 中已存在。
	(
		pi.on as unknown as (
			event: "agent_settled",
			handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		) => void
	)("agent_settled", async (_event, ctx) => {
		await report(ctx);
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!reported) await report(ctx, "Subagent session shut down before the task settled.");
	});
}

function trimPane(output: string): string {
	const lines = output.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
	return lines.slice(-PANE_PREVIEW_LINES).join("\n");
}

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function detailsFor(spec: RunSpec, status: RunStatus, extra: Partial<RunDetails> = {}): RunDetails {
	return {
		status,
		runId: spec.runId,
		childSessionId: spec.childSessionId,
		resumedFrom: spec.resumedFrom,
		profile: spec.profile,
		sessionFile: spec.sessionFile,
		task: spec.task,
		cwd: spec.cwd,
		tmuxSession: spec.tmuxSession,
		attachCommand: spec.attachCommand,
		captureCommand: spec.captureCommand,
		killCommand: spec.killCommand,
		provider: spec.provider,
		model: spec.model,
		thinking: spec.thinking,
		role: spec.role,
		...extra,
	};
}

function partialText(details: RunDetails): string {
	const lines = [
		`Subagent is ${details.status} in tmux session ${details.tmuxSession}.`,
		details.runId ? `Run ID: ${details.runId}` : undefined,
		`Queued: ${formatDuration(details.queuedAt, details.startedAt ?? details.finishedAt)}; runtime: ${formatDuration(details.startedAt, details.finishedAt) ?? "not started"}.`,
		details.lastToolAt ? `Last completed tool: ${details.lastTool} (${formatDuration(details.lastToolAt)} ago).` : "No completed tools reported yet.",
		details.startedAt && Date.now() - (details.lastToolAt ?? details.startedAt) >= 5 * 60_000
			? "No tool has completed in over 5 minutes; the agent may still be reasoning or waiting, which does not prove it is stuck." : undefined,
		details.statePath ? `State: ${details.statePath}` : undefined,
		details.resultPath ? `Result: ${details.resultPath}` : undefined,
		details.role ? `Role: ${details.role}` : undefined,
		`Attach: ${details.attachCommand}`,
		`Capture: ${details.captureCommand}`,
	].filter((line): line is string => line !== undefined);
	if (details.pane) lines.push("", details.pane);
	return lines.join("\n");
}

function truncateToolText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. See the child session file for the complete output.]`;
}

function resultText(details: RunDetails): string {
	const duration = formatDuration(details.startedAt, details.finishedAt);
	const lines = [
		`Subagent ${details.status}${duration ? ` (${duration})` : ""}.`,
		details.runId ? `Run ID: ${details.runId}${details.role === "implementation" ? " (continue_implementation run_id)" : ""}` : undefined,
		details.role ? `Role: ${details.role}` : undefined,
		`Model: ${details.provider}/${details.model} (${details.thinking})`,
		`Stop confirmed: ${details.stopConfirmed === true ? "yes" : "no"}`,
		details.statePath ? `State: ${details.statePath}` : undefined,
		details.resultPath ? `Result: ${details.resultPath}` : undefined,
		details.cleanupWarning ? `tmux cleanup warning: ${details.cleanupWarning}` : undefined,
	].filter((line): line is string => line !== undefined);
	if (details.sessionFile) lines.push(`Child session: ${details.sessionFile}`);
	if (details.error) lines.push(`Error: ${details.error}`);
	if (details.output) lines.push("", details.output);
	return truncateToolText(lines.join("\n"));
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Subagent was aborted.");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
			const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new Error("Subagent was aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function validateCwd(cwd: string): Promise<void> {
	let info;
	try {
		info = await stat(cwd);
	} catch {
		throw new Error(`Subagent working directory does not exist: ${cwd}`);
	}
	if (!info.isDirectory()) throw new Error(`Subagent working directory is not a directory: ${cwd}`);
}

function isSameOrDescendant(base: string, candidate: string): boolean {
	const relative = path.relative(base, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveModel(
	ctx: ExtensionContext,
	providerOverride: string | undefined,
	modelOverride: string | undefined,
): { provider: string; model: string } {
	const explicitProvider = providerOverride?.trim();
	const explicitModel = modelOverride?.trim();
	let provider = explicitProvider || ctx.model?.provider || "";
	let model = explicitModel || ctx.model?.id || "";

	// 继承 id 中的斜杠可能属于 id 本身（例如
	// OpenRouter 的 openai/gpt-* 模型）。只有在未单独提供 provider 时，才把显式模型解释为
	// provider/model。若两者都给出
	// 且前缀一致，则接受这种冗余的规范 provider/model 形式。
	const slashIndex = explicitModel?.indexOf("/") ?? -1;
	if (explicitModel && slashIndex > 0) {
		const modelProvider = explicitModel.slice(0, slashIndex);
		if (!explicitProvider) {
			provider = modelProvider;
			model = explicitModel.slice(slashIndex + 1);
		} else if (explicitProvider === modelProvider) {
			model = explicitModel.slice(slashIndex + 1);
		}
	}

	if (!provider || !model) {
		throw new Error("No active model. Pass both provider and model to the subagent tool.");
	}
	return { provider, model };
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function recoveredSessionFile(statePath: string, runId: string, state: Record<string, unknown>): Promise<string | undefined> {
	if (typeof state.sessionFile === "string" && path.isAbsolute(state.sessionFile)) return state.sessionFile;
	for (const name of ["session.json", "result.json"]) {
		try {
			const value = JSON.parse(await readFile(path.join(path.dirname(statePath), name), "utf8"));
			if (value.runId === runId && typeof value.sessionFile === "string" && path.isAbsolute(value.sessionFile)) {
				return value.sessionFile;
			}
		} catch { /* 附属恢复证据是可选的。 */ }
	}
}

function savedProcessIdentities(state: Record<string, unknown>, statePath: string): ProcessIdentity[] {
	if (state.processes === undefined) return [];
	if (!Array.isArray(state.processes)) throw new Error(`Invalid process manifest: ${statePath}`);
	return state.processes.map((value) => {
		if (!value || typeof value !== "object") throw new Error(`Invalid process manifest: ${statePath}`);
		const process = value as Partial<ProcessIdentity>;
		if (typeof process.pid !== "number" || typeof process.ppid !== "number" ||
			typeof process.started !== "string" || typeof process.state !== "string") {
			throw new Error(`Invalid process manifest: ${statePath}`);
		}
		return process as ProcessIdentity;
	});
}

async function reconcilePreviousStop(
	pi: ExtensionAPI,
	statePath: string,
	runId: string,
	state: Record<string, unknown>,
	processes: ProcessIdentity[],
): Promise<boolean> {
	if (state.version !== 1 || state.runId !== runId) throw new Error(`Invalid previous run state: ${statePath}`);
	const savedProcesses = savedProcessIdentities(state, statePath);
	// 旧记录只有 PPID 采样，不能证明短命 shell 没有遗留孤儿进程。
	if (state.processTrackingVersion !== 2 && state.startedAt !== undefined) return false;
	const groups = await readProcessGroups(path.dirname(statePath));
	if ([...groups, ...savedProcesses].some((saved) => saved.pgid !== undefined && processes.some((current) =>
		current.pgid === saved.pgid && !current.state.startsWith("Z"),
	))) return false;
	const hasLiveProcess = savedProcesses.some((saved) => processes.some((current) =>
		current.pid === saved.pid && current.started === saved.started && !current.state.startsWith("Z"),
	));
	if (hasLiveProcess) return false;

	const tmuxSession = tmuxSessionName(runId);
	const paneState = await tmuxPaneState(pi, tmuxSession);
	if (paneState === "live") return false;
	if (paneState === "dead") await removeTmuxSession(pi, tmuxSession);

	const recoveredAt = Date.now();
	const sessionFile = await recoveredSessionFile(statePath, runId, state);
	const recoveryError = "Recovered after parent exited without recording child cleanup; check the result and worktree before retrying.";
	await writeJsonAtomic(statePath, {
		...state,
		status: "failed",
		stopConfirmed: true,
		finishedAt: typeof state.finishedAt === "number" ? state.finishedAt : recoveredAt,
		error: typeof state.error === "string" && state.error ? state.error : recoveryError,
		...(sessionFile ? { sessionFile } : {}),
		recoveredAfterParentExit: true,
		recoveredAt,
	});
	return true;
}

async function verifyPreviousStops(pi: ExtensionAPI, parentDir: string, excludeRun?: string): Promise<void> {
	let entries;
	try { entries = await readdir(parentDir, { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let processes: ProcessIdentity[] | undefined;
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === excludeRun) continue;
		const statePath = path.join(parentDir, entry.name, "state.json");
		let previous: Record<string, unknown>;
		try { previous = JSON.parse(await readFile(statePath, "utf8")); }
		catch { throw new Error(`Could not verify previous run state: ${statePath}`); }
		if (previous?.stopConfirmed !== true) {
			processes ??= await processSnapshot();
			if (!(await reconcilePreviousStop(pi, statePath, entry.name, previous, processes))) {
				throw new Error(`The previous child process is not confirmed stopped. Check ${statePath}; do not start replacement work.`);
			}
		}
	}
}

async function continuationSpec(pi: ExtensionAPI, parentDir: string, parentSessionId: string, runId: string): Promise<RunSpec> {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid implementation run ID; use the returned run_id.");
	const statePath = path.join(parentDir, runId, "state.json");
	let state;
	try { state = JSON.parse(await readFile(statePath, "utf8")); }
	catch { throw new Error(`Implementation run not found for this parent session or could not be read: ${statePath}`); }
	if (!state || typeof state !== "object") throw new Error(`Invalid implementation run state: ${statePath}`);
	if (state.parentSessionId !== parentSessionId) throw new Error("Cannot continue a run owned by another parent session.");
	if (state.role !== "implementation") throw new Error("Only implementation runs can be continued.");
	if (state.stopConfirmed !== true) {
		const reconciled = await reconcilePreviousStop(pi, statePath, runId, state, await processSnapshot());
		if (!reconciled) throw new Error(`The previous implementation run is not confirmed stopped: ${statePath}`);
		state = JSON.parse(await readFile(statePath, "utf8"));
	}
	if (state.stopConfirmed !== true || !["completed", "failed", "cancelled"].includes(state.status)) {
		throw new Error(`The previous implementation run is not confirmed stopped: ${statePath}`);
	}
	const spec = state.spec as RunSpec | undefined;
	if (state.version !== 1 || state.runId !== runId || !spec || spec.runId !== runId ||
		spec.role !== "implementation" || spec.orchestrationChild !== true ||
		typeof spec.profile !== "string" || !spec.profile.trim() || spec.profile === "reviewer" ||
		typeof spec.provider !== "string" || !spec.provider.trim() || typeof spec.model !== "string" || !spec.model.trim() ||
		!THINKING_LEVELS.includes(spec.thinking) || typeof spec.cwd !== "string" || !path.isAbsolute(spec.cwd) ||
		typeof spec.childSessionId !== "string" || !RUN_ID_PATTERN.test(spec.childSessionId) ||
		typeof state.sessionFile !== "string" || !path.isAbsolute(state.sessionFile)) {
		throw new Error(`Run is missing information required to continue; start a new implementation task: ${statePath}`);
	}
	await validateCwd(spec.cwd);
	await validateSessionFile(state.sessionFile, spec.childSessionId, spec.cwd);
	return { ...spec, sessionFile: state.sessionFile };
}

async function validateSessionFile(sessionFile: string, sessionId: string, cwd: string): Promise<void> {
	try {
		if (!(await stat(sessionFile)).isFile()) throw new Error("Not a file");
		// Pi 可能重建无效或缺失的 session。在 --session 之前拒绝它们。
		const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const header = entries[0];
		if (header?.type !== "session" || header.version !== 3 || header.id !== sessionId || header.cwd !== cwd ||
			!entries.some((entry) => entry.type === "message")) throw new Error("Session header/history mismatch");
	} catch (error) {
		throw new Error(`Implementation session history is missing or invalid: ${sessionFile}: ${String(error)}`);
	}
}

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerFlag(ATTACH_FLAG, {
		description: "Attach using the run id printed by the subagent tool",
		type: "string",
	});
	const attachTarget = attachFlagValue(process.argv);
	if (attachTarget !== undefined) attachToSubagentAndExit(attachTarget);

	if (process.env[CHILD_ENV] === "1") {
		const resultPath = process.env[RESULT_ENV];
		if (!resultPath) {
			console.error(`[tmux-subagent] ${RESULT_ENV} is required in child process mode.`);
			return;
		}
		registerChildReporter(pi, resultPath);
		return;
	}

	const queue = new SerialQueue();
	const tasks = new Map<AbortController, { parentSessionId: string; promise: Promise<SubagentRunResult> }>();
	let closing = false;

	pi.on("session_shutdown", async () => {
		closing = true;
		for (const controller of tasks.keys()) controller.abort();
		await Promise.allSettled([...tasks.values()].map((task) => task.promise));
	});

	const serviceState = async (ctx: ExtensionContext): Promise<SubagentServiceState> => {
		const parentSessionId = ctx.sessionManager.getSessionId();
		const busyReason = () => closing ? "Subagent service is shutting down."
			: queue.blockReason ?? ([...tasks.values()].some((task) => task.parentSessionId === parentSessionId)
				? "A child process is queued, running, or being cleaned up." : undefined);
		try {
			const busy = busyReason();
			if (busy) return { writable: false, reason: busy };
			await verifyPreviousStops(pi, path.join(getAgentDir(), RUNS_DIR, parentSessionId));
			// 磁盘检查进行期间可能已有请求到达。
			const reason = busyReason();
			return { writable: !reason, reason };
		} catch (error) {
			return { writable: false, reason: String(error) };
		}
	};

	const executeInvocation = async (
		request: SubagentServiceRequest["invocation"],
		signal: AbortSignal | undefined,
		onUpdate?: SubagentServiceRequest["onUpdate"],
		ctx?: ExtensionContext,
	): Promise<SubagentRunResult> => {
		if (!ctx) throw new Error("Subagent execution context is required.");
		if (!request.task.trim()) throw new Error("Subagent task must not be empty.");
		const parentSessionId = ctx.sessionManager.getSessionId();
		const parentDir = path.join(getAgentDir(), RUNS_DIR, parentSessionId);
		const resumedFrom = isSubagentContinuation(request) ? request.continueRunId : undefined;
		const previous = resumedFrom !== undefined ? await continuationSpec(pi, parentDir, parentSessionId, resumedFrom) : undefined;
		const invocation: SubagentInvocation = previous ? { ...previous, task: request.task, tools: request.tools } : request as SubagentInvocation;
		const requestedCwd = previous?.cwd ?? path.resolve(ctx.cwd, invocation.cwd?.trim() || ".");
		await validateCwd(requestedCwd);
		const cwd = await realpath(requestedCwd);
		const selectedModel = previous ? { provider: previous.provider, model: previous.model }
			: resolveModel(ctx, invocation.provider, invocation.model);
		const thinking = previous?.thinking ?? invocation.thinking ?? pi.getThinkingLevel();
		const runId = randomUUID();
		const childSessionId = previous?.childSessionId ?? runId;
		const runDir = path.join(parentDir, runId);
		const resultPath = path.join(runDir, "result.json");
		const tmuxSession = tmuxSessionName(runId);
		const tmuxTarget = tmuxSession;
		const spec: RunSpec = {
			runId,
			childSessionId,
			resumedFrom,
			sessionFile: previous?.sessionFile,
			profile: invocation.profile,
			task: invocation.task,
			cwd,
			attachmentId: runId,
			tmuxSession,
			tmuxTarget,
			attachCommand: "",
			captureCommand: "",
			killCommand: "",
			provider: selectedModel.provider,
			model: selectedModel.model,
			thinking,
			trusted: isSameOrDescendant(await realpath(ctx.cwd), cwd) && ctx.isProjectTrusted(),
			role: invocation.role,
			tools: invocation.tools,
			orchestrationChild: invocation.orchestrationChild,
		};
		updateTmuxCommands(spec);
		const queuedAt = Date.now();
		const statePath = path.join(runDir, "state.json");
		let tracker: ProcessTracker | undefined;
		let tmuxCreateAttempted = false;
		let tmuxCreationUncertain = false;
		let panePid: number | undefined;
		let details = detailsFor(spec, "queued", { queuedAt, statePath, resultPath, stopConfirmed: true });
		await mkdir(runDir, { recursive: true, mode: 0o700 });
		const save = async (status: RunStatus, extra: Partial<RunDetails> = {}) => {
			details = { ...details, ...extra, status };
			await writeJsonAtomic(statePath, {
				version: 1, processTrackingVersion: 2, ownerPid: process.pid, parentSessionId,
				spec, ...details, processes: tracker ? [...tracker.known.values()] : [],
			});
			try { onUpdate?.({ content: [{ type: "text", text: partialText(details) }], details }); }
			catch { /* UI 观察者不拥有子进程的生命周期。 */ }
		};
		const captureSession = async () => {
			try {
				const value = JSON.parse(await readFile(path.join(runDir, "session.json"), "utf8"));
				if (value.runId === runId && value.childSessionId === childSessionId && typeof value.sessionFile === "string") {
					if (details.sessionFile !== value.sessionFile) await save(details.status, { sessionFile: value.sessionFile });
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		};
		await save("queued");

		return queue.run<SubagentRunResult>(signal, async () => {
				// resume/reload 时，未解决的子进程必须被检查，绝不能静默替换。
				// 读取所有运行，而不只是活动对话分支。
				await verifyPreviousStops(pi, parentDir, runId);
				if (resumedFrom) await continuationSpec(pi, parentDir, parentSessionId, resumedFrom);
				await validateCwd(cwd);
				if (spec.orchestrationChild) {
					const model = ctx.modelRegistry.find(spec.provider, spec.model);
					if (!model) throw new Error(`Configured child process model is unavailable: ${spec.provider}/${spec.model}`);
					if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Authentication is unavailable for child process model ${spec.provider}/${spec.model}`);
				}
				await mkdir(runDir, { recursive: true, mode: 0o700 });
				const specPath = path.join(runDir, "spec.json");
				await writeJsonAtomic(specPath, spec);
				const promptPath = path.join(runDir, "task.md");
				const sessionDir = path.join(runDir, "session");
				await mkdir(sessionDir, { recursive: true, mode: 0o700 });
				await writeFile(promptPath, `# 委派任务\n\n${invocation.task}\n`, {
					encoding: "utf8",
					mode: 0o600,
				});

				const piArgs = [
					...getPiInvocationParts(),
					"--provider",
					selectedModel.provider,
					"--model",
					selectedModel.model,
					"--thinking",
					thinking,
					...(spec.sessionFile ? ["--session", spec.sessionFile] : ["--session-dir", sessionDir, "--session-id", childSessionId]),
					"--name",
					tmuxSession,
					...(spec.tools !== undefined ? ["--tools", spec.tools.join(",")] : []),
					"--no-extensions",
					"--extension",
					EXTENSION_PATH,
					...(spec.orchestrationChild ? ["--extension", UNIFIED_EDIT_PATH] : []),
					spec.trusted ? "--approve" : "--no-approve",
					`@${promptPath}`,
				];
				const childCommand = [
					"exec env",
					`${CHILD_ENV}=1`,
					...(spec.orchestrationChild ? [`${ORCHESTRATION_CHILD_ENV}=1`] : []),
					`${RESULT_ENV}=${shellQuote(resultPath)}`,
					`${SPEC_ENV}=${shellQuote(specPath)}`,
					piArgs.map(shellQuote).join(" "),
				].join(" ");
				// 让终端输入保持在登录 shell 的单行长度上限以内。两个 exec
				// 都保留启动前追踪的 pane PID。
				const launchPath = path.join(runDir, "launch.sh");
				await writeFile(launchPath, `${childCommand}\n`, { encoding: "utf8", mode: 0o600 });
				const launchCommand = `exec /bin/sh ${shellQuote(launchPath)}`;

				const tmuxVersion = await pi.exec("tmux", ["-V"], { timeout: 5_000 });
				if (tmuxVersion.code !== 0) {
					throw new Error(`Subagent requires tmux: ${tmuxVersion.stderr.trim() || "tmux not found"}`);
				}

				const startedAt = Date.now();
				if (signal?.aborted) throw new Error("Subagent was cancelled before pane creation.");
				await save("running", { startedAt, stopConfirmed: false });
				try {
					tmuxCreateAttempted = true;
					const created = await pi.exec(
						"tmux",
						tmuxArgs("new-session", "-d", "-P", "-F", "#{pane_pid}", "-s", tmuxSession, "-n", "pi", "-c", cwd),
						{ timeout: 5_000 },
					);
					tmuxCreationUncertain = created.killed;
					if (created.code !== 0) throw new Error(`Failed to create tmux session: ${created.stderr.trim() || created.stdout.trim()}`);
					panePid = Number(created.stdout.trim());
					if (!Number.isSafeInteger(panePid) || panePid <= 1) {
						tmuxCreationUncertain = true;
						panePid = undefined;
						throw new Error("tmux returned an invalid pane PID.");
					}
					const root = (await processSnapshot()).find((row) => row.pid === panePid);
					if (!root) throw new Error("Could not identify tmux child process.");
					tracker = new ProcessTracker(root, undefined, undefined, () => readProcessGroups(runDir));
					await save("running");
					const remain = await pi.exec(
						"tmux",
						tmuxArgs("set-window-option", "-t", tmuxTarget, "remain-on-exit", "on"),
						{ timeout: 5_000 },
					);
					if (remain.code !== 0) throw new Error(remain.stderr.trim() || "Failed to set remain-on-exit.");

					if (signal?.aborted) throw new Error("Subagent was cancelled before startup.");
					const sent = await pi.exec("tmux", tmuxArgs("send-keys", "-t", tmuxTarget, "-l", "--", launchCommand), { timeout: 5_000 });
					if (sent.code !== 0) throw new Error(sent.stderr.trim() || "Failed to start child Pi process.");
					const entered = await pi.exec("tmux", tmuxArgs("send-keys", "-t", tmuxTarget, "Enter"), { timeout: 5_000 });
					if (entered.code !== 0) throw new Error(entered.stderr.trim() || "Failed to submit child process command.");

					let lastPane = "";
					let lastProgressAt = 0;
					let childResult: ChildResult | undefined;
					while (!childResult) {
						if (signal?.aborted) throw new Error("Subagent was aborted.");
						await captureSession();
						try {
							childResult = parseChildResult(JSON.parse(await readFile(resultPath, "utf8")), runId) as ChildResult;
							break;
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
							// 子进程结算时会原子创建结果文件。
						}
						await tracker.refresh();
						if (Date.now() - lastProgressAt >= 5_000) {
							let activity: Partial<RunDetails> = {};
							try {
								const value = JSON.parse(await readFile(path.join(runDir, "activity.json"), "utf8"));
								if (typeof value.lastToolAt === "number" && Number.isFinite(value.lastToolAt) && typeof value.lastTool === "string") {
									activity = { lastToolAt: value.lastToolAt, lastTool: value.lastTool };
								}
							} catch { /* 缺失的活动会显示为未知，而不是进展。 */ }
							await save("running", activity);
							lastProgressAt = Date.now();
						}

						const paneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", tmuxTarget), {
							timeout: 5_000,
						});
						if (paneResult.code === 0) {
							const pane = trimPane(paneResult.stdout);
							if (pane && pane !== lastPane) {
								lastPane = pane;
								details = { ...details, pane };
							}
						}

						const dead = await pi.exec(
							"tmux",
							tmuxArgs("display-message", "-p", "-t", tmuxTarget, "#{pane_dead}"),
							{ timeout: 5_000 },
						);
						if (dead.code !== 0) throw new Error(`Lost child process pane: ${dead.stderr.trim()}`);
						if (dead.code === 0 && dead.stdout.trim() === "1") {
							await abortableDelay(100, signal);
							try {
								childResult = parseChildResult(JSON.parse(await readFile(resultPath, "utf8")), runId) as ChildResult;
								break;
							} catch {
								throw new Error(
									`Child Pi process exited before reporting a result.\n\n${lastPane || "No pane output."}\n\nCapture: ${spec.captureCommand}`,
								);
							}
						}

						await abortableDelay(POLL_INTERVAL_MS, signal);
					}
					// 结果文件不等于退出确认。在允许下一个写入者之前，
					// 回收所有仍归属的进程。
					for (let attempt = 0; attempt < 10 && (await tracker.refresh()).length; attempt++) {
						await abortableDelay(100, signal);
					}
					await tracker.stop();
					if (signal?.aborted) throw new Error("Subagent was cancelled during cleanup.");

					const finalPaneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", tmuxTarget), {
						timeout: 5_000,
					});
					const finalPane = finalPaneResult.code === 0 ? trimPane(finalPaneResult.stdout) : lastPane;
					let cleanupWarning: string | undefined;
					try {
						await removeTmuxSession(pi, tmuxSession);
					} catch (error) {
						cleanupWarning = error instanceof Error ? error.message : String(error);
					}
					const status: RunStatus = childResult.status === "completed" ? "completed" : "failed";
					let rawOutput = childResult.output.trim();
					if (childResult.status === "failed" && childResult.error?.trim()) {
						rawOutput += `${rawOutput ? "\n\n" : ""}Error: ${childResult.error.trim()}`;
					}
					const output = spec.orchestrationChild ? childResult.output : truncateToolText(rawOutput || "(no text output)");
					await save(status, {
						pane: finalPane,
						output,
						...(spec.orchestrationChild ? { error: childResult.error, stopReason: childResult.stopReason } : {}),
						cleanupWarning,
						sessionFile: childResult.sessionFile,
						provider: spec.orchestrationChild ? spec.provider : childResult.provider ?? spec.provider,
						model: spec.orchestrationChild ? spec.model : childResult.model ?? spec.model,
						thinking: spec.orchestrationChild ? spec.thinking : (childResult.thinking as ThinkingLevel | undefined) ?? spec.thinking,
						startedAt,
						finishedAt: childResult.finishedAt,
						stopConfirmed: true,
					});

					if (childResult.status === "failed" && !spec.orchestrationChild) {
						throw new Error(resultText(details));
					}
					return {
						content: [{ type: "text", text: resultText(details) }],
						details,
					};
				} catch (error) {
					try {
						await save("cancelling", { stopConfirmed: false }).catch(() => {});
						let stopError: unknown;
						let cleanupWarning: string | undefined;
						if (tracker) {
							try { await tracker.stop(); }
							catch (trackerError) { stopError = trackerError; }
						}
						if (tmuxCreateAttempted) {
							try { await removeTmuxSession(pi, tmuxSession); }
							catch (tmuxError) {
								if (!tracker) stopError ??= tmuxError;
								else cleanupWarning = tmuxError instanceof Error ? tmuxError.message : String(tmuxError);
							}
						}
						if (!tracker && panePid !== undefined && !stopError) {
							try {
								const root = (await processSnapshot()).find((row) => row.pid === panePid && !row.state.startsWith("Z"));
								if (root) await new ProcessTracker(root, undefined, undefined, () => readProcessGroups(runDir)).stop();
							} catch (paneError) { stopError = paneError; }
						}
						if (!tracker && tmuxCreationUncertain && panePid === undefined && !stopError) {
							stopError = new Error("tmux creation was attempted, but the pane PID was not captured.");
						}
						if (stopError) throw stopError;
						await captureSession();
						await save(signal?.aborted ? "cancelled" : "failed", {
							stopConfirmed: true, finishedAt: Date.now(),
							cleanupWarning,
							...(spec.orchestrationChild ? { error: String(error) } : { output: String(error) }),
						});
					} catch (cleanupError) {
						const reason = `Stop is unconfirmed: ${String(cleanupError)}. Check ${statePath}`;
						queue.block(reason);
						await save("failed", {
							stopConfirmed: false,
							...(spec.orchestrationChild ? { error: reason } : { output: reason }),
						}).catch(() => {});
						throw new Error(reason);
					}
					throw new Error(`${String(error)}\nStop confirmed. Check ${statePath} and the worktree before retrying.`);
				}
		}).catch(async (error): Promise<SubagentRunResult> => {
			if (details.status === "queued") await save(signal?.aborted ? "cancelled" : "failed", {
				finishedAt: Date.now(),
				...(spec.orchestrationChild ? { error: String(error) } : { output: String(error) }),
			});
			if (spec.orchestrationChild) {
				// 一旦停止，即使 reporter 从未启动，也保留当前运行的失败产物。
				// 绝不从 session 历史重建输出。
				if (details.stopConfirmed === true && !existsSync(resultPath)) {
					await writeJsonAtomic(resultPath, {
						version: 1, runId, status: "failed", output: "", error: details.error,
						stopReason: details.status === "cancelled" ? "aborted" : undefined,
						sessionFile: details.sessionFile, provider: spec.provider, model: spec.model,
						thinking: spec.thinking, finishedAt: details.finishedAt ?? Date.now(),
					});
				}
				return { content: [{ type: "text", text: resultText(details) }], details };
			}
			throw error;
		});
	};

	const runInvocation = (...args: Parameters<typeof executeInvocation>): Promise<SubagentRunResult> => {
		if (closing) return Promise.reject(new Error("Subagent service is shutting down."));
		const ctx = args[3];
		if (!ctx) return Promise.reject(new Error("Subagent execution context is required."));
		const controller = new AbortController();
		const signal = args[1] ? AbortSignal.any([args[1], controller.signal]) : controller.signal;
		const task = executeInvocation(args[0], signal, args[2], args[3]).finally(() => tasks.delete(controller));
		tasks.set(controller, { parentSessionId: ctx.sessionManager.getSessionId(), promise: task });
		return task;
	};

	pi.events.on(SUBAGENT_SERVICE_CHANNEL, (raw) => {
		if (!raw || typeof raw !== "object") return;
		const status = raw as Partial<SubagentStatusRequest>;
		if (status.kind === "status") {
			if (status.ctx && typeof status.respond === "function") status.respond(serviceState(status.ctx));
			return;
		}
		const request = raw as Partial<SubagentServiceRequest>;
		if (request.kind !== "run" || typeof request.requestId !== "string" || !request.ctx) return;
		if (typeof request.resolve !== "function" || typeof request.reject !== "function") return;
		const invocation = request.invocation;
		if (invocation && typeof invocation === "object" && "continueRunId" in invocation) {
			if (!isSubagentContinuation(invocation)) {
				request.reject(new Error("Continuation requires a run ID, task, and non-empty tools list of explicit tool names."));
				return;
			}
		} else if (!isSubagentInvocation(invocation)) return;
		if (request.accept !== undefined && typeof request.accept !== "function") return;
		if (closing) {
			request.reject(new Error("Subagent service is shutting down."));
			return;
		}
		if (request.accept && !request.accept()) return;
		void runInvocation(invocation, request.signal, request.onUpdate, request.ctx).then(request.resolve, request.reject);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"在 tmux 内的一个独立交互式 Pi 进程中运行一个委派任务。调用会串行化：即使同时请求多个调用，也只有一个子进程工作。除非被覆盖，子进程继承当前的 provider、model 和 thinking level。运行期间会显示实时 pane 输出和可复制粘贴的 pi --attach-subagent 命令。输出上限为 50KB 或 2000 行；完整的子 session 会保存在磁盘上。",
		promptSnippet: "在一个可观察、由 tmux 支撑的 Pi session 中运行一个委派任务",
		promptGuidelines: [
			"每个委派任务使用一次 subagent；subagent 调用会自动串行化，因此优先发起多个简单调用，而不是让一个子进程去编排其他子进程。",
		],
		parameters: Type.Object({
			task: Type.String({ description: "子进程 Pi 的完整任务" }),
			cwd: Type.Optional(Type.String({ description: "工作目录。默认为当前项目。" })),
			provider: Type.Optional(Type.String({ description: "provider 覆盖。默认为当前 provider。" })),
			model: Type.Optional(
				Type.String({ description: "model id 或 provider/model 覆盖。默认为当前 model。" }),
			),
			thinking: Type.Optional(
				StringEnum(THINKING_LEVELS, {
					description: "thinking level 覆盖。默认为当前 thinking level。",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runInvocation(
				{
					task: params.task,
					cwd: params.cwd,
					provider: params.provider ?? ctx.model?.provider ?? "",
					model: params.model ?? ctx.model?.id ?? "",
					thinking: params.thinking ?? pi.getThinkingLevel(),
				},
				signal,
				(partial) => onUpdate?.(partial),
				ctx,
			);
		},

		renderCall(args, theme) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", preview);
			const overrides = [args.provider, args.model, args.thinking].filter(Boolean);
			if (overrides.length > 0) text += `\n  ${theme.fg("muted", overrides.join(" · "))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as RunDetails | undefined;
			if (!details || typeof details.status !== "string" || typeof details.tmuxSession !== "string") {
				const content = result.content.find((part) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}

			const running = details.status === "queued" || details.status === "running" || details.status === "cancelling";
			const icon = running
				? theme.fg("warning", details.status === "queued" ? "◦" : "●")
				: details.status === "completed"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
			const duration = formatDuration(details.startedAt, details.finishedAt);
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.tmuxSession))}`;
			text += theme.fg("muted", ` · ${details.status}${duration ? ` · ${duration}` : ""}`);
			if (running) text += `\n  ${theme.fg("accent", details.attachCommand)}`;
			text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;
			text += `\n  ${theme.fg("dim", `Queued ${formatDuration(details.queuedAt, details.startedAt ?? details.finishedAt) ?? "unknown"}; last tool: ${details.lastTool ?? "not reported"}${details.lastToolAt ? ` ${formatDuration(details.lastToolAt)} ago` : ""}`)}`;
			if (running && details.startedAt && Date.now() - (details.lastToolAt ?? details.startedAt) >= 5 * 60_000) {
				text += `\n  ${theme.fg("warning", "No tool has completed in over 5 minutes; the agent may still be reasoning or waiting.")}`;
			}
			if (details.statePath) text += `\n  ${theme.fg("dim", details.statePath)}`;

			if (running && details.pane) {
				const paneLines = details.pane.split("\n");
				const visible = expanded ? paneLines : paneLines.slice(-8);
				text += `\n\n${visible.map((line) => theme.fg("dim", line)).join("\n")}`;
			} else if (!running && details.output) {
				const outputLines = details.output.split("\n");
				const visible = expanded ? outputLines : outputLines.slice(0, 8);
				text += `\n\n${visible.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
				if (!expanded && outputLines.length > visible.length) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			}
			if (!running && details.resultPath) text += `\n  ${theme.fg("dim", `Result: ${details.resultPath}`)}`;
			if (!running && details.cleanupWarning) text += `\n  ${theme.fg("warning", `tmux cleanup: ${details.cleanupWarning}`)}`;
			return new Text(text, 0, 0);
		},
	});
}
