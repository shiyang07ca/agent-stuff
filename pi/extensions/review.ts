/**
 * Code Review 扩展（受 Codex 的 review 功能启发）
 *
 * 提供 `/review` 命令，提示 agent 审查（review）代码变更。
 * 支持多种 review 模式：
 * - 审查 GitHub pull request（在本地 checkout PR）
 * - 针对 base branch 审查（PR 风格）
 * - 审查未提交变更
 * - 审查指定 commit
 * - 共享的自定义 review 说明（配置后应用于所有 review 模式）
 *
 * 用法：
 * - `/review` - 显示交互式选择器
 * - `/review pr 123` - 审查 PR #123（在本地 checkout）
 * - `/review pr https://github.com/owner/repo/pull/123` - 审查 URL 指向的 PR
 * - `/review uncommitted` - 直接审查未提交变更
 * - `/review branch main` - 针对 main branch 审查
 * - `/review commit abc123` - 审查指定 commit
 * - `/review folder src docs` - 审查指定目录/文件（snapshot，不是 diff）
 * - `/review` 选择器包含「添加/移除自定义 review 说明」（应用于所有模式）
 * - `/review --extra "focus on performance regressions"` - 添加额外的 review 说明（适用于任何模式）
 *
 * 项目级 review guidelines：
 * - 如果 .pi 同目录下存在 REVIEW_GUIDELINES.md 文件，
 *   其内容会追加到 review prompt。
 *
 * 注意：PR review 要求工作区干净（tracked 文件没有未提交变更）。
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import path from "node:path";
import { promises as fs } from "node:fs";

// 用于跟踪 fresh session review（我们从此处分出的位置）的状态。
// 模块级状态意味着同一时间只能有一个 review 处于活动状态。
// 这是有意为之——UI 和 /end-review 命令都假设只有一个活动的 review。
let reviewOriginId: string | undefined = undefined;
let endReviewInProgress = false;
let reviewLoopFixingEnabled = false;
let reviewCustomInstructions: string | undefined = undefined;
let reviewLoopInProgress = false;

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_ANCHOR_TYPE = "review-anchor";
const REVIEW_SETTINGS_TYPE = "review-settings";
const REVIEW_LOOP_MAX_ITERATIONS = 10;
const REVIEW_LOOP_START_TIMEOUT_MS = 15000;
const REVIEW_LOOP_START_POLL_MS = 50;

type ReviewSessionState = {
	active: boolean;
	originId?: string;
};

type ReviewSettingsState = {
	loopFixingEnabled?: boolean;
	customInstructions?: string;
};

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
	if (!ctx.hasUI) return;
	if (!active) {
		ctx.ui.setWidget("review", undefined);
		return;
	}

	ctx.ui.setWidget("review", (_tui, theme) => {
		const message = reviewLoopInProgress
			? "Review session in progress (loop fixing is running)"
			: reviewLoopFixingEnabled
				? "Review session in progress (loop fixing enabled); use /end-review to return"
				: "Review session in progress; use /end-review to return";
		const text = new Text(theme.fg("warning", message), 0, 0);
		return {
			render(width: number) {
				return text.render(width);
			},
			invalidate() {
				text.invalidate();
			},
		};
	});
}

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
	let state: ReviewSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
			state = entry.data as ReviewSessionState | undefined;
		}
	}

	return state;
}

function applyReviewState(ctx: ExtensionContext) {
	const state = getReviewState(ctx);

	if (state?.active && state.originId) {
		reviewOriginId = state.originId;
		setReviewWidget(ctx, true);
		return;
	}

	reviewOriginId = undefined;
	setReviewWidget(ctx, false);
}

function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
	let state: ReviewSettingsState | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
			state = entry.data as ReviewSettingsState | undefined;
		}
	}

	return {
		loopFixingEnabled: state?.loopFixingEnabled === true,
		customInstructions: state?.customInstructions?.trim() || undefined,
	};
}

function applyReviewSettings(ctx: ExtensionContext) {
	const state = getReviewSettings(ctx);
	reviewLoopFixingEnabled = state.loopFixingEnabled === true;
	reviewCustomInstructions = state.customInstructions?.trim() || undefined;
}

function parseMarkdownHeading(line: string): { level: number; title: string } | null {
	const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
	if (!headingMatch) {
		return null;
	}

	const rawTitle = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
	return {
		level: headingMatch[1].length,
		title: rawTitle,
	};
}

function getFindingsSectionBounds(lines: string[]): { start: number; end: number } | null {
	let start = -1;
	let findingsHeadingLevel: number | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);
		if (heading && /^findings\b/i.test(heading.title)) {
			start = i + 1;
			findingsHeadingLevel = heading.level;
			break;
		}
		if (/^\s*findings\s*:?\s*$/i.test(line)) {
			start = i + 1;
			break;
		}
	}

	if (start < 0) {
		return null;
	}

	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);
		if (heading) {
			const normalizedTitle = heading.title.replace(/[*_`]/g, "").trim();
			if (/^(review scope|verdict|overall verdict|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(normalizedTitle)) {
				end = i;
				break;
			}

			if (/\[P[0-3]\]/i.test(heading.title)) {
				continue;
			}

			if (findingsHeadingLevel !== null && heading.level <= findingsHeadingLevel) {
				end = i;
				break;
			}
		}

		if (/^\s*(review scope|verdict|overall verdict|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(line)) {
			end = i;
			break;
		}
	}

	return { start, end };
}

function isLikelyFindingLine(line: string): boolean {
	if (!/\[P[0-3]\]/i.test(line)) {
		return false;
	}

	if (/^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+priority\s+tag\b/i.test(line)) {
		return false;
	}

	if (/^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+\[P[0-3]\]\s*-\s*(?:drop everything|urgent|normal|low|nice to have)\b/i.test(line)) {
		return false;
	}

	const allPriorityTags = line.match(/\[P[0-3]\]/gi) ?? [];
	if (allPriorityTags.length > 1) {
		return false;
	}

	if (/^\s*(?:[-*+]|(?:\d+)[.)])\s+/.test(line)) {
		return true;
	}

	if (/^\s*#{1,6}\s+/.test(line)) {
		return true;
	}

	if (/^\s*(?:\*\*|__)?\[P[0-3]\](?:\*\*|__)?(?=\s|:|-)/i.test(line)) {
		return true;
	}

	return false;
}

function normalizeVerdictValue(value: string): string {
	return value
		.trim()
		.replace(/^[-*+]\s*/, "")
		.replace(/^['"`]+|['"`]+$/g, "")
		.toLowerCase();
}

function isNeedsAttentionVerdictValue(value: string): boolean {
	const normalized = normalizeVerdictValue(value);
	if (!normalized.includes("needs attention")) {
		return false;
	}

	if (/\bnot\s+needs\s+attention\b/.test(normalized)) {
		return false;
	}

	// 拒绝像 "correct or needs attention" 这样的 rubric/选项措辞，
	// 但保留可能包含无关 "or" 的合法 verdict 文本。
	if (/\bcorrect\b/.test(normalized) && /\bor\b/.test(normalized)) {
		return false;
	}

	return true;
}

function hasNeedsAttentionVerdict(messageText: string): boolean {
	const lines = messageText.split(/\r?\n/);

	for (const line of lines) {
		const inlineMatch = line.match(/^\s*(?:[*-+]\s*)?(?:overall\s+)?verdict\s*:\s*(.+)$/i);
		if (inlineMatch && isNeedsAttentionVerdictValue(inlineMatch[1])) {
			return true;
		}
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const heading = parseMarkdownHeading(line);

		let verdictLevel: number | null = null;
		if (heading) {
			const normalizedHeading = heading.title.replace(/[*_`]/g, "").trim();
			if (!/^(?:overall\s+)?verdict\b/i.test(normalizedHeading)) {
				continue;
			}
			verdictLevel = heading.level;
		} else if (!/^\s*(?:overall\s+)?verdict\s*:?\s*$/i.test(line)) {
			continue;
		}

		for (let j = i + 1; j < lines.length; j++) {
			const verdictLine = lines[j];
			const nextHeading = parseMarkdownHeading(verdictLine);
			if (nextHeading) {
				const normalizedNextHeading = nextHeading.title.replace(/[*_`]/g, "").trim();
				if (verdictLevel === null || nextHeading.level <= verdictLevel) {
					break;
				}
				if (/^(review scope|findings|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(normalizedNextHeading)) {
					break;
				}
			}

			const trimmed = verdictLine.trim();
			if (!trimmed) {
				continue;
			}

			if (isNeedsAttentionVerdictValue(trimmed)) {
				return true;
			}

			if (/\bcorrect\b/i.test(normalizeVerdictValue(trimmed))) {
				break;
			}
		}
	}

	return false;
}

function hasBlockingReviewFindings(messageText: string): boolean {
	const lines = messageText.split(/\r?\n/);
	const bounds = getFindingsSectionBounds(lines);
	const candidateLines = bounds ? lines.slice(bounds.start, bounds.end) : lines;

	let inCodeFence = false;
	let foundTaggedFinding = false;
	for (const line of candidateLines) {
		if (/^\s*```/.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}
		if (inCodeFence) {
			continue;
		}

		if (!isLikelyFindingLine(line)) {
			continue;
		}

		foundTaggedFinding = true;
		if (/\[(P0|P1|P2)\]/i.test(line)) {
			return true;
		}
	}

	if (foundTaggedFinding) {
		return false;
	}

	return hasNeedsAttentionVerdict(messageText);
}

// Review 目标类型（与 Codex 的做法保持一致）
type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string }
	| { type: "pullRequest"; prNumber: number; baseBranch: string; title: string }
	| { type: "folder"; paths: string[] };

// Prompts（改编自 Codex）
const UNCOMMITTED_PROMPT =
	"审查当前的代码变更（staged、unstaged 和 untracked 文件），并给出按优先级排序的 findings。";

const LOCAL_CHANGES_REVIEW_INSTRUCTIONS =
	"同时纳入本分支的本地 working-tree 变更（staged、unstaged 和 untracked 文件）。使用 `git status --porcelain`、`git diff`、`git diff --staged` 和 `git ls-files --others --exclude-standard`，让本地修复也纳入本轮 review。";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"针对 base branch '{baseBranch}' 审查代码变更。本次比较的 merge base commit 是 {mergeBaseSha}。运行 `git diff {mergeBaseSha}` 查看相对于 {baseBranch} 的变更。给出按优先级排序、可操作的 findings。";

const BASE_BRANCH_PROMPT_FALLBACK =
	"针对 base branch '{branch}' 审查代码变更。先找到当前 branch 与 {branch} 上游之间的 merge diff，例如（`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"{branch}@{upstream}\")\"`），然后针对该 SHA 运行 `git diff`，查看会合并进 {branch} branch 的变更。给出按优先级排序、可操作的 findings。";

const COMMIT_PROMPT_WITH_TITLE =
	'审查 commit {sha}（"{title}"）引入的代码变更。给出按优先级排序、可操作的 findings。';

const COMMIT_PROMPT = "审查 commit {sha} 引入的代码变更。给出按优先级排序、可操作的 findings。";

const PULL_REQUEST_PROMPT =
	'针对 base branch \'{baseBranch}\' 审查 pull request #{prNumber}（"{title}"）。本次比较的 merge base commit 是 {mergeBaseSha}。运行 `git diff {mergeBaseSha}` 查看将要合并的变更。给出按优先级排序、可操作的 findings。';

const PULL_REQUEST_PROMPT_FALLBACK =
	'针对 base branch \'{baseBranch}\' 审查 pull request #{prNumber}（"{title}"）。先找到当前 branch 与 {baseBranch} 之间的 merge base（例如 `git merge-base HEAD {baseBranch}`），然后针对该 SHA 运行 `git diff`，查看将要合并的变更。给出按优先级排序、可操作的 findings。';

const FOLDER_REVIEW_PROMPT =
	"审查以下路径中的代码：{paths}。这是 snapshot review（不是 diff）。直接读取这些路径下的文件，并给出按优先级排序、可操作的 findings。";

// 详细的 review rubric（改编自 Codex 的 review_prompt.md）
const REVIEW_RUBRIC = `# 审查指南（Review Guidelines）

你现在是另一位工程师提交的代码变更的 code reviewer。

以下是判断该标记哪些问题的默认指南。它们不是最终结论 —— 如果你在其他地方（developer message、user message、文件，或下方追加的项目 review guidelines）遇到更具体的指南，以那些为准。

## 判断要标记什么

标记满足以下条件的问题：
1. 对代码的准确性、性能、安全性或可维护性有实质性影响。
2. 是离散且可操作的（不是笼统问题，也不是多个问题混在一起）。
3. 要求的标准不与代码库其余部分不一致。
4. 是在本次被 review 的变更中引入的（不是既有 bug）。
5. 作者知道后会愿意修复。
6. 不依赖关于代码库或作者意图的未明说假设。
7. 对代码其他部分有可证明的影响 —— 仅猜测某处变更可能影响另一部分是不够的，你必须指出可证明受影响的那些部分。
8. 明显不是作者有意为之的变更。
9. 对不可信的用户输入要格外小心，并遵循下面针对该场景的具体指南。
10. 除非有明确的边界级理由，把静默的本地错误恢复（尤其是 parsing/IO/network fallback）视为高信号的 review 候选。

## 不可信用户输入（Untrusted User Input）

1. 小心 open redirect，必须始终检查它们只跳转到可信域名（?next_page=...）
2. 始终标记未参数化的 SQL
3. 在接收用户提供 URL 输入的系统中，http fetch 必须防止访问本地资源（拦截 DNS resolver！）
4. 有选择时优先转义（escape），而不是清洗（sanitize）（例如 HTML escaping）

## 评论指南

1. 说清该问题为什么是个问题。
2. 恰当表达严重程度 - 不要夸大。
3. 简短 - 最多 1 段。
4. 代码片段控制在 3 行以内，用 inline code 或 code block 包裹。
5. 只在给出具体替换代码时使用 \`\`\`suggestion 块（行数最少；块内不要评论）。保留被替换行原有的前导空白。
6. 明确指出问题出现的场景/环境。
7. 用平和的语气 - 是有帮助的 AI assistant，而不是指责。
8. 面向快速理解，无需细读。
9. 避免过度恭维或无用的措辞，比如 "Great job..."。

## Review 优先级

1. 在末尾列出关键的非阻塞人工提示（migration、dependency 变动、auth/permissions、兼容性、破坏性操作）。
2. 优先简单直接的方案，而不是没有明确价值的 wrapper 或抽象。
3. 把 back pressure 处理视为系统稳定性的关键。
4. 运用系统级思考；标记会增加运维风险或 on-call 唤醒的变更。
5. 确保错误始终与错误码或稳定标识符比对，绝不比对错误消息。

## Fail-fast 错误处理（严格）

review 新增或修改的错误处理时，默认采用 fail-fast 行为。

1. 评估每一个新增或改动的 \`try/catch\`：指出什么可能失败，以及为什么在该层做本地处理是正确的。
2. 优先向上传播（propagation），而不是本地恢复。如果当前 scope 无法在保持正确性的前提下完全恢复，就重新抛出（可附带 context），而不是返回 fallback。
3. 标记会掩盖失败信号的 catch 块（例如返回 \`null\`/\`[]\`/\`false\`、吞掉 JSON parse 失败、log 后继续，或“尽力而为”的静默恢复）。
4. JSON parsing/decoding 默认应明确失败。只有在有明确兼容性要求且有清晰测试过的行为时，静默 fallback parsing 才可以接受。
5. 边界 handler（HTTP route、CLI entrypoint、supervisor）可以转换错误，但不得假装成功或静默降级。
6. 如果 catch 只是为了满足 lint/style 而没有真正的处理，把它当作 bug。
7. 不确定时，优先快速崩溃，而不是静默降级。

## 必须的人工提示（非阻塞，放在最后）

在 findings/verdict 之后，你必须在最后追加这一节：

## Human Reviewer Callouts (Non-Blocking)

仅包含适用的提示（不要 yes/no 行）：

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>

本节规则：
1. 这些是给人工 reviewer 的提示信息，不是修复项。
2. 除非存在独立缺陷，否则不要把它们放进 Findings。
3. 仅凭这些提示不得改变 verdict。
4. 只包含适用于被 review 变更的提示。
5. 每条输出的提示都要按所写内容保持 bold。
6. 如果都不适用，写 "- (none)"。

## 优先级

在标题中给每个 finding 标注优先级：
- [P0] - Drop everything to fix. 阻塞发布/运维。仅用于不依赖输入假设的普遍性问题。
- [P1] - Urgent. 应在下一个周期处理。
- [P2] - Normal. 最终要修复。
- [P3] - Low. Nice to have.

## 输出格式

以清晰、结构化的格式给出 findings：
1. 列出每个 finding，包含优先级标签、文件位置和说明。
2. findings 必须引用与实际 diff 重叠的位置 —— 不要标记既有代码。
3. 行引用尽量短（避免超过 5-10 行的范围；选取最合适的子范围）。
4. 给出 overall verdict："correct"（无阻塞问题）或 "needs attention"（存在阻塞问题）。
5. 忽略琐碎的 style 问题，除非它们妨碍理解或违反有文档记录的标准。
6. 不要生成完整的 PR 修复 —— 只标记问题，可选地给出简短的 suggestion 块。
7. 以必需的 "Human Reviewer Callouts (Non-Blocking)" 一节结尾，并包含所有适用的 bold 提示（不要 yes/no）。

输出作者知道后会修复的所有 findings。如果没有符合条件的问题，明确说明代码看起来没问题。不要停在第一个 finding - 列出每一个符合条件的问题。然后追加必需的 non-blocking 提示一节。`;

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

		const piStats = await fs.stat(piDir).catch(() => null);
		if (piStats?.isDirectory()) {
			const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
			if (guidelineStats?.isFile()) {
				try {
					const content = await fs.readFile(guidelinesPath, "utf8");
					const trimmed = content.trim();
					return trimmed ? trimmed : null;
				} catch {
					return null;
				}
			}
			return null;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

/**
 * 获取 HEAD 与某个 branch 的 merge base
 */
async function getMergeBase(
	pi: ExtensionAPI,
	branch: string,
): Promise<string | null> {
	try {
		// 先尝试获取 upstream tracking branch
		const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
			"rev-parse",
			"--abbrev-ref",
			`${branch}@{upstream}`,
		]);

		if (upstreamCode === 0 && upstream.trim()) {
			const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", upstream.trim()]);
			if (code === 0 && mergeBase.trim()) {
				return mergeBase.trim();
			}
		}

		// 回退为直接使用该 branch
		const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", branch]);
		if (code === 0 && mergeBase.trim()) {
			return mergeBase.trim();
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * 获取本地 branch 列表
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.filter((b) => b.trim());
}

/**
 * 获取最近的 commit 列表
 */
async function getRecentCommits(pi: ExtensionAPI, limit: number = 10): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("git", ["log", `--oneline`, `-n`, `${limit}`]);
	if (code !== 0) return [];

	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [sha, ...rest] = line.trim().split(" ");
			return { sha, title: rest.join(" ") };
		});
}

/**
 * 检查是否存在未提交变更（staged、unstaged 或 untracked）
 */
async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	return code === 0 && stdout.trim().length > 0;
}

/**
 * 检查是否存在会妨碍切换 branch 的变更
 * （tracked 文件的 staged 或 unstaged 变更 - untracked 文件无妨）
 */
async function hasPendingChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	// 检查 tracked 文件的 staged 或 unstaged 变更
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"], { cwd });
	if (code !== 0) throw new Error("Could not verify working tree changes before PR checkout.");

	// 过滤掉 untracked 文件（以 ?? 开头的行）
	const lines = stdout.trim().split("\n").filter((line) => line.trim());
	const trackedChanges = lines.filter((line) => !line.startsWith("??"));
	return trackedChanges.length > 0;
}

