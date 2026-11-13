/**
 * Unified Edit 扩展（extension）— 替换内置的 `edit` 工具。
 *
 * 该工具接受一个完整 patch payload。diff 渲染使用 pi 导出的
 * generateDiffString/generateUnifiedPatch；fuzzy edit matcher 核心内联自 pi
 * 内部的 edit-diff 实现，因为它不属于 pi 公开 API（本副本额外增加了整行匹配）。
 */

import {
	generateDiffString,
	generateUnifiedPatch,
	renderDiff,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, getCapabilities, hyperlink, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const TOOL_DESCRIPTION = `使用一个完整 patch payload 编辑文件。

Patch 格式：
*** Begin Patch
*** Update File: path/to/file
@@
 unchanged context
-old line
+new line
*** End Patch

每个 payload 必须以 *** Begin Patch 开头、以 *** End Patch 结尾。更新用 *** Update File:，新建文件用 *** Add File:，删除用 *** Delete File:。新增文件的每一行内容前加 +。在 update hunk 中，每个内容行必须以空格、+ 或 - 开头，并提供足够的未修改 context 以定位目标位置。一个 patch 中可出现多个文件 section。只提交这一完整的 patch 格式。`;

const TOOL_PROMPT_SNIPPET = "使用一个完整 *** Begin Patch ... *** End Patch payload 编辑文件。";

const TOOL_PROMPT_GUIDELINES = [
	"使用 edit 以完整 patch payload 修改文件。",
	"edit 的每个 payload 必须以 *** Begin Patch 开头、以 *** End Patch 结尾。",
	"edit patch 中使用 *** Update File:、*** Add File: 或 *** Delete File: section；新增文件内容行前加 +，并在 update hunk 中提供足够的未修改 context。",
	"一个 edit patch 可以包含多个文件 section。",
];

const unifiedEditSchema = {
	type: "object",
	additionalProperties: false,
	required: ["text"],
	properties: {
		text: {
			type: "string",
			description: TOOL_DESCRIPTION,
		},
	},
} as any;

type UnifiedEditParams = { text: string };
type ToolContent = Array<{ type: "text"; text: string }>;

interface Edit {
	oldText: string;
	newText: string;
}

interface EditDetailsLike {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

interface UnifiedEditDetails extends EditDetailsLike {
	files: Array<{
		path: string;
		kind: PlannedFileChange["kind"];
		details: EditDetailsLike;
	}>;
}

type PlannedFileChange = {
	kind: "update" | "write" | "add" | "delete";
	path: string;
	absolutePath: string;
	oldText: string;
	newText: string;
};

type ParsedPlan = {
	changes: PlannedFileChange[];
};
type PatchOperation =
	| { kind: "add"; path: string; contents: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; chunks: UpdateChunk[] };

type UpdateChunk = {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
};

type FileSnapshot = {
	path: string;
	absolutePath: string;
	original: string | null;
	current: string | null;
};

type RenderContext<TState> = {
	state: TState;
	cwd: string;
	invalidate: () => void;
	argsComplete: boolean;
	isError: boolean;
	args?: unknown;
	lastComponent?: Component;
};

type Preview = { diff: string; files: string[]; firstChangedLine?: number } | { error: string };

type UnifiedEditCallRenderComponent = Box & {
	preview?: Preview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

type UnifiedRenderState = {
	callComponent?: UnifiedEditCallRenderComponent;
};

function prepareUnifiedArguments(args: unknown): UnifiedEditParams {
	if (typeof args === "string") return { text: args };
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		for (const key of ["text", "patch", "input", "content"]) {
			const value = (args as Record<string, unknown>)[key];
			if (typeof value === "string") return { text: value };
		}
	}
	return args as UnifiedEditParams;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Operation was aborted");
}

// ============================================================================
// 内联的 pi edit-diff matcher 核心，并扩展了整行匹配
// ============================================================================

function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyTextReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different number of lines.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyTextReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function isWholeLineBoundary(content: string, start: number, length: number, oldText: string): boolean {
	const end = start + length;
	const startsOnBoundary = start === 0 || content[start - 1] === "\n";
	const consumesTrailingNewline = oldText.endsWith("\n");
	const endsOnBoundary = consumesTrailingNewline || end >= content.length || content[end] === "\n";
	return startsOnBoundary && endsOnBoundary;
}

function findMatchIndex(content: string, needle: string, wholeLines: boolean): number {
	if (needle.length === 0) return -1;
	let index = content.indexOf(needle);
	while (index !== -1) {
		if (!wholeLines || isWholeLineBoundary(content, index, needle.length, needle)) return index;
		index = content.indexOf(needle, index + 1);
	}
	return -1;
}

function fuzzyFindText(content: string, oldText: string, wholeLines: boolean): FuzzyMatchResult {
	const exactIndex = findMatchIndex(content, oldText, wholeLines);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = findMatchIndex(fuzzyContent, fuzzyOldText, wholeLines);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function countNeedleOccurrences(content: string, needle: string, wholeLines: boolean): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = content.indexOf(needle);
	while (index !== -1) {
		if (!wholeLines || isWholeLineBoundary(content, index, needle.length, needle)) count++;
		index = content.indexOf(needle, index + (wholeLines ? 1 : needle.length));
	}
	return count;
}

function countOccurrences(content: string, oldText: string, wholeLines: boolean): number {
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	if (fuzzyOldText.length === 0) {
		// 行尾空白归一化可能把只含空白的 oldText 折叠成空字符串。用
		// String#indexOf 搜索/计数空 needle 时，一旦偏移超过 content.length
		// 就永远不会返回 -1，因此这里改用字面量计数。
		return countNeedleOccurrences(content, oldText, wholeLines);
	}
	return countNeedleOccurrences(normalizeForFuzzyMatch(content), fuzzyOldText, wholeLines);
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	const what = totalEdits === 1 ? "exact text" : `edits[${editIndex}]`;
	const noun = totalEdits === 1 ? "old text" : "oldText";
	return new Error(
		`Could not find ${what} in ${path}. ${noun} must match exactly, including whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	const what = totalEdits === 1 ? "this text" : `edits[${editIndex}]`;
	const noun = totalEdits === 1 ? "The text" : "Each oldText";
	return new Error(
		`Found ${occurrences} occurrences of ${what} in ${path}. ${noun} must be unique. Provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) return new Error(`oldText in ${path} must not be empty.`);
	return new Error(`edits[${editIndex}].oldText in ${path} must not be empty.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes were made to ${path}. The replacement produced identical content. This may indicate a special character issue or that the text is not present as expected.`,
		);
	}
	return new Error(`No changes were made to ${path}. The replacements produced identical content.`);
}

function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
	options?: { requireWholeLines?: boolean },
): { baseContent: string; newContent: string } {
	const wholeLines = options?.requireWholeLines === true;
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText, wholeLines));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText, wholeLines);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(replacementBaseContent, edit.oldText, wholeLines);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target non-overlapping regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyTextReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

