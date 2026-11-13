// background 任务 manager：启动、检查、停止和清理可存活于父进程之外的
// background 任务。
//
// 目录结构：<agentDir>/background/<sha256(projectRoot)>/<taskId>/
//   params.json   manager 在 spawn runner 前写入一次
//   state.json    runner 原子写入（存活期间为唯一写入者）；只有当 runner
//                 和命令组确认死亡后，manager 才会写入终态记录
//   output.log[.1] 合并的 stdout/stderr，10 MiB 时轮转（总计 <= 20 MiB）
//   .superseded   较新运行被清理前留下的标记，防止旧失败重新成为当前异常
//
// 已记录的终态从不单独可信：必须先确认 runner 进程已消失且命令组没有存活成员，
// 任务才算结束（可 clean / 复用名称）。其他情况均为 "unconfirmed"。

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	ACTIVE_STATUSES,
	FINAL_STATUSES,
	ID_PATTERN,
	LOG_FILE,
	PARAMS_FILE,
	ROTATED_LOG_FILE,
	STATE_FILE,
	VERSION,
	projectDir,
	readJson,
	readJsonSafe,
	validateId,
	validateName,
	writeJsonAtomic,
} from "./shared.mjs";
import {
	identityState,
	identityMatches,
	killGroup,
	killPid,
	liveGroupMembers,
	processInventory,
	validPid,
	validStarted,
	waitForGroupExit,
} from "./processes.mjs";
import { newestFirst } from "./model.mjs";

const exec = promisify(execFile);
const RUNNER_PATH = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const SUPERSEDED_FILE = ".superseded";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const SETTLE_WAIT_MS = 3_000; // 终态 -> runner 真正消失
const GRACE_MS = 5_000; // 与 runner 的 TERM -> KILL 延迟保持一致
const RUNNER_STOP_BUDGET_MS = 15_000;
const STOP_OVERALL_TIMEOUT_MS = 30_000;
const LOCK_WAIT_MS = 60_000; // stop/clean 全程持有锁
const LOG_MAX_LINES = 500;
const LOG_MAX_BYTES = 50 * 1024;
const LOG_READ_WINDOW = 128 * 1024;

const KNOWN_STATUSES = new Set(["starting", "running", "stopping", "exited", "failed"]);

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function paramsError(params, id) {
	if (!isRecord(params)) return new Error("params.json is not an object");
	if (params.version !== VERSION) return new Error(`Invalid params.json version: ${String(params.version)}`);
	if (params.id !== id) return new Error("params.json task ID does not match the directory");
	try {
		validateName(params.name);
	} catch (error) {
		return new Error(`Invalid task name in params.json: ${error.message}`);
	}
	if (typeof params.command !== "string" || params.command.length === 0) return new Error("Invalid command in params.json");
	for (const field of ["cwd", "projectRoot", "sessionCwd", "createdAt"]) {
		if (typeof params[field] !== "string" || params[field].length === 0) {
			return new Error(`Invalid ${field} in params.json`);
		}
	}
	return null;
}

function stateError(state) {
	if (!isRecord(state)) return new Error("state.json is not an object");
	if (state.version !== VERSION) return new Error(`Invalid state.json version: ${String(state.version)}`);
	if (typeof state.status !== "string" || !KNOWN_STATUSES.has(state.status)) {
		return new Error(`Invalid status in state.json: ${String(state.status)}`);
	}
	for (const field of ["runnerPid", "childPid"]) {
		if (state[field] != null && !validPid(state[field])) return new Error(`Invalid ${field} in state.json`);
	}
	for (const field of ["runnerStarted", "childStarted"]) {
		if (state[field] != null && !validStarted(state[field])) return new Error(`Invalid ${field} in state.json`);
	}
	for (const field of ["stopped", "noChild", "unconfirmed", "confirmedByManager"]) {
		if (state[field] != null && typeof state[field] !== "boolean") return new Error(`Invalid ${field} in state.json`);
	}
	return null;
}

// ---------------------------------------------------------------------------
// 路径、校验和项目解析
// ---------------------------------------------------------------------------

async function resolveProjectRoot(sessionCwd) {
	let realCwd;
	try {
		realCwd = await fs.realpath(sessionCwd);
	} catch {
		throw new Error(`Session directory is inaccessible: ${sessionCwd}`);
	}
	let stdout;
	try {
		({ stdout } = await exec("git", ["-C", realCwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 }));
	} catch (error) {
		if (error.code === "ENOENT") throw new Error("git executable not found; cannot determine project root");
		const stderr = String(error.stderr ?? "");
		if (/not a git repository/.test(stderr)) return realCwd;
		throw new Error(`Could not determine project root: ${stderr.trim() || error.message}`);
	}
	return fs.realpath(stdout.trim());
}

