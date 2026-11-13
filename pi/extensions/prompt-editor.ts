import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";

// =============================================================================
// Modes
// =============================================================================

type ModeName = string;
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	/**
	 * 可选的 theme 颜色 token，用于编辑器边框。
	 * 未设置时，边框颜色由当前 thinking level 推导。
	 */
	color?: string;
};

type ModesFile = {
	version: 1;
	currentMode: ModeName;
	modes: Record<ModeName, ModeSpec>;
};

// 只有 "default" 是强制/内置模式。其余只是初始建议，可以重命名/删除。
const DEFAULT_MODE_ORDER = ["default"] as const;
const CUSTOM_MODE_NAME = "custom" as const;

function expandUserPath(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function getGlobalAgentDir(): string {
	// 尽量复刻 pi-coding-agent 的 getAgentDir() 行为（尽力而为）。
	// 规范实现见 pi-mono/packages/coding-agent/src/config.ts
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return expandUserPath(env);
	return path.join(os.homedir(), ".pi", "agent");
}

function getGlobalModesPath(): string {
	return path.join(getGlobalAgentDir(), "modes.json");
}

function getProjectModesPath(cwd: string): string {
	return path.join(cwd, ".pi", "modes.json");
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function ensureDirForFile(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function getMtimeMs(p: string): Promise<number | null> {
	try {
		const st = await fs.stat(p);
		return st.mtimeMs;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockPathForFile(filePath: string): string {
	// 将 lock 文件放在 json 旁边，以便跨进程生效。
	return `${filePath}.lock`;
}

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = getLockPathForFile(filePath);
	await ensureDirForFile(lockPath);

	const start = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			try {
				// 尽力记录元数据，便于调试 stale lock。
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
					"utf8"
				);
			} catch {
				// 忽略
			}

			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await fs.unlink(lockPath).catch(() => {});
			}
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			// 若 lock 看起来已失效（崩溃），则将其清除。
			try {
				const st = await fs.stat(lockPath);
				if (Date.now() - st.mtimeMs > 30_000) {
					await fs.unlink(lockPath);
					continue;
				}
			} catch {
				// 忽略
			}

			if (Date.now() - start > 5_000) {
				// 不要永远卡住 UI。
				throw new Error(`Timed out waiting for lock: ${lockPath}`);
			}
			await sleep(40 + Math.random() * 80);
		}
	}
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
	await ensureDirForFile(filePath);

	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`);

	await fs.writeFile(tmpPath, content, "utf8");

	try {
		// POSIX：原子替换。
		await fs.rename(tmpPath, filePath);
	} catch (err: any) {
		// Windows：rename 无法覆盖。
		if (err?.code === "EEXIST" || err?.code === "EPERM") {
			await fs.unlink(filePath).catch(() => {});
			await fs.rename(tmpPath, filePath);
		} else {
			// 尽力清理
			await fs.unlink(tmpPath).catch(() => {});
			throw err;
		}
	}
}

function cloneModesFile(file: ModesFile): ModesFile {
	// 这里用基于 JSON 的克隆即可（数据结构小且为普通对象）。
	return JSON.parse(JSON.stringify(file)) as ModesFile;
}

type ModeSpecPatch = {
	provider?: string | null;
	modelId?: string | null;
	thinkingLevel?: ThinkingLevel | null;
	color?: string | null;
};

type ModesPatch = {
	currentMode?: ModeName;
	modes?: Record<ModeName, ModeSpecPatch | null>;
};

function computeModesPatch(base: ModesFile, next: ModesFile, includeCurrentMode: boolean): ModesPatch | null {
	const patch: ModesPatch = {};

	if (includeCurrentMode && base.currentMode !== next.currentMode) {
		patch.currentMode = next.currentMode;
	}

	const keys = new Set([...Object.keys(base.modes), ...Object.keys(next.modes)]);
	const modesPatch: Record<ModeName, ModeSpecPatch | null> = {};

	for (const k of keys) {
		const a = base.modes[k];
		const b = next.modes[k];

		if (!b) {
			if (a) modesPatch[k] = null;
			continue;
		}
		if (!a) {
			modesPatch[k] = { ...b };
			continue;
		}

		const diff: ModeSpecPatch = {};
		const fields: (keyof ModeSpec)[] = ["provider", "modelId", "thinkingLevel", "color"];
		for (const f of fields) {
			const av = a[f];
			const bv = b[f];
			if (av !== bv) {
				(diff as any)[f] = bv === undefined ? null : bv;
			}
		}
		if (Object.keys(diff).length > 0) {
			modesPatch[k] = diff;
		}
	}

	if (Object.keys(modesPatch).length > 0) {
		patch.modes = modesPatch;
	}

	if (!patch.modes && patch.currentMode === undefined) return null;
	return patch;
}

function applyModesPatch(target: ModesFile, patch: ModesPatch): void {
	if (patch.currentMode !== undefined) {
		target.currentMode = patch.currentMode;
	}

	if (!patch.modes) return;
	for (const [mode, specPatch] of Object.entries(patch.modes)) {
		if (specPatch === null) {
			delete target.modes[mode];
			continue;
		}

		const targetSpec: Record<string, unknown> = (target.modes[mode] ??= {}) as Record<string, unknown>;
		for (const [k, v] of Object.entries(specPatch)) {
			if (v === null || v === undefined) {
				delete targetSpec[k];
			} else {
				targetSpec[k] = v;
			}
		}
	}
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	if (typeof level !== "string") return undefined;
	const v = level as ThinkingLevel;
	return ALL_THINKING_LEVELS.includes(v) ? v : undefined;
}

function sanitizeModeSpec(spec: unknown): ModeSpec {
	const obj = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
	return {
		provider: typeof obj.provider === "string" ? obj.provider : undefined,
		modelId: typeof obj.modelId === "string" ? obj.modelId : undefined,
		thinkingLevel: normalizeThinkingLevel(obj.thinkingLevel),
		color: typeof obj.color === "string" ? obj.color : undefined,
	};
}

function createDefaultModes(ctx: ExtensionContext, pi: ExtensionAPI): ModesFile {
	const currentModel = ctx.model;
	const currentThinking = pi.getThinkingLevel();

	const base: ModeSpec = {
		provider: currentModel?.provider,
		modelId: currentModel?.id,
		thinkingLevel: currentThinking,
	};

	return {
		version: 1,
		currentMode: "default",
		modes: {
			// 强制默认模式
			default: { ...base },
			// 便捷模式（用户可删除/重命名）
			fast: { ...base, thinkingLevel: "off" },
		},
	};
}

function ensureDefaultModeEntries(file: ModesFile, ctx: ExtensionContext, pi: ExtensionAPI): void {
	for (const name of DEFAULT_MODE_ORDER) {
		if (!file.modes[name]) {
			const defaults = createDefaultModes(ctx, pi);
			file.modes[name] = defaults.modes[name];
		}
	}

	// "custom" 是 overlay 模式；绝不应将其视为可持久化的合法 current mode。
	if (file.currentMode === CUSTOM_MODE_NAME) {
		file.currentMode = "" as any;
	}

	if (!file.currentMode || !(file.currentMode in file.modes) || file.currentMode === CUSTOM_MODE_NAME) {
		const first = Object.keys(file.modes).find((k) => k !== CUSTOM_MODE_NAME);
		file.currentMode = file.modes.default ? "default" : first || "default";
	}
}

async function loadModesFile(filePath: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<ModesFile> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const currentMode = typeof parsed.currentMode === "string" ? parsed.currentMode : "default";
		const modesRaw = parsed.modes && typeof parsed.modes === "object" ? (parsed.modes as Record<string, unknown>) : {};
		const modes: Record<string, ModeSpec> = {};
		for (const [k, v] of Object.entries(modesRaw)) {
			modes[k] = sanitizeModeSpec(v);
		}
		const file: ModesFile = {
			version: 1,
			currentMode,
			modes,
		};
		ensureDefaultModeEntries(file, ctx, pi);
		return file;
	} catch {
		return createDefaultModes(ctx, pi);
	}
}

async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
	await atomicWriteUtf8(filePath, JSON.stringify(data, null, 2) + "\n");
}

function orderedModeNames(modes: Record<string, ModeSpec>): string[] {
	// 保留 JSON 文件中的插入顺序。
	// 现代 JS 运行时的对象键迭代顺序是稳定的。
	// 注意："custom" 是 overlay 模式，不应可被选择/持久化。
	return Object.keys(modes).filter((name) => name !== CUSTOM_MODE_NAME);
}

function getModeBorderColor(theme: any, pi: ExtensionAPI, mode: string): (text: string) => string {
	const spec = runtime.data.modes[mode];

	// JSON 中显式指定的颜色覆盖。
	if (spec?.color) {
		try {
			// 提前校验，避免在渲染时崩溃。
			theme.getFgAnsi(spec.color as any);
			return (text: string) => theme.fg(spec.color as any, text);
		} catch {
			// 回退到基于 thinking level 的颜色
		}
	}

	// 默认：由当前 thinking level 推导。
	try {
		return theme.getThinkingBorderColor(pi.getThinkingLevel());
	} catch {
		return theme.getThinkingBorderColor("off");
	}
}

function formatModeLabel(mode: string): string {
	return mode;
}

async function resolveModesPath(cwd: string): Promise<string> {
	const projectPath = getProjectModesPath(cwd);
	if (await fileExists(projectPath)) return projectPath;
	return getGlobalModesPath();
}

function inferModeFromSelection(ctx: ExtensionContext, pi: ExtensionAPI, data: ModesFile): string | null {
	const provider = ctx.model?.provider;
	const modelId = ctx.model?.id;
	const thinkingLevel = pi.getThinkingLevel();
	if (!provider || !modelId) return null;

	// 只考虑已持久化的真实模式（排除 overlay 的 "custom"）。
	const names = orderedModeNames(data.modes);

	const supportsThinking = Boolean(ctx.model?.reasoning);

	// 1) 若支持 thinking，则要求精确匹配，以便模式可按 thinking level 区分。
	if (supportsThinking) {
		for (const name of names) {
			const spec = data.modes[name];
			if (!spec) continue;
			if (spec.provider !== provider || spec.modelId !== modelId) continue;
			if ((spec.thinkingLevel ?? undefined) !== thinkingLevel) continue;
			return name;
		}
		return null;
	}

	// 2) 若 model 不支持 thinking，实际 level 始终为 "off"。
	// 此时将 modes.json 中的 thinkingLevel 差别视为不构成区分。
	const candidates: string[] = [];
	for (const name of names) {
		const spec = data.modes[name];
		if (!spec) continue;
		if (spec.provider !== provider || spec.modelId !== modelId) continue;
		candidates.push(name);
	}
	if (candidates.length === 0) return null;

	// 优先选择显式匹配实际 thinking level 的候选。
	for (const name of candidates) {
		const spec = data.modes[name];
		if (!spec) continue;
		if ((spec.thinkingLevel ?? "off") === thinkingLevel) return name;
	}

	// 其次优先选择未配置 thinkingLevel 的候选。
	for (const name of candidates) {
		const spec = data.modes[name];
		if (!spec) continue;
		if (!spec.thinkingLevel) return name;
	}

	return candidates[0] ?? null;
}

type ModeRuntime = {
	filePath: string;
	fileMtimeMs: number | null;
	/**
	 * 上次从磁盘加载/同步内容的 snapshot。用于计算 patch，
	 * 以免多个运行中的 pi 进程互相覆盖彼此的模式编辑。
	 */
	baseline: ModesFile | null;
	data: ModesFile;

	/**
	 * 最后一个非 overlay 模式。处于 overlay 的 "custom" 模式时用作 cycle 基准。
	 */
	lastRealMode: string;

	/**
	 * 实际的 current mode。可能临时为 "custom"（overlay），
	 * 它不会被持久化，也无法通过 /mode 选择。
	 */
	currentMode: string;
	// 在我们自行切换 model 时防止反馈循环
	applying: boolean;
};

const runtime: ModeRuntime = {
	filePath: "",
	fileMtimeMs: null,
	baseline: null,
	data: { version: 1, currentMode: "default", modes: {} },
	lastRealMode: "default",
	currentMode: "default",
	applying: false,
};

// 自定义编辑器实例化时由 setEditor() 更新。
let requestEditorRender: (() => void) | undefined;

async function ensureRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const filePath = await resolveModesPath(ctx.cwd);

	const mtimeMs = await getMtimeMs(filePath);
	const filePathChanged = runtime.filePath !== filePath;
	const fileChanged = filePathChanged || runtime.fileMtimeMs !== mtimeMs;

	if (fileChanged) {
		runtime.filePath = filePath;
		runtime.fileMtimeMs = mtimeMs;

		const loaded = await loadModesFile(filePath, ctx, pi);
		// 在 snapshot baseline 之前先规范化/确保默认值，
		// 这样后续持久化只反映用户的显式操作（"store"）。
		ensureDefaultModeEntries(loaded, ctx, pi);
		runtime.data = loaded;
		runtime.baseline = cloneModesFile(runtime.data);

		// 切换项目时重置 overlay。
		if (filePathChanged && runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.currentMode = runtime.data.currentMode;
			runtime.lastRealMode = runtime.currentMode;
		}
	}

	// 若当前不在 overlay 的 "custom" 模式，确保 currentMode 合法。
	if (runtime.currentMode !== CUSTOM_MODE_NAME) {
		if (!runtime.currentMode || !(runtime.currentMode in runtime.data.modes)) {
			runtime.currentMode = runtime.data.currentMode;
		}
		if (!runtime.lastRealMode || !(runtime.lastRealMode in runtime.data.modes)) {
			runtime.lastRealMode = runtime.currentMode;
		}
	}
}

async function persistRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!runtime.filePath) return;

	// 不持久化 currentMode，否则多个运行中的 pi session 会争抢它。
	// 我们改为在启动时根据当前 model + thinking level 推断模式。
	runtime.baseline ??= cloneModesFile(runtime.data);
	const patch = computeModesPatch(runtime.baseline, runtime.data, false);
	if (!patch) return;

	await withFileLock(runtime.filePath, async () => {
		// 将本地 patch 合并到磁盘上的最新内容，避免覆盖其他 agent。
		const latest = await loadModesFile(runtime.filePath, ctx, pi);
		applyModesPatch(latest, patch);
		ensureDefaultModeEntries(latest, ctx, pi);
		await saveModesFile(runtime.filePath, latest);

		runtime.data = latest;
		runtime.baseline = cloneModesFile(latest);
		runtime.fileMtimeMs = await getMtimeMs(runtime.filePath);
	});
}

// 在同一个 tick 内紧接 pi.setModel() 之后，我们无法可靠地读取*当前* model，
// 因为 ctx.model 是近似 snapshot 的视图，通过 model_select 事件更新。
// 我们自行记录最后观察到的 model，并用于 overlay / 存储。
let lastObservedModel: { provider?: string; modelId?: string } = {};

function getCurrentSelectionSpec(pi: ExtensionAPI, _ctx: ExtensionContext): ModeSpec {
	return {
		provider: lastObservedModel.provider,
		modelId: lastObservedModel.modelId,
		thinkingLevel: pi.getThinkingLevel(),
	};
}

async function storeSelectionIntoMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string, selection: ModeSpec): Promise<void> {
	// "custom" 是 overlay；不会被持久化。
	if (mode === CUSTOM_MODE_NAME) return;

	await ensureRuntime(pi, ctx);

	const existingTarget = runtime.data.modes[mode] ?? {};
	const next: ModeSpec = { ...existingTarget };

	// 只覆盖我们实际能观察到的字段。
	if (selection.provider && selection.modelId) {
		next.provider = selection.provider;
		next.modelId = selection.modelId;
	}
	if (selection.thinkingLevel) next.thinkingLevel = selection.thinkingLevel;

	runtime.data.modes[mode] = next;
	await persistRuntime(pi, ctx);
}

async function applyMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	await ensureRuntime(pi, ctx);

	// "custom" 是仅运行时存在的 overlay 模式。
	if (mode === CUSTOM_MODE_NAME) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi, ctx);
		if (ctx.hasUI) requestEditorRender?.();
		return;
	}

	const spec = runtime.data.modes[mode];
	if (!spec) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Unknown mode: ${mode}`, "warning");
		}
		return;
	}

	runtime.currentMode = mode;
	runtime.lastRealMode = mode;
	customOverlay = null;

	runtime.applying = true;
	let modelAppliedOk = true;
	try {
		// 应用 model
		if (spec.provider && spec.modelId) {
			const m = ctx.modelRegistry.find(spec.provider, spec.modelId);
			if (m) {
				const ok = await pi.setModel(m);
				modelAppliedOk = ok;
				if (!ok && ctx.hasUI) {
					ctx.ui.notify(`No API key available for ${spec.provider}/${spec.modelId}`, "warning");
				}
			} else {
				modelAppliedOk = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`Mode "${mode}" references unknown model ${spec.provider}/${spec.modelId}`, "warning");
				}
			}
		}

		// 应用 thinking level
		if (spec.thinkingLevel) {
			pi.setThinkingLevel(spec.thinkingLevel);
		}
	} finally {
		runtime.applying = false;
	}

	// 若无法应用请求的 model（例如缺少 API key），则切换到 overlay。
	// 我们不把 thinking level 的 clamp 视为失败：在思考能力不同的
	// model 之间切换时，clamp 是预期行为。
	if (!modelAppliedOk) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi, ctx);
	}

	if (ctx.hasUI) {
		requestEditorRender?.();
	}
}

