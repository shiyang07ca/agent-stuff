#!/usr/bin/env node

import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PURPOSE = "General research support";
const SUPPORTED_TRANSPORTS = new Set([
	"auto",
	"responses",
	"alpha-search",
	"codex-responses",
	"codex-alpha-search",
	"anthropic",
]);

class SearchTransportError extends Error {
	constructor(message, options = {}) {
		super(message);
		this.name = "SearchTransportError";
		this.status = options.status;
		this.unsupported = options.unsupported === true;
	}
}

function parseArgs(argv) {
	const args = {
		provider: undefined,
		model: undefined,
		transport: "auto",
		endpoint: undefined,
		purpose: DEFAULT_PURPOSE,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		json: false,
		help: false,
		query: "",
	};
	const positional = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			args.help = true;
			continue;
		}
		if (arg === "--json") {
			args.json = true;
			continue;
		}
		if (arg === "--provider" || arg === "--model" || arg === "--transport" || arg === "--endpoint" || arg === "--purpose" || arg === "--timeout") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`A value is required for ${arg}`);
			index += 1;
			if (arg === "--provider") args.provider = value;
			if (arg === "--model") args.model = value;
			if (arg === "--transport") args.transport = value;
			if (arg === "--endpoint") args.endpoint = value;
			if (arg === "--purpose") args.purpose = value;
			if (arg === "--timeout") {
				const timeout = Number(value);
				if (!Number.isFinite(timeout) || timeout < 1_000) throw new Error("--timeout must be a number >= 1000");
				args.timeoutMs = timeout;
			}
			continue;
		}
		const assignment = arg.match(/^--(provider|model|transport|endpoint|purpose|timeout)=(.*)$/);
		if (assignment) {
			const [, name, value] = assignment;
			if (!value) throw new Error(`--${name}= requires a value`);
			if (name === "provider") args.provider = value;
			if (name === "model") args.model = value;
			if (name === "transport") args.transport = value;
			if (name === "endpoint") args.endpoint = value;
			if (name === "purpose") args.purpose = value;
			if (name === "timeout") {
				const timeout = Number(value);
				if (!Number.isFinite(timeout) || timeout < 1_000) throw new Error("--timeout must be a number >= 1000");
				args.timeoutMs = timeout;
			}
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
		positional.push(arg);
	}

	args.query = positional.join(" ").trim();
	args.provider = normalizeProvider(args.provider);
	args.transport = normalizeTransport(args.transport);
	if (!args.transport) throw new Error(`Unknown transport. Supported values: ${[...SUPPORTED_TRANSPORTS].join(", ")}`);
	return args;
}

function usage() {
	return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider <id>] [--model <id>]
    [--transport auto|responses|alpha-search|codex-responses|codex-alpha-search|anthropic]
    [--endpoint <url>] [--timeout <ms>] [--json]