async function resolveTaskCwd(realSessionCwd, projectRoot, cwd) {
	if (cwd === undefined) return realSessionCwd;
	if (typeof cwd !== "string" || cwd.length === 0) throw new Error(`Invalid task working directory: ${JSON.stringify(cwd)}`);
	const candidate = path.resolve(realSessionCwd, cwd);
	let real;
	try {
		real = await fs.realpath(candidate);
	} catch {
		throw new Error(`Task working directory does not exist: ${cwd}`);
	}
	if (!(await fs.stat(real)).isDirectory()) throw new Error(`Task working directory is not a directory: ${cwd}`);
	if (real !== projectRoot && !real.startsWith(projectRoot + path.sep)) {
		throw new Error(`Task working directory must be inside the project: ${cwd} (project root ${projectRoot})`);
	}
	return real;
}

// ---------------------------------------------------------------------------
// 项目锁。start/stop/clean 全程串行执行；遗留的锁（owner 已死或无法读取）
// 是显式错误，绝不按时间抢占。
// ---------------------------------------------------------------------------

async function acquireLock(projDir) {
	const lockDir = path.join(projDir, ".lock");
	const ownerFile = path.join(lockDir, "owner.json");
	const token = randomUUID();
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			await fs.mkdir(lockDir, { mode: 0o700 });
			try {
				await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
			} catch (error) {
				await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
				throw error;
			}
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			let owner = null;
			try {
				owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
			} catch {}
			if (owner && Number.isInteger(owner.pid)) {
				let alive = true;
				try {
					process.kill(owner.pid, 0);
				} catch (killError) {
					alive = killError.code === "EPERM";
				}
				if (!alive) {
					throw new Error(
						`Stale background project lock: ${lockDir} (owner pid ${owner.pid} is no longer running). After confirming no operation is active, remove this directory manually`,
					);
				}
			}
			// Owner 存活：等待操作完成。Owner 无法读取：
			// 持有者可能正在写入；短暂等待。
			if (Date.now() >= deadline) {
				throw new Error(`Background project lock${owner?.pid ? ` held by pid ${owner.pid}` : ""} was not released in time: ${lockDir}`);
			}
			await delay(50);
		}
	}
	return async () => {
		try {
			const owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
			if (owner?.token === token) await fs.rm(lockDir, { recursive: true, force: true });
		} catch {}
	};
}

// ---------------------------------------------------------------------------
// 任务记录与状态推导
// ---------------------------------------------------------------------------

function deriveStatus(state, inventory) {
	if (!state) return { status: "unconfirmed", detail: "Task state record is missing" };
	if (!isRecord(state)) {
		return { status: "unconfirmed", detail: `Unknown task state record: ${String(state.status)}` };
	}
	const invalid = stateError(state);
	if (invalid) return { status: "unconfirmed", recordedFinal: FINAL_STATUSES.has(state.status) ? state.status : undefined, detail: invalid.message };
	const runnerIdentity = identityState(inventory, state.runnerPid, state.runnerStarted);
	const members = validPid(state.childPid) ? liveGroupMembers(inventory, state.childPid) : [];
	if (FINAL_STATUSES.has(state.status)) {
		if (state.unconfirmed === true) {
			return { status: "unconfirmed", recordedFinal: state.status, detail: "Terminal record is explicitly marked unconfirmed" };
		}
		if (runnerIdentity === "unknown") {
			return { status: "unconfirmed", recordedFinal: state.status, detail: "Supervisor process identity record is incomplete; exit cannot be confirmed" };
		}
		if (runnerIdentity === "live" || members.length > 0) {
			return { status: "unconfirmed", recordedFinal: state.status, detail: "Terminal state recorded, but related processes are still alive or have not exited" };
		}
		if (state.noChild !== true && !validPid(state.childPid)) {
			return { status: "unconfirmed", recordedFinal: state.status, detail: "Command process identity record is incomplete; process group exit cannot be confirmed" };
		}
		return { status: state.status };
	}
	if (runnerIdentity === "live") return { status: state.status };
	return {
		status: "unconfirmed",
		detail:
			members.length > 0
				? "Supervisor exited without recording a result; command process may still be running"
				: runnerIdentity === "unknown"
					? "Supervisor process identity cannot be verified"
					: "Supervisor exited without recording a result; no related processes remain alive",
	};
}