const MODE_UI_CONFIGURE = "Configure modes…";
const MODE_UI_ADD = "Add mode…";
const MODE_UI_BACK = "Back";

const THINKING_UNSET_LABEL = "(don't change)";

function resolveModeModel(ctx: ExtensionContext, spec: ModeSpec) {
	if (spec.provider && spec.modelId) {
		return ctx.modelRegistry.find(spec.provider, spec.modelId);
	}
	return ctx.model;
}

function getModeSupportedThinkingLevels(ctx: ExtensionContext, spec: ModeSpec): ThinkingLevel[] | undefined {
	const model = resolveModeModel(ctx, spec);
	return model ? getSupportedThinkingLevels(model) : undefined;
}

function formatModeThinkingLabel(ctx: ExtensionContext, spec: ModeSpec): string {
	const current = spec.thinkingLevel;
	if (!current) return THINKING_UNSET_LABEL;

	const supported = getModeSupportedThinkingLevels(ctx, spec);
	if (!supported || supported.includes(current)) return current;

	const model = resolveModeModel(ctx, spec);
	const effective = model ? clampThinkingLevel(model, current) : undefined;
	return effective ? `${current} (unsupported; effective: ${effective})` : `${current} (unsupported)`;
}

function isDefaultModeName(name: string): boolean {
	return (DEFAULT_MODE_ORDER as readonly string[]).includes(name);
}