/**
 * PR checkout 前的工作区检查；有变更或无法确认时通知用户并返回 true。
 */
async function blockedByPendingChanges(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	try {
		if (!(await hasPendingChanges(pi, ctx.cwd))) return false;
		ctx.ui.notify("Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.", "error");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
	return true;
}

/**
 * 保留 URL 的仓库身份，checkout 前与 gh 当前仓库核对。
 */
function parsePrReference(ref: string): { number: number; repository?: string } | null {
	const trimmed = ref.trim();
	const url = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:\/(?:files|changes|commits|checks)(?:\/[^\s?#]*)?)?\/?(?:[?#]\S*)?$/i);
	const number = /^#?\d+$/.test(trimmed) ? Number(trimmed.replace(/^#/, "")) : url ? Number(url[2]) : NaN;
	return Number.isSafeInteger(number) && number > 0 ? { number, repository: url?.[1] } : null;
}

async function resolvePrNumber(pi: ExtensionAPI, ref: string, cwd: string): Promise<number> {
	const parsed = parsePrReference(ref);
	if (!parsed) throw new Error("Invalid PR reference. Enter a number or GitHub PR URL.");
	if (parsed.repository) {
		const current = await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd });
		if (current.code !== 0 || !current.stdout.trim()) throw new Error("Could not verify the current GitHub repository.");
		if (current.stdout.trim().toLowerCase() !== parsed.repository.toLowerCase()) {
			throw new Error(`PR belongs to ${parsed.repository}, but the current repository is ${current.stdout.trim()}. Open the matching checkout first.`);
		}
	}
	return parsed.number;
}

/**
 * 通过 GitHub CLI 获取 PR 信息
 */
async function getPrInfo(pi: ExtensionAPI, prNumber: number, cwd: string): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
	const { stdout, code } = await pi.exec("gh", [
		"pr", "view", String(prNumber),
		"--json", "baseRefName,title,headRefName",
	], { cwd });

	if (code !== 0) return null;

	try {
		const data = JSON.parse(stdout);
		return {
			baseBranch: data.baseRefName,
			title: data.title,
			headBranch: data.headRefName,
		};
	} catch {
		return null;
	}
}

