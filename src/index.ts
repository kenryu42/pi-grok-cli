/**
 * pi-grok-cli — Grok CLI API provider for pi
 *
 * Brings access to the Grok CLI's endpoint
 * into pi. This endpoint has access to models not available on the public
 * xAI API, including grok-composer-2.5-fast (Cursor's Composer 2.5 model).
 *
 * Environment variables:
 *   PI_GROK_CLI_BASE_URL     - Override the API base URL
 *   PI_GROK_CLI_MODELS       - Comma-separated model IDs to expose
 *   PI_GROK_CLI_OAUTH_CLIENT_ID  - Override OAuth client ID
 *   PI_GROK_CLI_OAUTH_SCOPE      - Override OAuth scopes
 */

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	streamSimpleOpenAIResponses,
	Type,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

import { XaiOAuthError } from "./errors.js";
import { type GrokCliModelConfig, resolveModels } from "./models.js";
import * as oauth from "./oauth.js";
import { getBaseUrl, type XaiOAuthCredentials } from "./oauth.js";
import { sanitizePayload } from "./sanitize.js";

// ─── Grok CLI version (observed from traffic capture) ─────────────────────────

const GROK_CLI_VERSION = "0.2.16";
const QUOTA_CACHE_FILE = "grok-cli-quota.json";
const GROK_TOOL_NAMES = [
	"Grep",
	"Glob",
	"LS",
	"Read",
	"Write",
	"StrReplace",
	"Delete",
	"Shell",
];

// ─── Rate limit cache (piggybacks on onResponse from normal traffic) ──────────

interface RateLimitInfo {
	remainingRequests: number;
	limitRequests: number;
	remainingTokens: number;
	limitTokens: number;
	contextWindow: number;
	zeroDataRetention: boolean;
	capturedAt: number;
}

const cachedRateLimits = new Map<string, RateLimitInfo>();

function quotaCachePath() {
	return join(homedir(), ".pi", QUOTA_CACHE_FILE);
}

function isRateLimitInfo(value: unknown): value is RateLimitInfo {
	if (!value || typeof value !== "object") return false;
	const info = value as Record<string, unknown>;
	return (
		typeof info.remainingRequests === "number" &&
		typeof info.limitRequests === "number" &&
		typeof info.remainingTokens === "number" &&
		typeof info.limitTokens === "number" &&
		typeof info.contextWindow === "number" &&
		typeof info.zeroDataRetention === "boolean" &&
		typeof info.capturedAt === "number"
	);
}

function loadQuotaCache() {
	cachedRateLimits.clear();
	if (!existsSync(quotaCachePath())) return;

	try {
		const payload = JSON.parse(
			readFileSync(quotaCachePath(), "utf8"),
		) as Record<string, unknown>;
		const models = payload.models;
		if (!models || typeof models !== "object") return;

		Object.entries(models).forEach(([model, rateLimit]) => {
			if (isRateLimitInfo(rateLimit)) cachedRateLimits.set(model, rateLimit);
		});
	} catch {
		cachedRateLimits.clear();
	}
}

function persistQuotaCache() {
	try {
		mkdirSync(dirname(quotaCachePath()), { recursive: true });
		writeFileSync(
			quotaCachePath(),
			JSON.stringify(
				{ version: 1, models: Object.fromEntries(cachedRateLimits) },
				null,
				"\t",
			),
		);
	} catch {
		// Status remains cache-only; persistence failures should not break requests.
	}
}

/**
 * Extract rate limit info from response headers.
 * Returns undefined if no rate limit headers are present.
 */
function extractRateLimit(
	h: Record<string, string>,
): RateLimitInfo | undefined {
	const remainingReqs = Number(h["x-ratelimit-remaining-requests"]);
	const limitReqs = Number(h["x-ratelimit-limit-requests"]);
	const remainingTokens = Number(h["x-ratelimit-remaining-tokens"]);
	const limitTokens = Number(h["x-ratelimit-limit-tokens"]);
	const contextWindow = Number(h["x-grok-context-window"]);

	if (Number.isNaN(remainingReqs) && Number.isNaN(remainingTokens))
		return undefined;

	return {
		remainingRequests: remainingReqs,
		limitRequests: limitReqs,
		remainingTokens,
		limitTokens,
		contextWindow: contextWindow || 512_000,
		zeroDataRetention: h["x-zero-data-retention"] === "true",
		capturedAt: Date.now(),
	};
}

