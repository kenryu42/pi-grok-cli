import type {
	Api,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import * as oauth from "../auth/oauth.js";
import { getBaseUrl, type XaiOAuthCredentials } from "../auth/oauth.js";
import { type GrokCliModelConfig, resolveModels } from "../models/catalog.js";
import { sanitizePayload } from "../payload/sanitize.js";
import { registerGrokTools } from "../tools/register.js";
import { loadQuotaCache } from "./quota.js";
import { registerStatusCommand } from "./status.js";
import { streamGrokCli } from "./stream.js";
import { syncGrokTools } from "./toolScope.js";

export default function registerGrokCli(pi: ExtensionAPI) {
	loadQuotaCache();
	const baseUrl = getBaseUrl();
	const models = resolveModels();

	pi.on("model_select", (event) => {
		syncGrokTools(pi, event.model.provider);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		syncGrokTools(pi, ctx.model?.provider);
	});

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

	registerGrokTools(pi);

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

	registerStatusCommand(pi);

	if (process.env.GROK_CLI_OAUTH_TOKEN) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				"[pi-grok-cli] Using GROK_CLI_OAUTH_TOKEN bypass — no auto-refresh, no model discovery",
				"warning",
			);
		});
	}
}
