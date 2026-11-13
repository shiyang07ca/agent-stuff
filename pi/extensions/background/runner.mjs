#!/usr/bin/env node
// background 任务 runner。由 BackgroundManager 以 detached 方式启动（自有 session，
// stdio 忽略、unref），因此可存活于父进程之外。它在自己的进程组中执行
// `bash -c <command>`，并且是 state.json 的唯一写入者；最终状态写入始终在最后。
//
// 生命周期：SIGTERM（或致命的日志错误）先以 TERM 停止命令组，宽限期后以 KILL 强制结束。
// runner 在每条退出路径上都会回收残留的组成员，并在写入最终状态前确认进程组已消失；
// 无法核实的内容会如实记录，而不是隐藏。

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getProcessStarted, killGroup, waitForGroupExit } from "./processes.mjs";
import {
	FINAL_STATUSES,
	LOG_FILE,
	MAX_LOG_FILE_BYTES,
	PARAMS_FILE,
	STATE_FILE,
	VERSION,
	writeJsonAtomic,
} from "./shared.mjs";

const GRACE_MS = 5_000; // 停止路径：TERM -> KILL 升级的延迟
const KILL_SETTLE_MS = 5_000; // KILL 后等待进程组退出的时间
const FLUSH_TIMEOUT_MS = 2_000; // 命令退出后日志排空的预算
const LOG_PAUSE_BYTES = 1024 * 1024;

const taskDir = process.argv[2];
if (!taskDir) {
	console.error("usage: runner.mjs <taskDir>");
	process.exit(2);
}
const stateFile = join(taskDir, STATE_FILE);

// 串行化的状态写入。最终写入处于 pending 时会先预留，
// 写入失败时释放预留以便重试。
let state = { version: VERSION, status: "starting" };
let stateChain = Promise.resolve();
let finalRequested = false;
let finalPromise = null;
let finalWritten = false;
let finalizationStarted = false;
function writeState(patch) {
	if (finalWritten) return Promise.resolve();
	const terminal = FINAL_STATUSES.has(patch?.status);
	if (finalizationStarted && !terminal) return Promise.resolve();
	if (finalRequested) return finalPromise ?? Promise.resolve();
	state = { ...state, ...patch };
	const snapshot = state;
	const operation = stateChain.then(() => writeJsonAtomic(stateFile, snapshot));
	stateChain = operation.catch(() => {});
	if (!terminal) return operation;

	finalRequested = true;
	finalPromise = operation.then(
		() => {
			finalWritten = true;
		},
		(error) => {
			finalRequested = false;
			finalPromise = null;
			throw error;
		},
	);
	return finalPromise;
}

async function writeFinalState(patch) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await writeState(patch);
			return true;
		} catch {
			if (attempt < 2) await delay(200);
		}
	}
	return false;
}

let child = null;
let finalized = false;
let stopping = false; // 已发起进程组终止
let stopRequested = false; // 子进程创建前就收到了 SIGTERM
let graceTimer = null;
let logError = null;
let termAt = 0;
let forcedCleanup = false;

// 尽力而为但如实记录：失败会尽量写入最终状态；
// 如果状态写入本身失败，记录将保持非终态，
// manager 会把任务报告为 unconfirmed。
async function fatal(error) {
	if (finalized) return;
	finalized = true;
	finalizationStarted = true;
	const problems = [`Supervisor error: ${error?.message ?? String(error)}`];
	if (child?.pid) {
		try {
			await killGroup(child.pid, "SIGKILL");
		} catch (killError) {
			problems.push(`Failed to terminate process group: ${killError.message}`);
		}
		try {
			const { gone } = await waitForGroupExit(child.pid, KILL_SETTLE_MS);
			if (!gone) problems.push("Process group members are still alive after SIGKILL");
		} catch (waitError) {
			problems.push(`Could not verify whether the process group exited: ${waitError.message}`);
		}
	}
	await writeFinalState({
		status: "failed",
		error: problems.join("；"),
		finishedAt: new Date().toISOString(),
		noChild: child?.pid == null,
	});
	process.exit(1);
}

process.on("uncaughtException", (error) => {
	void fatal(error);
});
process.on("unhandledRejection", (reason) => {
	void fatal(reason instanceof Error ? reason : new Error(String(reason)));
});

// ---------------------------------------------------------------------------
// 轮转的合并日志，带有限的 memory backpressure。
// ---------------------------------------------------------------------------

function pauseStreams() {
	child?.stdout?.pause();
	child?.stderr?.pause();
}

