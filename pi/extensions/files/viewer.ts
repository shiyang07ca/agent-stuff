import { getLanguageFromPath, getMarkdownTheme, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parsePatch } from "diff";
import type { FileEntry, Source } from "./data.js";

export type ViewMode = "source" | "markdown" | "diff";
interface Row { text: string; line?: number }

export function displayText(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export class FileViewer {
	entry: FileEntry;
	source?: Source;
	diff = "";
	mode: ViewMode;
	cursor = 0;
	top = 0;
	anchor?: number;
	query = "";
	error = "";
	private rows: Row[] = [];
	private width = 0;
	private colored?: string[];
	private markdown?: Markdown;
	private restoreLine?: number;

	constructor(entry: FileEntry, mode: ViewMode) {
		this.entry = entry;
		this.mode = mode;
	}

	get line(): number { return this.rows[this.cursor]?.line ?? 0; }
	get selecting(): boolean { return this.anchor !== undefined; }

	setMode(mode: ViewMode): void {
		if (mode === this.mode) return;
		this.restoreLine = this.mode === "source" ? this.line : 0;
		this.mode = mode;
		this.cursor = 0;
		this.top = 0;
		this.anchor = undefined;
		this.query = "";
		this.invalidate();
	}

	invalidate(): void {
		if (this.width && this.mode === "source") this.restoreLine = this.line;
		this.width = 0;
		this.colored = undefined;
		this.markdown = undefined;
	}

	private buildRows(width: number, theme: Theme): void {
		if (this.width === width) return;
		const sourceLine = this.restoreLine ?? (this.mode === "source" ? this.line : undefined);
		this.restoreLine = undefined;
		this.width = width;
		this.rows = [];
		if (this.error) {
			this.rows = wrapTextWithAnsi(theme.fg("warning", displayText(this.error)), width).map((text) => ({ text }));
		} else if (this.mode === "markdown" && this.source) {
			this.markdown ??= new Markdown(this.source.lines.map((line) => displayText(line.replace(/\t/g, "    "))).join("\n"), 0, 0, getMarkdownTheme());
			this.rows = this.markdown.render(width).map((text) => ({ text }));
		} else if (this.mode === "source" && this.source) {
			const clean = this.source.lines.map((line) => displayText(line.replace(/\t/g, "    ")));
			this.colored ??= highlightCode(clean.join("\n"), getLanguageFromPath(this.entry.path));
			const digits = String(clean.length).length;
			const gutter = Math.min(digits + 3, Math.max(0, width - 4));
			for (let i = 0; i < clean.length; i++) {
				const chunks = wrapTextWithAnsi(this.colored[i] ?? clean[i], Math.max(1, width - gutter));
				for (let j = 0; j < chunks.length; j++) {
					const prefix = gutter ? theme.fg("dim", truncateToWidth(j ? " ".repeat(digits) + " | " : `${String(i + 1).padStart(digits)} | `, gutter, "")) : "";
					this.rows.push({ text: prefix + chunks[j], line: i });
				}
			}
		} else if (this.mode === "diff") {
			this.rows = this.diffRows(width, theme);
		}
		if (!this.rows.length) this.rows = [{ text: theme.fg("dim", this.mode === "diff" ? "No changes relative to HEAD" : "(empty)") }];
		if (sourceLine !== undefined && this.mode === "source") {
			const target = this.rows.findIndex((row) => row.line === sourceLine);
			this.cursor = target < 0 ? 0 : target;
		}
		this.cursor = Math.min(this.cursor, this.rows.length - 1);
	}

	private diffRows(width: number, theme: Theme): Row[] {
		if (!this.diff.trim()) return [];
		const rows: Row[] = [];
		const append = (text: string, color: "dim" | "accent" | "toolDiffAdded" | "toolDiffRemoved" | "text") => {
			for (const wrapped of wrapTextWithAnsi(theme.fg(color, displayText(text.replace(/\t/g, "    "))), width)) rows.push({ text: wrapped });
		};
		let patches: ReturnType<typeof parsePatch>;
		try { patches = parsePatch(this.diff); }
		catch {
			for (const line of this.diff.split("\n")) append(line, "text");
			return rows;
		}
		// 保留 Git metadata（rename、file mode、binary diff），并为 hunk 补充旧/新行号。
		for (const patch of patches) {
			if (patch.oldFileName !== undefined && patch.newFileName !== undefined) append(`${patch.oldFileName} -> ${patch.newFileName}`, "accent");
			for (const hunk of patch.hunks) {
				append(`@@ -${hunk.oldLines ? hunk.oldStart : hunk.oldStart - 1},${hunk.oldLines} +${hunk.newLines ? hunk.newStart : hunk.newStart - 1},${hunk.newLines} @@`, "accent");
				let oldLine = hunk.oldStart;
				let newLine = hunk.newStart;
				for (const line of hunk.lines) {
					const marker = line[0];
					if (marker === "\\") { append(line, "dim"); continue; }
					const left = marker === "+" ? "" : String(oldLine++);
					const right = marker === "-" ? "" : String(newLine++);
					append(`${left.padStart(4)} ${right.padStart(4)} ${line}`, marker === "+" ? "toolDiffAdded" : marker === "-" ? "toolDiffRemoved" : "text");
				}
			}
		}
		const metadata = this.diff.split("\n").filter((line) => /^(old mode |new mode |new file mode |deleted file mode |similarity index |rename from |rename to |Binary files |Submodule )/.test(line));
		for (const line of metadata) append(line, "dim");
		if (!rows.length) for (const line of this.diff.split("\n")) append(line, "text");
		return rows;
	}

	render(width: number, height: number, theme: Theme): string[] {
		this.buildRows(width, theme);
		this.top = Math.max(0, Math.min(this.top, this.cursor));
		if (this.cursor >= this.top + height) this.top = this.cursor - height + 1;
		const from = Math.min(this.anchor ?? this.line, this.line);
		const to = Math.max(this.anchor ?? this.line, this.line);
		return Array.from({ length: height }, (_, offset) => {
			const index = this.top + offset;
			const row = this.rows[index];
			if (!row) return "";
			let text = truncateToWidth(row.text, width, "");
			if (this.anchor !== undefined && row.line !== undefined && row.line >= from && row.line <= to) text = theme.bg("selectedBg", text);
			else if (index === this.cursor) text = theme.inverse(text || " ");
			return text;
		});
	}

	move(delta: number): void { this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta)); }
	page(delta: number): void {
		this.move(delta);
		this.top = Math.max(0, Math.min(this.rows.length - Math.abs(delta), this.top + delta));
	}
	start(): void { this.cursor = 0; }
	end(): void { this.cursor = Math.max(0, this.rows.length - 1); }
	select(): void { if (this.source && !this.error && this.mode === "source") this.anchor = this.anchor === undefined ? this.line : undefined; }

	search(query: string, direction = 1, includeCurrent = false): boolean {
		this.query = query;
		if (!query) return false;
		const text = this.mode === "diff" ? undefined : this.source?.lines;
		const lower = query.toLocaleLowerCase();
		const first = includeCurrent ? 0 : 1;
		for (let distance = first; distance < this.rows.length + first; distance++) {
			const index = (this.cursor + direction * distance + this.rows.length) % this.rows.length;
			const row = this.rows[index];
			if (!includeCurrent && row.line !== undefined && row.line === this.line && index !== this.cursor) continue;
			const value = text && row.line !== undefined ? text[row.line] : row.text.replace(/\x1b\[[0-9;]*m/g, "");
			if (value.toLocaleLowerCase().includes(lower)) {
				this.cursor = row.line === undefined ? index : this.rows.findIndex((candidate) => candidate.line === row.line);
				return true;
			}
		}
		return false;
	}

	get position(): string {
		if (this.mode === "source" && this.source) {
			return this.selecting ? `Lines ${Math.min(this.anchor!, this.line) + 1}-${Math.max(this.anchor!, this.line) + 1}` : `Line ${this.line + 1}/${this.source.lines.length}`;
		}
		return `${this.cursor + 1}/${this.rows.length}`;
	}
}