function uniqueActionLabel(label: string, modeNames: readonly string[]): string {
	const used = new Set(modeNames);
	if (!used.has(label)) return label;

	let suffix = 2;
	while (used.has(`${label} (${suffix})`)) suffix += 1;
	return `${label} (${suffix})`;
}

function isReservedModeName(name: string): boolean {
	return name === CUSTOM_MODE_NAME;
}

function normalizeModeNameInput(name: string | undefined): string {
	return (name ?? "").trim();
}

function validateModeNameOrError(
	name: string,
	existing: Record<string, ModeSpec>,
	opts?: { allowExisting?: boolean },
): string | null {
	if (!name) return "Mode name cannot be empty";
	if (/\s/.test(name)) return "Mode name cannot contain whitespace";
	if (isReservedModeName(name)) return `Mode name \"${name}\" is reserved`;
	if (!opts?.allowExisting && existing[name]) return `Mode \"${name}\" already exists`;
	return null;
}

async function handleModeChoiceUI(pi: ExtensionAPI, ctx: ExtensionContext, choice: string): Promise<void> {
	// 特殊行为：处于 "custom" 且选择了另一个模式时，
	// 询问是要*使用*它（切换），还是将当前 custom 选择*存入*它。
	if (runtime.currentMode === CUSTOM_MODE_NAME && choice !== CUSTOM_MODE_NAME) {
		const action = await ctx.ui.select(`Mode \"${choice}\"`, ["use", "store"]);
		if (!action) return;

		if (action === "use") {
			await applyMode(pi, ctx, choice);
			return;
		}

		// "store"：用当前 overlay 选择覆盖目标模式（若目标已设置颜色则保留）
		await ensureRuntime(pi, ctx);
		const overlay = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
		await storeSelectionIntoMode(pi, ctx, choice, overlay);
		await applyMode(pi, ctx, choice);
		ctx.ui.notify(`Stored ${CUSTOM_MODE_NAME} into \"${choice}\"`, "info");
		return;
	}

	await applyMode(pi, ctx, choice);
}

