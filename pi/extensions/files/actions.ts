import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import type { BrowserResult } from "./browser.js";
import { git, hasHead, MAX_PREVIEW_BYTES, readSource, run } from "./data.js";

function launch(command: string, args: string[], cwd: string, signal: AbortSignal, terminal: boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		// 编辑器命令是受信任的本地配置；文件路径是位置参数。
		const child = spawn("/bin/sh", ["-c", `exec ${command} "$@"`, "pi-files", ...args], {
			cwd, signal, stdio: terminal ? "inherit" : ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (data) => { stderr = (stderr + String(data)).slice(-4000); });
		child.on("error", reject);
		child.on("close", (code, exitSignal) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `Editor exited with ${exitSignal ?? code}`));
		});
	});
}

async function waitForApplication(ctx: ExtensionContext, label: string, command: string, args: string[], signal: AbortSignal, terminal = false): Promise<void> {
	const error = await ctx.ui.custom<Error | undefined>((tui, theme, _keys, done) => {
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		queueMicrotask(async () => {
			if (terminal) tui.stop();
			let failure: Error | undefined;
			try { await launch(command, args, ctx.cwd, controller.signal, terminal); }
			catch (error) { if (!controller.signal.aborted) failure = error instanceof Error ? error : new Error(String(error)); }
			finally {
				signal.removeEventListener("abort", abort);
				if (terminal) { tui.start(); tui.requestRender(true); }
				done(failure);
			}
		});
		return {
			render: (width) => new Text(theme.fg("dim", label), 0, 0).render(width),
			invalidate() {},
			handleInput: (data) => { if (matchesKey(data, "ctrl+g") || matchesKey(data, "escape")) abort(); },
			dispose: abort,
		};
	});
	if (error) throw error;
}

export async function performAction(ctx: ExtensionContext, action: Exclude<BrowserResult, { kind: "quote" } | undefined>, signal: AbortSignal): Promise<void> {
	const absolute = path.join(action.index.root, action.entry.path);
	if (action.kind === "edit") {
		if (!ctx.isIdle() && !(await ctx.ui.confirm("Open external editor?", "The agent is running and may change the same files."))) return;
		signal.throwIfAborted();
		await lstat(absolute);
		const command = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "cursor -w";
		const gui = /^\s*(?:["']?[^\s"']*\/)?(?:cursor|code|code-insiders)["']?(?:\s|$)/.test(command);
		const args = gui ? ["--wait", ...(action.entry.directory ? [absolute] : ["--goto", `${absolute}:${action.line}:1`])] : [absolute];
		await waitForApplication(ctx, `Editing ${action.entry.path}`, command, args, signal, !gui);
	} else if (action.kind === "diff") {
		const temp = await mkdtemp(path.join(os.tmpdir(), "pi-files-diff-"));
		try {
			let before = "";
			const basePath = action.entry.oldPath ?? action.entry.path;
			if (await hasHead(action.index.root, signal)) {
				const record = await git(action.index.root, ["ls-tree", "-z", "HEAD", "--", basePath], signal);
				if (record) {
					const object = record.slice(0, record.indexOf("\t")).split(" ");
					if (object[1] !== "blob") throw new Error("Use Cursor to inspect this directory or submodule.");
					before = await git(action.index.root, ["show", object[2]], signal, MAX_PREVIEW_BYTES);
				}
			}
			let after = "";
			try {
				const info = await lstat(absolute);
				after = info.isSymbolicLink() ? await readlink(absolute) : (await readSource(absolute)).text;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (before.includes("\0")) throw new Error("Binary diff. Use the system application to inspect the file.");
			const name = path.basename(action.entry.path);
			const left = path.join(temp, `HEAD-${name}`);
			const right = path.join(temp, `WORKING-${name}`);
			await Promise.all([writeFile(left, before), writeFile(right, after)]);
			await Promise.all([chmod(left, 0o444), chmod(right, 0o444)]);
			await waitForApplication(ctx, `Cursor diff: ${action.entry.path}`, "cursor", ["--wait", "--diff", left, right], signal);
		} finally { await rm(temp, { recursive: true, force: true }); }
	} else {
		const info = await lstat(absolute);
		if (action.kind === "quicklook") {
			await waitForApplication(ctx, `Quick Look: ${action.entry.path}`, "qlmanage", ["-p", absolute], signal);
		} else if (action.kind === "reveal") {
			if (process.platform === "darwin") await run("open", info.isDirectory() ? [absolute] : ["-R", absolute], ctx.cwd, signal);
			else await run("xdg-open", [info.isDirectory() ? absolute : path.dirname(absolute)], ctx.cwd, signal);
		} else {
			await run(process.platform === "darwin" ? "open" : "xdg-open", [absolute], ctx.cwd, signal);
		}
	}
}