// ============================================================================
// row script 解析与应用
// ============================================================================

function normalizePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) throw new Error("File path must not be empty.");
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function resolveToCwd(cwd: string, path: string): string {
	const normalized = normalizePath(path);
	return isAbsolute(normalized) ? resolvePath(normalized) : resolvePath(cwd, normalized);
}

async function readExistingNormalized(path: string, absolutePath: string): Promise<string> {
	try {
		return normalizeToLF(stripBom(await readFile(absolutePath, "utf-8")).text);
	} catch (err: any) {
		const code = err && typeof err === "object" && "code" in err ? ` (${err.code})` : "";
		throw new Error(`Could not read ${path}${code}.`);
	}
}

async function maybeReadNormalized(absolutePath: string): Promise<string | null> {
	try {
		return normalizeToLF(stripBom(await readFile(absolutePath, "utf-8")).text);
	} catch (err: any) {
		if (err?.code === "ENOENT") return null;
		throw err;
	}
}


// ============================================================================
// patch 规划
// ============================================================================

function createUpdatePlan(path: string, absolutePath: string, oldText: string, newText: string): PlannedFileChange | undefined {
	if (oldText === newText) return undefined;
	return { kind: oldText.length === 0 ? "write" : "update", path, absolutePath, oldText, newText };
}