async function selectModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);
		const names = orderedModeNames(runtime.data.modes);
		const configureLabel = uniqueActionLabel(MODE_UI_CONFIGURE, names);
		const choice = await ctx.ui.select(`Mode (current: ${runtime.currentMode})`, [...names, configureLabel]);
		if (!choice) return;

		if (choice === configureLabel) {
			await configureModesUI(pi, ctx);
			continue;
		}

		await handleModeChoiceUI(pi, ctx, choice);
		return;
	}
}

async function configureModesUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);
		const names = orderedModeNames(runtime.data.modes);
		const addLabel = uniqueActionLabel(MODE_UI_ADD, names);
		const backLabel = uniqueActionLabel(MODE_UI_BACK, [...names, addLabel]);
		const choice = await ctx.ui.select("Configure modes", [...names, addLabel, backLabel]);
		if (!choice || choice === backLabel) return;

		if (choice === addLabel) {
			const created = await addModeUI(pi, ctx);
			if (created) {
				await editModeUI(pi, ctx, created);
			}
			continue;
		}

		await editModeUI(pi, ctx, choice);
	}
}

async function addModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input("New mode name", "e.g. docs, review, planning");
		if (raw === undefined) return undefined;

		const name = normalizeModeNameInput(raw);
		const err = validateModeNameOrError(name, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		// 新模式默认使用当前选择，使其立即按预期工作。
		const selection = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
		runtime.data.modes[name] = {
			provider: selection.provider,
			modelId: selection.modelId,
			thinkingLevel: selection.thinkingLevel,
		};
		await persistRuntime(pi, ctx);
		ctx.ui.notify(`Added mode \"${name}\"`, "info");
		return name;
	}
}

