import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { performAction } from "./files/actions.js";
import { FileBrowser, type BrowserResult, type BrowserState } from "./files/browser.js";

export default function filesExtension(pi: ExtensionAPI): void {
	let active: AbortController | undefined;

	const browse = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Files requires interactive mode", "error");
			return;
		}
		if (active) return;
		const controller = new AbortController();
		active = controller;
		const state: BrowserState = { expanded: new Set(), selected: "", query: "" };
		try {
			while (!controller.signal.aborted) {
				const result = await ctx.ui.custom<BrowserResult>((tui, theme, keys, done) => {
					const browser = new FileBrowser(ctx.cwd, state, tui, theme, keys, done);
					const close = () => done(undefined);
					controller.signal.addEventListener("abort", close, { once: true });
					return {
						get focused() { return browser.focused; },
						set focused(value: boolean) { browser.focused = value; },
						render: (width) => browser.render(width),
						handleInput: (data) => browser.handleInput(data),
						invalidate: () => browser.invalidate(),
						dispose() { controller.signal.removeEventListener("abort", close); browser.dispose(); },
					};
				});
				if (!result || controller.signal.aborted) break;
				if (result.kind === "quote") {
					// custom() 会在本次 append 前恢复原编辑器。
					const draft = ctx.ui.getEditorText();
					ctx.ui.setEditorText(`${draft}${draft ? "\n\n" : ""}${result.text}\n\n`);
					break;
				}
				try { await performAction(ctx, result, controller.signal); }
				catch (error) {
					if (!controller.signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			}
		} finally { controller.abort(); active = undefined; }
	};

	pi.registerCommand("files", { description: "Browse project files, preview changes, and quote source lines", handler: (_args, ctx) => browse(ctx) });
	pi.registerShortcut("ctrl+shift+o", { description: "Browse project files", handler: browse });
	pi.on("session_shutdown", () => active?.abort());
}