function createSnapshotStore(cwd: string, read: (path: string, absolutePath: string) => Promise<string | null>) {
	const snapshots = new Map<string, FileSnapshot>();
	const ordered: FileSnapshot[] = [];

	return {
		async get(path: string): Promise<FileSnapshot> {
			const absolutePath = resolveToCwd(cwd, path);
			let snapshot = snapshots.get(absolutePath);
			if (!snapshot) {
				const original = await read(path, absolutePath);
				snapshot = { path, absolutePath, original, current: original };
				snapshots.set(absolutePath, snapshot);
				ordered.push(snapshot);
			}
			return snapshot;
		},
		collectChanges(noChangesError: string): PlannedFileChange[] {
			const changes: PlannedFileChange[] = [];
			for (const { path, absolutePath, original, current } of ordered) {
				if (original === current) continue;
				if (original === null && current !== null) {
					changes.push({ kind: "add", path, absolutePath, oldText: "", newText: current });
				} else if (original !== null && current === null) {
					changes.push({ kind: "delete", path, absolutePath, oldText: original, newText: "" });
				} else if (original !== null && current !== null) {
					const plan = createUpdatePlan(path, absolutePath, original, current);
					if (plan) changes.push(plan);
				}
			}
			if (changes.length === 0) throw new Error(noChangesError);
			return changes;
		},
	};
}

// patch 解析/应用 planning
// ============================================================================

function isPatchPayload(text: string): boolean {
	const trimmed = normalizeToLF(text).trim();
	return trimmed.startsWith("*** Begin Patch") && trimmed.endsWith("*** End Patch");
}

function isPatchLikePayload(text: string): boolean {
	return normalizeToLF(text).trimStart().startsWith("*** Begin Patch");
}

function patchTextForPreview(text: string): string {
	const normalized = normalizeToLF(text).trimEnd();
	return normalized.endsWith("*** End Patch") ? normalized : `${normalized}\n*** End Patch`;
}

function parseUpdateChunk(lines: string[], startIndex: number, lastContentLine: number, allowMissingContext: boolean): { chunk: UpdateChunk; nextIndex: number } {
	let i = startIndex;
	let changeContext: string | undefined;
	const first = lines[i].trimEnd();

	if (first === "@@") i++;
	else if (first.startsWith("@@ ")) {
		changeContext = first.slice(3);
		i++;
	} else if (!allowMissingContext) {
		throw new Error(`Expected update hunk to start with @@ context marker, got: '${lines[i]}'`);
	}

	const oldLines: string[] = [];
	const newLines: string[] = [];
	let parsed = 0;
	let isEndOfFile = false;

	while (i <= lastContentLine) {
		const raw = lines[i];
		const trimmed = raw.trimEnd();
		if (trimmed === "*** End of File") {
			if (parsed === 0) throw new Error("Update hunk contains no lines");
			isEndOfFile = true;
			i++;
			break;
		}
		if (parsed > 0 && (trimmed.startsWith("@@") || trimmed.startsWith("*** "))) break;
		if (raw.length === 0) {
			oldLines.push("");
			newLines.push("");
			parsed++;
			i++;
			continue;
		}

		const marker = raw[0];
		const body = raw.slice(1);
		if (marker === " ") {
			oldLines.push(body);
			newLines.push(body);
		} else if (marker === "-") oldLines.push(body);
		else if (marker === "+") newLines.push(body);
		else if (parsed === 0) throw new Error(`Unexpected line in update hunk: '${raw}'. Each line must start with ' ', '+', or '-'.`);
		else break;
		parsed++;
		i++;
	}

	if (parsed === 0) throw new Error("Update hunk contains no lines");
	return { chunk: { changeContext, oldLines, newLines, isEndOfFile }, nextIndex: i };
}

