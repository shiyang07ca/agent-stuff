import { createHash } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import * as path from "node:path";

import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface WorktreeFile {
	path: string;
	status: string;
	originalPath?: string;
}

interface WorktreeSnapshot {
	cwd: string;
	root?: string;
	git: boolean;
	branch?: string;
	paths?: string[];
	files: WorktreeFile[];
	statusText: string;
	diffText?: string;
	stagedDiffText?: string;
	truncated: boolean;
}

function cap(text: string, maxBytes: number, maxLines = 2000) {
	const result = truncateHead(text, { maxBytes, maxLines });
	const notice = "\n[Worktree evidence truncated; narrow paths and read the necessary files before deciding.]";
	return {
		text: result.truncated ? `${truncateHead(text, { maxBytes: maxBytes - Buffer.byteLength(notice), maxLines: maxLines - 1 }).content}${notice}` : result.content,
		truncated: result.truncated,
	};
}

function parseStatus(raw: string): WorktreeFile[] {
	const records = raw.split("\0");
	const files: WorktreeFile[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		const file: WorktreeFile = { status: record.slice(0, 2), path: record.slice(3) };
		// Porcelain v1 -z 先输出目标路径，重命名/复制时再输出原路径。
		if (/[RC]/.test(file.status)) file.originalPath = records[++index];
		files.push(file);
	}
	return files;
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await pi.exec("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", ...args], { cwd, timeout: 8_000, signal });
	if (result.killed) throw new Error("Git query was cancelled or exceeded the 8000ms timeout.");
	if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Git query failed.");
	return result.stdout;
}