async function editModeUI(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	if (!ctx.hasUI) return;

	let modeName = mode;

	while (true) {
		await ensureRuntime(pi, ctx);
		const spec = runtime.data.modes[modeName];
		if (!spec) return;

		const modelLabel = spec.provider && spec.modelId ? `${spec.provider}/${spec.modelId}` : "(no model)";
		const thinkingLabel = formatModeThinkingLabel(ctx, spec);

		const actions = ["Change name", "Change model", "Change thinking level"];
		if (!isDefaultModeName(modeName)) actions.push("Delete mode");
		actions.push(MODE_UI_BACK);

		const action = await ctx.ui.select(
			`Edit mode \"${modeName}\"  model: ${modelLabel}  thinking: ${thinkingLabel}`,
			actions,
		);
		if (!action || action === MODE_UI_BACK) return;

		if (action === "Change name") {
			const renamed = await renameModeUI(pi, ctx, modeName);
			if (renamed) modeName = renamed;
			continue;
		}

		if (action === "Change model") {
			const selected = await pickModelForModeUI(ctx, spec);
			if (!selected) continue;

			const nextSpec: ModeSpec = {
				...spec,
				provider: selected.provider,
				modelId: selected.modelId,
			};
			const supported = getModeSupportedThinkingLevels(ctx, nextSpec);
			if (nextSpec.thinkingLevel && supported && !supported.includes(nextSpec.thinkingLevel)) {
				const previousLevel = nextSpec.thinkingLevel;
				const level = await pickThinkingLevelForModeUI(ctx, nextSpec, {
					allowUnsupportedCurrent: false,
					title: `"${previousLevel}" is not supported by ${selected.provider}/${selected.modelId}`,
				});
				if (level === undefined) continue;
				if (level === null) delete nextSpec.thinkingLevel;
				else nextSpec.thinkingLevel = level;
			}

			runtime.data.modes[modeName] = nextSpec;
			await persistRuntime(pi, ctx);
			ctx.ui.notify(`Updated model for \"${modeName}\"`, "info");

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			}
			continue;
		}

		if (action === "Change thinking level") {
			const level = await pickThinkingLevelForModeUI(ctx, spec);
			if (level === undefined) continue;

			if (level === null) {
				delete spec.thinkingLevel;
			} else {
				spec.thinkingLevel = level;
			}

			runtime.data.modes[modeName] = spec;
			await persistRuntime(pi, ctx);
			ctx.ui.notify(`Updated thinking level for \"${modeName}\"`, "info");

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			}
			continue;
		}

		if (action === "Delete mode") {
			const ok = await ctx.ui.confirm("Delete mode", `Delete mode \"${modeName}\"?`);
			if (!ok) continue;

			delete runtime.data.modes[modeName];
			await persistRuntime(pi, ctx);

			if (runtime.currentMode === modeName) {
				runtime.currentMode = CUSTOM_MODE_NAME;
				customOverlay = getCurrentSelectionSpec(pi, ctx);
			}
			if (runtime.lastRealMode === modeName) {
				runtime.lastRealMode = "default";
			}
			requestEditorRender?.();
			ctx.ui.notify(`Deleted mode \"${modeName}\"`, "info");
			return;
		}
	}
}

function renameModesRecord(modes: Record<string, ModeSpec>, oldName: string, newName: string): Record<string, ModeSpec> {
	const out: Record<string, ModeSpec> = {};
	for (const [k, v] of Object.entries(modes)) {
		if (k === oldName) out[newName] = v;
		else out[k] = v;
	}
	return out;
}