/**
 * 使用 GitHub CLI checkout 一个 PR
 */
async function checkoutPr(pi: ExtensionAPI, prNumber: number, cwd: string): Promise<{ success: boolean; error?: string }> {
	const { stdout, stderr, code } = await pi.exec("gh", ["pr", "checkout", String(prNumber)], { cwd });

	if (code !== 0) {
		return { success: false, error: stderr || stdout || "Failed to check out PR" };
	}

	return { success: true };
}

/**
 * 获取当前 branch 名
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim();
	}
	return null;
}

/**
 * 获取默认 branch（main 或 master）
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	// 尝试从 remote HEAD 获取
	const { stdout, code } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace("origin/", "");
	}

	// 回退为检查 main 或 master 是否存在
	const branches = await getLocalBranches(pi);
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";

	return "main"; // 默认回退值
}

/**
 * 根据 target 构建 review prompt
 */
async function buildReviewPrompt(
	pi: ExtensionAPI,
	target: ReviewTarget,
	options?: { includeLocalChanges?: boolean },
): Promise<string> {
	const includeLocalChanges = options?.includeLocalChanges === true;

	switch (target.type) {
		case "uncommitted":
			return UNCOMMITTED_PROMPT;

		case "baseBranch": {
			const mergeBase = await getMergeBase(pi, target.branch);
			const basePrompt = mergeBase
				? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(/{mergeBaseSha}/g, mergeBase)
				: BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
			return includeLocalChanges ? `${basePrompt} ${LOCAL_CHANGES_REVIEW_INSTRUCTIONS}` : basePrompt;
		}

		case "commit":
			if (target.title) {
				return COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title);
			}
			return COMMIT_PROMPT.replace("{sha}", target.sha);

		case "pullRequest": {
			const mergeBase = await getMergeBase(pi, target.baseBranch);
			const basePrompt = mergeBase
				? PULL_REQUEST_PROMPT
						.replace(/{prNumber}/g, String(target.prNumber))
						.replace(/{title}/g, target.title)
						.replace(/{baseBranch}/g, target.baseBranch)
						.replace(/{mergeBaseSha}/g, mergeBase)
				: PULL_REQUEST_PROMPT_FALLBACK
						.replace(/{prNumber}/g, String(target.prNumber))
						.replace(/{title}/g, target.title)
						.replace(/{baseBranch}/g, target.baseBranch);
			return includeLocalChanges ? `${basePrompt} ${LOCAL_CHANGES_REVIEW_INSTRUCTIONS}` : basePrompt;
		}

		case "folder":
			return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
	}
}