function parsePatch(patchText: string): PatchOperation[] {
	const lines = normalizeToLF(patchText).trim().split("\n");
	if (lines.length < 2) throw new Error("Patch is empty or invalid");
	if (lines[0].trim() !== "*** Begin Patch") throw new Error("Patch must start with '*** Begin Patch'");
	if (lines[lines.length - 1].trim() !== "*** End Patch") throw new Error("Patch must end with '*** End Patch'");

	const operations: PatchOperation[] = [];
	let i = 1;
	const lastContentLine = lines.length - 2;
	while (i <= lastContentLine) {
		if (lines[i].trim() === "") {
			i++;
			continue;
		}
		const line = lines[i].trim();
		if (line.startsWith("*** Add File: ")) {
			const path = normalizePath(line.slice("*** Add File: ".length));
			i++;
			const contentLines: string[] = [];
			while (i <= lastContentLine) {
				const next = lines[i];
				if (next.trim().startsWith("*** ")) break;
				if (!next.startsWith("+")) throw new Error(`Invalid add-file line '${next}'. Add-file lines must start with '+'`);
				contentLines.push(next.slice(1));
				i++;
			}
			operations.push({ kind: "add", path, contents: contentLines.length > 0 ? `${contentLines.join("\n")}\n` : "" });
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			operations.push({ kind: "delete", path: normalizePath(line.slice("*** Delete File: ".length)) });
			i++;
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			const path = normalizePath(line.slice("*** Update File: ".length));
			i++;
			if (i <= lastContentLine && lines[i].trim().startsWith("*** Move to: ")) throw new Error("Patch move operations (*** Move to:) are not supported.");
			const chunks: UpdateChunk[] = [];
			while (i <= lastContentLine) {
				if (lines[i].trim() === "") {
					i++;
					continue;
				}
				if (lines[i].trim().startsWith("*** ")) break;
				const parsed = parseUpdateChunk(lines, i, lastContentLine, chunks.length === 0);
				chunks.push(parsed.chunk);
				i = parsed.nextIndex;
			}
			if (chunks.length === 0) throw new Error(`Update file hunk is empty for path '${path}'`);
			operations.push({ kind: "update", path, chunks });
			continue;
		}
		throw new Error(`'${line}' is not a valid hunk header. Valid headers: '*** Add File:', '*** Delete File:', '*** Update File:'`);
	}
	return operations;
}

function seekSequence(lines: string[], pattern: string[], start: number, eof = false): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;
	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : Math.max(0, start);
	const searchEnd = lines.length - pattern.length;
	const passes = [
		(a: string, b: string) => a === b,
		(a: string, b: string) => a.trimEnd() === b.trimEnd(),
		(a: string, b: string) => a.trim() === b.trim(),
		(a: string, b: string) => normalizeForFuzzyMatch(a).trim() === normalizeForFuzzyMatch(b).trim(),
	];
	for (const equal of passes) {
		for (let i = searchStart; i <= searchEnd; i++) {
			let ok = true;
			for (let j = 0; j < pattern.length; j++) {
				if (!equal(lines[i + j], pattern[j])) {
					ok = false;
					break;
				}
			}
			if (ok) return i;
		}
	}
	return undefined;
}

function deriveUpdatedContent(filePath: string, currentContent: string, chunks: UpdateChunk[]): string {
	const originalLines = currentContent.split("\n");
	if (originalLines[originalLines.length - 1] === "") originalLines.pop();
	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const ctxIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (ctxIndex === undefined) throw new Error(`Could not find context '${chunk.changeContext}' in ${filePath}`);
			lineIndex = ctxIndex + 1;
		}
		if (chunk.oldLines.length === 0) {
			replacements.push([originalLines.length, 0, [...chunk.newLines]]);
			continue;
		}
		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (found === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}
		if (found === undefined) throw new Error(`Could not find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`);
		replacements.push([found, pattern.length, [...newSlice]]);
		lineIndex = found + pattern.length;
	}

	const newLines = [...originalLines];
	for (const [start, oldLen, newSegment] of replacements.sort((a, b) => b[0] - a[0])) {
		newLines.splice(start, oldLen, ...newSegment);
	}
	if (newLines[newLines.length - 1] !== "") newLines.push("");
	return newLines.join("\n");
}

