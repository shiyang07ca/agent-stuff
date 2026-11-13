import { execFile } from "node:child_process";
import { lstat, opendir, open, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

export interface FileEntry {
	path: string;
	directory: boolean;
	status: string;
	oldPath?: string;
	untrackedCopy?: boolean;
}

export interface FileIndex {
	root: string;
	git: boolean;
	entries: FileEntry[];
	note?: string;
}

export interface Source {
	text: string;
	lines: string[];
}

export const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_FILES = 50000;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".cache"]);

export function run(command: string, args: string[], cwd: string, signal?: AbortSignal, maxBuffer = 16 * 1024 * 1024): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd, signal, encoding: "utf8", timeout: 15000, maxBuffer }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message, { cause: error }));
			else resolve(stdout);
		});
	});
}

export const git = (root: string, args: string[], signal?: AbortSignal, maxBuffer?: number) =>
	run("git", ["--no-optional-locks", "--literal-pathspecs", ...args], root, signal, maxBuffer);

export function parseStatus(output: string): Map<string, FileEntry> {
	const entries = new Map<string, FileEntry>();
	const records = output.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) continue;
		const status = record.slice(0, 2);
		const filePath = record.slice(3);
		// Porcelain -z 先写目标路径，再写来源路径。
		const oldPath = /[RC]/.test(status) ? records[++i] : undefined;
		const previous = entries.get(filePath);
		if (status === "??" && previous) {
			previous.untrackedCopy = true;
			continue;
		}
		entries.set(filePath, { path: filePath, directory: false, status, oldPath });
	}
	return entries;
}

export async function loadIndex(cwd: string, signal: AbortSignal, progress?: (count: number) => void): Promise<FileIndex> {
	let root: string;
	try {
		root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).replace(/\r?\n$/, "");
	} catch (error) {
		signal.throwIfAborted();
		if (!String(error).includes("not a git repository")) throw error;
		return scanDirectory(cwd, signal, progress);
	}
	const [tracked, statusOutput] = await Promise.all([
		git(root, ["ls-files", "--stage", "-z"], signal),
		git(root, ["status", "--porcelain=v1", "-uall", "-z"], signal),
	]);
	const statuses = parseStatus(statusOutput);
	const entries = new Map<string, FileEntry>();
	for (const record of tracked.split("\0")) {
		if (!record) continue;
		const filePath = record.slice(record.indexOf("\t") + 1);
		entries.set(filePath, { path: filePath, directory: record.startsWith("160000"), status: "  " });
	}
	for (const [filePath, entry] of statuses) {
		entries.set(filePath, { ...entry, directory: entries.get(filePath)?.directory ?? false });
	}
	return { root, git: true, entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

async function scanDirectory(root: string, signal: AbortSignal, progress?: (count: number) => void): Promise<FileIndex> {
	const entries: FileEntry[] = [];
	const pending = [""];
	let unreadable = 0;
	while (pending.length && entries.length < MAX_FILES) {
		signal.throwIfAborted();
		const parent = pending.shift()!;
		try {
			const directory = await opendir(path.join(root, parent));
			for await (const item of directory) {
				signal.throwIfAborted();
				if (item.name === ".git" || (item.isDirectory() && SKIP_DIRECTORIES.has(item.name))) continue;
				const relative = path.join(parent, item.name);
				entries.push({ path: relative, directory: item.isDirectory(), status: "  " });
				if (item.isDirectory()) pending.push(relative);
				if (entries.length >= MAX_FILES) break;
			}
		} catch (error) {
			signal.throwIfAborted();
			if (!parent) throw error;
			unreadable++;
		}
		progress?.(entries.length);
	}
	const notes: string[] = [];
	if (entries.length >= MAX_FILES) notes.push(`Partial listing: ${MAX_FILES} entries`);
	if (unreadable) notes.push(`${unreadable} unreadable directories`);
	return { root, git: false, entries: entries.sort((a, b) => a.path.localeCompare(b.path)), note: notes.join("; ") || undefined };
}

export function sourceFromText(text: string): Source {
	const lines = text.split(/\r\n|\n|\r/);
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return { text, lines };
}

export async function readSource(filePath: string): Promise<Source> {
	const info = await stat(filePath);
	if (!info.isFile()) throw new Error("Preview is available for regular files. Use an external action for this entry.");
	if (info.size > MAX_PREVIEW_BYTES) throw new Error("File exceeds the 1 MiB preview limit. Open it in the external editor.");
	const file = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const result = await file.read(buffer, size, buffer.length - size, null);
			if (!result.bytesRead) break;
			size += result.bytesRead;
		}
		if (size > MAX_PREVIEW_BYTES) throw new Error("File exceeds the 1 MiB preview limit. Open it in the external editor.");
		const content = buffer.subarray(0, size);
		if (content.includes(0)) throw new Error("Binary file. Use Quick Look or the system application.");
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
		} catch {
			throw new Error("Non-UTF-8 file. Open it in the external editor.");
		}
		const source = sourceFromText(text);
		if (source.lines.length > 30000) throw new Error("File exceeds the 30,000-line preview limit. Open it in the external editor.");
		return source;
	} finally {
		await file.close();
	}
}