async function renameModeUI(pi: ExtensionAPI, ctx: ExtensionContext, oldName: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;

	if (isDefaultModeName(oldName)) {
		ctx.ui.notify(`Cannot rename default mode \"${oldName}\"`, "warning");
		return oldName;
	}

	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input(`Rename mode \"${oldName}\"`, oldName);
		if (raw === undefined) return undefined;

		const newName = normalizeModeNameInput(raw);
		if (!newName || newName === oldName) return oldName;

		const err = validateModeNameOrError(newName, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		runtime.data.modes = renameModesRecord(runtime.data.modes, oldName, newName);
		await persistRuntime(pi, ctx);

		if (runtime.currentMode === oldName) runtime.currentMode = newName;
		if (runtime.lastRealMode === oldName) runtime.lastRealMode = newName;
		requestEditorRender?.();

		ctx.ui.notify(`Renamed \"${oldName}\" → \"${newName}\"`, "info");
		return newName;
	}
}

async function pickModelForModeUI(
	ctx: ExtensionContext,
	spec: ModeSpec,
): Promise<{ provider: string; modelId: string } | undefined> {
	if (!ctx.hasUI) return undefined;

	const currentModel = spec.provider && spec.modelId ? ctx.modelRegistry.find(spec.provider, spec.modelId) : ctx.model;
	const models = [...ctx.modelRegistry.getAvailable()];
	if (models.length === 0) {
		ctx.ui.notify("No available models. Check provider configuration and authentication.", "warning");
		return undefined;
	}

	models.sort((a, b) => {
		const aIsCurrent = a.provider === currentModel?.provider && a.id === currentModel?.id;
		const bIsCurrent = b.provider === currentModel?.provider && b.id === currentModel?.id;
		if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
		return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
	});

	const options = models.map((model) => {
		const name = model.name && model.name !== model.id ? ` - ${model.name}` : "";
		return `${model.provider}/${model.id}${name}`;
	});
	const selected = await ctx.ui.select("Select model for mode", options, { signal: ctx.signal });
	const model = models[options.indexOf(selected ?? "")];
	return model ? { provider: model.provider, modelId: model.id } : undefined;
}

async function pickThinkingLevelForModeUI(
	ctx: ExtensionContext,
	spec: ModeSpec,
	options?: { allowUnsupportedCurrent?: boolean; title?: string },
): Promise<ThinkingLevel | null | undefined> {
	if (!ctx.hasUI) return undefined;

	const current = spec.thinkingLevel;
	let supported = getModeSupportedThinkingLevels(ctx, spec);
	if (!supported) {
		supported = [...ALL_THINKING_LEVELS];
		if (spec.provider && spec.modelId) {
			ctx.ui.notify(
				`Model ${spec.provider}/${spec.modelId} is unavailable; showing all thinking levels.`,
				"warning",
			);
		}
	}

	type Choice = { label: string; value: ThinkingLevel | null };
	const choices: Choice[] = [];
	const currentIsSupported = current ? supported.includes(current) : false;
	const allowUnsupportedCurrent = options?.allowUnsupportedCurrent ?? true;

	if (!current) {
		choices.push({ label: THINKING_UNSET_LABEL, value: null });
	} else if (currentIsSupported) {
		choices.push({ label: current, value: current });
	} else if (allowUnsupportedCurrent) {
		const model = resolveModeModel(ctx, spec);
		const effective = model ? clampThinkingLevel(model, current) : undefined;
		const suffix = effective ? `; effective: ${effective}` : "";
		choices.push({ label: `${current} (unsupported${suffix})`, value: current });
	}

	for (const level of supported) {
		if (level !== current) choices.push({ label: level, value: level });
	}
	if (current) choices.push({ label: THINKING_UNSET_LABEL, value: null });

	const labels = choices.map((choice) => choice.label);
	const selected = await ctx.ui.select(options?.title ?? "Thinking level", labels);
	if (!selected) return undefined;
	return choices[labels.indexOf(selected)]?.value;
}

async function cycleMode(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
	if (!ctx.hasUI) return;
	await ensureRuntime(pi, ctx);
	const names = orderedModeNames(runtime.data.modes);
	if (names.length === 0) return;

	// 若当前处于 overlay 模式，则相对最后一个真实模式进行 cycle。
	const baseMode = runtime.currentMode === CUSTOM_MODE_NAME ? runtime.lastRealMode : runtime.currentMode;
	const idx = Math.max(0, names.indexOf(baseMode));
	const next = names[(idx + direction + names.length) % names.length] ?? names[0]!;
	await applyMode(pi, ctx, next);
}

// =============================================================================
// Prompt 历史
// =============================================================================

const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENT_PROMPTS = 30;

interface PromptEntry {
	text: string;
	timestamp: number;
}

type PromptEditorOptions = NonNullable<ConstructorParameters<typeof CustomEditor>[3]> & {
	embedWorkingStatus?: boolean;
};