async function buildPatchPlan(text: string, cwd: string): Promise<ParsedPlan> {
	const operations = parsePatch(text);
	const store = createSnapshotStore(cwd, (_path, absolutePath) => maybeReadNormalized(absolutePath));

	for (const op of operations) {
		const snapshot = await store.get(op.path);
		if (op.kind === "add") {
			const contents = normalizeToLF(op.contents);
			snapshot.current = contents.endsWith("\n") ? contents : `${contents}\n`;
			continue;
		}
		if (op.kind === "delete") {
			if (snapshot.current === null) throw new Error(`Cannot delete ${op.path}: file does not exist.`);
			snapshot.current = null;
			continue;
		}
		if (snapshot.current === null) throw new Error(`Cannot update ${op.path}: file does not exist.`);
		snapshot.current = deriveUpdatedContent(op.path, snapshot.current, op.chunks);
	}

	return { changes: store.collectChanges("Patch did not produce any changes.") };
}

async function buildPlan(text: string, cwd: string): Promise<ParsedPlan> {
	if (!isPatchLikePayload(text)) {
		throw new Error("edit requires a complete patch beginning with *** Begin Patch and ending with *** End Patch.");
	}
	return buildPatchPlan(text, cwd);
}

// ============================================================================
// Preflight 与真实文件修改
// ============================================================================

async function checkCanCreatePath(absolutePath: string): Promise<void> {
	let dir = dirname(absolutePath);
	while (true) {
		try {
			if (!(await stat(dir)).isDirectory()) throw new Error(`Cannot create file: ${dir} is not a directory.`);
			await access(dir, constants.W_OK);
			return;
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err;
			const parent = dirname(dir);
			if (parent === dir) throw err;
			dir = parent;
		}
	}
}

async function preflightPlan(plan: ParsedPlan, signal?: AbortSignal): Promise<void> {
	const paths = new Set(plan.changes.map((change) => change.absolutePath));
	for (const change of plan.changes) {
		for (let parent = dirname(change.absolutePath); parent !== dirname(parent); parent = dirname(parent)) {
			if (paths.has(parent)) throw new Error(`Conflicting patch paths: ${parent} and ${change.path}. Split the operations into separate patches.`);
		}
	}
	for (const change of plan.changes) {
		throwIfAborted(signal);
		if (change.kind === "add") {
			await checkCanCreatePath(change.absolutePath);
			continue;
		}
		if (change.kind === "update") {
			applyEditsToNormalizedContent(change.oldText, [{ oldText: change.oldText, newText: change.newText }], change.path);
		}
		await access(change.absolutePath, constants.R_OK | constants.W_OK);
	}
}

function detailsForChange(path: string, oldText: string, newText: string): EditDetailsLike {
	const { diff, firstChangedLine } = generateDiffString(oldText, newText);
	return { diff, patch: generateUnifiedPatch(path, oldText, newText), firstChangedLine };
}

async function readFileForMutation(absolutePath: string): Promise<{ bom: string; ending: "\r\n" | "\n"; content: string }> {
	await access(absolutePath, constants.R_OK | constants.W_OK);
	const { bom, text } = stripBom(await readFile(absolutePath, "utf-8"));
	return { bom, ending: detectLineEnding(text), content: normalizeToLF(text) };
}

async function applyUpdateChange(change: PlannedFileChange, signal?: AbortSignal): Promise<EditDetailsLike> {
	return withFileMutationQueue(change.absolutePath, async () => {
		throwIfAborted(signal);
		const file = await readFileForMutation(change.absolutePath);
		throwIfAborted(signal);

		const { baseContent, newContent } = applyEditsToNormalizedContent(
			file.content,
			[{ oldText: change.oldText, newText: change.newText }],
			change.path,
		);

		await writeFile(change.absolutePath, file.bom + restoreLineEndings(newContent, file.ending), "utf-8");
		throwIfAborted(signal);
		return detailsForChange(change.path, baseContent, newContent);
	});
}

async function applyWriteChange(change: PlannedFileChange, signal?: AbortSignal): Promise<EditDetailsLike> {
	return withFileMutationQueue(change.absolutePath, async () => {
		throwIfAborted(signal);
		const file = await readFileForMutation(change.absolutePath);
		if (file.content !== change.oldText) {
			throw new Error(`Cannot edit ${change.path}: file changed after preflight.`);
		}
		await writeFile(change.absolutePath, file.bom + restoreLineEndings(change.newText, file.ending), "utf-8");
		return detailsForChange(change.path, file.content, change.newText);
	});
}