function resumeStreams() {
	child?.stdout?.resume();
	child?.stderr?.resume();
}

class RotatingLog {
	constructor(dir) {
		this.current = join(dir, LOG_FILE);
		this.rotated = `${this.current}.1`;
		this.fd = null;
		this.size = 0;
		this.chain = Promise.resolve();
		this.inflight = 0;
		this.paused = false;
		this.closed = false;
	}

	async open() {
		this.fd = await fs.open(this.current, "w", 0o600);
		this.size = 0;
		this.closed = false;
	}

	write(chunk) {
		if (this.closed || !this.fd) return;
		this.inflight += chunk.length;
		if (!this.paused && this.inflight > LOG_PAUSE_BYTES) {
			this.paused = true;
			pauseStreams();
		}
		const result = this.chain.then(() => this.#writeNow(chunk));
		this.chain = result.catch(() => {});
		result.catch((error) => onLogError(error));
		result.catch(() => {}).then(() => {
			this.inflight -= chunk.length;
			if (this.paused && this.inflight <= LOG_PAUSE_BYTES) {
				this.paused = false;
				resumeStreams();
			}
		});
	}

	async #writeNow(chunk) {
		let offset = 0;
		while (offset < chunk.length) {
			if (this.size === MAX_LOG_FILE_BYTES) await this.#rotate();
			const room = MAX_LOG_FILE_BYTES - this.size;
			const end = Math.min(chunk.length, offset + room);
			const start = offset;
			let written = offset;
			while (written < end) {
				const { bytesWritten } = await this.fd.write(chunk, written, end - written);
				written += bytesWritten;
			}
			offset = end;
			this.size += end - start;
		}
	}

	async #rotate() {
		await this.fd.close();
		await fs.rename(this.current, this.rotated);
		this.fd = await fs.open(this.current, "w", 0o600);
		this.size = 0;
	}

	async flush() {
		await this.chain;
	}

	async close() {
		await this.chain;
		this.closed = true;
		if (this.fd) {
			await this.fd.close().catch(() => {});
			this.fd = null;
		}
	}
}

// 日志 I/O 错误是显式失败：停止整个进程组并记录。
function onLogError(error) {
	if (logError || finalized) return;
	logError = error;
	void initiateStop();
}

// ---------------------------------------------------------------------------
// 停止处理。initiateStop 幂等且总会终止进程组；
// spawn 之前到达的 SIGTERM 会被记住，并在 exec 前处理。
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => {
	if (finalized) return;
	if (child?.pid) void initiateStop();
	else stopRequested = true;
});

async function initiateStop() {
	if (stopping || finalized) return;
	stopping = true;
	termAt = Date.now();
	// 若组长忽略 TERM，"close" 永远不会触发；仍强制 KILL。
	graceTimer = setTimeout(() => {
		if (child?.pid) void killGroup(child.pid, "SIGKILL").catch(() => {});
	}, GRACE_MS);
	if (child?.pid) await killGroup(child.pid, "SIGTERM").catch(() => {});
	await writeState({ status: "stopping", stopRequestedAt: new Date().toISOString() }).catch(() => {});
}

// 回收命令组的全部残留；无法确认进程组已死亡时返回警告字符串。
// 无需身份检查也安全：该进程组就是 runner 自己创建的。
async function ensureGroupGone(pgid) {
	try {
		let { gone } = await waitForGroupExit(pgid, 0);
		if (gone) return null;
		if (!stopping) await killGroup(pgid, "SIGTERM").catch(() => {});
		const waitMs = stopping ? Math.max(0, termAt + GRACE_MS - Date.now()) : GRACE_MS;
		({ gone } = await waitForGroupExit(pgid, waitMs));
		if (gone) return null;
		await killGroup(pgid, "SIGKILL").catch(() => {});
		forcedCleanup = true;
		({ gone } = await waitForGroupExit(pgid, KILL_SETTLE_MS));
		if (gone) return null;
		return "Process group members are still alive after SIGKILL";
	} catch (error) {
		await killGroup(pgid, "SIGKILL").catch(() => {});
		return `Could not verify whether the process group exited: ${error.message}`;
	}
}

// ---------------------------------------------------------------------------
// 收尾。恰好运行一次；最终状态写入是最后一次写入。
// ---------------------------------------------------------------------------