function toRecord(taskDir, id, params, state, derived) {
	const record = {
		id,
		name: params?.name ?? null,
		command: params?.command ?? null,
		cwd: params?.cwd ?? null,
		projectRoot: params?.projectRoot ?? null,
		createdAt: params?.createdAt ?? null,
		status: derived.status,
		runnerPid: state?.runnerPid ?? null,
		childPid: state?.childPid ?? null,
		startedAt: state?.startedAt ?? null,
		finishedAt: state?.finishedAt ?? null,
		exitCode: state?.exitCode ?? null,
		signal: state?.signal ?? null,
		stopped: state?.stopped === true,
		unconfirmed: derived.status === "unconfirmed" || state?.unconfirmed === true,
		logPath: path.join(taskDir, LOG_FILE),
		taskDir,
	};
	if (derived.detail) record.detail = derived.detail;
	if (state?.error) record.error = state.error;
	if (state?.warning) record.warning = state.warning;
	if (state?.managerNote) record.managerNote = state.managerNote;
	if (state?.note) record.note = state.note;
	return record;
}

async function readTask(taskDir, id) {
	const params = await readJsonSafe(path.join(taskDir, PARAMS_FILE));
	const state = await readJsonSafe(path.join(taskDir, STATE_FILE));
	let paramError = params.error ?? null;
	if (!paramError && params.value !== null) paramError = paramsError(params.value, id);
	return {
		id,
		taskDir,
		params: paramError ? null : params.value,
		paramError,
		state: state.value ?? null,
		stateError: state.error ?? null,
	};
}

async function readTasks(projDir) {
	let entries;
	try {
		entries = await fs.readdir(projDir, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const tasks = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
		tasks.push(await readTask(path.join(projDir, entry.name), entry.name));
	}
	return tasks;
}

// ---------------------------------------------------------------------------
// 跨轮转日志文件的有界尾部读取。
// ---------------------------------------------------------------------------

async function readTailWindow(file) {
	let handle;
	try {
		handle = await fs.open(file, "r");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - LOG_READ_WINDOW);
		const buffer = Buffer.alloc(size - start);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return { buffer: buffer.subarray(0, offset), start };
	} finally {
		await handle.close();
	}
}