Examples:
  node search.mjs "latest Python release" --purpose "Update dependency docs"
  node search.mjs "Ghostty latest release" --provider sub2api --model gpt-6.1-sol
  node search.mjs "HTTP/3 browser support" --provider openai-codex
  node search.mjs "latest Vite release" --transport responses --json`;
}

function stripJsonComments(text) {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];
		if (inString) {
			output += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === "/" && next === "/") {
			index += 2;
			while (index < text.length && text[index] !== "\n") index += 1;
			if (index < text.length) output += "\n";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
			index += 1;
			continue;
		}
		output += char;
	}
	return output.replace(/,\s*([}\]])/g, "$1");
}

function readJson(path, fallback = {}) {
	if (!existsSync(path)) return fallback;
	const text = readFileSync(path, "utf8");
	try {
		return JSON.parse(text);
	} catch {
		try {
			return JSON.parse(stripJsonComments(text));
		} catch (error) {
			throw new Error(`Could not parse ${path}: ${error.message}`);
		}
	}
}

function getAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

function normalizeProvider(value) {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const provider = value.trim().toLowerCase();
	if (provider === "claude") return "anthropic";
	if (provider === "codex" || provider === "chatgpt") return "openai-codex";
	return provider;
}

function normalizeTransport(value) {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const transport = value.trim().toLowerCase().replaceAll("_", "-");
	const aliases = {
		hosted: "responses",
		alpha: "alpha-search",
		standalone: "alpha-search",
		codex: "codex-responses",
		"anthropic-messages": "anthropic",
	};
	const normalized = aliases[transport] || transport;
	return SUPPORTED_TRANSPORTS.has(normalized) ? normalized : undefined;
}

function splitModelReference(value) {
	if (typeof value !== "string" || !value.trim()) return {};
	const model = value.trim();
	const slash = model.indexOf("/");
	if (slash > 0 && slash < model.length - 1) {
		return { provider: normalizeProvider(model.slice(0, slash)), model: model.slice(slash + 1) };
	}
	return { model };
}

function getProviderConfig(modelsConfig, provider) {
	const value = modelsConfig?.providers?.[provider];
	return value && typeof value === "object" ? value : {};
}

function getConfiguredModels(providerConfig) {
	return Array.isArray(providerConfig.models)
		? providerConfig.models.filter((model) => model && typeof model.id === "string" && model.id.trim())
		: [];
}

// settings.json 的 webSearch.model（provider/model）指定固定搜索模型；命令行未指定 provider/model 时优先使用。
function webSearchReference(settings) {
	const value = settings.webSearch?.model;
	if (value === undefined) return {};
	const ref = splitModelReference(value);
	if (!ref.provider) throw new Error("settings.json webSearch.model must use the provider/model form, e.g. sub2api/gpt-6.1-sol");
	return ref;
}

function pickProvider(args, settings, auth) {
	const modelRef = splitModelReference(args.model);
	const fromCli = args.provider || modelRef.provider || args.model;
	return (
		args.provider ||
		modelRef.provider ||
		(fromCli ? undefined : webSearchReference(settings).provider) ||
		normalizeProvider(process.env.PI_PROVIDER) ||
		normalizeProvider(settings.defaultProvider) ||
		(auth["openai-codex"] ? "openai-codex" : undefined) ||
		(auth.anthropic ? "anthropic" : undefined) ||
		(auth.openai ? "openai" : undefined)
	);
}

function pickModel(args, provider, settings, providerConfig) {
	const argRef = splitModelReference(args.model);
	const environmentProvider = normalizeProvider(process.env.PI_PROVIDER);
	const settingsProvider = normalizeProvider(settings.defaultProvider);
	const searchRef = args.provider || args.model ? {} : webSearchReference(settings);
	const requested =
		argRef.model ||
		(searchRef.provider === provider ? searchRef.model : undefined) ||
		(environmentProvider === provider ? splitModelReference(process.env.PI_MODEL).model : undefined) ||
		(settingsProvider === provider ? splitModelReference(settings.defaultModel).model : undefined);
	const configuredModels = getConfiguredModels(providerConfig);
	if (requested) {
		const configured = configuredModels.find((model) => model.id === requested || model.name === requested);
		return configured ? { ...configured } : { id: requested };
	}
	if (configuredModels.length > 0) return { ...configuredModels[0] };
	if (provider === "openai-codex") return { id: "gpt-5.4-mini" };
	if (provider === "anthropic") return { id: "claude-haiku-4-5" };
	if (provider === "openai") return { id: "gpt-5.4-mini" };
	throw new Error(`No model configured for provider '${provider}'. Pass --model or update models.json.`);
}

function resolveConfigValue(value) {
	if (typeof value !== "string" || !value) return undefined;
	if (value.startsWith("!")) {
		try {
			return execSync(value.slice(1), {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 10_000,
			}).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	let missing = false;
	const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
		const environmentValue = process.env[braced || bare];
		if (environmentValue === undefined) missing = true;
		return environmentValue || "";
	});
	if (missing) return undefined;
	if (resolved !== value) return resolved || undefined;
	return value;
}

function resolveHeaders(...sources) {
	const headers = {};
	for (const source of sources) {
		if (!source || typeof source !== "object" || Array.isArray(source)) continue;
		for (const [name, value] of Object.entries(source)) {
			const resolved = resolveConfigValue(value);
			if (resolved) headers[name] = resolved;
		}
	}
	return headers;
}

function getCredential(provider, providerConfig) {
	const commands = [
		["auth", "print-api-key", "--provider", provider],
		["auth", "print-bearer-token", "--provider", provider, "--min-expiry", "30s"],
	];
	for (const [index, command] of commands.entries()) {
		const result = spawnSync("pi", command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const credential = (result.stdout || "").trim();
		if (result.status === 0 && credential) return { value: credential, kind: index === 0 ? "api-key" : "bearer" };
	}
	const configured = resolveConfigValue(providerConfig.apiKey);
	if (configured) return { value: configured, kind: "api-key" };
	if (providerConfig.authHeader === false && providerConfig.headers && typeof providerConfig.headers === "object") {
		return { value: "", kind: "none" };
	}
	throw new Error(`No credentials available for provider '${provider}'. Use /login or configure models.json.`);
}

function decodeJwtAccountId(token) {
	if (typeof token !== "string") return undefined;
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function isGpt56Lite(modelId) {
	return /^gpt-5\.6-(?:sol|terra|luna)$/i.test(modelId);
}

function buildPrompt(query, purpose) {
	return `在互联网上搜索: ${query}\n\n目的: ${purpose}\n\n返回一份简洁的研究摘要，包含:\n- 3 到 7 条关键发现\n- 每条发现: 标题、它对当前目的的意义，以及完整的规范 URL（https://...）\n- 相关时说明来源之间的分歧\n- 关于应优先信任哪些来源的简短建议。`;
}

