import { ACTIVE_STATUSES } from "./shared.mjs";

export function newestFirst(tasks) {
	return [...tasks].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || String(b.id).localeCompare(String(a.id)));
}

export function currentTasks(tasks) {
	const sorted = newestFirst(tasks);
	const seen = new Set();
	return sorted.filter((task) => {
		const latest = !seen.has(task.name);
		seen.add(task.name);
		return ACTIVE_STATUSES.has(task.status) || task.status === "unconfirmed" || (latest && task.status === "failed" && task.superseded !== true);
	}).sort((a, b) => Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status)));
}

export function resolveTask(tasks, target) {
	const query = target.trim();
	if (!query) throw new Error("Task target cannot be empty.");
	const exact = tasks.find((task) => task.id === query);
	if (exact) return exact;
	const named = newestFirst(tasks.filter((task) => task.name === query));
	if (named.length) return named.find((task) => ACTIVE_STATUSES.has(task.status)) ?? named[0];
	const matches = tasks.filter((task) => task.id.startsWith(query));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`Ambiguous task target "${query}". Use a longer ID:\n${matches.map((task) => `${task.id}  ${task.name}  ${task.status}`).join("\n")}`);
	throw new Error(`No background task matches "${query}".`);
}

export function parseCommand(args) {
	const input = args.trim();
	if (!input) return { action: "panel" };
	if (input === "history") return { action: "history" };
	if (input === "start") return { action: "start" };
	const start = /^start\s+(\S+)\s+([\s\S]+)$/.exec(input);
	if (start) return { action: "start", name: start[1], command: start[2] };
	const action = /^(logs|stop|clean)\s+(\S+)$/.exec(input);
	if (action) return { action: action[1], target: action[2] };
	throw new Error("Usage: /background [history | start [<name> <command>] | logs <target> | stop <target> | clean <target>]");
}