class PromptEditor extends CustomEditor {
	public modeLabelProvider?: () => string;
	/**
	 * 模式标签的颜色函数。未设置时，标签继承边框颜色。
	 * 用它保持标签一致（例如与 footer/状态栏一致）。
	 */
	public modeLabelColor?: (text: string) => string;
	private lockedBorder = false;
	private _borderColor?: (text: string) => string;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, theme, keybindings, { embedWorkingStatus: true } as PromptEditorOptions);
		delete (this as { borderColor?: (text: string) => string }).borderColor;
		Object.defineProperty(this, "borderColor", {
			get: () => this._borderColor ?? ((text: string) => text),
			set: (value: (text: string) => string) => {
				if (this.lockedBorder) return;
				this._borderColor = value;
			},
			configurable: true,
			enumerable: true,
		});
	}

	lockBorderColor() {
		this.lockedBorder = true;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const topBorder = lines[0] ?? "";
		const mode = this.modeLabelProvider?.();
		if (!mode) return lines;

		const topPlain = stripTerminalSequences(topBorder);
		const isBashMode = this.getText().trimStart().startsWith("!");

		// 保留尾部边框之前渲染的 working 状态和滚动指示器。
		// 空闲 bash 模式保持相同的两字符边框前缀。
		const trailingBorderStart = topPlain.search(/─+$/);
		if (trailingBorderStart < 0) return lines;
		const semanticPrefix = trailingBorderStart > 0 ? topPlain.slice(0, trailingBorderStart) : "";
		const prefixWidth = Math.min(width, semanticPrefix ? visibleWidth(semanticPrefix) : isBashMode ? 2 : 0);
		let left = truncateToWidth(topBorder, prefixWidth, "");
		let leftWidth = prefixWidth;

		const labelColor = this.modeLabelColor ?? ((text: string) => this.borderColor(text));
		if (isBashMode) {
			const bashPrefix = semanticPrefix ? this.borderColor("── ") : labelColor(" ");
			const bashLabel = labelColor("bash ");
			left += bashPrefix + bashLabel;
			leftWidth += visibleWidth(bashPrefix) + visibleWidth(bashLabel);
		}

		const modeLeftSpace = " ";
		const modeRightSpace = " ";
		const rightBorderWidth = 2;
		const minGapWidth = 1;
		const maxModeWidth = Math.max(
			0,
			width -
				leftWidth -
				visibleWidth(modeLeftSpace) -
				visibleWidth(modeRightSpace) -
				rightBorderWidth -
				minGapWidth,
		);
		if (maxModeWidth <= 0) return lines;

		const modeLabel = truncateToWidth(formatModeLabel(mode), maxModeWidth, "");
		const modeWidth = visibleWidth(modeLabel);
		const gapWidth =
			width - leftWidth - visibleWidth(modeLeftSpace) - modeWidth - visibleWidth(modeRightSpace) - rightBorderWidth;
		if (gapWidth < minGapWidth) return lines;

		lines[0] =
			left +
			this.borderColor("─".repeat(gapWidth)) +
			labelColor(modeLeftSpace) +
			labelColor(modeLabel) +
			labelColor(modeRightSpace) +
			this.borderColor("─".repeat(rightBorderWidth));
		return lines;
	}

	public requestRenderNow(): void {
		this.tui.requestRender();
	}
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("")
		.trim();
}

function collectUserPromptsFromEntries(entries: Array<any>): PromptEntry[] {
	const prompts: PromptEntry[] = [];

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry?.message;
		if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = extractText(message.content);
		if (!text) continue;
		const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
		prompts.push({ text, timestamp });
	}

	return prompts;
}

function getSessionDirForCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getGlobalAgentDir(), "sessions", safePath);
}

async function readTail(filePath: string, maxBytes = 256 * 1024): Promise<string> {
	let fileHandle: fs.FileHandle | undefined;
	try {
		const stats = await fs.stat(filePath);
		const size = stats.size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";

		const buffer = Buffer.alloc(length);
		fileHandle = await fs.open(filePath, "r");
		const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
		if (bytesRead === 0) return "";
		let chunk = buffer.subarray(0, bytesRead).toString("utf8");
		if (start > 0) {
			const firstNewline = chunk.indexOf("\n");
			if (firstNewline !== -1) {
				chunk = chunk.slice(firstNewline + 1);
			}
		}
		return chunk;
	} catch {
		return "";
	} finally {
		await fileHandle?.close();
	}
}

async function loadPromptHistoryForCwd(cwd: string, excludeSessionFile?: string): Promise<PromptEntry[]> {
	const sessionDir = getSessionDirForCwd(path.resolve(cwd));
	const resolvedExclude = excludeSessionFile ? path.resolve(excludeSessionFile) : undefined;
	const prompts: PromptEntry[] = [];

	let entries: Dirent[] = [];
	try {
		entries = await fs.readdir(sessionDir, { withFileTypes: true });
	} catch {
		return prompts;
	}

	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry) => {
				const filePath = path.join(sessionDir, entry.name);
				try {
					const stats = await fs.stat(filePath);
					return { filePath, mtimeMs: stats.mtimeMs };
				} catch {
					return undefined;
				}
			}),
	);

	const sortedFiles = files
		.filter((file): file is { filePath: string; mtimeMs: number } => Boolean(file))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	for (const file of sortedFiles) {
		if (resolvedExclude && path.resolve(file.filePath) === resolvedExclude) continue;

		const tail = await readTail(file.filePath);
		if (!tail) continue;
		const lines = tail.split("\n").filter(Boolean);
		for (const line of lines) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry?.message;
			if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
			const text = extractText(message.content);
			if (!text) continue;
			const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
			prompts.push({ text, timestamp });
			if (prompts.length >= MAX_RECENT_PROMPTS) break;
		}
		if (prompts.length >= MAX_RECENT_PROMPTS) break;
	}

	return prompts;
}

