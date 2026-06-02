import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerSearchTools } from "../../src/tools/search.js";
import {
	collectTools,
	executePreparedTool,
	executeTool,
	firstText,
	plainTheme,
	renderText,
	type ToolResult,
	tempDir,
} from "./toolTestHelpers.js";

function setupProject() {
	const dir = tempDir("pi-grok-cli-search-");
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "alpha.ts"), "needle\nhaystack\n", "utf-8");
	writeFileSync(join(dir, "src", "beta.md"), "needle in docs\n", "utf-8");
	writeFileSync(join(dir, "src", "gamma.ts"), "plain text\n", "utf-8");
	return dir;
}

function expectGrepResult(cwd: string, result: ToolResult) {
	expect(firstText(result)).toContain(
		`${join(cwd, "src", "alpha.ts")}:1:needle`,
	);
	expect(firstText(result)).not.toContain("beta.md");
	expect(result.details).toEqual({ matchCount: 1 });
}

function expectGlobResult(cwd: string, result: ToolResult) {
	expect(firstText(result)).toContain(join(cwd, "src", "alpha.ts"));
	expect(firstText(result)).toContain(join(cwd, "src", "gamma.ts"));
	expect(firstText(result)).not.toContain("beta.md");
	expect(result.details).toEqual({ fileCount: 2 });
}

describe("search tools", () => {
	it("greps matching file contents with include filters", async () => {
		const cwd = setupProject();
		const result = await executeTool(
			collectTools(registerSearchTools).get("Grep"),
			{ pattern: "needle", path: "src", include: "*.ts" },
			cwd,
		);

		expectGrepResult(cwd, result);
	});

	it("greps matching file contents with Cursor-style glob filters", async () => {
		const cwd = setupProject();
		const result = await executePreparedTool(
			collectTools(registerSearchTools).get("Grep"),
			{ pattern: "needle", path: "src", glob_filter: "*.ts" },
			cwd,
		);

		expectGrepResult(cwd, result);
	});

	it("reports no grep matches as an empty result", async () => {
		const cwd = setupProject();
		const result = await executeTool(
			collectTools(registerSearchTools).get("Grep"),
			{ pattern: "absent", path: "src" },
			cwd,
		);

		expect(firstText(result)).toBe("No matches found");
		expect(result.details).toEqual({ matchCount: 0 });
	});

	it("reports grep command errors with empty match details", async () => {
		const cwd = setupProject();
		const result = await executeTool(
			collectTools(registerSearchTools).get("Grep"),
			{ pattern: "[", path: "src" },
			cwd,
		);

		expect(firstText(result).startsWith("Grep error:")).toBe(true);
		expect(result.details).toEqual({ matchCount: 0 });
	});

	it("globs files under the requested path", async () => {
		const cwd = setupProject();
		const result = await executeTool(
			collectTools(registerSearchTools).get("Glob"),
			{ pattern: "**/*.ts", path: "src" },
			cwd,
		);

		expectGlobResult(cwd, result);
	});

	it("globs files with Cursor-style glob pattern arguments", async () => {
		const cwd = setupProject();
		const result = await executePreparedTool(
			collectTools(registerSearchTools).get("Glob"),
			{ glob_pattern: "**/*.ts", path: "src" },
			cwd,
		);

		expectGlobResult(cwd, result);
	});

	it("reports empty glob command results", async () => {
		const cwd = setupProject();
		const result = await executeTool(
			collectTools(registerSearchTools).get("Glob"),
			{ pattern: "**/*.json", path: "src" },
			cwd,
		);

		expect(firstText(result)).toBe("No matches found");
		expect(result.details).toEqual({ fileCount: 0 });
	});

	it("renders grep calls and result states", () => {
		const grep = collectTools(registerSearchTools).get("Grep");
		const result = {
			content: [{ type: "text", text: "src/alpha.ts:1:needle" }],
			details: { matchCount: 1 },
		};

		expect(
			renderText(
				grep?.renderCall?.(
					{ pattern: "needle", path: "src", include: "*.ts" },
					plainTheme,
				) ?? { render: () => [] },
			),
		).toBe('Grep "needle" in src [*.ts]');
		expect(
			renderText(
				grep?.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					plainTheme,
					{},
				) ?? { render: () => [] },
			),
		).toBe("1 match(es)");
		expect(
			renderText(
				grep?.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					plainTheme,
					{},
				) ?? { render: () => [] },
			),
		).toBe("src/alpha.ts:1:needle");
		expect(
			renderText(
				grep?.renderResult?.(
					{
						content: [{ type: "text", text: "No matches found" }],
						details: {},
					},
					{ expanded: false, isPartial: false },
					plainTheme,
					{},
				) ?? { render: () => [] },
			),
		).toBe("No matches");
		expect(
			renderText(
				grep?.renderResult?.(
					result,
					{ expanded: false, isPartial: true },
					plainTheme,
					{},
				) ?? { render: () => [] },
			),
		).toBe("Running...");
	});

	it("renders glob calls and result states", () => {
		const glob = collectTools(registerSearchTools).get("Glob");
		const result = {
			content: [{ type: "text", text: "src/alpha.ts\nsrc/gamma.ts" }],
			details: { fileCount: 2 },
		};

		expect(
			renderText(
				glob?.renderCall?.({ pattern: "**/*.ts", path: "src" }, plainTheme) ?? {
					render: () => [],
				},
			),
		).toBe("Glob **/*.ts in src");
		expect(
			renderText(
				glob?.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					plainTheme,
					{},
				) ?? { render: () => [] },
			),
		).toBe("2 file(s)");
		expect(
			renderText(
				glob?.renderResult?.(
					{ content: [{ type: "text", text: "No files found" }], details: {} },
					{ expanded: false, isPartial: false },
					plainTheme,
					{},
				) ?? { render: () => [] },
			),
		).toBe("No files");
		expect(
			renderText(
				glob?.renderResult?.(
					result,
					{ expanded: false, isPartial: true },
					plainTheme,
					{},
				) ?? { render: () => [] },
			),
		).toBe("Running...");
	});
});