/**
 * 获取 review target 面向用户的提示
 */
function getUserFacingHint(target: ReviewTarget): string {
	switch (target.type) {
		case "uncommitted":
			return "current changes";
		case "baseBranch":
			return `changes against '${target.branch}'`;
		case "commit": {
			const shortSha = target.sha.slice(0, 7);
			return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
		}

		case "pullRequest": {
			const shortTitle = target.title.length > 30 ? target.title.slice(0, 27) + "..." : target.title;
			return `PR #${target.prNumber}: ${shortTitle}`;
		}

		case "folder": {
			const joined = target.paths.join(", ");
			return joined.length > 40 ? `Folder: ${joined.slice(0, 37)}...` : `Folder: ${joined}`;
		}
	}
}

type AssistantSnapshot = {
	id: string;
	text: string;
	stopReason?: string;
};

function extractAssistantTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const textParts = content
		.filter(
			(part): part is { type: "text"; text: string } =>
				Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part),
		)
		.map((part) => part.text);
	return textParts.join("\n").trim();
}

function getLastAssistantSnapshot(ctx: ExtensionContext): AssistantSnapshot | null {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}

		const assistantMessage = entry.message as { content?: unknown; stopReason?: string };
		return {
			id: entry.id,
			text: extractAssistantTextContent(assistantMessage.content),
			stopReason: assistantMessage.stopReason,
		};
	}

	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoopTurnToStart(ctx: ExtensionContext, previousAssistantId?: string): Promise<boolean> {
	const deadline = Date.now() + REVIEW_LOOP_START_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const lastAssistantId = getLastAssistantSnapshot(ctx)?.id;
		if (!ctx.isIdle() || ctx.hasPendingMessages() || (lastAssistantId && lastAssistantId !== previousAssistantId)) {
			return true;
		}
		await sleep(REVIEW_LOOP_START_POLL_MS);
	}

	return false;
}

// 选择器用的 review preset 选项（保持此顺序稳定）
const REVIEW_PRESETS = [
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "baseBranch", label: "Review against a base branch", description: "(local)" },
	{ value: "commit", label: "Review a commit", description: "" },
	{ value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
	{ value: "folder", label: "Review a folder (or more)", description: "(snapshot, not diff)" },
] as const;

const TOGGLE_LOOP_FIXING_VALUE = "toggleLoopFixing" as const;
const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = "toggleCustomInstructions" as const;
type ReviewPresetValue =
	| (typeof REVIEW_PRESETS)[number]["value"]
	| typeof TOGGLE_LOOP_FIXING_VALUE
	| typeof TOGGLE_CUSTOM_INSTRUCTIONS_VALUE;

