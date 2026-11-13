/**
 * 桌面通知扩展
 *
 * Agent 完成并等待输入时发送原生桌面通知。
 * 使用 OSC 777 转义序列，无外部依赖。
 *
 * 支持的终端：Ghostty、iTerm2、WezTerm、rxvt-unicode
 * 不支持：Kitty（使用 OSC 99）、Terminal.app、Windows Terminal、Alacritty
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * 通过 OSC 777 转义序列发送桌面通知。
 */
const notify = (title: string, body: string): void => {
	// OSC 777 格式：ESC ] 777 ; notify ; title ; body BEL
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
};

const isTextPart = (part: unknown): part is { type: "text"; text: string } =>
	Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);

const extractLastAssistantText = (messages: Array<{ role?: string; content?: unknown }>): string | null => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") {
			continue;
		}

		const content = message.content;
		if (typeof content === "string") {
			return content.trim() || null;
		}

		if (Array.isArray(content)) {
			const text = content.filter(isTextPart).map((part) => part.text).join("\n").trim();
			return text || null;
		}

		return null;
	}

	return null;
};

const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: () => "",
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: () => "",
	quote: (text) => text,
	quoteBorder: () => "",
	hr: () => "",
	listBullet: () => "",
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

const simpleMarkdown = (text: string, width = 80): string => {
	const markdown = new Markdown(text, 0, 0, plainMarkdownTheme);
	return markdown.render(width).join("\n");
};

const formatNotification = (text: string | null): { title: string; body: string } => {
	const simplified = text ? simpleMarkdown(text) : "";
	// Markdown 会输出 OSC 8 超链接。将 OSC 序列嵌入 OSC 777 通知会提前终止通知，
	// 并把其可见文本打印到终端光标处。构造外层 OSC 序列前，
	// 先移除终端序列和残余控制字符。
	const normalized = stripTerminalSequences(simplified)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) {
		return { title: "Waiting for input", body: "" };
	}

	const maxBody = 200;
	const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
	return { title: "π", body };
};

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.aborted || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const messages = ctx.sessionManager.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const lastText = extractLastAssistantText(messages);
		const { title, body } = formatNotification(lastText);
		notify(title, body);
	});
}