async function applyAddChange(change: PlannedFileChange, signal?: AbortSignal): Promise<EditDetailsLike> {
	return withFileMutationQueue(change.absolutePath, async () => {
		throwIfAborted(signal);
		const existing = await maybeReadNormalized(change.absolutePath);
		if (existing !== null) throw new Error(`Cannot add ${change.path}: file already exists.`);
		await mkdir(dirname(change.absolutePath), { recursive: true });
		await writeFile(change.absolutePath, change.newText, "utf-8");
		return detailsForChange(change.path, "", change.newText);
	});
}

async function applyDeleteChange(change: PlannedFileChange, signal?: AbortSignal): Promise<EditDetailsLike> {
	return withFileMutationQueue(change.absolutePath, async () => {
		throwIfAborted(signal);
		await access(change.absolutePath, constants.R_OK | constants.W_OK);
		const current = await readExistingNormalized(change.path, change.absolutePath);
		if (current !== change.oldText) throw new Error(`Cannot delete ${change.path}: file changed after preflight.`);
		await unlink(change.absolutePath);
		return detailsForChange(change.path, change.oldText, "");
	});
}

async function applyPlan(plan: ParsedPlan, signal?: AbortSignal): Promise<UnifiedEditDetails> {
	const appliers = {
		update: applyUpdateChange,
		write: applyWriteChange,
		add: applyAddChange,
		delete: applyDeleteChange,
	} as const;

	const files: UnifiedEditDetails["files"] = [];
	for (const change of plan.changes) {
		try {
			throwIfAborted(signal);
			const details = await appliers[change.kind](change, signal);
			files.push({ path: change.path, kind: change.kind, details });
		} catch (error) {
			const applied = files.map((file) => `${file.kind} ${file.path}`).join("\n") || "(none)";
			throw new Error(`Patch failed at ${change.path}: ${error instanceof Error ? error.message : String(error)}\nAlready applied:\n${applied}\nInspect the failing file before retrying; writes are not rolled back.`);
		}
	}
	return combineDetails(files);
}

function combineDetails(files: UnifiedEditDetails["files"]): UnifiedEditDetails {
	const diff = files.length === 1 ? files[0].details.diff : files.map((file) => `File: ${file.path}\n${file.details.diff}`).join("\n\n");
	const patch = files.map((file) => file.details.patch).join("\n");
	const firstChangedLine = files.find((file) => file.details.firstChangedLine !== undefined)?.details.firstChangedLine;
	return { diff, patch, firstChangedLine, files };
}

function formatSummary(details: UnifiedEditDetails): string {
	if (details.files.length === 1) {
		const file = details.files[0];
		const verb = file.kind === "add" ? "Added" : file.kind === "delete" ? "Deleted" : "Edited";
		return `${verb} ${file.path}.`;
	}
	return `Applied unified edit to ${details.files.length} files.\n${details.files
		.map((file, index) => `${index + 1}. ${file.kind} ${file.path}`)
		.join("\n")}`;
}

// ============================================================================
// 渲染
// ============================================================================

function previewForPlan(plan: ParsedPlan): Preview {
	const details = combineDetails(
		plan.changes.map((change) => ({
			path: change.path,
			kind: change.kind,
			details: detailsForChange(change.path, change.oldText, change.newText),
		})),
	);
	return { diff: details.diff, files: uniquePaths(plan.changes.map((change) => change.path)), firstChangedLine: details.firstChangedLine };
}

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	return hyperlink(styledText, pathToFileURL(resolveToCwd(cwd, rawPath)).href);
}

function renderToolPath(rawPath: string | null, theme: any, cwd: string, options?: { emptyFallback?: string }): string {
	if (rawPath === null) return theme.fg("error", "[invalid args]");
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}

function uniquePaths(paths: string[]): string[] {
	return Array.from(new Set(paths));
}