export async function hasHead(root: string, signal?: AbortSignal): Promise<boolean> {
	const refs = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], signal).catch(async (error) => {
		signal?.throwIfAborted();
		const cause = error.cause as { code?: number | string } | undefined;
		if (cause?.code !== 1) throw error;
		// 未诞生（unborn）分支没有 commit，但仍是有效仓库。
		await git(root, ["symbolic-ref", "HEAD"], signal);
		return "";
	});
	return Boolean(refs.trim());
}

export async function loadDiff(index: FileIndex, entry: FileEntry, signal?: AbortSignal): Promise<string> {
	if (!index.git) throw new Error("Git diff is available inside a Git repository.");
	if (entry.status === "??" || !(await hasHead(index.root, signal))) {
		const absolute = path.join(index.root, entry.path);
		const info = await lstat(absolute);
		const text = info.isSymbolicLink() ? await readlink(absolute) : (await readSource(absolute)).text;
		const patchPath = /[\x00-\x1f\x7f"\\]/.test(entry.path) ? JSON.stringify(entry.path) : entry.path;
		const patch = createTwoFilesPatch("/dev/null", patchPath, "", text, "", "", { timeout: 1000 });
		if (patch === undefined) throw new Error("Diff exceeded its time limit. Open the file in Cursor.");
		return patch;
	}
	const paths = [entry.path];
	if (entry.oldPath) paths.push(entry.oldPath);
	return git(index.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "HEAD", "--", ...paths], signal, 2 * MAX_PREVIEW_BYTES);
}

export function referencePath(absolute: string, cwd: string): string {
	const relative = path.relative(cwd, absolute);
	const display = relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) ? relative : absolute;
	return /[\s"`\\\x00-\x1f\x7f]/.test(display) ? JSON.stringify(display) : display;
}

export async function quoteSelection(absolute: string, cwd: string, source: Source, start: number, end: number): Promise<string> {
	const latest = await readSource(absolute);
	if (latest.text !== source.text) throw new Error("File changed. Refresh and reselect.");
	const from = Math.min(start, end);
	const to = Math.max(start, end);
	const text = source.lines.slice(from, to + 1).join("\n");
	if (Buffer.byteLength(text) > 32 * 1024) throw new Error("Selection exceeds 32 KiB. Select fewer lines or add the file path.");
	const longestFence = Math.max(2, ...(text.match(/`+/g) ?? []).map((match) => match.length));
	const fence = "`".repeat(longestFence + 1);
	return `@${referencePath(absolute, cwd)}:${from + 1}-${to + 1}\n${fence}\n${text}\n${fence}`;
}

export interface TreeRow {
	path: string;
	directory: boolean;
	depth: number;
	entry?: FileEntry;
}

export function treeRows(entries: FileEntry[], expanded: Set<string>): TreeRow[] {
	const children = new Map<string, Map<string, TreeRow>>();
	for (const entry of entries) {
		const parts = entry.path.split(path.sep);
		for (let i = 0; i < parts.length; i++) {
			const parent = parts.slice(0, i).join(path.sep);
			const filePath = parts.slice(0, i + 1).join(path.sep);
			const siblings = children.get(parent) ?? new Map<string, TreeRow>();
			if (!siblings.has(filePath) || i === parts.length - 1) {
				siblings.set(filePath, { path: filePath, directory: i < parts.length - 1 || entry.directory, depth: i, entry: i === parts.length - 1 ? entry : undefined });
			}
			children.set(parent, siblings);
		}
	}
	const rows: TreeRow[] = [];
	const visit = (parent: string) => {
		const siblings = [...(children.get(parent)?.values() ?? [])].sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
		for (const row of siblings) {
			rows.push(row);
			if (row.directory && expanded.has(row.path)) visit(row.path);
		}
	};
	visit("");
	return rows;
}
