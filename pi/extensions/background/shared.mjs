// background 任务核心的共享常量、校验和原子 JSON 持久化。
// 由 manager 和 runner 共用。

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export const VERSION = 1;
export const PARAMS_FILE = "params.json";
export const STATE_FILE = "state.json";
export const LOG_FILE = "output.log";
export const ROTATED_LOG_FILE = "output.log.1";

// 两个日志文件各最多 10 MiB，保证日志总量不超过 20 MiB。
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;

// 生命周期状态。exited/failed 为终态。"unconfirmed" 从不写入，
// 而是 runner 已消失但记录状态非终态时由 manager 推导得出。
export const FINAL_STATUSES = new Set(["exited", "failed"]);
export const ACTIVE_STATUSES = new Set(["starting", "running", "stopping"]);

export const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateName(name) {
	if (typeof name !== "string" || !NAME_PATTERN.test(name) || name === "." || name === "..") {
		throw new Error(
			`Invalid task name ${JSON.stringify(name)}: must contain 1-64 [A-Za-z0-9._-] characters and cannot be "." or ".."`,
		);
	}
}

export function validateId(id) {
	if (typeof id !== "string" || !ID_PATTERN.test(id)) {
		throw new Error(`Invalid task ID ${JSON.stringify(id)}: expected a UUID`);
	}
}

export function projectKey(projectRoot) {
	return createHash("sha256").update(projectRoot).digest("hex");
}

export function projectDir(agentDir, projectRoot) {
	return join(agentDir, "background", projectKey(projectRoot));
}

// 文件不存在时返回 null；JSON 不可读或损坏时抛出异常。
export async function readJson(file) {
	let raw;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	return JSON.parse(raw);
}

// 用于状态推导的容错版本：损坏的 state 不能被误认为任务已完成。
export async function readJsonSafe(file) {
	try {
		return { value: await readJson(file) };
	} catch (error) {
		return { error };
	}
}

export async function writeJsonAtomic(file, value) {
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await fs.rename(tmp, file);
	} finally {
		await fs.rm(tmp, { force: true }).catch(() => {});
	}
}
