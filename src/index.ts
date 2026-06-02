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

import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	streamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { XaiOAuthError } from "./errors.js";
import { type GrokCliModelConfig, resolveModels } from "./models.js";
import * as oauth from "./oauth.js";
import { getBaseUrl, type XaiOAuthCredentials } from "./oauth.js";
import { sanitizePayload } from "./sanitize.js";

// ─── Grok CLI version (observed from traffic capture) ─────────────────────────

const GROK_CLI_VERSION = "0.2.16";

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
				if (rateLimit) cachedRateLimits.set(model.id, rateLimit);
				options?.onResponse?.(response, model);
			},
		},
	);
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const baseUrl = getBaseUrl();
	const models = resolveModels();

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