function uniquePathsForCwd(paths: string[], cwd: string): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const path of paths) {
		let key = path;
		try {
			key = resolveToCwd(cwd, path);
		} catch {
			// 若路径仍在流式传输中，就把它自身作为 key 保留。
		}
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(path);
	}
	return unique;
}

function safeRenderablePath(path: string): string | undefined {
	try {
		return normalizePath(path);
	} catch {
		return undefined;
	}
}

// 旧的 row-script 调用在恢复的 session transcript 中仍可渲染。
function extractRowHeaderPaths(text: string): string[] {
	const paths: string[] = [];
	const lines = normalizeToLF(text).split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const complete = /^\[(.+)]\s*$/.exec(trimmed);
		const partial = i === lines.length - 1 ? /^\[([^\]]+)$/.exec(trimmed) : null;
		const path = safeRenderablePath(complete?.[1] ?? partial?.[1] ?? "");
		if (path) paths.push(path);
	}
	return uniquePaths(paths);
}

function extractPatchHeaderPaths(text: string): string[] {
	const paths: string[] = [];
	const prefixes = ["*** Add File: ", "*** Delete File: ", "*** Update File: "];
	for (const raw of normalizeToLF(text).split("\n")) {
		const trimmed = raw.trim();
		for (const prefix of prefixes) {
			if (!trimmed.startsWith(prefix)) continue;
			const path = safeRenderablePath(trimmed.slice(prefix.length));
			if (path) paths.push(path);
			break;
		}
	}
	return uniquePaths(paths);
}

function getRenderablePaths(text: string | undefined): string[] | undefined {
	if (!text) return undefined;
	const patchLike = isPatchLikePayload(text);
	const fallback = patchLike ? extractPatchHeaderPaths(text) : extractRowHeaderPaths(text);
	if (!patchLike) return fallback.length > 0 ? fallback : undefined;
	try {
		const paths = parsePatch(isPatchPayload(text) ? text : patchTextForPreview(text)).map((op) => op.path);
		const unique = uniquePaths(paths);
		return unique.length > 0 ? unique : fallback.length > 0 ? fallback : undefined;
	} catch {
		return fallback.length > 0 ? fallback : undefined;
	}
}

function renderUnifiedPathLabel(paths: string[] | undefined, theme: any, cwd: string): string {
	const unique = paths ? uniquePathsForCwd(paths, cwd) : undefined;
	if (!unique || unique.length === 0) return renderToolPath("", theme, cwd);
	if (unique.length === 1) return renderToolPath(str(unique[0]), theme, cwd);
	return theme.fg("accent", `${unique.length} files`);
}

function formatUnifiedEditCall(text: string | undefined, preview: Preview | undefined, theme: any, cwd: string): string {
	const title = theme.fg("toolTitle", theme.bold("edit"));
	const paths = preview && !("error" in preview) ? preview.files : getRenderablePaths(text);
	return `${title} ${renderUnifiedPathLabel(paths, theme, cwd)}`;
}

function createUnifiedEditCallRenderComponent(): UnifiedEditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as Preview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getUnifiedEditCallRenderComponent(
	state: UnifiedRenderState,
	lastComponent: unknown,
): UnifiedEditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as UnifiedEditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) return state.callComponent;
	const component = createUnifiedEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getUnifiedEditHeaderBg(
	preview: Preview | undefined,
	settledError: boolean | undefined,
	theme: any,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) return (text: string) => theme.bg("toolErrorBg", text);
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) return (text: string) => theme.bg("toolErrorBg", text);
	return (text: string) => theme.bg("toolPendingBg", text);
}

function setUnifiedEditPreview(
	component: UnifiedEditCallRenderComponent,
	preview: Preview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff ||
				current.firstChangedLine !== preview.firstChangedLine ||
				current.files.join("\0") !== preview.files.join("\0")));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

function requestUnifiedEditPreview(
	component: UnifiedEditCallRenderComponent,
	text: string | undefined,
	argsKey: string | undefined,
	cwd: string,
	invalidate: () => void,
): void {
	if (!text || !argsKey || component.preview || component.previewPending) return;

	component.previewPending = true;
	const requestKey = argsKey;
	void buildPlan(text, cwd)
		.then((plan): Preview => previewForPlan(plan))
		.catch((err): Preview => ({ error: err instanceof Error ? err.message : String(err) }))
		.then((preview) => {
			if (component.previewArgsKey !== requestKey || !component.previewPending) return;
			setUnifiedEditPreview(component, preview, requestKey);
			invalidate();
		});
}

