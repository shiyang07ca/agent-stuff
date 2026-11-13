import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunStatus } from "./lifecycle.ts";

export const SUBAGENT_SERVICE_CHANNEL = "monte-pi:subagent:run";
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export type SubagentRole = "investigation" | "implementation" | "review";
export type SubagentProfile = string;

export interface SubagentContinuation {
	continueRunId: string;
	task: string;
	tools: string[];
}

export interface SubagentInvocation {
	task: string;
	cwd?: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	role?: SubagentRole;
	tools?: string[];
	orchestrationChild?: boolean;
	profile?: SubagentProfile;
}

export interface SubagentRunDetails {
	runId?: string;
	childSessionId?: string;
	resumedFrom?: string;
	profile?: SubagentProfile;
	status: RunStatus;
	task: string;
	cwd: string;
	tmuxSession: string;
	attachCommand: string;
	captureCommand: string;
	killCommand: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	role?: SubagentRole;
	pane?: string;
	/** orchestration run 的原始模型报告；展示输出另行截断。 */
	output?: string;
	error?: string;
	cleanupWarning?: string;
	stopReason?: string;
	sessionFile?: string;
	startedAt?: number;
	finishedAt?: number;
	queuedAt?: number;
	lastToolAt?: number;
	lastTool?: string;
	resultPath?: string;
	statePath?: string;
	stopConfirmed?: boolean;
}

export interface SubagentRunResult {
	content: Array<{ type: "text"; text: string }>;
	details: SubagentRunDetails;
}

export interface SubagentServiceState {
	writable: boolean;
	reason?: string;
}

export interface SubagentStatusRequest {
	kind: "status";
	ctx: ExtensionContext;
	/** 用 service 持有的异步状态检查同步回应。 */
	respond: (state: Promise<SubagentServiceState>) => void;
}

export interface SubagentServiceRequest {
	kind: "run";
	requestId: string;
	invocation: SubagentInvocation | SubagentContinuation;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentRunDetails }) => void;
	/** 在开始工作前同步调用。返回 false 表示调用方拒绝转移所有权。 */
	accept?: () => boolean;
	resolve: (result: SubagentRunResult) => void;
	reject: (error: unknown) => void;
}

export function isSubagentContinuation(value: unknown): value is SubagentContinuation {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SubagentContinuation>;
	return typeof candidate.continueRunId === "string" && typeof candidate.task === "string" &&
		Array.isArray(candidate.tools) && candidate.tools.length > 0 &&
		Array.from(candidate.tools).every((tool) => typeof tool === "string" && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(tool));
}

export function isSubagentInvocation(value: unknown): value is SubagentInvocation {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SubagentInvocation>;
	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return (
		typeof candidate.task === "string" &&
		typeof candidate.provider === "string" &&
		typeof candidate.model === "string" &&
		typeof candidate.thinking === "string" &&
		thinkingLevels.includes(candidate.thinking) &&
		(candidate.cwd === undefined || typeof candidate.cwd === "string") &&
		(candidate.role === undefined || ["investigation", "implementation", "review"].includes(candidate.role)) &&
		(candidate.tools === undefined || (Array.isArray(candidate.tools) && candidate.tools.every((tool) => typeof tool === "string"))) &&
		(candidate.orchestrationChild === undefined || typeof candidate.orchestrationChild === "boolean") &&
		(candidate.profile === undefined || (typeof candidate.profile === "string" && candidate.profile.length > 0))
	);
}