async function finalize(result) {
	if (finalized) return;
	finalized = true;
	finalizationStarted = true;
	if (graceTimer) clearTimeout(graceTimer);

	// 残留后代（例如 `something & exit`）不得作为 "exited" 记录背后的
	// 无人管理服务继续存活。
	const warning = child?.pid ? await ensureGroupGone(child.pid) : null;

	resumeStreams();
	await Promise.race([log.flush(), delay(FLUSH_TIMEOUT_MS)]);
	child?.stdout?.destroy();
	child?.stderr?.destroy();
	await log.close().catch(() => {});

	const finishedAt = new Date().toISOString();
	let patch;
	if (result.preSpawn) {
		patch = { status: "exited", stopped: true, exitCode: null, signal: null, noChild: true, note: "Stopped before command startup" };
	} else if (result.spawnError) {
		patch = {
			status: "failed",
			error: `Command startup failed: ${result.spawnError.message}`,
			exitCode: null,
			signal: null,
			noChild: true,
		};
	} else if (logError) {
		patch = {
			status: "failed",
			error: `Log write failed: ${logError.message}`,
			exitCode: result.code ?? null,
			signal: result.signal ?? null,
		};
	} else if (stopping) {
		patch = { status: "exited", stopped: true, exitCode: result.code ?? null, signal: result.signal ?? null };
	} else if (result.code === 0) {
		patch = { status: "exited", exitCode: 0, signal: null };
	} else {
		patch = { status: "failed", exitCode: result.code ?? null, signal: result.signal ?? null };
	}
	if (forcedCleanup && !stopping && !logError) {
		patch.status = "failed";
		patch.error = "Child processes remained more than 5 seconds after the command exited and were forcibly terminated";
	}
	if (warning) {
		patch.warning = warning;
		patch.unconfirmed = true;
	}
	const persisted = await writeFinalState({ ...patch, finishedAt });
	process.exit(result.spawnError || logError || warning || !persisted ? 1 : 0);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const log = new RotatingLog(taskDir);

async function main() {
	let runnerStarted = null;
	let identityError = null;
	for (let attempt = 0; attempt < 5 && !runnerStarted; attempt++) {
		try {
			runnerStarted = await getProcessStarted(process.pid);
			identityError = null;
		} catch (error) {
			identityError = error;
		}
		if (!runnerStarted) await delay(100);
	}
	if (!runnerStarted) {
		const detail = identityError ? `: ${identityError.message}` : "";
		throw new Error(`Could not determine supervisor process identity (ps failed)${detail}`);
	}
	await writeState({ runnerPid: process.pid, runnerStarted });

	const params = JSON.parse(await fs.readFile(join(taskDir, PARAMS_FILE), "utf8"));

	await log.open();
	if (stopRequested) return finalize({ preSpawn: true });

	child = spawn("/bin/bash", ["-c", params.command], {
		cwd: params.cwd,
		env: process.env,
		detached: true, // 自有进程组，与 runner 分离
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.on("error", (error) => void finalize({ spawnError: error }));
	child.stdout.on("data", (chunk) => log.write(chunk));
	child.stderr.on("data", (chunk) => log.write(chunk));
	child.on("exit", () => {
		// 后代可能仍持有管道；限制排空时间，然后强制关闭。
		setTimeout(() => {
			child?.stdout?.destroy();
			child?.stderr?.destroy();
		}, FLUSH_TIMEOUT_MS).unref();
	});
	child.on("close", (code, signal) => void finalize({ code, signal }));

	await writeState({ childPid: child.pid });

	let childStarted = null;
	let psError = null;
	for (let attempt = 0; attempt < 10 && !childStarted; attempt++) {
		if (stopping || finalized || child.exitCode !== null || child.signalCode !== null) break;
		try {
			childStarted = await getProcessStarted(child.pid);
			psError = null;
		} catch (error) {
			psError = error;
		}
		if (!childStarted) await delay(50);
	}
	if (childStarted && !stopping && !finalized && child.exitCode === null && child.signalCode === null) {
		// 仅在命令存活时可到达；并发停止已写入 "stopping" 并接管
		// 生命周期的其余部分。
		await writeState({ status: "running", childStarted, startedAt: new Date().toISOString() });
	} else if (!childStarted && !stopping && !finalized && child.exitCode === null && child.signalCode === null) {
		// 无法核实身份的存活命令不能安全管理。
		throw new Error(psError ? `Could not determine command process identity (ps failed): ${psError.message}` : "Could not determine command process identity (ps failed)");
	}
}

main().catch((error) => {
	if (finalized) return;
	void fatal(error);
});
