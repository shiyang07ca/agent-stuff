import { execFile } from "node:child_process";
import { readFile, readdir, unlink } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);

export type RunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface ProcessIdentity {
	pid: number;
	ppid: number;
	pgid?: number;
	started: string;
	state: string;
}

interface ProcessGroup extends ProcessIdentity {
	manifestPath?: string;
}

export async function processSnapshot(): Promise<ProcessIdentity[]> {
	const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
		timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
	});
	return parseProcesses(stdout);
}

function parseProcesses(text: string): ProcessIdentity[] {
	return text.trim().split("\n").map((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
		if (!match) throw new Error("Could not parse process manifest; refusing to assume the child process has stopped.");
		return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4], started: match[5] };
	});
}

export async function readProcessGroups(runDir: string): Promise<ProcessGroup[]> {
	const dir = path.join(runDir, "processes");
	let names: string[];
	try { names = await readdir(dir); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const groups: ProcessGroup[] = [];
	for (const name of names.filter((name) => name.endsWith(".process"))) {
		const manifestPath = path.join(dir, name);
		const rows = parseProcesses(await readFile(manifestPath, "utf8"));
		if (rows.length !== 1 || rows[0].pid <= 1 || rows[0].pgid !== rows[0].pid) {
			throw new Error(`Invalid process group manifest: ${name}`);
		}
		groups.push({ ...rows[0], manifestPath });
	}
	return groups;
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
	return a.pid === b.pid && a.started === b.started;
}

/** lstart 精度为秒；任一时间无法解析时不认定归属。 */
function startedNoEarlier(rows: ProcessIdentity[], reference: ProcessIdentity): boolean {
	const base = Date.parse(reference.started);
	if (!Number.isFinite(base)) return false;
	return rows.every((row) => {
		const started = Date.parse(row.started);
		return Number.isFinite(started) && started >= base;
	});
}

export class ProcessTracker {
	readonly known = new Map<number, ProcessIdentity>();
	private snapshot: () => Promise<ProcessIdentity[]>;
	private send: (pid: number, signal: NodeJS.Signals) => unknown;
	private groups = new Map<number, ProcessGroup>();
	private loadGroups: () => Promise<ProcessGroup[]>;
	constructor(
		root: ProcessIdentity,
		snapshot = processSnapshot,
		send = (pid: number, signal: NodeJS.Signals): unknown => process.kill(pid, signal),
		loadGroups: () => Promise<ProcessGroup[]> = async () => [],
	) {
		if (root.pid <= 1 || root.pid === process.pid) throw new Error("Invalid child process PID.");
		this.known.set(root.pid, root);
		if (root.pgid === root.pid) this.groups.set(root.pid, root);
		this.snapshot = snapshot;
		this.send = send;
		this.loadGroups = loadGroups;
	}

	async refresh(): Promise<ProcessIdentity[]> {
		for (const group of await this.loadGroups()) {
			this.groups.set(group.pid, group);
			if (!this.known.has(group.pid)) this.known.set(group.pid, group);
		}
		const rows = await this.snapshot();
		const live = rows.filter((row) => {
			const previous = this.known.get(row.pid);
			return previous && sameProcess(previous, row) && !row.state.startsWith("Z");
		});
		const owned = new Set(live.map((row) => row.pid));
		for (const group of this.groups.values()) {
			const members = rows.filter((row) => row.pgid === group.pid && !row.state.startsWith("Z"));
			if (!members.length) {
				// 已观察到组消失；删除 manifest，避免下次 refresh 重新加入，
				// 也避免把以后复用这个 PGID 的无关进程当作本次运行的遗留。
				if (group.manifestPath) {
					await unlink(group.manifestPath).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				}
				this.groups.delete(group.pid);
				for (const [pid, known] of this.known) {
					if (known.pgid === group.pid && !live.some((row) => sameProcess(row, known))) this.known.delete(pid);
				}
				continue;
			}
			const leader = members.find((row) => row.pid === group.pid);
			// 组长仍在但身份不符，说明 PID 已被重用；保留未确认，绝不误杀。
			// 组长已退出且没有已知成员（例如 `cmd &` 留下的孤儿）时，凭 manifest
			// 记录认定归属：成员都必须晚于组长启动。PGID 在组内仍有成员时不会
			// 被重新分配，残余风险只剩组曾完全消失又被复用且未被采样到。
			const ownedByManifest = !leader && group.manifestPath !== undefined && startedNoEarlier(members, group);
			if ((leader && !sameProcess(leader, group)) || (!ownedByManifest && !members.some((row) => owned.has(row.pid)))) {
				throw new Error(`Process group ${group.pid} still has live processes, but ownership cannot be confirmed. The queue remains blocked.`);
			}
			for (const row of members) {
				if (owned.has(row.pid)) continue;
				owned.add(row.pid);
				this.known.set(row.pid, row);
				live.push(row);
			}
		}
		let changed = true;
		while (changed) {
			changed = false;
			for (const row of rows) {
				if (!owned.has(row.pid) && owned.has(row.ppid) && !row.state.startsWith("Z")) {
					owned.add(row.pid);
					this.known.set(row.pid, row);
					live.push(row);
					changed = true;
				}
			}
		}
		return live;
	}

	private signal(row: ProcessIdentity, signal: NodeJS.Signals): void {
		try { this.send(row.pid, signal); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	}

	async stop(): Promise<void> {
		// 在再次发现子进程之前冻结父进程，包括脱离的 shell 进程组。
		// 只杀 tmux pane 会漏掉这些进程组。
		const frozen = new Set<number>();
		for (let round = 0; round < 20; round++) {
			const live = await this.refresh();
			const pending = live.filter((row) => !frozen.has(row.pid));
			if (!pending.length) {
				for (const row of live.reverse()) this.signal(row, "SIGKILL");
				for (let check = 0; check < 40; check++) {
					if (!(await this.refresh()).length) return;
					await delay(50);
				}
				throw new Error("Child processes are still alive after SIGKILL.");
			}
			for (const row of pending) {
				this.signal(row, "SIGSTOP");
				frozen.add(row.pid);
			}
		}
		throw new Error("Child process tree did not stabilize; the queue remains blocked.");
	}
}

export class SerialQueue {
	private tail: Promise<void> = Promise.resolve();
	private blocked?: string;

	block(reason: string): void { this.blocked = reason; }

	get blockReason(): string | undefined { return this.blocked; }

	async run<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		const slot = new Promise<void>((resolve) => { release = resolve; });
		this.tail = previous.then(() => slot);
		try {
			await waitFor(previous, signal);
			if (this.blocked) throw new Error(`Subagent queue is blocked: ${this.blocked}`);
			return await fn();
		} finally { release(); }
	}
}

export async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw new Error("Subagent was cancelled while queued.");
	return new Promise<T>((resolve, reject) => {
		const abort = () => { cleanup(); reject(new Error("Subagent was cancelled while queued.")); };
		const cleanup = () => signal.removeEventListener("abort", abort);
		signal.addEventListener("abort", abort, { once: true });
		promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
	});
}

export function parseChildResult(value: unknown, expectedRunId?: string): { status: "completed" | "failed"; output: string; finishedAt: number } {
	if (!value || typeof value !== "object") throw new Error("Invalid child process result.");
	const result = value as Record<string, unknown>;
	if (expectedRunId !== undefined && result.runId !== expectedRunId) throw new Error("Child process result belongs to a different run.");
	if (result.version !== 1 || !["completed", "failed"].includes(String(result.status)) ||
		typeof result.output !== "string" || typeof result.finishedAt !== "number" || !Number.isFinite(result.finishedAt)) {
		throw new Error("Invalid child process result.");
	}
	return value as ReturnType<typeof parseChildResult>;
}