export default function reviewExtension(pi: ExtensionAPI) {
	function persistReviewSettings() {
		pi.appendEntry(REVIEW_SETTINGS_TYPE, {
			loopFixingEnabled: reviewLoopFixingEnabled,
			customInstructions: reviewCustomInstructions,
		});
	}

	function setReviewLoopFixingEnabled(enabled: boolean) {
		reviewLoopFixingEnabled = enabled;
		persistReviewSettings();
	}

	function setReviewCustomInstructions(instructions: string | undefined) {
		reviewCustomInstructions = instructions?.trim() || undefined;
		persistReviewSettings();
	}

	function applyAllReviewState(ctx: ExtensionContext) {
		applyReviewSettings(ctx);
		applyReviewState(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		applyAllReviewState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		applyAllReviewState(ctx);
	});

	/**
	 * 根据 git 状态确定智能默认的 review 类型
	 */
	async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
		// 优先级 1：存在未提交变更时，默认审查它们
		if (await hasUncommittedChanges(pi)) {
			return "uncommitted";
		}

		// 优先级 2：位于 feature branch（非默认 branch）时，默认采用 PR 风格 review
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		if (currentBranch && currentBranch !== defaultBranch) {
			return "baseBranch";
		}

		// 优先级 3：默认审查指定 commit
		return "commit";
	}

	/**
	 * 显示 review preset 选择器
	 */
	async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// 确定智能默认值（但不改变列表顺序）
		const smartDefault = await getSmartDefault();
		const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
			value: preset.value,
			label: preset.label,
			description: preset.description,
		}));
		const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

		while (true) {
			const customInstructionsLabel = reviewCustomInstructions
				? "Remove custom review instructions"
				: "Add custom review instructions";
			const customInstructionsDescription = reviewCustomInstructions
				? "(currently set)"
				: "(applies to all review modes)";
			const loopToggleLabel = reviewLoopFixingEnabled ? "Disable loop fixing" : "Enable loop fixing";
			const loopToggleDescription = reviewLoopFixingEnabled ? "(currently enabled)" : "(currently disabled)";
			const items: SelectItem[] = [
				...presetItems,
				{
					value: TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
					label: customInstructionsLabel,
					description: customInstructionsDescription,
				},
				{ value: TOGGLE_LOOP_FIXING_VALUE, label: loopToggleLabel, description: loopToggleDescription },
			];

			const result = await ctx.ui.custom<ReviewPresetValue | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Select a review preset"))));

				const selectList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});

				// 预选智能默认值，但不重排列表
				if (smartDefaultIndex >= 0) {
					selectList.setSelectedIndex(smartDefaultIndex);
				}

				selectList.onSelect = (item) => done(item.value as ReviewPresetValue);
				selectList.onCancel = () => done(null);

				container.addChild(selectList);
				container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to go back")));
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			if (!result) return null;

			if (result === TOGGLE_LOOP_FIXING_VALUE) {
				const nextEnabled = !reviewLoopFixingEnabled;
				setReviewLoopFixingEnabled(nextEnabled);
				ctx.ui.notify(nextEnabled ? "Loop fixing enabled" : "Loop fixing disabled", "info");
				continue;
			}

			if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
				if (reviewCustomInstructions) {
					setReviewCustomInstructions(undefined);
					ctx.ui.notify("Custom review instructions removed", "info");
					continue;
				}

				const customInstructions = await ctx.ui.editor(
					"Enter custom review instructions (applies to all review modes):",
					"",
				);

				if (!customInstructions?.trim()) {
					ctx.ui.notify("Custom review instructions not changed", "info");
					continue;
				}

				setReviewCustomInstructions(customInstructions);
				ctx.ui.notify("Custom review instructions saved", "info");
				continue;
			}

			// 处理每种 preset 类型
			switch (result) {
				case "uncommitted":
					return { type: "uncommitted" };

				case "baseBranch": {
					const target = await showBranchSelector(ctx);
					if (target) return target;
					break;
				}

				case "commit": {
					if (reviewLoopFixingEnabled) {
						ctx.ui.notify("Loop mode does not work with commit review.", "error");
						break;
					}
					const target = await showCommitSelector(ctx);
					if (target) return target;
					break;
				}

				case "folder": {
					const target = await showFolderInput(ctx);
					if (target) return target;
					break;
				}

				case "pullRequest": {
					const target = await showPrInput(ctx);
					if (target) return target;
					break;
				}

				default:
					return null;
			}
		}
	}

	/**
	 * 显示 base branch review 的 branch 选择器
	 */
	async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const branches = await getLocalBranches(pi);
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);

		// 永远不要将当前 branch 作为 base branch 提供（针对自身 review 没有意义）。
		const candidateBranches = currentBranch ? branches.filter((b) => b !== currentBranch) : branches;

		if (candidateBranches.length === 0) {
			ctx.ui.notify(
				currentBranch ? `No other branches found (current branch: ${currentBranch})` : "No branches found",
				"error",
			);
			return null;
		}

		// 排序时将默认 branch 放在首位
		const sortedBranches = candidateBranches.sort((a, b) => {
			if (a === defaultBranch) return -1;
			if (b === defaultBranch) return 1;
			return a.localeCompare(b);
		});

		const items: SelectItem[] = sortedBranches.map((branch) => ({
			value: branch,
			label: branch,
			description: branch === defaultBranch ? "(default)" : "",
		}));

		const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select base branch"))));

			const searchInput = new Input();
			container.addChild(searchInput);
			container.addChild(new Spacer(1));

			const listContainer = new Container();
			container.addChild(listContainer);
			container.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			let filteredItems = items;
			let selectList: SelectList | null = null;

			const updateList = () => {
				listContainer.clear();
				if (filteredItems.length === 0) {
					listContainer.addChild(new Text(theme.fg("warning", "  No matching branches")));
					selectList = null;
					return;
				}

				selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});

				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				listContainer.addChild(selectList);
			};

			const applyFilter = () => {
				const query = searchInput.getValue();
				filteredItems = query
					? fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`)
					: items;
				updateList();
			};

			applyFilter();

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (
						keybindings.matches(data, "tui.select.up") ||
						keybindings.matches(data, "tui.select.down") ||
						keybindings.matches(data, "tui.select.confirm") ||
						keybindings.matches(data, "tui.select.cancel")
					) {
						if (selectList) {
							selectList.handleInput(data);
						} else if (keybindings.matches(data, "tui.select.cancel")) {
							done(null);
						}
						tui.requestRender();
						return;
					}

					searchInput.handleInput(data);
					applyFilter();
					tui.requestRender();
				},
			};
		});

		if (!result) return null;
		return { type: "baseBranch", branch: result };
	}

	/**
	 * 显示 commit 选择器
	 */
	async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const commits = await getRecentCommits(pi, 20);

		if (commits.length === 0) {
			ctx.ui.notify("No commits found", "error");
			return null;
		}

		const items: SelectItem[] = commits.map((commit) => ({
			value: commit.sha,
			label: `${commit.sha.slice(0, 7)} ${commit.title}`,
			description: "",
		}));

		const result = await ctx.ui.custom<{ sha: string; title: string } | null>((tui, theme, keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Select commit to review"))));

			const searchInput = new Input();
			container.addChild(searchInput);
			container.addChild(new Spacer(1));

			const listContainer = new Container();
			container.addChild(listContainer);
			container.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			let filteredItems = items;
			let selectList: SelectList | null = null;

			const updateList = () => {
				listContainer.clear();
				if (filteredItems.length === 0) {
					listContainer.addChild(new Text(theme.fg("warning", "  No matching commits")));
					selectList = null;
					return;
				}

				selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});

				selectList.onSelect = (item) => {
					const commit = commits.find((c) => c.sha === item.value);
					if (commit) {
						done(commit);
					} else {
						done(null);
					}
				};
				selectList.onCancel = () => done(null);
				listContainer.addChild(selectList);
			};

			const applyFilter = () => {
				const query = searchInput.getValue();
				filteredItems = query
					? fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`)
					: items;
				updateList();
			};

			applyFilter();

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (
						keybindings.matches(data, "tui.select.up") ||
						keybindings.matches(data, "tui.select.down") ||
						keybindings.matches(data, "tui.select.confirm") ||
						keybindings.matches(data, "tui.select.cancel")
					) {
						if (selectList) {
							selectList.handleInput(data);
						} else if (keybindings.matches(data, "tui.select.cancel")) {
							done(null);
						}
						tui.requestRender();
						return;
					}

					searchInput.handleInput(data);
					applyFilter();
					tui.requestRender();
				},
			};
		});

		if (!result) return null;
		return { type: "commit", sha: result.sha, title: result.title };
	}


	function parseReviewPaths(value: string): string[] {
		return value
			.split(/\s+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	/**
	 * 显示目录输入
	 */
	async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const result = await ctx.ui.editor(
			"Enter directories/files to review (space-separated or one per line):",
			".",
		);

		if (!result?.trim()) return null;
		const paths = parseReviewPaths(result);
		if (paths.length === 0) return null;

		return { type: "folder", paths };
	}

	/**
	 * 显示 PR 输入并处理 checkout
	 */
	async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// 先检查会妨碍切换 branch 的待处理变更
		if (await blockedByPendingChanges(pi, ctx)) return null;

		// 从用户获取 PR 引用
		const prRef = await ctx.ui.editor(
			"Enter a PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
			"",
		);

		if (!prRef?.trim()) return null;
		return handlePrCheckout(ctx, prRef);
	}

	/**
	 * 执行 review
	 */
	async function executeReview(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
		useFreshSession: boolean,
		options?: { includeLocalChanges?: boolean; extraInstruction?: string },
	): Promise<boolean> {
		// 检查是否已经在 review 中
		if (reviewOriginId) {
			ctx.ui.notify("Already in a review. Use /end-review to finish first.", "warning");
			return false;
		}

		// 处理 fresh session 模式
		if (useFreshSession) {
			// 保存当前位置（我们要返回的位置）。
			// 空 session 中还没有 leaf，因此先创建一个轻量 anchor。
			let originId = ctx.sessionManager.getLeafId() ?? undefined;
			if (!originId) {
				pi.appendEntry(REVIEW_ANCHOR_TYPE, { createdAt: new Date().toISOString() });
				originId = ctx.sessionManager.getLeafId() ?? undefined;
			}
			if (!originId) {
				ctx.ui.notify("Failed to determine review origin.", "error");
				return false;
			}
			reviewOriginId = originId;

			// 保留本地副本，以免导航期间的 session_tree 事件把它清掉
			const lockedOriginId = originId;

			// 找到 session 中的第一条 user message。
			// 如果不存在（例如全新 session），则停留在当前 leaf。
			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find(
				(e) => e.type === "message" && e.message.role === "user",
			);

			if (firstUserMessage) {
				// 导航到第一条 user message，从该点创建新 branch
				// 标记为 "code-review"，以便在 tree 中可见
				try {
					const result = await ctx.navigateTree(firstUserMessage.id, { summarize: false, label: "code-review" });
					if (result.cancelled) {
						reviewOriginId = undefined;
						return false;
					}
				} catch (error) {
					// 导航失败时清理状态
					reviewOriginId = undefined;
					ctx.ui.notify(`Failed to start review: ${error instanceof Error ? error.message : String(error)}`, "error");
					return false;
				}

				// 清空编辑器（导航到 user message 会将该消息文本填入）
				ctx.ui.setEditorText("");
			}

			// 导航事件之后恢复 origin（session_tree 可能会重置它）
			reviewOriginId = lockedOriginId;

			// 显示表示 review 已激活的 widget
			setReviewWidget(ctx, true);

			// 持久化 review 状态，以便 tree 导航可以恢复/重置它
			pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId: lockedOriginId });
		}

		const prompt = await buildReviewPrompt(pi, target, {
			includeLocalChanges: options?.includeLocalChanges === true,
		});
		const hint = getUserFacingHint(target);
		const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

		// 将 review rubric 与具体 prompt 组合
		let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\n请围绕以下重点执行 code review：\n\n${prompt}`;

		if (reviewCustomInstructions) {
			fullPrompt += `\n\n共享的自定义 review 说明（应用于所有 review）：\n\n${reviewCustomInstructions}`;
		}

		if (options?.extraInstruction?.trim()) {
			fullPrompt += `\n\n用户提供的附加 review 说明：\n\n${options.extraInstruction.trim()}`;
		}

		if (projectGuidelines) {
			fullPrompt += `\n\n本项目有额外的 code review 说明：\n\n${projectGuidelines}`;
		}

		const modeHint = useFreshSession ? "（fresh session）" : "";
		ctx.ui.notify(`Starting review: ${hint}${modeHint}`, "info");

		// 作为触发一轮对话的 user message 发送
		pi.sendUserMessage(fullPrompt);
		return true;
	}

	/**
	 * 解析直接调用时的命令参数
	 * 返回 target，或需要异步处理的 PR 特殊标记
	 */
	type ParsedReviewArgs = {
		target: ReviewTarget | { type: "pr"; ref: string } | null;
		extraInstruction?: string;
		error?: string;
	};

	function tokenizeArgs(value: string): string[] {
		const tokens: string[] = [];
		let current = "";
		let quote: '"' | "'" | null = null;

		for (let i = 0; i < value.length; i++) {
			const char = value[i];

			if (quote) {
				if (char === "\\" && i + 1 < value.length) {
					current += value[i + 1];
					i += 1;
					continue;
				}
				if (char === quote) {
					quote = null;
					continue;
				}
				current += char;
				continue;
			}

			if (char === '"' || char === "'") {
				quote = char;
				continue;
			}

			if (/\s/.test(char)) {
				if (current.length > 0) {
					tokens.push(current);
					current = "";
				}
				continue;
			}

			current += char;
		}

		if (current.length > 0) {
			tokens.push(current);
		}

		return tokens;
	}

	function parseArgs(args: string | undefined): ParsedReviewArgs {
		if (!args?.trim()) return { target: null };

		const rawParts = tokenizeArgs(args.trim());
		const parts: string[] = [];
		let extraInstruction: string | undefined;

		for (let i = 0; i < rawParts.length; i++) {
			const part = rawParts[i];
			if (part === "--extra") {
				const next = rawParts[i + 1];
				if (!next) {
					return { target: null, error: "Missing value for --extra" };
				}
				extraInstruction = next;
				i += 1;
				continue;
			}

			if (part.startsWith("--extra=")) {
				extraInstruction = part.slice("--extra=".length);
				continue;
			}

			parts.push(part);
		}

		if (parts.length === 0) {
			return { target: null, extraInstruction };
		}

		const subcommand = parts[0]?.toLowerCase();

		switch (subcommand) {
			case "uncommitted":
				return { target: { type: "uncommitted" }, extraInstruction };

			case "branch": {
				const branch = parts[1];
				if (!branch) return { target: null, extraInstruction };
				return { target: { type: "baseBranch", branch }, extraInstruction };
			}

			case "commit": {
				const sha = parts[1];
				if (!sha) return { target: null, extraInstruction };
				const title = parts.slice(2).join(" ") || undefined;
				return { target: { type: "commit", sha, title }, extraInstruction };
			}


			case "folder": {
				const paths = parseReviewPaths(parts.slice(1).join(" "));
				if (paths.length === 0) return { target: null, extraInstruction };
				return { target: { type: "folder", paths }, extraInstruction };
			}

			case "pr": {
				const ref = parts[1];
				if (!ref) return { target: null, extraInstruction };
				return { target: { type: "pr", ref }, extraInstruction };
			}

			default:
				return { target: null, extraInstruction };
		}
	}

	/**
	 * 处理 PR checkout 并返回 ReviewTarget（失败时返回 null）
	 */
	async function handlePrCheckout(ctx: ExtensionContext, ref: string): Promise<ReviewTarget | null> {
		// 先检查待处理变更
		if (await blockedByPendingChanges(pi, ctx)) return null;

		let prNumber: number;
		try {
			prNumber = await resolvePrNumber(pi, ref, ctx.cwd);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return null;
		}

		// 获取 PR 信息
		ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
		const prInfo = await getPrInfo(pi, prNumber, ctx.cwd);

		if (!prInfo) {
			ctx.ui.notify(`Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`, "error");
			return null;
		}

		// Checkout 该 PR
		if (await blockedByPendingChanges(pi, ctx)) return null;
		ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
		const checkoutResult = await checkoutPr(pi, prNumber, ctx.cwd);

		if (!checkoutResult.success) {
			ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
			return null;
		}

		ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");

		return {
			type: "pullRequest",
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	function isLoopCompatibleTarget(target: ReviewTarget): boolean {
		if (target.type !== "commit") {
			return true;
		}

		return false;
	}

	async function runLoopFixingReview(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
		extraInstruction?: string,
	): Promise<void> {
		if (reviewLoopInProgress) {
			ctx.ui.notify("Loop fixing review is already running.", "warning");
			return;
		}

		reviewLoopInProgress = true;
		setReviewWidget(ctx, Boolean(reviewOriginId));
		try {
			ctx.ui.notify(
				"Loop fixing enabled: using Empty branch mode until no blocking findings remain.",
				"info",
			);

			for (let pass = 1; pass <= REVIEW_LOOP_MAX_ITERATIONS; pass++) {
				const reviewBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
				const started = await executeReview(ctx, target, true, {
					includeLocalChanges: true,
					extraInstruction,
				});
				if (!started) {
					ctx.ui.notify("Loop fixing stopped before starting the review pass.", "warning");
					return;
				}

				const reviewTurnStarted = await waitForLoopTurnToStart(ctx, reviewBaselineAssistantId);
				if (!reviewTurnStarted) {
					ctx.ui.notify("Loop fixing stopped: review pass did not start in time.", "error");
					return;
				}

				await ctx.waitForIdle();

				const reviewSnapshot = getLastAssistantSnapshot(ctx);
				if (!reviewSnapshot || reviewSnapshot.id === reviewBaselineAssistantId) {
					ctx.ui.notify("Loop fixing stopped: could not read the review result.", "warning");
					return;
				}

				if (reviewSnapshot.stopReason === "aborted") {
					ctx.ui.notify("Loop fixing stopped: review was aborted.", "warning");
					return;
				}

				if (reviewSnapshot.stopReason === "error") {
					ctx.ui.notify("Loop fixing stopped: review failed with an error.", "error");
					return;
				}

				if (reviewSnapshot.stopReason === "length") {
					ctx.ui.notify("Loop fixing stopped: review output was truncated (stopReason=length).", "warning");
					return;
				}

				if (!hasBlockingReviewFindings(reviewSnapshot.text)) {
					const finalized = await executeEndReviewAction(ctx, "returnAndSummarize", {
						showSummaryLoader: true,
						notifySuccess: false,
					});
					if (finalized !== "ok") {
						return;
					}

					ctx.ui.notify("Loop fixing complete: no blocking findings remain.", "info");
					return;
				}

				ctx.ui.notify(`Loop fixing pass ${pass}: found blocking findings, returning to fix them...`, "info");

				const fixBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
				const sentFixPrompt = await executeEndReviewAction(ctx, "returnAndFix", {
					showSummaryLoader: true,
					notifySuccess: false,
				});
				if (sentFixPrompt !== "ok") {
					return;
				}

				const fixTurnStarted = await waitForLoopTurnToStart(ctx, fixBaselineAssistantId);
				if (!fixTurnStarted) {
					ctx.ui.notify("Loop fixing stopped: fix pass did not start in time.", "error");
					return;
				}

				await ctx.waitForIdle();

				const fixSnapshot = getLastAssistantSnapshot(ctx);
				if (!fixSnapshot || fixSnapshot.id === fixBaselineAssistantId) {
					ctx.ui.notify("Loop fixing stopped: could not read the fix pass result.", "warning");
					return;
				}
				if (fixSnapshot.stopReason === "aborted") {
					ctx.ui.notify("Loop fixing stopped: fix pass was aborted.", "warning");
					return;
				}
				if (fixSnapshot.stopReason === "error") {
					ctx.ui.notify("Loop fixing stopped: fix pass failed with an error.", "error");
					return;
				}
				if (fixSnapshot.stopReason === "length") {
					ctx.ui.notify("Loop fixing stopped: fix pass output was truncated (stopReason=length).", "warning");
					return;
				}
			}

			ctx.ui.notify(
				`Loop fixing stopped after ${REVIEW_LOOP_MAX_ITERATIONS} passes (safety limit reached).`,
				"warning",
			);
		} finally {
			reviewLoopInProgress = false;
			setReviewWidget(ctx, Boolean(reviewOriginId));
		}
	}

	// 注册 /review 命令
	pi.registerCommand("review", {
		description: "Review code changes (PR, uncommitted, branch, commit, or folder)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Review requires interactive mode", "error");
				return;
			}

			if (reviewLoopInProgress) {
				ctx.ui.notify("Loop fixing review is already running.", "warning");
				return;
			}

			// 检查是否已经在 review 中
			if (reviewOriginId) {
				ctx.ui.notify("Already in a review. Use /end-review to finish first.", "warning");
				return;
			}

			// 检查是否处于 git 仓库中
			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (code !== 0) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			// 尝试解析直接参数
			let target: ReviewTarget | null = null;
			let fromSelector = false;
			let extraInstruction: string | undefined;
			const parsed = parseArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			extraInstruction = parsed.extraInstruction?.trim() || undefined;

			if (parsed.target) {
				if (parsed.target.type === "pr") {
					// 处理 PR checkout（异步操作）
					target = await handlePrCheckout(ctx, parsed.target.ref);
					if (!target) {
					ctx.ui.notify("PR review failed. Returning to review menu.", "warning");
					}
				} else {
					target = parsed.target;
				}
			}

			// 无参数或参数无效时，显示选择器
			if (!target) {
				fromSelector = true;
			}

			while (true) {
				if (!target && fromSelector) {
					target = await showReviewSelector(ctx);
				}

				if (!target) {
				ctx.ui.notify("Review cancelled", "info");
					return;
				}

				if (reviewLoopFixingEnabled && !isLoopCompatibleTarget(target)) {
				ctx.ui.notify("Loop mode does not work with commit review.", "error");
					if (fromSelector) {
						target = null;
						continue;
					}
					return;
				}

				if (reviewLoopFixingEnabled) {
					await runLoopFixingReview(ctx, target, extraInstruction);
					return;
				}

				// 确定是否使用 fresh session 模式
				// 检查是否为全新 session（尚无消息）
				const entries = ctx.sessionManager.getEntries();
				const messageCount = entries.filter((e) => e.type === "message").length;

				// 在空 session 中默认使用 fresh review 模式，以便 /end-review 行为一致。
				let useFreshSession = messageCount === 0;

				if (messageCount > 0) {
					// 已有 session - 询问用户想要哪种模式
					const choice = await ctx.ui.select("Start review in:", ["Empty branch", "Current session"]);

					if (choice === undefined) {
						if (fromSelector) {
							target = null;
							continue;
						}
						ctx.ui.notify("Review cancelled", "info");
						return;
					}

					useFreshSession = choice === "Empty branch";
				}

				await executeReview(ctx, target, useFreshSession, { extraInstruction });
				return;
			}
		},
	});

	// review summary 的自定义 prompt - 侧重保留可操作的 findings
	const REVIEW_SUMMARY_PROMPT = `我们正在离开 code-review 分支，回到主 coding 分支。
