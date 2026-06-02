import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerGrokTools } from "../../src/tools/register.js";

describe("Grok tool registration", () => {
	it("registers all Grok/Cursor-native tool shims with renderers", () => {
		const toolNames: string[] = [];

		registerGrokTools({
			registerTool(tool: {
				name: string;
				renderCall?: unknown;
				renderResult?: unknown;
			}) {
				toolNames.push(tool.name);
				expect(tool.renderCall).toBeTypeOf("function");
				expect(tool.renderResult).toBeTypeOf("function");
			},
		} as unknown as ExtensionAPI);

		expect(toolNames.sort()).toEqual([
			"Delete",
			"Glob",
			"Grep",
			"LS",
			"Read",
			"Shell",
			"StrReplace",
			"Write",
		]);
	});
});