function buildSystemPrompt() {
	return "你是一个快速的网页研究助手。使用真实的 web search，提供实用的摘要，并包含完整的来源 URL。";
}

function endpoint(baseUrl, path) {
	if (!baseUrl) throw new Error(`Missing baseUrl for ${path}`);
	const url = new URL(baseUrl);
	const basePath = url.pathname.replace(/\/+$/, "");
	const suffix = path.replace(/^\/+/, "");
	if (!basePath.endsWith(`/${suffix}`)) url.pathname = `${basePath}/${suffix}`;
	return url.toString();
}

// Anthropic SDK 在 baseURL 后追加 /v1/messages；models.json 的 baseUrl 通常不含 /v1。
function anthropicApiBase(baseUrl) {
	const url = new URL(baseUrl);
	const path = url.pathname.replace(/\/+$/, "");
	if (!/\/v1(?:\/messages)?$/.test(path)) url.pathname = `${path}/v1`;
	return url.toString();
}

function codexResponsesEndpoint(baseUrl = "https://chatgpt.com/backend-api") {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function codexAlphaEndpoint(baseUrl = "https://chatgpt.com/backend-api") {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/alpha/search")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/alpha/search`;
	if (normalized.endsWith("/backend-api")) return `${normalized}/codex/alpha/search`;
	return `${normalized}/alpha/search`;
}

function parseResponseError(label, response, body) {
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = undefined;
	}
	const detail = parsed?.error?.message || parsed?.message || body || response.statusText || "Request failed";
	const endpointTerms = /endpoint|route|path|method|url|alpha\/search|responses/i;
	const requestError = /\bmodel\b|\bquota\b|\bcredit(?:s)?\b|\bbalance\b|\bbilling\b|\bparameter\b|\bargument\b/i.test(detail);
	const unsupported =
		!requestError && ![401, 403, 429].includes(response.status) && (
			[404, 405, 501].includes(response.status) ||
			(endpointTerms.test(detail) && /not found|not supported|unsupported|not implemented|no route|method not allowed/i.test(detail))
		);
	return new SearchTransportError(`${label} request failed (${response.status}): ${detail}`, {
		status: response.status,
		unsupported,
	});
}

function noSearchError(label) {
	return new Error(
		`${label} did not run a web search (no search tool activity in the response); the provider or gateway likely drops hosted search tools. ` +
			"Set webSearch.model (provider/model) in ~/.pi/agent/settings.json or pass --provider/--model for a provider that supports search.",
	);
}

// alpha search 片段中的内部引用标记和字数限制标记。
function stripSearchMarkup(text) {
	return text.replace(/\ue200cite\ue202[^\ue201]*\ue201\s*/g, "").replace(/\[wordlim: \d+\]\s*/g, "");
}