function formatQuota(name: string, rateLimit: RateLimitInfo | undefined) {
	if (!rateLimit) {
		return [
			`  ${name}:`,
			"    no cached quota data — make a request with this model first",
		];
	}

	const ageSec = Math.round((Date.now() - rateLimit.capturedAt) / 1000);
	const ageStr =
		ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
	const lines = [`  ${name}:`];
	lines.push(`    Cached: ${ageStr}`);
	lines.push(
		`    Requests: ${rateLimit.remainingRequests}/${rateLimit.limitRequests} remaining`,
	);
	lines.push(
		`    Tokens:   ${rateLimit.remainingTokens.toLocaleString()}/${rateLimit.limitTokens.toLocaleString()} remaining`,
	);
	lines.push(
		`    Context Limit: ${rateLimit.contextWindow.toLocaleString()} tokens`,
	);
	if (rateLimit.zeroDataRetention) {
		lines.push("    Data:     Zero retention ✓");
	}
	return lines;
}

// ─── Stream function ─────────────────────────────────────────────────────────

/**
 * Stream function that adds Grok CLI-specific headers to requests.
 *
 * The real Grok CLI sends these headers:
 *   - x-grok-client-identifier: grok-shell
 *   - x-grok-client-version: 0.2.16
 *   - x-grok-conv-id: <session/conversation ID>
 *   - x-grok-model-override: <model ID>
 *   - x-xai-token-auth: xai-grok-cli
 */
