// background 任务核心的进程身份辅助函数（macOS/Linux）。
//
// 身份由 `ps` 的 (pid, 启动时间) 组成；pid 被复用时会因启动时间变化而识别出来。
// 组成员关系来自 pgid 列，只有我们自己创建的进程组才能由自己的进程树填充。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER = 16 * 1024 * 1024;

// 将 "Wed Jan  1 12:00:00 2025" 归一化为 "Wed Jan 1 12:00:00 2025"，
// 使不同 ps 调用得到的值可以比较相等。
function normalizeStarted(raw) {
	return raw.trim().split(/\s+/).join(" ");
}

// 返回某个 pid 的启动时间；进程不存在时返回 null。
// 只有“进程已消失”才能返回 null；真正的查询失败会抛出异常。
export async function getProcessStarted(pid) {
	try {
		const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: PS_TIMEOUT_MS });
		return normalizeStarted(stdout) || null;
	} catch (error) {
		// macOS/Linux 上 pid 不存在时 ps 以退出码 1 结束且输出为空。
		const stdout = typeof error.stdout === "string" ? error.stdout : "";
		const stderr = typeof error.stderr === "string" ? error.stderr : "";
		if (error.code === 1 && stdout.trim() === "" && stderr.trim() === "" && !error.killed) return null;
		throw new Error(`ps failed to query process ${pid}: ${stderr.trim() || error.message}`);
	}
}

export function parseInventory(stdout, { strict = true } = {}) {
	const rows = new Map();
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const tokens = trimmed.split(/\s+/);
		const pid = Number(tokens[0]);
		const ppid = Number(tokens[1]);
		const pgid = Number(tokens[2]);
		const state = tokens[3];
		if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid) || !state) {
			if (strict) throw new Error("Could not parse the process list; refusing to assume process state");
			continue;
		}
		rows.set(pid, {
			pid,
			ppid,
			pgid,
			state,
			started: tokens.slice(4, 9).join(" "),
			command: tokens.length > 9 ? tokens.slice(9).join(" ") : null,
		});
	}
	return rows;
}

export async function processInventory() {
	try {
		const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
			timeout: PS_TIMEOUT_MS,
			maxBuffer: PS_MAX_BUFFER,
		});
		return parseInventory(stdout);
	} catch (error) {
		throw new Error(`ps process query failed: ${error.message}`);
	}
}

export function isLive(row) {
	return Boolean(row) && !row.state.startsWith("Z");
}

export function validPid(pid) {
	return Number.isInteger(pid) && pid > 0;
}

export function validStarted(started) {
	return typeof started === "string" && started.length > 0;
}

// 判定已记录进程的状态，不把无效或不完整的身份当作进程已消失的证据。
export function identityState(inventory, pid, started) {
	if (!validPid(pid) || !validStarted(started)) return "unknown";
	const row = inventory.get(pid);
	if (!row || !isLive(row)) return "gone";
	return row.started === started ? "live" : "mismatch";
}

export function identityMatches(row, pid, started) {
	return isLive(row) && validPid(pid) && validStarted(started) && row.pid === pid && row.started === started;
}

export function liveGroupMembers(inventory, pgid) {
	const members = [];
	for (const row of inventory.values()) {
		if (row.pgid === pgid && isLive(row)) members.push(row);
	}
	return members;
}

export async function killGroup(pgid, signal) {
	if (!validPid(pgid)) throw new Error(`Invalid process group ID: ${pgid}`);
	try {
		process.kill(-pgid, signal);
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}

// 信号成功送达时返回 true。
export function killPid(pid, signal) {
	if (!validPid(pid)) throw new Error(`Invalid process ID: ${pid}`);
	try {
		process.kill(pid, signal);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

export function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

export async function waitForGroupExit(pgid, timeoutMs) {
	if (!validPid(pgid)) throw new Error(`Invalid process group ID: ${pgid}`);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const inventory = await processInventory();
		const members = liveGroupMembers(inventory, pgid);
		if (members.length === 0) return { gone: true, members };
		if (Date.now() >= deadline) return { gone: false, members };
		await delay(100);
	}
}