function extractText(value) {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
	if (typeof value !== "object") return "";
	if (typeof value.output_text === "string") return value.output_text;
	if (typeof value.text === "string") return value.text;
	if (typeof value.content === "string") return value.content;
	if (value.content) return extractText(value.content);
	if (value.output) return extractText(value.output);
	if (value.response) return extractText(value.response);
	return "";
}

function extractSseData(block) {
	return block
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
}

async function readResponsesText(response, label) {
	const contentType = response.headers.get("content-type") || "";
	if (contentType.includes("application/json")) {
		const body = await response.text();
		if (!response.ok) throw parseResponseError(label, response, body);
		let parsed;
		try {
			parsed = JSON.parse(body);
		} catch {
			throw new Error(`${label} returned invalid JSON`);
		}
		if (!JSON.stringify(parsed.output ?? parsed).includes('"web_search_call"')) throw noSearchError(label);
		const text = extractText(parsed).trim();
		if (!text) throw new Error(`${label} returned no text`);
		return text;
	}

	if (!response.ok) throw parseResponseError(label, response, await response.text());
	if (!response.body) throw new Error(`${label} returned no response body`);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let fallback = "";
	let searched = false;

	const consume = (finish = false) => {
		if (finish) buffer += "\n\n";
		let separator = buffer.search(/\r?\n\r?\n/);
		while (separator !== -1) {
			const block = buffer.slice(0, separator);
			buffer = buffer.slice(separator + (buffer[separator] === "\r" ? 4 : 2));
			const data = extractSseData(block);
			if (data && data !== "[DONE]") {
				let event;
				try {
					event = JSON.parse(data);
				} catch {
					event = undefined;
				}
				if (event?.type?.startsWith("response.web_search_call.") || event?.item?.type === "web_search_call") searched = true;
				if (event?.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
				if (event?.type === "response.output_item.done") fallback = extractText(event.item) || fallback;
				if (event?.type === "response.completed") fallback = extractText(event.response) || fallback;
				if (event?.type === "error" || event?.type === "response.failed") {
					throw new Error(event.message || event.response?.error?.message || `${label} failed`);
				}
			}
			separator = buffer.search(/\r?\n\r?\n/);
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		consume();
	}
	buffer += decoder.decode();
	consume(true);
	if (!searched) throw noSearchError(label);
	const result = (text || fallback).trim();
	if (!result) throw new Error(`${label} returned no text`);
	return result;
}

async function runResponses({ model, query, purpose, timeoutMs, url, headers, label }) {
	const body = {
		model,
		store: false,
		stream: true,
		instructions: buildSystemPrompt(),
		input: [{ role: "user", content: buildPrompt(query, purpose) }],
		tools: [{ type: "web_search" }],
		tool_choice: "auto",
	};
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	return readResponsesText(response, label);
}

async function runAlphaSearch({ model, query, purpose, timeoutMs, url, headers, label }) {
	const body = {
		id: randomUUID(),
		model,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: buildPrompt(query, purpose) }],
			},
		],
		commands: {
			search_query: [{ q: query }],
			response_length: "short",
		},
		settings: {
			allowed_callers: ["direct"],
			external_web_access: true,
		},
		max_output_tokens: 1_800,
	};
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const responseBody = await response.text();
	if (!response.ok) throw parseResponseError(label, response, responseBody);
	let parsed;
	try {
		parsed = JSON.parse(responseBody);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
	const text = stripSearchMarkup(extractText(parsed.output || parsed)).trim();
	if (text) return text;
	const sources = Array.isArray(parsed.results) ? parsed.results : [];
	if (sources.length > 0) {
		return sources
			.map((source) => [source.title || source.url, source.snippet && stripSearchMarkup(source.snippet), source.url].filter(Boolean).join(" — "))
			.filter(Boolean)
			.map((source) => `- ${source}`)
			.join("\n");
	}
	throw new Error(`${label} returned no readable results`);
}

const ANTHROPIC_MAX_TOKENS = 8_000;
const ANTHROPIC_MAX_PAUSE_CONTINUATIONS = 2;

