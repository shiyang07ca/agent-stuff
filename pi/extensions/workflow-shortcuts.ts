import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COARSE_ALIASES = new Set(["big", "b", "coarse"]);
const NEXT_USAGE = "Usage: /next [1-20] [big|b|coarse], e.g. /next, /next 3, /next big 3";

export type NextArguments = {
	count: number | undefined;
	coarse: boolean;
};

export function parseNextArguments(args: string): NextArguments | null {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let count: number | undefined;
	let coarse = false;

	for (const part of parts) {
		if (COARSE_ALIASES.has(part)) {
			if (coarse) return null;
			coarse = true;
			continue;
		}

		if (!/^\d+$/.test(part) || count !== undefined) return null;
		const parsed = Number(part);
		if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) return null;
		count = parsed;
	}

	return { count, coarse };
}

export function buildNextPrompt(args: string): string | null {
	const parsed = parseNextArguments(args);
	if (!parsed) return null;

	const { count, coarse } = parsed;
	const item = coarse ? "粗粒度工作块" : "下一步";
	const granularity = coarse
		? "每项必须是有意义的完整工作块，不要把常规子步骤或微小操作拆成独立项目。"
		: "每一步都应具体、可执行，并按优先级排列。";

	if (count === 1) {
		return `简要说明当前状态，然后只给出唯一的最佳${item}。${granularity}`;
	}

	const countInstruction = count === undefined
		? `列出 1 至 5 个真正必要的${item}，不要为了凑数补充内容。`
		: `列出恰好 ${count} 个${item}。`;

	return `简要说明当前状态。${countInstruction}${granularity}最后明确指出其中唯一的最佳行动。`;
}

export function buildDiscussPrompt(args: string): string {
	const topic = args.trim();

	return `在采取行动前，先把问题讨论清楚。

可以读取和搜索现有代码、文档与 Git 状态，并运行明确只读的查询来核实必要事实。不要编辑、创建或删除文件，不要执行有副作用的命令，不要提交或推送。

分析相关选项、权衡、风险和可能路径。只有问题的答案会实质改变判断时才提问；信息已经足够时直接分析。最后给出简洁、明确的推荐。${topic ? `\n\n讨论主题：${topic}` : ""}`;
}

export function buildRecapPrompt(args: string): string {
	const focus = args.trim();

	return `根据当前对话恢复全局上下文，帮助我们重新明确方向。不要只关注最近一轮。

覆盖以下内容：

1. 原始目标或计划
2. 当前状态
3. 已确认的重要决策
4. 尚未完成的事项
5. 计划偏移或变化
6. 最佳下一步

默认只使用会话上下文，不调用工具。只有关注点明确要求核对项目状态时，才进行必要的只读检查。保持简洁。${focus ? `\n\n重点关注：${focus}` : ""}`;
}

export default function workflowShortcuts(pi: ExtensionAPI) {
	pi.registerCommand("next", {
		description: "Summarize the current state, list necessary next steps, and identify the best action",
		async handler(args, ctx) {
			const prompt = buildNextPrompt(args);
			if (!prompt) {
				if (ctx.hasUI) {
					ctx.ui.notify(NEXT_USAGE, "warning");
					return;
				}
				throw new Error(NEXT_USAGE);
			}
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("discuss", {
		description: "Discuss options, tradeoffs, and risks before acting; make no changes",
		async handler(args) {
			pi.sendUserMessage(buildDiscussPrompt(args), { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("recap", {
		description: "Restore the session's global context and determine the best next step",
		async handler(args) {
			pi.sendUserMessage(buildRecapPrompt(args), { deliverAs: "followUp" });
		},
	});
}
