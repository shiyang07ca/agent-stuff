import type { Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, matchesKey, SelectList, truncateToWidth, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import path from "node:path";
import { loadDiff, loadIndex, quoteSelection, readSource, referencePath, treeRows, type FileEntry, type FileIndex, type TreeRow } from "./data.js";
import { displayText, FileViewer, type ViewMode } from "./viewer.js";

export type ExternalAction = "edit" | "diff" | "reveal" | "quicklook" | "open";
export type BrowserResult = { kind: "quote"; text: string } | { kind: ExternalAction; index: FileIndex; entry: FileEntry; line: number } | undefined;

export interface BrowserState {
	expanded: Set<string>;
	changed?: boolean;
	selected: string;
	query: string;
	viewer?: FileViewer;
}

export class FileBrowser implements Focusable {
	private input = new Input();
	private searching = false;
	private searchDirection = 1;
	private searchFrom = 0;
	private searchOrigin?: { cursor: number; top: number; query: string; selected: string };
	private commandPrefix = false;
	private focusedValue = false;
	private controller = new AbortController();
	private disposed = false;
	private index?: FileIndex;
	private rows: TreeRow[] = [];
	private selectedIndex = 0;
	private height = 15;
	private busy = "";
	private message = "";
	private menu?: SelectList;
	private menuItems: string[] = [];
	private menuEntry?: FileEntry;
	private listingCache?: TreeRow[];

	constructor(
		private cwd: string,
		private state: BrowserState,
		private tui: TUI,
		private theme: Theme,
		private keys: KeybindingsManager,
		private done: (result: BrowserResult) => void,
	) {
		this.input.setValue(state.query);
		void this.work("Loading files...", () => this.refresh());
	}

	get focused(): boolean { return this.focusedValue; }
	set focused(value: boolean) { this.focusedValue = value; this.input.focused = value && this.searching; }

	dispose(): void { this.disposed = true; this.controller.abort(); }
	invalidate(): void { this.state.viewer?.invalidate(); this.input.invalidate(); this.menu?.invalidate(); }

	private async work(label: string, operation: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = label;
		this.message = "";
		this.tui.requestRender();
		try { await operation(); }
		catch (error) { if (!this.disposed) this.message = error instanceof Error ? error.message : String(error); }
		finally {
			this.busy = "";
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private async refresh(): Promise<void> {
		const index = await loadIndex(this.cwd, this.controller.signal, (count) => {
			if (!this.disposed) { this.busy = `Loading files... ${count}`; this.tui.requestRender(); }
		});
		if (this.disposed) return;
		this.index = index;
		this.state.changed ??= index.git && index.entries.some((entry) => entry.status.trim());
		this.listingCache = undefined;
		this.rebuildRows();
		const viewer = this.state.viewer;
		if (viewer) {
			viewer.entry = index.entries.find((entry) => entry.path === viewer.entry.path) ?? viewer.entry;
			viewer.anchor = undefined;
			await this.loadViewer(viewer, viewer.mode);
		}
	}

	private rebuildRows(): void {
		if (!this.index) return;
		const query = this.state.query;
		if (query) {
			const matches = fuzzyFilter(this.index.entries, query, (entry) => entry.path);
			this.rows = matches.map((entry) => ({ path: entry.path, directory: entry.directory, depth: 0, entry }));
		} else if (this.state.changed) {
			this.rows = this.index.entries.filter((entry) => entry.status.trim()).map((entry) => ({ path: entry.path, directory: entry.directory, depth: 0, entry }));
		} else {
			this.listingCache ??= treeRows(this.index.entries, this.state.expanded);
			this.rows = this.listingCache;
		}
		const previous = this.rows.findIndex((row) => row.path === this.state.selected);
		this.selectedIndex = previous >= 0 ? previous : Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
		this.rememberSelection();
	}

	private rememberSelection(): void { this.state.selected = this.rows[this.selectedIndex]?.path ?? ""; }
	private entry(): FileEntry | undefined {
		if (this.state.viewer) return this.state.viewer.entry;
		const row = this.rows[this.selectedIndex];
		return row?.entry ?? (row ? { path: row.path, directory: row.directory, status: "  " } : undefined);
	}

	private async loadViewer(viewer: FileViewer, mode: ViewMode): Promise<void> {
		if (!this.index) return;
		try {
			if (mode === "diff") {
				const diff = await loadDiff(this.index, viewer.entry, this.controller.signal);
				if (this.disposed) return;
				viewer.diff = diff;
			} else {
				const source = await readSource(path.join(this.index.root, viewer.entry.path));
				if (this.disposed) return;
				viewer.source = source;
			}
			viewer.setMode(mode);
			viewer.error = "";
		} catch (error) {
			if (this.disposed) return;
			// 工作文件被删除时仍保持可用的 diff 可见。
			if (viewer.mode === "diff" && mode !== "diff" && viewer.diff) throw error;
			viewer.error = error instanceof Error ? error.message : String(error);
		}
		viewer.invalidate();
	}

	private async openEntry(entry: FileEntry): Promise<void> {
		const mode = this.state.changed && this.index?.git && entry.status.trim() ? "diff" : /\.md$/i.test(entry.path) ? "markdown" : "source";
		const viewer = new FileViewer(entry, mode);
		this.state.viewer = viewer;
		await this.loadViewer(viewer, mode);
	}

	private toggleDirectory(row: TreeRow): void {
		if (this.state.expanded.has(row.path)) this.state.expanded.delete(row.path);
		else this.state.expanded.add(row.path);
		this.state.query = "";
		this.input.setValue("");
		this.state.changed = false;
		this.listingCache = undefined;
		this.rebuildRows();
	}

	private beginSearch(direction: number): void {
		const viewer = this.state.viewer;
		if (viewer?.mode === "markdown") {
			viewer.setMode("source");
			viewer.start();
			viewer.render(this.tui.terminal.columns, this.height, this.theme);
		}
		this.searching = true;
		this.searchDirection = direction;
		this.searchFrom = viewer?.cursor ?? 0;
		this.searchOrigin = { cursor: this.searchFrom, top: viewer?.top ?? 0, query: viewer?.query ?? this.state.query, selected: this.state.selected };
		this.input.setValue(viewer ? "" : this.state.query);
		this.input.focused = this.focused;
	}

	private stopSearch(cancel: boolean): void {
		const viewer = this.state.viewer;
		const origin = this.searchOrigin;
		if (cancel && origin) {
			if (viewer) {
				viewer.cursor = origin.cursor;
				viewer.top = origin.top;
				viewer.query = origin.query;
			} else {
				this.state.query = origin.query;
				this.state.selected = origin.selected;
				this.rebuildRows();
			}
		}
		this.message = "";
		this.searching = false;
		this.searchOrigin = undefined;
		this.input.focused = false;
	}

	private updateSearch(repeat = false): void {
		const viewer = this.state.viewer;
		const query = this.input.getValue();
		this.message = "";
		if (viewer) {
			const previous = viewer.cursor;
			if (!repeat) viewer.cursor = this.searchFrom;
			if (query && !viewer.search(query, this.searchDirection, !repeat)) {
				viewer.cursor = previous;
				this.message = "No matches";
			}
			if (!query) viewer.query = "";
			if (repeat) this.searchFrom = viewer.cursor;
		} else if (repeat && query === this.state.query && this.rows.length) {
			this.selectedIndex = (this.selectedIndex + this.searchDirection + this.rows.length) % this.rows.length;
			this.rememberSelection();
		} else {
			this.state.query = query;
			this.state.selected = "";
			this.selectedIndex = 0;
			this.rebuildRows();
		}
	}

	private showActions(): void {
		const entry = this.entry();
		if (!entry || !this.index) return;
		this.menuEntry = entry;
		const items = [
			{ value: "quote", label: this.state.viewer?.selecting ? "Add selected lines to prompt" : "Add file path to prompt" },
			{ value: "edit", label: "External editor" },
			...(this.index.git && !entry.directory ? [{ value: "diff", label: "Diff in Cursor" }] : []),
			...(process.platform === "darwin" && !entry.directory ? [{ value: "quicklook", label: "Quick Look" }] : []),
			{ value: "reveal", label: "Reveal in file manager" },
			{ value: "open", label: "System application" },
		];
		this.menuItems = items.map((item) => item.value);
		this.menu = new SelectList(items, items.length, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("dim", text),
		});
		this.menu.onCancel = () => { this.menu = undefined; };
		this.menu.onSelect = (item) => {
			this.menu = undefined;
			if (item.value === "quote") void this.work("Checking selection...", () => this.addToPrompt());
			else this.done({ kind: item.value as ExternalAction, index: this.index!, entry, line: this.state.viewer?.mode === "source" ? this.state.viewer.line + 1 : 1 });
		};
	}

	private async addToPrompt(): Promise<void> {
		const entry = this.entry();
		if (!entry || !this.index) return;
		const absolute = path.join(this.index.root, entry.path);
		const viewer = this.state.viewer;
		const text = viewer?.selecting && viewer.source
			? await quoteSelection(absolute, this.cwd, viewer.source, viewer.anchor!, viewer.line)
			: `@${referencePath(absolute, this.cwd)}`;
		if (!this.disposed) this.done({ kind: "quote", text });
	}

	private async nextChange(direction: number): Promise<void> {
		const entries = this.index?.entries.filter((entry) => entry.status.trim() && !entry.directory) ?? [];
		if (!entries.length) return;
		const selected = this.entry()?.path;
		const current = entries.findIndex((entry) => entry.path === selected);
		const next = current < 0 ? (direction > 0 ? 0 : entries.length - 1) : (current + direction + entries.length) % entries.length;
		this.state.selected = entries[next].path;
		this.rebuildRows();
		await this.openEntry(entries[next]);
	}

	handleInput(data: string): void {
		const cancel = matchesKey(data, "ctrl+g") || this.keys.matches(data, "tui.select.cancel");
		if (this.busy) {
			if (cancel) this.done(undefined);
			return;
		}
		if (this.menu) {
			if (cancel || matchesKey(data, "q")) this.menu = undefined;
			else if (matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+p")) {
				const current = this.menuItems.indexOf(this.menu.getSelectedItem()?.value ?? "");
				const delta = matchesKey(data, "ctrl+n") ? 1 : -1;
				this.menu.setSelectedIndex((current + delta + this.menuItems.length) % this.menuItems.length);
			} else this.menu.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.searching) {
			if (cancel) this.stopSearch(true);
			else if (this.keys.matches(data, "tui.select.confirm")) this.stopSearch(false);
			else if (matchesKey(data, "ctrl+s") || matchesKey(data, "ctrl+r")) {
				this.searchDirection = matchesKey(data, "ctrl+s") ? 1 : -1;
				if (!this.input.getValue()) this.input.setValue(this.searchOrigin?.query ?? "");
				this.updateSearch(true);
			}
			else {
				const previous = this.input.getValue();
				this.input.handleInput(data);
				if (this.input.getValue() !== previous) this.updateSearch();
			}
			this.tui.requestRender();
			return;
		}
		this.message = "";
		const viewer = this.state.viewer;
		if (this.commandPrefix) {
			this.commandPrefix = false;
			if (!cancel) this.handleCommand(data);
		} else if (matchesKey(data, "ctrl+c")) {
			this.commandPrefix = true;
		} else if (cancel || matchesKey(data, "q")) {
			if (cancel && viewer?.selecting) viewer.anchor = undefined;
			else if (viewer) this.state.viewer = undefined;
			else if (this.state.query) { this.state.query = ""; this.rebuildRows(); }
			else { this.done(undefined); return; }
		} else if (matchesKey(data, "g")) {
			void this.work("Refreshing...", () => this.refresh());
		} else if (matchesKey(data, "ctrl+s") || matchesKey(data, "ctrl+r")) {
			this.beginSearch(matchesKey(data, "ctrl+s") ? 1 : -1);
		} else if (matchesKey(data, "alt+x")) {
			this.showActions();
		} else if (matchesKey(data, "alt+w")) {
			void this.work("Checking selection...", () => this.addToPrompt());
		} else if (matchesKey(data, "alt+n") || matchesKey(data, "alt+p")) {
			void this.work("Loading change...", () => this.nextChange(matchesKey(data, "alt+n") ? 1 : -1));
		} else if (viewer) {
			this.handleViewerInput(data, viewer);
		} else {
			this.handleTreeInput(data);
		}
		this.tui.requestRender();
	}

	private handleCommand(data: string): void {
		const viewer = this.state.viewer;
		if (matchesKey(data, "c") && this.index?.git) {
			this.state.viewer = undefined;
			this.state.changed = !this.state.changed;
			this.state.query = "";
			this.rebuildRows();
		} else if (matchesKey(data, "d") && viewer && this.index?.git) {
			void this.work("Loading diff...", () => this.loadViewer(viewer, viewer.mode === "diff" ? "source" : "diff"));
		} else if (matchesKey(data, "m") && viewer && /\.md$/i.test(viewer.entry.path)) {
			void this.work("Loading Markdown...", () => this.loadViewer(viewer, viewer.mode === "markdown" ? "source" : "markdown"));
		} else {
			this.message = "Command unavailable";
		}
	}

	private handleViewerInput(data: string, viewer: FileViewer): void {
		if (this.keys.matches(data, "tui.select.down") || matchesKey(data, "ctrl+n")) viewer.move(1);
		else if (this.keys.matches(data, "tui.select.up") || matchesKey(data, "ctrl+p")) viewer.move(-1);
		else if (this.keys.matches(data, "tui.select.pageDown") || matchesKey(data, "ctrl+v")) viewer.page(this.height);
		else if (this.keys.matches(data, "tui.select.pageUp") || matchesKey(data, "alt+v")) viewer.page(-this.height);
		else if (matchesKey(data, "alt+<") || matchesKey(data, "alt+shift+,") || matchesKey(data, "home")) viewer.start();
		else if (matchesKey(data, "alt+>") || matchesKey(data, "alt+shift+.") || matchesKey(data, "end")) viewer.end();
		else if (matchesKey(data, "ctrl+space") || matchesKey(data, "ctrl+@") || matchesKey(data, "ctrl+shift+2")) {
			if (viewer.mode !== "source") void this.work("Loading source...", async () => { await this.loadViewer(viewer, "source"); viewer.select(); });
			else viewer.select();
		}
	}

	private handleTreeInput(data: string): void {
		const row = this.rows[this.selectedIndex];
		if (this.keys.matches(data, "tui.select.down") || matchesKey(data, "ctrl+n")) this.selectedIndex++;
		else if (this.keys.matches(data, "tui.select.up") || matchesKey(data, "ctrl+p")) this.selectedIndex--;
		else if (this.keys.matches(data, "tui.select.pageDown") || matchesKey(data, "ctrl+v")) this.selectedIndex += this.height;
		else if (this.keys.matches(data, "tui.select.pageUp") || matchesKey(data, "alt+v")) this.selectedIndex -= this.height;
		else if (matchesKey(data, "alt+<") || matchesKey(data, "alt+shift+,") || matchesKey(data, "home")) this.selectedIndex = 0;
		else if (matchesKey(data, "alt+>") || matchesKey(data, "alt+shift+.") || matchesKey(data, "end")) this.selectedIndex = this.rows.length - 1;
		else if (row && (this.keys.matches(data, "tui.select.confirm") || matchesKey(data, "ctrl+f") || matchesKey(data, "right"))) {
			if (row.directory) this.toggleDirectory(row);
			else if (row.entry) void this.work("Loading file...", () => this.openEntry(row.entry!));
		} else if (row && (matchesKey(data, "ctrl+b") || matchesKey(data, "left"))) {
			if (row.directory && this.state.expanded.has(row.path)) this.toggleDirectory(row);
			else {
				const parent = path.dirname(row.path);
				this.state.expanded.delete(parent);
				this.state.selected = parent;
				this.listingCache = undefined;
				this.rebuildRows();
			}
		}
		this.selectedIndex = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex));
		this.rememberSelection();
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		this.height = Math.max(3, Math.min(24, this.tui.terminal.rows - 12));
		const theme = this.theme;
		const viewer = this.state.viewer;
		let body: string[];
		let title: string;
		if (this.menu) {
			title = `Actions: ${displayText(this.menuEntry?.path ?? "")}`;
			body = this.menu.render(width);
		} else if (viewer) {
			title = `${displayText(viewer.entry.path)}  [${viewer.mode === "diff" ? "HEAD -> working tree" : viewer.mode}]`;
			body = viewer.render(width, this.height, theme);
		} else {
			title = `${this.state.query ? "Search" : this.state.changed ? "Changes" : "Files"}  ${displayText(this.index?.root ?? this.cwd)}`;
			const top = Math.max(0, this.selectedIndex - Math.floor(this.height / 2));
			body = this.rows.slice(top, top + this.height).map((row, offset) => {
				const entry = row.entry;
				const status = entry?.status || "  ";
				const name = this.state.changed || this.state.query ? row.path : path.basename(row.path);
				const prefix = row.directory ? (this.state.expanded.has(row.path) ? "- " : "+ ") : "  ";
				const old = entry?.oldPath ? ` <- ${displayText(entry.oldPath)}` : "";
				const untracked = entry?.untrackedCopy ? " (also untracked)" : "";
				let line = `${theme.fg(status.trim() ? "warning" : "dim", status)} ${"  ".repeat(row.depth)}${prefix}${displayText(name)}${old}${untracked}`;
				line = truncateToWidth(line, width, "");
				return top + offset === this.selectedIndex ? theme.bg("selectedBg", line) : line;
			});
		if (!body.length) body.push(theme.fg("dim", this.busy ? "" : "(no files)"));
		}
		while (body.length < this.height) body.push("");
		const status = this.busy || this.message || (this.commandPrefix ? "C-c" : "") || (viewer ? `${viewer.position}${viewer.query ? `  ${displayText(viewer.query)}` : ""}` : `${this.rows.length} entries${this.index?.note ? `  ${this.index.note}` : ""}`);
		const lines = [theme.fg("accent", theme.bold(title)), theme.fg("borderMuted", "-".repeat(width)), ...body, theme.fg(this.message ? "warning" : "dim", displayText(status))];
		if (this.searching) lines.push(...this.input.render(width));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}