function streamGrokCli(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const sessionId = options?.sessionId;
	const headers: Record<string, string> = {
		...options?.headers,
		"x-grok-client-identifier": "pi-grok-cli",
		"x-grok-client-version": GROK_CLI_VERSION,
		"x-xai-token-auth": "xai-grok-cli",
		"x-grok-model-override": model.id,
	};

	if (sessionId) {
		headers["x-grok-conv-id"] = sessionId;
	}

	return streamSimpleOpenAIResponses(
		model as Model<"openai-responses">,
		context,
		{
			...options,
			headers,
			onResponse(response) {
				const rateLimit = extractRateLimit(response.headers);
				if (rateLimit) {
					cachedRateLimits.set(model.id, rateLimit);
					persistQuotaCache();
				}
				options?.onResponse?.(response, model);
			},
		},
	);
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	loadQuotaCache();
	const baseUrl = getBaseUrl();
	const models = resolveModels();

	function syncGrokTools(provider: string | undefined) {
		const currentTools = pi.getActiveTools();
		const baseTools = currentTools.filter(
			(toolName) => !GROK_TOOL_NAMES.includes(toolName),
		);
		const nextTools =
			provider === "grok-cli" ? [...baseTools, ...GROK_TOOL_NAMES] : baseTools;

		if (
			currentTools.length === nextTools.length &&
			currentTools.every((toolName, i) => toolName === nextTools[i])
		) {
			return;
		}

		pi.setActiveTools(nextTools);
	}

	pi.on("model_select", (event) => {
		syncGrokTools(event.model.provider);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		syncGrokTools(ctx.model?.provider);
	});

	// ── Register provider ─────────────────────────────────────────────────
	pi.registerProvider("grok-cli", {
		name: "Grok CLI",
		baseUrl,
		apiKey: "$GROK_CLI_OAUTH_TOKEN",
		api: "openai-responses",
		models: models.map((m: GrokCliModelConfig) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
		oauth: {
			name: "Grok CLI",

			async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				return oauth.login(callbacks);
			},

			async refreshToken(
				credentials: OAuthCredentials,
			): Promise<OAuthCredentials> {
				return oauth.refresh(credentials);
			},

			getApiKey(credentials: OAuthCredentials): string {
				return credentials.access;
			},

			modifyModels(models: Model<Api>[], credentials: OAuthCredentials) {
				const effectiveBaseUrl = String(
					(credentials as XaiOAuthCredentials).baseUrl ?? getBaseUrl(),
				).replace(/\/+$/, "");

				return models.map((m) =>
					m.provider === "grok-cli" ? { ...m, baseUrl: effectiveBaseUrl } : m,
				);
			},
		} satisfies ProviderConfig["oauth"],

		streamSimple: streamGrokCli,
	});

	// ── Register Grok/Cursor-native tools ──────────────────────────────────

	const MAX_OUTPUT_CHARS = 50_000;
	const MAX_LINES = 500;

	function truncateLines(lines: string[]): string {
		if (lines.length > MAX_LINES) {
			return (
				lines.slice(0, MAX_LINES).join("\n") +
				`\n\n[Showing first ${MAX_LINES} of ${lines.length} results. Refine your pattern to narrow results.]`
			);
		}
		return lines.join("\n");
	}

	function truncateChars(output: string): string {
		if (output.length > MAX_OUTPUT_CHARS) {
			return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`;
		}
		return output;
	}

	let rgAvailable: boolean | undefined;
	async function hasRipgrep(): Promise<boolean> {
		if (rgAvailable !== undefined) return rgAvailable;
		try {
			await execFileAsync("rg", ["--version"]);
			rgAvailable = true;
		} catch {
			rgAvailable = false;
		}
		return rgAvailable;
	}

	type ToolError = { code?: number; message?: string };
	type ToolResult<T> = {
		content: [{ type: "text"; text: string }];
		details: T;
	};

	function text(text: string): Text {
		return new Text(text, 0, 0);
	}

	function firstText(result: { content: { type: string; text?: string }[] }) {
		const first = result.content[0];
		if (first?.type !== "text") return undefined;
		return first.text;
	}

	function renderResultText(
		result: { content: { type: string; text?: string }[] },
		expanded: boolean,
		summary: string,
	): Text {
		if (expanded) return text(firstText(result) ?? summary);
		return text(summary);
	}

	function renderRunning(isPartial: boolean): Text | undefined {
		if (!isPartial) return undefined;
		return text("Running...");
	}

	function detailRecord(result: { details: unknown }): Record<string, unknown> {
		if (!result.details || typeof result.details !== "object") return {};
		return result.details as Record<string, unknown>;
	}

	function numberDetail(result: { details: unknown }, key: string): number {
		const value = detailRecord(result)[key];
		if (typeof value !== "number") return 0;
		return value;
	}

	function stringDetail(result: { details: unknown }, key: string): string {
		const value = detailRecord(result)[key];
		if (typeof value !== "string") return "";
		return value;
	}

	function booleanDetail(result: { details: unknown }, key: string): boolean {
		const value = detailRecord(result)[key];
		return value === true;
	}

	type FileDetails = { path: string; [key: string]: unknown };

	function fileNotFound<T extends FileDetails>(
		filePath: string,
		extraDetails: Omit<T, "path">,
	): ToolResult<T> {
		return {
			content: [{ type: "text", text: `File not found: ${filePath}` }],
			details: { path: filePath, ...extraDetails } as T,
		};
	}

	function fileError<T extends FileDetails>(
		error: unknown,
		toolName: string,
		filePath: string,
		extraDetails: Omit<T, "path">,
	): ToolResult<T> {
		const err = error as ToolError;
		return {
			content: [
				{
					type: "text",
					text: `${toolName} error: ${err.message ?? "Unknown error"}`,
				},
			],
			details: { path: filePath, ...extraDetails } as T,
		};
	}

	function toolError<T>(
		error: unknown,
		toolName: string,
		emptyDetails: T,
	): ToolResult<T> {
		const err = error as ToolError;
		if (err.code === 1) {
			return {
				content: [{ type: "text", text: "No matches found" }],
				details: emptyDetails,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: `${toolName} error: ${err.message ?? "Unknown error"}`,
				},
			],
			details: emptyDetails,
		};
	}

	async function execWithRgFallback(
		rgArgs: string[],
		grepArgs: string[],
		options: { cwd: string; signal?: AbortSignal },
	): Promise<string> {
		if (await hasRipgrep()) {
			const result = await execFileAsync("rg", rgArgs, {
				cwd: options.cwd,
				maxBuffer: MAX_OUTPUT_CHARS * 2,
				signal: options.signal,
			});
			return result.stdout;
		}
		const result = await execFileAsync("grep", grepArgs, {
			cwd: options.cwd,
			maxBuffer: MAX_OUTPUT_CHARS * 2,
			signal: options.signal,
		});
		return result.stdout;
	}

	const GrepParams = Type.Object({
		pattern: Type.String({
			description: "Regex pattern to search for in file contents",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"Directory or file to search. Defaults to current working directory.",
			}),
		),
		include: Type.Optional(
			Type.String({
				description:
					"Glob pattern to filter which files are searched (e.g. *.ts, **/*.md)",
			}),
		),
	});

	pi.registerTool({
		name: "Grep",
		label: "Grep",
		description:
			"Search for a regex pattern in file contents. Returns matching lines with file path and line number. Use the include parameter to filter by file type.",
		parameters: GrepParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = resolve(ctx.cwd, params.path ?? ".");

			try {
				const rgArgs = ["-n", "--no-heading", "--color=never"];
				if (params.include) rgArgs.push("--glob", params.include);
				rgArgs.push(params.pattern, searchPath);

				const grepArgs = ["-r", "-n", "--color=never"];
				if (params.include) grepArgs.push(`--include=${params.include}`);
				grepArgs.push(params.pattern, searchPath);

				const stdout = await execWithRgFallback(rgArgs, grepArgs, {
					cwd: ctx.cwd,
					signal,
				});

				const lines = stdout.trim().split("\n").filter(Boolean);
				if (lines.length === 0) {
					return {
						content: [{ type: "text", text: "No matches found" }],
						details: { matchCount: 0 },
					};
				}

				return {
					content: [
						{ type: "text", text: truncateChars(truncateLines(lines)) },
					],
					details: { matchCount: lines.length },
				};
			} catch (error: unknown) {
				return toolError(error, "Grep", { matchCount: 0 });
			}
		},
		renderCall(args, theme) {
			const path = args.path ? theme.fg("muted", ` in ${args.path}`) : "";
			const include = args.include ? theme.fg("dim", ` [${args.include}]`) : "";
			return text(
				theme.fg("toolTitle", theme.bold("Grep ")) +
					theme.fg("accent", `"${args.pattern}"`) +
					path +
					include,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const running = renderRunning(isPartial);
			if (running) return running;
			const matchCount = numberDetail(result, "matchCount");
			return renderResultText(
				result,
				expanded,
				matchCount === 0
					? theme.fg("dim", "No matches")
					: theme.fg("muted", `${matchCount} match(es)`),
			);
		},
	});

	const GlobParams = Type.Object({
		pattern: Type.String({
			description: "Glob pattern to match files (e.g. **/*.ts, src/**/*.json)",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"Directory to search within. Defaults to current working directory.",
			}),
		),
	});

	pi.registerTool({
		name: "Glob",
		label: "Glob",
		description:
			"Find files matching a glob pattern. Returns a list of matching file paths sorted by modification time (newest first).",
		parameters: GlobParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = resolve(ctx.cwd, params.path ?? ".");

			try {
				let files: string[];

				if (await hasRipgrep()) {
					const result = await execFileAsync(
						"rg",
						["--files", "--color=never", "--glob", params.pattern, searchPath],
						{ cwd: ctx.cwd, maxBuffer: MAX_OUTPUT_CHARS * 2, signal },
					);
					files = result.stdout.trim().split("\n").filter(Boolean);
				} else {
					// find fallback — convert **/*.ext → -name "*.ext"
					const basename = params.pattern.replace(/^(\*\*\/)+/, "");
					const result = await execFileAsync(
						"find",
						[searchPath, "-type", "f", "-name", basename],
						{ cwd: ctx.cwd, maxBuffer: MAX_OUTPUT_CHARS * 2, signal },
					);
					files = result.stdout.trim().split("\n").filter(Boolean);
				}

				if (files.length === 0) {
					return {
						content: [{ type: "text", text: "No files found" }],
						details: { fileCount: 0 },
					};
				}

				return {
					content: [
						{ type: "text", text: truncateChars(truncateLines(files)) },
					],
					details: { fileCount: files.length },
				};
			} catch (error: unknown) {
				return toolError(error, "Glob", { fileCount: 0 });
			}
		},
		renderCall(args, theme) {
			const path = args.path ? theme.fg("muted", ` in ${args.path}`) : "";
			return text(
				theme.fg("toolTitle", theme.bold("Glob ")) +
					theme.fg("accent", args.pattern) +
					path,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const running = renderRunning(isPartial);
			if (running) return running;
			const fileCount = numberDetail(result, "fileCount");
			return renderResultText(
				result,
				expanded,
				fileCount === 0
					? theme.fg("dim", "No files")
					: theme.fg("muted", `${fileCount} file(s)`),
			);
		},
	});

	// ── LS tool ──────────────────────────────────────────────────────────

	const LsParams = Type.Object({
		path: Type.String({
			description: "Directory path to list",
		}),
	});

	pi.registerTool({
		name: "LS",
		label: "LS",
		description: "List the contents of a directory, including hidden files.",
		parameters: LsParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const targetPath = resolve(ctx.cwd, params.path);

			try {
				const { stdout } = await execFileAsync("ls", ["-la", targetPath], {
					cwd: ctx.cwd,
					maxBuffer: MAX_OUTPUT_CHARS * 2,
					signal,
				});

				let output = stdout.trim();
				if (output.length > MAX_OUTPUT_CHARS) {
					output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[LS: output truncated at 50KB]`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: { path: targetPath },
				};
			} catch (error: unknown) {
				const err = error as ToolError;
				return {
					content: [
						{
							type: "text",
							text: `LS error: ${err.message ?? "Unknown error"}`,
						},
					],
					details: { path: targetPath },
				};
			}
		},
		renderCall(args, theme) {
			return text(
				theme.fg("toolTitle", theme.bold("LS ")) +
					theme.fg("accent", args.path),
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const running = renderRunning(isPartial);
			if (running) return running;
			return renderResultText(
				result,
				expanded,
				theme.fg("muted", stringDetail(result, "path")),
			);
		},
	});

	// ── Read tool ────────────────────────────────────────────────────────

	const ReadParams = Type.Object({
		path: Type.String({
			description: "Path to the file to read",
		}),
		offset: Type.Optional(
			Type.Number({
				description: "Line number to start reading from (0-indexed)",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum number of lines to read",
			}),
		),
	});

	pi.registerTool({
		name: "Read",
		label: "Read",
		description:
			"Read the contents of a file. Returns the file content with line numbers.",
		parameters: ReadParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);

			try {
				if (!existsSync(filePath)) {
					return fileNotFound(filePath, { exists: false, totalLines: 0 });
				}

				const content = readFileSync(filePath, "utf-8");
				const lines = content.split("\n");

				const startLine = params.offset ?? 0;
				const endLine = params.limit
					? Math.min(startLine + params.limit, lines.length)
					: Math.min(startLine + 2000, lines.length);

				const selectedLines = lines.slice(startLine, endLine);
				const numberedLines = selectedLines.map(
					(line, i) => `${startLine + i + 1}\t${line}`,
				);

				let output = numberedLines.join("\n");
				if (endLine < lines.length) {
					output += `\n\n[Showing lines ${startLine + 1}-${endLine} of ${lines.length} total lines. Use offset to see more.]`;
				}

				if (output.length > MAX_OUTPUT_CHARS) {
					output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`;
				}

				return {
					content: [{ type: "text", text: output }],
					details: { path: filePath, totalLines: lines.length },
				};
			} catch (error: unknown) {
				return fileError(error, "Read", filePath, {
					exists: false,
					totalLines: 0,
				});
			}
		},
		renderCall(args, theme) {
			const range =
				args.offset !== undefined || args.limit !== undefined
					? theme.fg(
							"muted",
							` (from ${args.offset ?? 0}${args.limit ? `, ${args.limit} lines` : ""})`,
						)
					: "";
			return text(
				theme.fg("toolTitle", theme.bold("Read ")) +
					theme.fg("accent", args.path) +
					range,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const running = renderRunning(isPartial);
			if (running) return running;
			return renderResultText(
				result,
				expanded,
				detailRecord(result).exists === false
					? theme.fg("error", "File not found")
					: theme.fg("muted", `${numberDetail(result, "totalLines")} line(s)`),
			);
		},
	});

	// ── Write tool ───────────────────────────────────────────────────────

	const WriteParams = Type.Object({
		path: Type.String({
			description: "Path to the file to write",
		}),
		content: Type.String({
			description: "Content to write to the file",
		}),
	});

	pi.registerTool({
		name: "Write",
		label: "Write",
		description:
			"Create or overwrite a file with the given content. Creates parent directories if needed.",
		parameters: WriteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);

			try {
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, params.content, "utf-8");

				return {
					content: [
						{
							type: "text",
							text: `Successfully wrote ${params.content.length} bytes to ${params.path}`,
						},
					],
					details: { path: filePath, bytesWritten: params.content.length },
				};
			} catch (error: unknown) {
				const err = error as ToolError;
				return {
					content: [
						{
							type: "text",
							text: `Write error: ${err.message ?? "Unknown error"}`,
						},
					],
					details: { path: filePath, bytesWritten: 0 },
				};
			}
		},
		renderCall(args, theme) {
			return text(
				theme.fg("toolTitle", theme.bold("Write ")) +
					theme.fg("accent", args.path),
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const running = renderRunning(isPartial);
			if (running) return running;
			return renderResultText(
				result,
				expanded,
				theme.fg(
					"muted",
					`${numberDetail(result, "bytesWritten")} bytes written`,
				),
			);
		},
	});

	// ── StrReplace tool ──────────────────────────────────────────────────

	const StrReplaceParams = Type.Object({
		path: Type.String({
			description: "Path to the file to modify",
		}),
		old_str: Type.String({
			description: "String to search for (exact match)",
		}),
		new_str: Type.String({
			description: "String to replace with",
		}),
	});

	pi.registerTool({
		name: "StrReplace",
		label: "StrReplace",
		description:
			"Replace all occurrences of a string in a file. The old_str must be an exact match.",
		parameters: StrReplaceParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);

			try {
				if (!existsSync(filePath)) {
					return fileNotFound(filePath, { replacements: 0 });
				}

				const content = readFileSync(filePath, "utf-8");
				const count = content.split(params.old_str).length - 1;

				if (count === 0) {
					return {
						content: [
							{
								type: "text",
								text: `String not found in ${params.path}: "${params.old_str}"`,
							},
						],
						details: { path: filePath, replacements: 0 },
					};
				}

				const newContent = content.replaceAll(params.old_str, params.new_str);
				writeFileSync(filePath, newContent, "utf-8");

				return {
					content: [
						{
							type: "text",
							text: `Replaced ${count} occurrence(s) in ${params.path}`,
						},
					],
					details: { path: filePath, replacements: count },
				};
			} catch (error: unknown) {
				return fileError(error, "StrReplace", filePath, { replacements: 0 });
			}
		},
		renderCall(args, theme) {
			return text(
				theme.fg("toolTitle", theme.bold("StrReplace ")) +
					theme.fg("accent", args.path),
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const running = renderRunning(isPartial);
			if (running) return running;
			return renderResultText(
				result,
				expanded,
				numberDetail(result, "replacements") === 0
					? theme.fg("dim", "No replacements")
					: theme.fg(
							"muted",
							`${numberDetail(result, "replacements")} replacement(s)`,
						),
			);
		},
	});

	// ── Delete tool ──────────────────────────────────────────────────────

	const DeleteParams = Type.Object({
		path: Type.String({
			description: "Path to the file to delete",
		}),
	});

	pi.registerTool({
		name: "Delete",
		label: "Delete",
		description: "Delete a file from the filesystem.",
		parameters: DeleteParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);

			try {
				if (!existsSync(filePath)) {
					return fileNotFound(filePath, { deleted: false });
				}

				unlinkSync(filePath);

				return {
					content: [
						{ type: "text", text: `Successfully deleted ${params.path}` },
					],
					details: { path: filePath, deleted: true },
				};
			} catch (error: unknown) {
				return fileError(error, "Delete", filePath, { deleted: false });
			}
		},
		renderCall(args, theme) {
			return text(
				theme.fg("toolTitle", theme.bold("Delete ")) +
					theme.fg("accent", args.path),
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const running = renderRunning(isPartial);
			if (running) return running;
			return renderResultText(
				result,
				expanded,
				booleanDetail(result, "deleted")
					? theme.fg("muted", "Deleted")
					: theme.fg("error", "Not deleted"),
			);
		},
	});

	// ── Shell tool ───────────────────────────────────────────────────────

	const ShellParams = Type.Object({
		command: Type.String({
			description: "Shell command to execute",
		}),
		working_directory: Type.Optional(
			Type.String({
				description: "Working directory for the command",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description: "Timeout in milliseconds (default: 120000)",
			}),
		),
	});

	pi.registerTool({
		name: "Shell",
		label: "Shell",
		description:
			"Execute a shell command and return stdout, stderr, and exit code.",
		parameters: ShellParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = params.working_directory
				? resolve(ctx.cwd, params.working_directory)
				: ctx.cwd;
			const timeout = params.timeout ?? 120_000;

			try {
				const { stdout, stderr } = await execFileAsync(
					"bash",
					["-c", params.command],
					{
						cwd,
						maxBuffer: MAX_OUTPUT_CHARS * 2,
						timeout,
						signal,
					},
				);

				let output = "";
				if (stdout) output += stdout;
				if (stderr) output += `\n[stderr]\n${stderr}`;

				if (output.length > MAX_OUTPUT_CHARS) {
					output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`;
				}

				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { exitCode: 0, command: params.command },
				};
			} catch (error: unknown) {
				const err = error as {
					code?: number;
					message?: string;
					stdout?: string;
					stderr?: string;
				};

				let output = "";
				if (err.stdout) output += err.stdout;
				if (err.stderr) output += `\n[stderr]\n${err.stderr}`;

				if (output.length > MAX_OUTPUT_CHARS) {
					output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated at 50KB]`;
				}

				return {
					content: [
						{
							type: "text",
							text: `Shell error (exit code ${err.code ?? "unknown"}): ${err.message ?? "Unknown error"}${output ? `\n${output}` : ""}`,
						},
					],
					details: {
						exitCode: err.code ?? 1,
						command: params.command,
					},
				};
			}
		},
		renderCall(args, theme) {
			const cwd = args.working_directory
				? theme.fg("muted", ` in ${args.working_directory}`)
				: "";
			return text(
				theme.fg("toolTitle", theme.bold("Shell ")) +
					theme.fg("accent", args.command) +
					cwd,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const running = renderRunning(isPartial);
			if (running) return running;
			return renderResultText(
				result,
				expanded,
				numberDetail(result, "exitCode") === 0
					? theme.fg("muted", "Exit 0")
					: theme.fg("warning", `Exit ${numberDetail(result, "exitCode")}`),
			);
		},
	});

	// ── Payload sanitization via event ────────────────────────────────────
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "grok-cli") return;

		const modelId = ctx.model?.id ?? "";
		const sessionId = ctx.sessionManager?.getSessionId();
		return sanitizePayload(
			event.payload as Record<string, unknown>,
			modelId,
			sessionId,
		);
	});

	// ── /grok-cli-status command ─────────────────────────────────────────
	pi.registerCommand("grok-cli-status", {
		description: "Show Grok CLI provider status, quota, and token health",
		handler: async (_args, ctx) => {
			const token = process.env.GROK_CLI_OAUTH_TOKEN;
			if (token) {
				ctx.ui.notify(
					"⚠️  Grok CLI: using GROK_CLI_OAUTH_TOKEN env bypass — no auto-refresh available",
					"warning",
				);
			}

			try {
				const registry = ctx.modelRegistry;
				const grokModels = registry
					.getAll()
					.filter((m: Model<Api>) => m.provider === "grok-cli");
				if (grokModels.length === 0) {
					ctx.ui.notify(
						"Grok CLI: no models registered. Run /login grok-cli first.",
						"warning",
					);
					return;
				}

				const modelNames = grokModels
					.slice(0, 5)
					.map((m: Model<Api>) => m.id)
					.join(", ");
				const suffix =
					grokModels.length > 5 ? ` (+${grokModels.length - 5} more)` : "";
				ctx.ui.notify(
					`✓ Grok CLI: ${grokModels.length} models available (${modelNames}${suffix})`,
					"info",
				);

				const lines = [
					"  Quota:",
					"",
					...formatQuota("grok-build", cachedRateLimits.get("grok-build")),
					"",
					...formatQuota(
						"grok-composer-2.5-fast",
						cachedRateLimits.get("grok-composer-2.5-fast"),
					),
				];
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				const msg =
					err instanceof XaiOAuthError
						? `${err.message} (code: ${err.code})`
						: err instanceof Error
							? err.message
							: String(err);
				ctx.ui.notify(`Grok CLI: ${msg}`, "warning");
			}
		},
	});

	// ── Warn on env bypass ────────────────────────────────────────────────
	if (process.env.GROK_CLI_OAUTH_TOKEN) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				"[pi-grok-cli] Using GROK_CLI_OAUTH_TOKEN bypass — no auto-refresh, no model discovery",
				"warning",
			);
		});
	}
}