function buildUnifiedEditCallComponent(
	component: UnifiedEditCallRenderComponent,
	text: string | undefined,
	theme: any,
	cwd: string,
): UnifiedEditCallRenderComponent {
	component.setBgFn(getUnifiedEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatUnifiedEditCall(text, component.preview, theme, cwd), 0, 0));

	if (!component.preview) return component;

	const body = "error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function formatUnifiedEditResult(
	preview: Preview | undefined,
	result: { content: ToolContent; details?: UnifiedEditDetails },
	theme: any,
	isError: boolean,
): string | undefined {
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content.map((item) => item.text || "").join("\n");
		if (!errorText || errorText === previewError) return undefined;
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) return renderDiff(resultDiff);
	return undefined;
}

export default function unifiedEditExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		promptGuidelines: TOOL_PROMPT_GUIDELINES,
		parameters: unifiedEditSchema,
		renderShell: "self",
		prepareArguments: prepareUnifiedArguments,

		async execute(_toolCallId, params: UnifiedEditParams, signal, _onUpdate, ctx) {
			const text = params.text;
			if (typeof text !== "string" || text.trim() === "") throw new Error("edit requires a non-empty text payload.");
			const plan = await buildPlan(text, ctx.cwd);
			try {
				await preflightPlan(plan, signal);
			} catch (err: any) {
				throw new Error(`Preflight failed before editing files.\n${err?.message ?? String(err)}`);
			}
			const details = await applyPlan(plan, signal);
			return { content: [{ type: "text" as const, text: formatSummary(details) }], details };
		},

		renderCall(args, theme, context: RenderContext<UnifiedRenderState>) {
			const component = getUnifiedEditCallRenderComponent(context.state, context.lastComponent);
			const prepared = prepareUnifiedArguments(args);
			const text = prepared && typeof prepared.text === "string" ? prepared.text : undefined;
			const key = text === undefined ? undefined : `${context.cwd}\0${text}`;
			if (component.previewArgsKey !== key) {
				component.preview = undefined;
				component.previewArgsKey = key;
				component.previewPending = false;
				component.settledError = false;
			}

			// 每个流式参数片段都重建 diff 会让工具卡片反复折叠和展开。
			// 等 payload 稳定完整后再构建。
			if (context.argsComplete) {
				requestUnifiedEditPreview(component, text, key, context.cwd, () => context.invalidate());
			}

			return buildUnifiedEditCallComponent(component, text, theme, context.cwd);
		},

		renderResult(result, _options, theme, context: RenderContext<UnifiedRenderState>) {
			const typed = result as { content: ToolContent; details?: UnifiedEditDetails };
			const component = context.state.callComponent;
			const prepared = prepareUnifiedArguments(context.args);
			const text = prepared && typeof prepared.text === "string" ? prepared.text : undefined;
			const key = text === undefined ? undefined : `${context.cwd}\0${text}`;
			let changed = false;

			if (component) {
				if (!context.isError && typed.details?.diff) {
					changed =
						setUnifiedEditPreview(
							component,
							{
								diff: typed.details.diff,
								files: uniquePaths(typed.details.files.map((file) => file.path)),
								firstChangedLine: typed.details.firstChangedLine,
							},
							key,
						) || changed;
				}
				if (component.settledError !== context.isError) {
					component.settledError = context.isError;
					changed = true;
				}
				if (changed) buildUnifiedEditCallComponent(component, text, theme, context.cwd);
			}

			const output = formatUnifiedEditResult(component?.preview, typed, theme, context.isError);
			const resultComponent = (context.lastComponent as Container | undefined) ?? new Container();
			resultComponent.clear();
			if (!output) return resultComponent;
			resultComponent.addChild(new Spacer(1));
			resultComponent.addChild(new Text(output, 1, 0));
			return resultComponent;
		},
	});
}