async function readLogTail(taskDir, maxLines) {
	const rotated = await readTailWindow(path.join(taskDir, ROTATED_LOG_FILE));
	const current = await readTailWindow(path.join(taskDir, LOG_FILE));
	const parts = [rotated, current].filter(Boolean);
	if (parts.length === 0) return { text: "", truncated: false };

	let truncated = parts.some((part) => part.start > 0);
	let text = Buffer.concat(parts.map((part) => part.buffer)).toString("utf8");
	if (parts[0].start > 0) {
		// 丢弃读取窗口造成的行首残片。
		const newline = text.indexOf("\n");
		if (newline >= 0) text = text.slice(newline + 1);
		// 没有换行：整个窗口都是某个超长行的尾部；保留它。
	}
	let lines = text.length > 0 ? text.split("\n") : [];
	if (lines.at(-1) === "") lines.pop();
	if (lines.length > maxLines) {
		lines = lines.slice(-maxLines);
		truncated = true;
	}
	let out = lines.join("\n");
	while (lines.length > 1 && Buffer.byteLength(out, "utf8") > LOG_MAX_BYTES) {
		lines.shift();
		out = lines.join("\n");
		truncated = true;
	}
	if (Buffer.byteLength(out, "utf8") > LOG_MAX_BYTES) {
		// 单个超长行：保留其尾部字节（严格控制在上限内）。
		const buffer = Buffer.from(out, "utf8");
		let start = buffer.length - LOG_MAX_BYTES;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		out = buffer.subarray(start).toString("utf8");
		truncated = true;
	}
	return { text: out, truncated };
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class BackgroundManager {
	constructor(agentDir) {
		if (typeof agentDir !== "string" || agentDir.length === 0) {
			throw new Error("BackgroundManager requires an agentDir argument");
		}
		this.agentDir = path.resolve(agentDir);
	}

	async #projectDir(sessionCwd) {
		const projectRoot = await resolveProjectRoot(sessionCwd);
		return { projectRoot, dir: projectDir(this.agentDir, projectRoot) };
	}

	// 只有当 runner 已消失且命令组为空时，终态记录才算数；
	// 给 runner 的最终退出留一小段窗口。
	async #waitSettled(taskDir, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const { value: state } = await readJsonSafe(path.join(taskDir, STATE_FILE));
			const inventory = await processInventory();
			const derived = deriveStatus(state, inventory);
			if (FINAL_STATUSES.has(derived.status)) return { settled: true, state, derived };
			if (!derived.recordedFinal) return { settled: false, state, derived };
			if (Date.now() >= deadline) return { settled: false, state, derived };
			await delay(100);
		}
	}

	async start(sessionCwd, spec, env = process.env, signal) {
		if (signal?.aborted) throw new Error("Background startup was cancelled before it began");
		const { name, command, cwd } = spec ?? {};
		validateName(name);
		if (typeof command !== "string" || command.length === 0) {
			throw new Error("Command must be a non-empty string");
		}
		const projectRoot = await resolveProjectRoot(sessionCwd);
		const realSession = await fs.realpath(sessionCwd);
		const taskCwd = await resolveTaskCwd(realSession, projectRoot, cwd);
		const projDir = projectDir(this.agentDir, projectRoot);
		await fs.mkdir(projDir, { recursive: true, mode: 0o700 });

		const cleanEnv = {};
		for (const [key, value] of Object.entries(env ?? process.env)) {
			if (typeof value === "string") cleanEnv[key] = value;
		}

		const release = await acquireLock(projDir);
		let params;
		let taskDir;
		let runner;
		let runnerExited = () => false;
		try {
			const inventory = await processInventory();
			for (const task of await readTasks(projDir)) {
				if (task.paramError || !task.params) {
					throw new Error(`An unconfirmed background task record exists (id ${task.id}); refusing to reuse the task name`);
				}
				if (task.params?.name !== name) continue;
				let derived = task.stateError ? { status: "unconfirmed" } : deriveStatus(task.state, inventory);
				if (derived.recordedFinal) {
					// runner 仍在退出中的终态记录：等待其结束。
					const settled = await this.#waitSettled(task.taskDir, SETTLE_WAIT_MS);
					derived = settled.derived;
				}
				if (!FINAL_STATUSES.has(derived.status)) {
					throw new Error(`A background task with the same name already exists: "${name}" (id ${task.id}, status ${derived.status})`);
				}
			}
			if (signal?.aborted) throw new Error("Background startup was cancelled before spawning the runner");
			const id = randomUUID();
			taskDir = path.join(projDir, id);
			await fs.mkdir(taskDir, { mode: 0o700 });
			params = {
				version: VERSION,
				id,
				name,
				command,
				cwd: taskCwd,
				projectRoot,
				sessionCwd: realSession,
				createdAt: new Date().toISOString(),
			};
			await writeJsonAtomic(path.join(taskDir, PARAMS_FILE), params);
			if (signal?.aborted) {
				await fs.rm(taskDir, { recursive: true, force: true });
				throw new Error("Background startup was cancelled before spawning the runner");
			}
			runner = spawn(process.execPath, [RUNNER_PATH, taskDir], {
				detached: true,
				stdio: "ignore",
				env: cleanEnv,
				cwd: taskCwd,
			});
			// 监听器必须在任何 await 之前挂好；异步 spawn 失败
			// （error 事件）绝不能变成宿主中的未处理 rejection。
			let exited = false;
			runner.on("error", () => {
				exited = true;
			});
			runner.on("exit", () => {
				exited = true;
			});
			runnerExited = () => exited;
			runner.unref();
		} catch (error) {
			if (!runner && taskDir) await fs.rm(taskDir, { recursive: true, force: true }).catch(() => {});
			throw error;
		} finally {
			await release();
		}

		return this.#handshake(params, taskDir, runner, runnerExited, signal);
	}

	// 等待 runner 以已核实的身份报告 "running"，或对瞬间完成的命令
	// 等到已结算的终态。取消或超时时，任务要么已完全清理，
	// 要么被保留为 unconfirmed。
	async #handshake(params, taskDir, runner, runnerExited, signal) {
		const stateFile = path.join(taskDir, STATE_FILE);
		const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
		for (;;) {
			if (signal?.aborted || Date.now() >= deadline) break;
			const state = (await readJsonSafe(stateFile)).value;
			if (signal?.aborted) break;
			if (state && FINAL_STATUSES.has(state.status)) {
				const { settled } = await this.#waitSettled(taskDir, SETTLE_WAIT_MS);
				if (signal?.aborted) break;
				if (settled) return toRecord(taskDir, params.id, params, state, { status: state.status });
				throw new Error(`Background task ${params.id} has a recorded terminal state, but related processes are still alive or their exit could not be verified; status is unconfirmed`);
			}
			if (state && ACTIVE_STATUSES.has(state.status) && state.status !== "starting") {
				const inventory = await processInventory();
				if (signal?.aborted || Date.now() >= deadline) break;
				const runnerOk =
					state.runnerPid != null && identityMatches(inventory.get(state.runnerPid), state.runnerPid, state.runnerStarted);
				const childOk =
					state.childPid != null && identityMatches(inventory.get(state.childPid), state.childPid, state.childStarted);
				if (runnerOk && childOk) return toRecord(taskDir, params.id, params, state, { status: state.status });
			}
			if (runnerExited()) {
				// 最终状态写入总在 runner 退出之前；重新读取一次。
				const latest = (await readJsonSafe(stateFile)).value;
				if (signal?.aborted) break;
				if (latest && FINAL_STATUSES.has(latest.status)) {
					const { settled } = await this.#waitSettled(taskDir, SETTLE_WAIT_MS);
					if (signal?.aborted) break;
					if (settled) return toRecord(taskDir, params.id, params, latest, { status: latest.status });
				}
				break;
			}
			if (signal?.aborted || Date.now() >= deadline) break;
			await delay(50);
		}

		const outcome = await this.#abortStart(params, taskDir, runner, runnerExited);
		const reason = signal?.aborted ? "was cancelled" : "timed out";
		if (outcome.finished && !signal?.aborted) return outcome.record;
		if (outcome.finished) throw new Error(`Background startup ${reason}, but the task had already finished (id ${params.id}); task records and command effects were retained`);
		if (outcome.cleaned) throw new Error(`Background startup ${reason}; task processes were stopped; command effects were not rolled back (id ${params.id})`);
		throw new Error(`Background startup ${reason}; task could not be fully cleaned up and remains unconfirmed (id ${params.id})`);
	}

	// 取消/超时后的启动清理。runner 是我们自己的子进程：
	// 在其 exit 事件触发前，pid 仍属于它，因此可以直接发信号，
	// 无需任何身份猜测。
	async #abortStart(params, taskDir, runner, runnerExited) {
		const projDir = path.dirname(taskDir);
		const release = await acquireLock(projDir);
		try {
			const stateFile = path.join(taskDir, STATE_FILE);
			let checked = await readJsonSafe(stateFile);
			let state = checked.value;
			if (checked.error) return { cleaned: false };
			if (state && FINAL_STATUSES.has(state.status)) {
				const settled = await this.#waitSettled(taskDir, SETTLE_WAIT_MS);
				if (settled.settled) return { finished: true, record: toRecord(taskDir, params.id, params, settled.state, settled.derived) };
			}

			// 先停止 runner。它自己的 SIGTERM 处理器知道它创建的进程组，
			// 即使 manager 尚未观察到 childPid。
			let runnerStuck = false;
			if (!runnerExited() && runner.pid != null) {
				try {
					killPid(runner.pid, "SIGTERM");
				} catch {
					runnerStuck = true;
				}
				const deadline = Date.now() + 8_000;
				while (!runnerStuck && !runnerExited() && Date.now() < deadline) await delay(100);
				if (!runnerStuck && !runnerExited()) {
					try {
						killPid(runner.pid, "SIGKILL");
					} catch {
						runnerStuck = true;
					}
					const killDeadline = Date.now() + 5_000;
					while (!runnerStuck && !runnerExited() && Date.now() < killDeadline) await delay(100);
				}
			}
			if (!runnerExited()) runnerStuck = true;

			checked = await readJsonSafe(stateFile);
			state = checked.value;
			if (!runnerStuck && !checked.error && !state && runnerExited()) {
				// runner.mjs 在 spawn 命令之前先持久化自己的身份，
				// 因此已退出且没有 state 的 runner 不可能留下命令进程组。
				await fs.rm(taskDir, { recursive: true, force: true }).catch(() => {});
				return { cleaned: true };
			}
			if (runnerStuck || checked.error || !state || stateError(state)) {
				// runner 仍存活时不要成为第二个状态写入者。
				// 其记录会保留以便后续恢复。
				return { cleaned: false };
			}

			// runner 由其自身的 ChildProcess exit 事件确认死亡。
			// 只要进程组仍存在，已记录的终态仍然不够。
			const childPid = state.childPid ?? null;
			let groupConfirmed = state.noChild === true;
			if (validPid(childPid)) {
				const inventory = await processInventory();
				const members = liveGroupMembers(inventory, childPid);
				if (members.length > 0) {
					const leader = members.find((member) => member.pid === childPid);
					if (!leader || leader.started !== state.childStarted) {
						await writeJsonAtomic(stateFile, {
							version: VERSION,
							...state,
							unconfirmed: true,
							managerNote: "Startup was cancelled, but process group leader identity could not be verified; refusing to signal",
						}).catch(() => {});
						return { cleaned: false };
					}
					await killGroup(childPid, "SIGKILL");
					if (!(await waitForGroupExit(childPid, 5_000)).gone) {
						await writeJsonAtomic(stateFile, {
							version: VERSION,
							...state,
							unconfirmed: true,
							managerNote: "Startup was cancelled, but the process group is still alive after SIGKILL",
						}).catch(() => {});
						return { cleaned: false };
					}
				}
				groupConfirmed = true;
			}
			if (!groupConfirmed) {
				await writeJsonAtomic(stateFile, {
					version: VERSION,
					...state,
					unconfirmed: true,
					managerNote: "Startup was cancelled, but it could not be confirmed whether a command process group was created",
				}).catch(() => {});
				return { cleaned: false };
			}
			await fs.rm(taskDir, { recursive: true, force: true }).catch(() => {});
			return { cleaned: true };
		} finally {
			await release();
		}
	}

	async list(sessionCwd) {
		const { dir } = await this.#projectDir(sessionCwd);
		const tasks = await readTasks(dir);
		const inventory = await processInventory();
		const records = [];
		for (const task of tasks) {
			if (!task.params) {
				records.push({
					id: task.id,
					name: null,
					status: "unconfirmed",
					detail: task.paramError ? `Could not read task parameter record: ${task.paramError.message}` : "Task record is incomplete (params.json is missing)",
					unconfirmed: true,
					taskDir: task.taskDir,
				});
				continue;
			}
			const derived = task.stateError
				? { status: "unconfirmed", detail: `Could not read state file: ${task.stateError.message}` }
				: deriveStatus(task.state, inventory);
			const record = toRecord(task.taskDir, task.id, task.params, task.state, derived);
			if (record.status === "failed") {
				record.superseded = await fs.stat(path.join(task.taskDir, SUPERSEDED_FILE)).then(
					() => true,
					(error) => { if (error.code === "ENOENT") return false; throw error; },
				);
			}
			records.push(record);
		}
		records.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
		return records;
	}

	async logs(sessionCwd, id, lines = 50) {
		validateId(id);
		if (typeof lines !== "number" || Number.isNaN(lines)) throw new Error(`Invalid line count: ${lines}`);
		const maxLines = Math.min(Math.max(1, Math.floor(lines)), LOG_MAX_LINES);
		const { dir } = await this.#projectDir(sessionCwd);
		const taskDir = path.join(dir, id);
		const task = await readTask(taskDir, id);
		if (!task.params) {
			if (task.paramError) throw new Error(`Could not read parameters for task ${id}: ${task.paramError.message}`);
			throw new Error(`Unknown background task: ${id}`);
		}
		const inventory = await processInventory();
		const derived = task.stateError
			? { status: "unconfirmed", detail: `Could not read state file: ${task.stateError.message}` }
			: deriveStatus(task.state, inventory);
		const { text, truncated } = await readLogTail(taskDir, maxLines);
		return {
			id,
			name: task.params.name,
			status: derived.status,
			text,
			truncated,
			logPath: path.join(taskDir, LOG_FILE),
		};
	}

	async stop(sessionCwd, id, signal) {
		if (signal?.aborted) throw new Error("Background task stop was cancelled before it began");
		// 一旦受理，即使调用方取消回合也完成清理。
		validateId(id);
		const { dir } = await this.#projectDir(sessionCwd);
		const taskDir = path.join(dir, id);
		try {
			await fs.stat(taskDir);
		} catch (error) {
			if (error.code === "ENOENT") throw new Error(`Unknown background task: ${id}`);
			throw error;
		}
		// 整个操作期间持有，避免终态写入与并发的 clean/stop 竞争。
		const release = await acquireLock(dir);
		try {
			const stateFile = path.join(taskDir, STATE_FILE);
			const cleanedError = async () => {
				const dirExists = await fs.stat(taskDir).then(
					() => true,
					() => false,
				);
				return new Error(dirExists ? `Task ${id} record is incomplete or missing; inspect manually` : `Unknown background task: ${id} (record was cleaned up)`);
			};
			const task = await readTask(taskDir, id);
			if (!task.params) {
				if (task.paramError) throw new Error(`Cannot stop task ${id}: could not read parameter record (${task.paramError.message}); refusing to signal blindly`);
				throw await cleanedError();
			}
			if (task.stateError) {
				throw new Error(`Cannot stop task ${id}: could not read state file (${task.stateError.message}); refusing to signal blindly`);
			}
			if (!task.state) {
				// runner 可能尚在启动、还未进行首次写入；给它一点时间。
				const deadline = Date.now() + SETTLE_WAIT_MS;
				let appeared = false;
				while (Date.now() < deadline) {
					const checked = await readJsonSafe(stateFile);
					if (checked.error) {
						throw new Error(`Cannot stop task ${id}: could not read state file (${checked.error.message}); refusing to signal blindly`);
					}
					if (checked.value) {
						appeared = true;
						break;
					}
					await delay(100);
				}
				if (!appeared) {
					throw new Error(`Cannot stop task ${id}: no running state was ever recorded, so related processes cannot be verified; inspect manually`);
				}
			}

			const deadline = Date.now() + STOP_OVERALL_TIMEOUT_MS;
			let runnerTermAt = 0;
			let groupTermAt = 0;
			let runnerKilled = false;
			let groupKilled = false;
			let finalSeenAt = 0;
			let killedLeftovers = false;
			for (;;) {
				const stateCheck = await readJsonSafe(stateFile);
				if (stateCheck.error) {
					throw new Error(`Cannot stop task ${id}: could not read state file (${stateCheck.error.message}); refusing to signal blindly`);
				}
				const state = stateCheck.value;
				if (!state) throw await cleanedError();
				const invalidState = stateError(state);
				if (invalidState) {
					throw new Error(`Cannot stop task ${id}: invalid state record (${invalidState.message}); refusing to signal blindly`);
				}
				const inventory = await processInventory();
				const runnerIdentity = identityState(inventory, state.runnerPid, state.runnerStarted);
				const childPid = state.childPid ?? null;
				const members = validPid(childPid) ? liveGroupMembers(inventory, childPid) : [];
				const leader = childPid != null ? members.find((member) => member.pid === childPid) : null;
				const leaderVerified = Boolean(leader && validStarted(state.childStarted) && leader.started === state.childStarted);

				if (FINAL_STATUSES.has(state.status)) {
					if (members.length > 0) {
						if (!leaderVerified) {
							throw new Error(
								`Task ${id} stop is unconfirmed: process group leader exited or pid was reused, so group identity cannot be verified; refusing to signal, inspect manually (pgid ${childPid})`,
							);
						}
						if (!groupTermAt) {
							await killGroup(childPid, "SIGTERM");
							groupTermAt = Date.now();
							killedLeftovers = true;
						} else if (!groupKilled && Date.now() - groupTermAt >= GRACE_MS) {
							await killGroup(childPid, "SIGKILL");
							groupKilled = true;
							killedLeftovers = true;
						}
					} else if (runnerIdentity === "live") {
						if (!finalSeenAt) finalSeenAt = Date.now();
						// 终态写入之后应紧跟 runner 退出。只有在 settle window 后才升级，
						// 并使用同一身份。
						if (Date.now() - finalSeenAt > SETTLE_WAIT_MS && !runnerKilled) {
							killPid(state.runnerPid, "SIGKILL");
							runnerKilled = true;
						}
					} else if (runnerIdentity === "unknown") {
						throw new Error(`Task ${id} stop is unconfirmed: supervisor process identity is incomplete; refusing to assume it exited`);
					} else if (killedLeftovers || state.unconfirmed === true) {
						if (state.noChild !== true && !validPid(childPid)) {
							throw new Error(`Task ${id} stop is unconfirmed: command process group identity is incomplete; refusing to assume it exited`);
						}
						const merged = {
							...state,
							stopped: true,
							unconfirmed: false,
							confirmedByManager: true,
							managerNote: killedLeftovers
								? "Processes remained after the terminal record and were terminated by the stop operation"
								: "Stop operation re-verified the terminal state and confirmed all related processes exited",
						};
						await writeJsonAtomic(stateFile, merged);
						return toRecord(taskDir, id, task.params, merged, { status: merged.status });
					} else {
						if (state.noChild !== true && !validPid(childPid)) {
							throw new Error(`Task ${id} stop is unconfirmed: command process group identity is incomplete; refusing to assume it exited`);
						}
						return toRecord(taskDir, id, task.params, state, { status: state.status });
					}
				} else if (runnerIdentity === "live") {
					// runner 负责关闭：向它发 TERM，然后由它处理命令组
					// 及其宽限期。
					if (!runnerTermAt) {
						killPid(state.runnerPid, "SIGTERM");
						runnerTermAt = Date.now();
					} else if (!runnerKilled && Date.now() - runnerTermAt >= RUNNER_STOP_BUDGET_MS) {
						killPid(state.runnerPid, "SIGKILL");
						runnerKilled = true;
					}
				} else if (runnerIdentity === "unknown") {
					throw new Error(`Task ${id} stop is unconfirmed: supervisor process identity is incomplete; refusing to assume it exited`);
				} else if (members.length === 0) {
					// 原 runner 已消失且没有组成员残留。
					// 记录 manager 结果前要求有足够的进程组元数据。
					if (state.noChild !== true && !validPid(childPid)) {
						throw new Error(`Task ${id} stop is unconfirmed: command process group identity is incomplete; refusing to assume it exited`);
					}
					const latestCheck = await readJsonSafe(stateFile);
					if (latestCheck.error) {
						throw new Error(`Cannot stop task ${id}: could not read state file (${latestCheck.error.message}); refusing to signal blindly`);
					}
					const latest = latestCheck.value;
					if (!latest) throw await cleanedError();
					const latestError = stateError(latest);
					if (latestError) {
						throw new Error(`Cannot stop task ${id}: invalid state record (${latestError.message}); refusing to signal blindly`);
					}
					if (FINAL_STATUSES.has(latest.status)) continue;
					const merged = {
						...latest,
						status: "failed",
						stopped: true,
						exitCode: null,
						signal: null,
						confirmedByManager: true,
						managerNote: "Supervisor exited without recording a result; stop operation confirmed all related processes exited",
						finishedAt: new Date().toISOString(),
					};
					await writeJsonAtomic(stateFile, merged);
					return toRecord(taskDir, id, task.params, merged, { status: merged.status });
				} else {
					if (!leaderVerified) {
						throw new Error(
							`Task ${id} stop is unconfirmed: supervisor exited and process group identity cannot be verified (leader is missing or pid was reused); refusing to signal, inspect manually (pgid ${childPid})`,
						);
					}
					if (!groupTermAt) {
						await killGroup(childPid, "SIGTERM");
						groupTermAt = Date.now();
					} else if (!groupKilled && Date.now() - groupTermAt >= GRACE_MS) {
						await killGroup(childPid, "SIGKILL");
						groupKilled = true;
					}
				}
				if (Date.now() >= deadline) {
					throw new Error(`Could not confirm task ${id} stopped within ${STOP_OVERALL_TIMEOUT_MS / 1000} seconds; processes may remain (unconfirmed)`);
				}
				await delay(100);
			}
		} finally {
			await release();
		}
	}

	async clean(sessionCwd, id) {
		validateId(id);
		const { dir } = await this.#projectDir(sessionCwd);
		const taskDir = path.join(dir, id);
		try {
			await fs.stat(taskDir);
		} catch (error) {
			if (error.code === "ENOENT") throw new Error(`Unknown background task: ${id}`);
			throw error;
		}
		const release = await acquireLock(dir);
		try {
			const task = await readTask(taskDir, id);
			if (!task.params) {
				throw new Error(
						task.paramError
							? `Cannot clean up task ${id}: could not read parameter record (${task.paramError.message}); refusing to delete`
							: `Cannot clean up task ${id}: task record is incomplete (params.json is missing); refusing to delete`,
				);
			}
			if (task.stateError) {
				throw new Error(`Cannot clean up task ${id}: could not read state record (${task.stateError.message}); refusing to delete`);
			}
			if (!task.state) {
				throw new Error(`Cannot clean up task ${id}: no running state was ever recorded, so remaining processes cannot be verified; refusing to delete`);
			}
			const { settled, derived } = await this.#waitSettled(taskDir, SETTLE_WAIT_MS);
			if (!settled) {
				throw new Error(
					`Cannot clean up task ${id}: status is ${derived.status}${derived.detail ? ` (${derived.detail})` : ""}; only confirmed completed tasks can be cleaned up`,
				);
			}
			// 在项目锁内先标记较早的同名运行，再删除当前记录。标记仅影响
			// Current 的失败筛选，不改变进程状态，也不隐藏待确认的记录。
			const runs = newestFirst((await readTasks(dir)).flatMap((candidate) =>
				candidate.params?.name === task.params.name ? [candidate.params] : []));
			const index = runs.findIndex((run) => run.id === id);
			if (index < 0) throw new Error(`Task ${id} record changed during cleanup; refusing to delete`);
			for (const previous of runs.slice(index + 1)) {
				try {
					await fs.writeFile(path.join(dir, previous.id, SUPERSEDED_FILE), "", { flag: "wx", mode: 0o600 });
				} catch (error) {
					if (error.code !== "EEXIST") throw error;
				}
			}
			await fs.rm(taskDir, { recursive: true, force: true });
		} finally {
			await release();
		}
		return { id, removed: true };
	}
}