// 不传 temperature：Claude Opus 4.7+ 不支持，且与 adaptive/extended thinking 不兼容。
// max_tokens 需同时容纳 thinking 与正文；pause_turn 表示服务端工具循环被暂停，带上已有内容续发。
async function runAnthropic({ model, query, purpose, timeoutMs, url, headers, label }) {
	const messages = [{ role: "user", content: buildPrompt(query, purpose) }];
	const blocks = [];
	let searched = false;
	for (let attempt = 0; ; attempt += 1) {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model,
				max_tokens: ANTHROPIC_MAX_TOKENS,
				system: buildSystemPrompt(),
				tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
				messages,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const responseBody = await response.text();
		if (!response.ok) throw parseResponseError(label, response, responseBody);
		let parsed;
		try {
			parsed = JSON.parse(responseBody);
		} catch {
			throw new Error(`${label} returned invalid JSON`);
		}
		const content = Array.isArray(parsed.content) ? parsed.content : [];
		blocks.push(...content);
		if ((parsed.usage?.server_tool_use?.web_search_requests ?? 0) > 0) searched = true;
		if (content.some((block) => block.type === "server_tool_use" || block.type === "web_search_tool_result")) searched = true;
		if (parsed.stop_reason !== "pause_turn") break;
		if (attempt >= ANTHROPIC_MAX_PAUSE_CONTINUATIONS) throw new Error(`${label} kept pausing after ${attempt + 1} requests`);
		messages.push({ role: "assistant", content });
	}
	if (!searched) throw noSearchError(label);
	// 引用会把正文拆成多个 text block，直接拼接以免断句。
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
		.trim();
	if (!text) throw new Error(`${label} returned no text`);
	return text;
}

function transportAttempts(transport, provider, api, modelId) {
	if (transport !== "auto") return [transport];
	if (provider === "openai-codex") {
		return isGpt56Lite(modelId) ? ["codex-alpha-search", "codex-responses"] : ["codex-responses"];
	}
	if (provider === "anthropic" || api === "anthropic-messages") return ["anthropic"];
	if (api === "openai-responses") {
		return provider === "sub2api" || (provider !== "openai" && isGpt56Lite(modelId))
			? ["alpha-search", "responses"]
			: ["responses"];
	}
	throw new Error(
		`Provider '${provider}' uses '${api || "unknown"}', which has no available automatic native search transport. ` +
			"Pass --transport with a compatible endpoint, or use the web-browser skill.",
	);
}

function baseHeaders(providerConfig, modelConfig, credential) {
	const headers = resolveHeaders(providerConfig.headers, modelConfig.headers);
	if (credential.value && providerConfig.authHeader !== false && modelConfig.authHeader !== false) {
		headers.authorization ||= `Bearer ${credential.value}`;
	}
	headers["content-type"] ||= "application/json";
	return headers;
}

function headersForTransport(transport, providerConfig, modelConfig, credential) {
	const headers = baseHeaders(providerConfig, modelConfig, credential);
	if (transport === "anthropic") {
		if (credential.kind === "bearer") {
			headers.authorization = `Bearer ${credential.value}`;
			headers["anthropic-beta"] ||= "claude-code-20250219,oauth-2025-04-20,web-search-2025-03-05";
			headers["x-app"] ||= "cli";
			headers["user-agent"] ||= "claude-cli/1.0.72 (external, cli)";
		} else if (credential.value) {
			delete headers.authorization;
			headers["x-api-key"] ||= credential.value;
		}
		headers["anthropic-version"] ||= "2023-06-01";
		headers["anthropic-beta"] ||= "web-search-2025-03-05";
		headers.accept ||= "application/json";
		return headers;
	}
	if (transport.startsWith("codex")) {
		const accountId = decodeJwtAccountId(credential.value);
		if (!accountId) throw new Error("Could not determine the ChatGPT account ID from the openai-codex token.");
		headers["chatgpt-account-id"] ||= accountId;
		headers.originator ||= "pi-native-web-search-skill";
	}
	headers.accept ||= transport.includes("alpha") ? "application/json" : "text/event-stream, application/json";
	return headers;
}

