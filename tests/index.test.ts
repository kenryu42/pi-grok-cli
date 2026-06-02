import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const originalHome = process.env.HOME;
const originalToken = process.env.GROK_CLI_OAUTH_TOKEN;
const tempDirs: string[] = [];

afterEach(() => {
	vi.resetModules();
	streamSimpleOpenAIResponses.mockClear();
	globalThis.fetch = originalFetch;
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalToken === undefined) {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
	} else {
		process.env.GROK_CLI_OAUTH_TOKEN = originalToken;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
});

async function setupExtension() {
	const commands = new Map<string, CommandConfig>();
	const providers = new Map<string, ProviderConfig>();
	const tools = new Map<string, unknown>();
	const registerGrokCli = (await import("../src/index.js")).default;
	registerGrokCli({
		registerProvider(name: string, config: ProviderConfig) {
			providers.set(name, config);
		},
		on() {},
		registerCommand(name: string, config: unknown) {
			commands.set(name, config as CommandConfig);
		},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI);
	return { commands, providers, tools };
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

function setupHome() {
	const dir = mkdtempSync(join(tmpdir(), "pi-grok-cli-home-"));
	mkdirSync(join(dir, ".pi"));
	tempDirs.push(dir);
	process.env.HOME = dir;
	return dir;
}

async function runStatus(
	extension: Awaited<ReturnType<typeof setupExtension>>,
) {
	const notify = vi.fn();
	await extension.commands
		.get("grok-cli-status")
		?.handler([], statusContext(notify));
	return notify;
}

describe("Grok CLI status command", () => {
	it("uses only cached quota data and tells users to make requests first", async () => {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
		setupHome();
		const fetchMock = vi.fn<typeof fetch>();
		globalThis.fetch = fetchMock;
		const extension = await setupExtension();
		const notify = await runStatus(extension);

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
		setupHome();
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
		const notify = await runStatus(extension);

		expect(notify.mock.calls.at(-1)?.[0]).toContain("grok-build:\n    Cached:");
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"grok-composer-2.5-fast:\n    Cached:",
		);
		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Requests: 179/180 remaining",
		);
	});

	it("persists cached quotas to the global pi config directory", async () => {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
		const home = setupHome();
		const extension = await setupExtension();
		extension.providers
			.get("grok-cli")
			?.streamSimple?.({ provider: "grok-cli", id: "grok-build" }, {}, {});

		expect(
			JSON.parse(readFileSync(join(home, ".pi", "grok-cli-quota.json"), "utf8"))
				.models["grok-build"].remainingRequests,
		).toBe(179);
	});

	it("loads cached quotas from the global pi config directory", async () => {
		delete process.env.GROK_CLI_OAUTH_TOKEN;
		const home = setupHome();
		writeFileSync(
			join(home, ".pi", "grok-cli-quota.json"),
			JSON.stringify({
				version: 1,
				models: {
					"grok-build": {
						remainingRequests: 42,
						limitRequests: 180,
						remainingTokens: 1_000,
						limitTokens: 2_000,
						contextWindow: 512_000,
						zeroDataRetention: true,
						capturedAt: Date.now(),
					},
				},
			}),
		);
		const extension = await setupExtension();
		const notify = await runStatus(extension);

		expect(notify.mock.calls.at(-1)?.[0]).toContain(
			"Requests: 42/180 remaining",
		);
	});
});