function buildHistoryList(currentSession: PromptEntry[], previousSessions: PromptEntry[]): PromptEntry[] {
	const all = [...currentSession, ...previousSessions];
	all.sort((a, b) => a.timestamp - b.timestamp);

	const seen = new Set<string>();
	const deduped: PromptEntry[] = [];
	for (const prompt of all) {
		const key = `${prompt.timestamp}:${prompt.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(prompt);
	}

	return deduped.slice(-MAX_HISTORY_ENTRIES);
}

// Overlay 模式状态（"custom"）。不可选择，也不会被 cycle 进入。
let customOverlay: ModeSpec | null = null;

let loadCounter = 0;

function historiesMatch(a: PromptEntry[], b: PromptEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i]?.text !== b[i]?.text || a[i]?.timestamp !== b[i]?.timestamp) return false;
	}
	return true;
}

function setEditor(pi: ExtensionAPI, ctx: ExtensionContext, history: PromptEntry[]) {
	const uiTheme = ctx.ui.theme;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = new PromptEditor(tui, theme, keybindings);
		requestEditorRender = () => editor.requestRenderNow();
		editor.modeLabelProvider = () => runtime.currentMode;
		// 保持模式标签颜色稳定（与 footer/状态栏一致）。
		editor.modeLabelColor = (text: string) => uiTheme.fg("dim", text);
		const borderColor = (text: string) => {
			const isBashMode = editor.getText().trimStart().startsWith("!");
			if (isBashMode) {
				return uiTheme.getBashModeBorderColor()(text);
			}
			return getModeBorderColor(uiTheme, pi, runtime.currentMode)(text);
		};

		editor.borderColor = borderColor;
		editor.lockBorderColor();
		for (const prompt of history) {
			editor.addToHistory?.(prompt.text);
		}
		return editor;
	});
}

function applyEditor(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const sessionFile = ctx.sessionManager.getSessionFile();
	const currentEntries = ctx.sessionManager.getBranch();
	const currentPrompts = collectUserPromptsFromEntries(currentEntries);
	const immediateHistory = buildHistoryList(currentPrompts, []);

	const currentLoad = ++loadCounter;
	const initialText = ctx.ui.getEditorText();
	setEditor(pi, ctx, immediateHistory);

	void (async () => {
		const previousPrompts = await loadPromptHistoryForCwd(ctx.cwd, sessionFile ?? undefined);
		if (currentLoad !== loadCounter) return;
		if (ctx.ui.getEditorText() !== initialText) return;
		const history = buildHistoryList(currentPrompts, previousPrompts);
		if (historiesMatch(history, immediateHistory)) return;
		setEditor(pi, ctx, history);
	})();
}

// =============================================================================
// 扩展导出
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerCommand("mode", {
		description: "Select prompt mode",
		handler: async (args, ctx) => {
			const tokens = args
				.split(/\s+/)
				.map((x) => x.trim())
				.filter(Boolean);

			// /mode
			if (tokens.length === 0) {
				await selectModeUI(pi, ctx);
				return;
			}

			// /mode store [name]
			if (tokens[0] === "store") {
				await ensureRuntime(pi, ctx);

				let target = tokens[1];
				if (!target) {
					if (!ctx.hasUI) return;
					const names = orderedModeNames(runtime.data.modes);
					target = await ctx.ui.select("Store current selection into mode", names);
					if (!target) return;
				}

				if (target === CUSTOM_MODE_NAME) {
					if (ctx.hasUI) ctx.ui.notify(`Cannot store into "${CUSTOM_MODE_NAME}"`, "warning");
					return;
				}

				const selection = customOverlay ?? getCurrentSelectionSpec(pi, ctx);
				await storeSelectionIntoMode(pi, ctx, target, selection);
				if (ctx.hasUI) ctx.ui.notify(`Stored current selection into "${target}"`, "info");
				return;
			}

			// /mode <name>
			await applyMode(pi, ctx, tokens[0]!);
		},
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Select prompt mode",
		handler: async (ctx) => {
			await selectModeUI(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+space", {
		description: "Cycle prompt mode",
		handler: async (ctx) => {
			await cycleMode(pi, ctx, 1);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastObservedModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
		await ensureRuntime(pi, ctx);
		customOverlay = null;

		const inferred = inferModeFromSelection(ctx, pi, runtime.data);
		if (inferred) {
			runtime.currentMode = inferred;
			runtime.lastRealMode = inferred;
		} else {
			// 无精确匹配 → 视为 overlay。
			runtime.currentMode = CUSTOM_MODE_NAME;
			customOverlay = getCurrentSelectionSpec(pi, ctx);
		}

		applyEditor(pi, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		// 始终记录最后观察到的 model，以保证 overlay/store 正确。
		lastObservedModel = { provider: event.model.provider, modelId: event.model.id };

		// 跳过由 applyMode() 自身触发的模式切换，否则我们会在
		// 正在应用模式的途中跳到 "custom"。
		if (runtime.applying) return;

		// 手动切换 model 总是进入 overlay 的 "custom" 模式。
		await ensureRuntime(pi, ctx);
		if (runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.lastRealMode = runtime.currentMode;
		}
		runtime.currentMode = CUSTOM_MODE_NAME;

		customOverlay = {
			provider: event.model.provider,
			modelId: event.model.id,
			thinkingLevel: pi.getThinkingLevel(),
		};

		// 不持久化/不选择 custom。
		if (ctx.hasUI) {
			requestEditorRender?.();
		}
	});

}