export async function inspectWorktree(
	pi: ExtensionAPI,
	cwd: string,
	options: { paths?: string[]; include_diff?: boolean } = {},
	signal?: AbortSignal,
): Promise<WorktreeSnapshot> {
	const paths = options.paths;
	if (paths && (paths.length === 0 || paths.length > 80 || paths.some((value) => !value || value.includes("\0")) || Buffer.byteLength(paths.join("\n")) > 8000)) {
		throw new Error("paths must contain 1-80 non-empty literal paths without NUL, up to 8000 bytes total. Omit paths to inspect the entire worktree.");
	}
	try {
		const statusRaw = await runGit(pi, cwd, ["-c", "status.relativePaths=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...(paths ?? [])], signal);
		const root = (await runGit(pi, cwd, ["rev-parse", "--show-toplevel"], signal)).replace(/\n$/, "");
		const branch = (await runGit(pi, cwd, ["branch", "--show-current"], signal)).trim();
		const allFiles = parseStatus(statusRaw);
		const files: WorktreeFile[] = [];
		let fileBytes = 0;
		for (const file of allFiles) {
			fileBytes += Buffer.byteLength(JSON.stringify(file));
			if (files.length >= 80 || fileBytes > 8000) break;
			files.push(file);
		}
		const status = cap(allFiles.map((file) => `${file.status} ${file.originalPath === undefined ? "" : `${JSON.stringify(file.originalPath)} -> `}${JSON.stringify(file.path)}`).join("\n") || (paths ? "(no changes in selected paths)" : "(working tree clean)"), 8000);
		const snapshot: WorktreeSnapshot = {
			cwd, root, git: true, branch: branch || undefined, paths, files,
			statusText: status.text,
			truncated: status.truncated || files.length < allFiles.length,
		};
		if (options.include_diff !== false) {
			const diffArgs = ["--no-ext-diff", "--no-color", "--no-textconv", "--no-relative", "--", ...(paths ?? [])];
			const diff = cap((await runGit(pi, cwd, ["diff", ...diffArgs], signal)) || "(none)", 24000);
			const staged = cap((await runGit(pi, cwd, ["diff", "--cached", ...diffArgs], signal)) || "(none)", 24000);
			snapshot.diffText = diff.text;
			snapshot.stagedDiffText = staged.text;
			snapshot.truncated ||= diff.truncated || staged.truncated;
		}
		return snapshot;
	} catch (error) {
		const failure = cap(`Git evidence unavailable: ${error instanceof Error ? error.message : String(error)}`, 8000);
		return { cwd, paths, git: false, files: [], statusText: failure.text, truncated: failure.truncated };
	}
}

export function worktreeText(snapshot: WorktreeSnapshot): { text: string; truncated: boolean } {
	return cap([
		`Working directory: ${JSON.stringify(snapshot.cwd)}`,
		snapshot.root ? `Repository root: ${JSON.stringify(snapshot.root)}` : "",
		`Git evidence: ${snapshot.git ? "available" : "unavailable (cannot prove the worktree is clean)"}`,
		snapshot.git ? `Branch: ${snapshot.branch || "(detached HEAD)"}` : "",
		`Scope: ${snapshot.paths ? JSON.stringify(snapshot.paths) : "entire worktree"}`,
		`Changed files (relative to repository; XY = index/worktree, ?? = untracked):\n${snapshot.statusText}`,
		snapshot.diffText === undefined ? "" : `Unstaged diff:\n${snapshot.diffText}`,
		snapshot.stagedDiffText === undefined ? "" : `Staged diff:\n${snapshot.stagedDiffText}`,
		"Use inspect_worktree with literal paths when you need diffs. Untracked file contents are not in Git diff; read them explicitly.",
		snapshot.truncated ? "Some worktree evidence or file-list details were truncated; narrow paths and read the necessary files before deciding." : "",
	].filter(Boolean).join("\n\n"), 48000, 2000);
}

/** HEAD、暂存区 blob、变更文件（含未跟踪）状态及大小/修改时间的指纹；Git 或文件元数据不可用、或变更项是目录（子模块、嵌套仓库）时返回 undefined。 */
export async function worktreeFingerprint(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<{ root: string; hash: string } | undefined> {
	try {
		const root = (await runGit(pi, cwd, ["rev-parse", "--show-toplevel"], signal)).replace(/\n$/, "");
		// 尚无提交的仓库没有 HEAD：rev-parse -q --verify 以 1 退出且无输出，记为空。
		const head = await pi.exec("git", ["--no-optional-locks", "rev-parse", "-q", "--verify", "HEAD"], { cwd: root, timeout: 8_000, signal });
		if (head.killed || (head.code !== 0 && (head.code !== 1 || head.stdout.trim()))) throw new Error("HEAD query failed.");
		const staged = await runGit(pi, root, ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames"], signal);
		const status = await runGit(pi, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal);
		const hash = createHash("sha256").update(`${head.stdout.trim()}\0${staged}\0${status}`);
		for (const file of parseStatus(status)) {
			// lstat 不跟随符号链接；只有文件已消失记为 missing，其他错误让整体结果为 unknown。
			const info = await lstat(path.join(root, file.path)).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			// 目录元数据反映不了内部文件变化，无法判断时整体为 unknown。
			if (info?.isDirectory()) return undefined;
			hash.update(`\0${file.path}\0${info ? `${info.size}:${info.mtimeMs}` : "missing"}`);
		}
		return { root, hash: hash.digest("hex") };
	} catch {
		return undefined;
	}
}

export function registerInspectWorktree(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "inspect_worktree",
		label: "Inspect Worktree",
		executionMode: "sequential",
		description: "只读的 Git status 以及已暂存/未暂存 diff。可选的 paths 是相对于 cwd 的字面文件或目录（不支持 glob 或 pathspec magic）；省略 paths 则检查整个 worktree。include_diff 默认为 true；false 则不运行 diff 查询。未跟踪内容需要 read 读取。输出上限为 48000 字节或 2000 行，status 上限 8000 字节，单份 diff 上限 24000 字节；截断后请缩小 paths 并读取必要文件。",
		promptSnippet: "检查 worktree 状态并按需读取限定范围的 diff，不修改文件",
		annotations: { readOnlyHint: true },
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "工作目录；默认为当前项目。" })),
			paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 80, description: "相对于 cwd 的字面文件/目录路径，或绝对路径。不支持 glob。保留空格；省略则检查整个 worktree。" })),
			include_diff: Type.Optional(Type.Boolean({ description: "包含有上限的已暂存和未暂存 tracked-file diff（默认 true）。false 则只查询 status。" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			if (!(await stat(cwd)).isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
			const snapshot = await inspectWorktree(pi, cwd, params, signal);
			const output = worktreeText(snapshot);
			return { content: [{ type: "text", text: output.text }], details: { ...snapshot, truncated: snapshot.truncated || output.truncated } };
		},
	});
}