创建一个结构化的 handoff，可立即用于实施修复。

你必须总结本分支中发生的 review，以便 findings 能被处理。
不要遗漏 finding：包含所有已识别的可操作问题。

必需章节（按顺序）：

## Review Scope
- 审查了什么（文件/路径、变更和 scope）

## Verdict
- "correct" 或 "needs attention"

## Findings
对每个 finding，包含：
- 优先级标签（[P0]..[P3]）和简短标题
- 文件位置（\`path/to/file.ext:line\`）
- 为什么重要（简短）
- 应该改什么（简短、可操作）

## Fix Queue
1. 有序的实施清单（最高优先级在前）

## Constraints & Preferences
- review 期间提到的任何 constraints 或 preferences
- 或 "(none)"

## Human Reviewer Callouts (Non-Blocking)
只包含适用的提示（不要 yes/no 行）：
- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>

如果都不适用，写 "- (none)"。

这些是给人工的提示信息，本身不是修复项。

在可用的情况下保留确切的文件路径、函数名和错误消息。`;

	const REVIEW_FIX_FINDINGS_PROMPT = `使用本 session 中最新的 review summary，立即实施 review findings。

说明：
1. 把 summary 的 Findings/Fix Queue 当作清单。
2. 按优先级修复：P0、P1，然后 P2（P3 如果快速且安全也一并处理）。
3. 如果某个 finding 无效/已修复/当前无法处理，简要说明原因并继续。
4. 把 "Human Reviewer Callouts (Non-Blocking)" 仅当作提示信息；除非另有明确 finding，否则不要把它们转成修复任务。
5. 遵循 fail-fast 错误处理：不要添加本地 catch/fallback 恢复，除非该 scope 是明确可安全转换失败的边界。
6. 如果你新增或保留 \`try/catch\`，说明预期的失败模式，并要么附带 context 重新抛出，要么返回边界安全的错误响应。
7. JSON parsing/decoding 默认应明确失败；避免静默 fallback parsing。
8. 在可行的情况下，对改动的代码运行相关测试/检查。
9. 结尾给出：已修复项、延后/跳过的项（附原因），以及验证结果。`;

	type EndReviewAction = "returnOnly" | "returnAndFix" | "returnAndSummarize";
	type EndReviewActionResult = "ok" | "cancelled" | "error";
	type EndReviewActionOptions = {
		showSummaryLoader?: boolean;
		notifySuccess?: boolean;
	};

	function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
		if (reviewOriginId) {
			return reviewOriginId;
		}

		const state = getReviewState(ctx);
		if (state?.active && state.originId) {
			reviewOriginId = state.originId;
			return reviewOriginId;
		}

		if (state?.active) {
			setReviewWidget(ctx, false);
			pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
			ctx.ui.notify("Review state was missing origin info; cleared review status.", "warning");
		}

		return undefined;
	}

	function clearReviewState(ctx: ExtensionContext) {
		setReviewWidget(ctx, false);
		reviewOriginId = undefined;
		pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
	}

	async function navigateWithSummary(
		ctx: ExtensionCommandContext,
		originId: string,
		showLoader: boolean,
	): Promise<{ cancelled: boolean; error?: string } | null> {
		if (showLoader && ctx.hasUI) {
			return ctx.ui.custom<{ cancelled: boolean; error?: string } | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Returning and summarizing review branch...");
				loader.onAbort = () => done(null);

				ctx.navigateTree(originId, {
					summarize: true,
					customInstructions: REVIEW_SUMMARY_PROMPT,
					replaceInstructions: true,
				})
					.then(done)
					.catch((err) => done({ cancelled: false, error: err instanceof Error ? err.message : String(err) }));

				return loader;
			});
		}

		try {
			return await ctx.navigateTree(originId, {
				summarize: true,
				customInstructions: REVIEW_SUMMARY_PROMPT,
				replaceInstructions: true,
			});
		} catch (error) {
			return { cancelled: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async function executeEndReviewAction(
		ctx: ExtensionCommandContext,
		action: EndReviewAction,
		options: EndReviewActionOptions = {},
	): Promise<EndReviewActionResult> {
		const originId = getActiveReviewOrigin(ctx);
		if (!originId) {
			if (!getReviewState(ctx)?.active) {
			ctx.ui.notify("Not in a review branch (use /review first, or review was started in current session mode)", "info");
			}
			return "error";
		}

		const notifySuccess = options.notifySuccess ?? true;

		if (action === "returnOnly") {
			try {
				const result = await ctx.navigateTree(originId, { summarize: false });
				if (result.cancelled) {
				ctx.ui.notify("Navigation cancelled. Use /end-review to try again.", "info");
					return "cancelled";
				}
			} catch (error) {
			ctx.ui.notify(`Failed to return: ${error instanceof Error ? error.message : String(error)}`, "error");
				return "error";
			}

			clearReviewState(ctx);
			if (notifySuccess) {
			ctx.ui.notify("Review complete! Returned to original position.", "info");
			}
			return "ok";
		}

		const summaryResult = await navigateWithSummary(ctx, originId, options.showSummaryLoader ?? false);
		if (summaryResult === null) {
		ctx.ui.notify("Summarization cancelled. Use /end-review to try again.", "info");
			return "cancelled";
		}

		if (summaryResult.error) {
		ctx.ui.notify(`Summarization failed: ${summaryResult.error}`, "error");
			return "error";
		}

		if (summaryResult.cancelled) {
		ctx.ui.notify("Navigation cancelled. Use /end-review to try again.", "info");
			return "cancelled";
		}

		clearReviewState(ctx);

		if (action === "returnAndSummarize") {
			if (!ctx.ui.getEditorText().trim()) {
				ctx.ui.setEditorText("Act on the review findings");
			}
			if (notifySuccess) {
				ctx.ui.notify("Review complete! Returned and summarized.", "info");
			}
			return "ok";
		}

		pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" });
		if (notifySuccess) {
		ctx.ui.notify("Review complete! Returned and queued a follow-up to fix findings.", "info");
		}
		return "ok";
	}

	async function runEndReview(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("End-review requires interactive mode", "error");
			return;
		}

		if (reviewLoopInProgress) {
			ctx.ui.notify("Loop fixing review is running. Wait for it to finish.", "info");
			return;
		}

		if (endReviewInProgress) {
			ctx.ui.notify("/end-review is already running", "info");
			return;
		}

		endReviewInProgress = true;
		try {
			const choice = await ctx.ui.select("Finish review:", [
				"Return only",
				"Return and fix findings",
				"Return and summarize",
			]);

			if (choice === undefined) {
				ctx.ui.notify("Cancelled. Use /end-review to try again.", "info");
				return;
			}

			const action: EndReviewAction =
				choice === "Return and fix findings"
					? "returnAndFix"
					: choice === "Return and summarize"
						? "returnAndSummarize"
						: "returnOnly";

			await executeEndReviewAction(ctx, action, {
				showSummaryLoader: true,
				notifySuccess: true,
			});
		} finally {
			endReviewInProgress = false;
		}
	}

	// 注册 /end-review 命令
	pi.registerCommand("end-review", {
		description: "Complete review and return to original position",
		handler: async (_args, ctx) => {
			await runEndReview(ctx);
		},
	});
}
