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

interface RegisteredTool {
	name: string;
	renderCall?: (...args: unknown[]) => Renderable;
	renderResult?: (...args: unknown[]) => Renderable;
}

interface Renderable {
	render: (width: number) => string[];
}

interface TestContext {
	modelRegistry: {
		getAll: () => { provider: string; id: string }[];
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	};
	model?: { provider: string; id: string };
	ui: {
		notify: (message: string, level: string) => void;
	};
}

type ExtensionHandler = (event: unknown, ctx: TestContext) => unknown;

const grokToolNames = [
	"Grep",
	"Glob",
	"LS",
	"Read",
	"Write",
	"StrReplace",
	"Delete",
	"Shell",
];

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

async function setupExtension(initialActiveTools = ["read", "bash"]) {
	const commands = new Map<string, CommandConfig>();
	const providers = new Map<string, ProviderConfig>();
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, ExtensionHandler>();
	let activeTools = initialActiveTools;
	const setActiveTools = vi.fn((toolNames: string[]) => {
		activeTools = toolNames;
	});
	const registerGrokCli = (await import("../../src/index.js")).default;
	registerGrokCli({
		registerProvider(name: string, config: ProviderConfig) {
			providers.set(name, config);
		},
		on(event: string, handler: ExtensionHandler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, config: unknown) {
			commands.set(name, config as CommandConfig);
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools,
	} as unknown as ExtensionAPI);
	return { commands, providers, tools, handlers, setActiveTools };
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

function contextForModel(provider: string): TestContext {
	return {
		model: { provider, id: `${provider}-model` },
		modelRegistry: { getAll: () => [] },
		ui: { notify: vi.fn() },
	};
}

function renderText(component: Renderable): string {
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n");
}

const theme = {
	bold: (text: string) => text,
	fg: (_name: string, text: string) => text,
};

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

describe("Grok CLI tool scoping", () => {
	it("registers the Grok/Cursor-native tool shims", async () => {
		const extension = await setupExtension();

		expect([...extension.tools.keys()].sort()).toEqual(
			[...grokToolNames].sort(),
		);
	});

	it("enables Grok tools for Grok models while preserving other active tools", async () => {
		const extension = await setupExtension(["read", "custom_tool"]);

		await extension.handlers.get("model_select")?.(
			{ model: { provider: "grok-cli", id: "grok-build" } },
			contextForModel("grok-cli"),
		);

		expect(extension.setActiveTools).toHaveBeenLastCalledWith([
			"read",
			"custom_tool",
			...grokToolNames,
		]);
	});

	it("removes Grok tools for non-Grok models while preserving other active tools", async () => {
		const extension = await setupExtension([
			"read",
			"Grep",
			"custom_tool",
			"Shell",
		]);

		await extension.handlers.get("model_select")?.(
			{ model: { provider: "openai", id: "gpt-4" } },
			contextForModel("openai"),
		);

		expect(extension.setActiveTools).toHaveBeenLastCalledWith([
			"read",
			"custom_tool",
		]);
	});

	it("syncs tool scope before each agent turn from the current context model", async () => {
		const extension = await setupExtension(["read"]);

		await extension.handlers.get("before_agent_start")?.(
			{},
			contextForModel("grok-cli"),
		);

		expect(extension.setActiveTools).toHaveBeenLastCalledWith([
			"read",
			...grokToolNames,
		]);
	});

	it("does not update active tools when the selection is already correct", async () => {
		const extension = await setupExtension(["read", ...grokToolNames]);

		await extension.handlers.get("before_agent_start")?.(
			{},
			contextForModel("grok-cli"),
		);

		expect(extension.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("Grok CLI tool rendering", () => {
	it("adds renderers to every Grok tool shim", async () => {
		const extension = await setupExtension();

		for (const name of grokToolNames) {
			expect(extension.tools.get(name)?.renderCall).toBeTypeOf("function");
			expect(extension.tools.get(name)?.renderResult).toBeTypeOf("function");
		}
	});

	it("keeps collapsed search output compact and expands to full output", async () => {
		const extension = await setupExtension();
		const grep = extension.tools.get("Grep");
		const result = {
			content: [{ type: "text", text: "src/a.ts:1:match\nsrc/b.ts:2:match" }],
			details: { matchCount: 2 },
		};

		const collapsed = renderText(
			grep?.renderResult?.(
				result,
				{ expanded: false, isPartial: false },
				theme,
				{},
			) as Renderable,
		);
		const expanded = renderText(
			grep?.renderResult?.(
				result,
				{ expanded: true, isPartial: false },
				theme,
				{},
			) as Renderable,
		);

		expect(collapsed).toBe("2 match(es)");
		expect(collapsed).not.toContain("src/a.ts");
		expect(expanded).toContain("src/a.ts:1:match");
	});

	it("renders compact summaries for file mutations, delete, and shell tools", async () => {
		const extension = await setupExtension();

		expect(
			renderText(
				extension.tools.get("Write")?.renderResult?.(
					{
						content: [{ type: "text", text: "long write output" }],
						details: { bytesWritten: 42 },
					},
					{ expanded: false, isPartial: false },
					theme,
					{},
				) as Renderable,
			),
		).toBe("42 bytes written");
		expect(
			renderText(
				extension.tools.get("StrReplace")?.renderResult?.(
					{
						content: [{ type: "text", text: "long replace output" }],
						details: { replacements: 3 },
					},
					{ expanded: false, isPartial: false },
					theme,
					{},
				) as Renderable,
			),
		).toBe("3 replacement(s)");
		expect(
			renderText(
				extension.tools.get("Delete")?.renderResult?.(
					{
						content: [{ type: "text", text: "long delete output" }],
						details: { deleted: true },
					},
					{ expanded: false, isPartial: false },
					theme,
					{},
				) as Renderable,
			),
		).toBe("Deleted");
		expect(
			renderText(
				extension.tools.get("Shell")?.renderResult?.(
					{
						content: [{ type: "text", text: "long shell output" }],
						details: { exitCode: 2 },
					},
					{ expanded: false, isPartial: false },
					theme,
					{},
				) as Renderable,
			),
		).toBe("Exit 2");
	});
});
