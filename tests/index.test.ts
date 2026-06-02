import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamSimpleOpenAIResponses = vi.fn(
	(
		_model: unknown,
		_context: unknown,
		options?: {
			onResponse?: (response: { headers: Record<string, string> }) => void;
		},
	) => {
		options?.onResponse?.({
			headers: {
				"x-ratelimit-remaining-requests": "179",
				"x-ratelimit-limit-requests": "180",
				"x-ratelimit-remaining-tokens": "7500000",
				"x-ratelimit-limit-tokens": "7500000",
				"x-grok-context-window": "512000",
				"x-zero-data-retention": "true",
			},
		});
		return {};
	},
);

vi.mock("@earendil-works/pi-ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-ai")>()),
	streamSimpleOpenAIResponses,
}));

interface CommandConfig {
	handler: (args: string[], ctx: TestContext) => Promise<void>;
}

interface TestContext {
	modelRegistry: {
		getAll: () => { provider: string; id: string }[];
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};
	ui: {
		notify: (message: string, level: string) => void;
	};
}

const originalFetch = globalThis.fetch;
const originalToken = process.env.GROK_CLI_OAUTH_TOKEN;

afterEach(() => {
	vi.resetModules();
	streamSimpleOpenAIResponses.mockClear();
	globalThis.fetch = originalFetch;
	if (originalToken === undefined) {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
		return;
	}
	process.env.GROK_CLI_OAUTH_TOKEN = originalToken;
});

async function setupExtension() {
	const commands = new Map<string, CommandConfig>();
	const providers = new Map<string, ProviderConfig>();
	const registerGrokCli = (await import("../src/index.js")).default;
	registerGrokCli({
		registerProvider(name: string, config: ProviderConfig) {
			providers.set(name, config);
		},
		on() {},
		registerCommand(name: string, config: unknown) {
			commands.set(name, config as CommandConfig);
		},
	} as unknown as ExtensionAPI);
	return { commands, providers };
}

function statusContext(notify: TestContext["ui"]["notify"]): TestContext {
	return {
		modelRegistry: {
			getAll: () => [
				{ provider: "grok-cli", id: "grok-build" },
				{ provider: "grok-cli", id: "grok-composer-2.5-fast" },
			],
		},
		ui: { notify },
	};
}

describe("Grok CLI status command", () => {
	it("uses only cached quota data and tells users to make requests first", async () => {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
		const fetchMock = vi.fn<typeof fetch>();
		globalThis.fetch = fetchMock;
		const extension = await setupExtension();
		const notify = vi.fn();

		await extension.commands
			.get("grok-cli-status")
			?.handler([], statusContext(notify));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(notify.mock.calls.at(-1)?.[0]).toBe(
			[
				"  Quota:",
				"",
				"  grok-build:",
				"    no cached quota data — make a request with this model first",
				"",
				"  grok-composer-2.5-fast:",
				"    no cached quota data — make a request with this model first",
			].join("\n"),
		);
	});

	it("shows separate cached quotas for build and composer", async () => {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
		const extension = await setupExtension();
		const provider = extension.providers.get("grok-cli");
		provider?.streamSimple?.(
			{ provider: "grok-cli", id: "grok-build" },
			{},
			{},
		);
		provider?.streamSimple?.(
			{ provider: "grok-cli", id: "grok-composer-2.5-fast" },
			{},
			{},
		);
		const notify = vi.fn();

		await extension.commands
			.get("grok-cli-status")
			?.handler([], statusContext(notify));

		expect(notify.mock.calls.at(-1)?.[0]).toContain("grok-build:\n    Cached:");
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"grok-composer-2.5-fast:\n    Cached:",
		);
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Requests: 179/180 remaining",
		);
	});
});