function endpointForTransport(transport, args, providerConfig, modelConfig) {
	if (args.endpoint) return new URL(args.endpoint).toString();
	const baseUrl = modelConfig.baseUrl || providerConfig.baseUrl;
	switch (transport) {
		case "responses":
			return endpoint(baseUrl || "https://api.openai.com/v1", "responses");
		case "alpha-search":
			return endpoint(baseUrl, "alpha/search");
		case "codex-responses":
			return codexResponsesEndpoint(baseUrl);
		case "codex-alpha-search":
			return codexAlphaEndpoint(baseUrl);
		case "anthropic":
			return endpoint(anthropicApiBase(baseUrl || "https://api.anthropic.com"), "messages");
		default:
			throw new Error(`Unsupported transport: ${transport}`);
	}
}

async function runTransport(transport, context) {
	const url = endpointForTransport(transport, context.args, context.providerConfig, context.modelConfig);
	const headers = headersForTransport(transport, context.providerConfig, context.modelConfig, context.credential);
	const common = {
		model: context.modelConfig.id,
		query: context.args.query,
		purpose: context.args.purpose,
		timeoutMs: context.args.timeoutMs,
		url,
		headers,
		label: `${context.provider}/${transport}`,
	};
	if (transport === "responses" || transport === "codex-responses") return runResponses(common);
	if (transport === "alpha-search" || transport === "codex-alpha-search") return runAlphaSearch(common);
	if (transport === "anthropic") return runAnthropic(common);
	throw new Error(`Unsupported transport: ${transport}`);
}

async function runWithFallback(attempts, context) {
	const attempted = [];
	for (const transport of attempts) {
		attempted.push(transport);
		try {
			const result = await runTransport(transport, {
				...context,
				args: {
					...context.args,
					endpoint: attempted.length === 1 ? context.args.endpoint : undefined,
				},
			});
			return { result, transport, attempted };
		} catch (error) {
			const mayFallback = error instanceof SearchTransportError && error.unsupported && attempted.length < attempts.length;
			if (!mayFallback) {
				throw new Error(
					`Search failed (provider=${context.provider}, model=${context.modelConfig.id}, transport=${transport}, ` +
					`timeout=${context.args.timeoutMs}ms, attempted=${attempted.join(" -> ")}): ${error.message || String(error)}`,
					{ cause: error },
				);
			}
		}
	}
	throw new Error("No web search transport completed successfully.");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}

	const agentDir = getAgentDir();
	const settings = readJson(join(agentDir, "settings.json"), {});
	const modelsConfig = readJson(join(agentDir, "models.json"), {});
	const auth = readJson(join(agentDir, "auth.json"), {});
	const provider = pickProvider(args, settings, auth);
	if (!provider) throw new Error("Could not determine the provider. Pass --provider or configure Pi's defaultProvider.");
	const providerConfig = getProviderConfig(modelsConfig, provider);
	const selectedModel = pickModel(args, provider, settings, providerConfig);
	const modelConfig = {
		...selectedModel,
		api:
			selectedModel.api ||
			providerConfig.api ||
			(provider === "anthropic" ? "anthropic-messages" : undefined) ||
			(provider === "openai" ? "openai-responses" : undefined),
		baseUrl: selectedModel.baseUrl || providerConfig.baseUrl,
	};
	const attempts = transportAttempts(args.transport, provider, modelConfig.api, modelConfig.id);
	const credential = getCredential(provider, providerConfig);
	const outcome = await runWithFallback(attempts, {
		args,
		provider,
		providerConfig,
		modelConfig,
		credential,
	});

	if (args.json) {
		console.log(JSON.stringify({
			provider,
			model: modelConfig.id,
			transport: outcome.transport,
			attemptedTransports: outcome.attempted,
			query: args.query,
			purpose: args.purpose,
			result: outcome.result,
		}, null, 2));
		return;
	}

	console.log(`Provider: ${provider}`);
	console.log(`Model: ${modelConfig.id}`);
	console.log(`Transport: ${outcome.transport}`);
	console.log("");
	console.log(outcome.result);
}

main().catch((error) => {
	console.error(`Error: ${error?.message || String(error)}`);
	process.exit(1);
});
