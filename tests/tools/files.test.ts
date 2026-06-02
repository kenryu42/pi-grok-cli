import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerFileTools } from "../../src/tools/files.js";
import {
	collectTools,
	executeTool,
	firstText,
	renderToolCall,
	renderToolResult,
	type ToolResult,
	tempDir,
} from "./toolTestHelpers.js";

function expectStoryState(
	result: ToolResult,
	cwd: string,
	replacements: number,
	content: string,
) {
	expect(result.details).toEqual({
		path: join(cwd, "story.txt"),
		replacements,
	});
	expect(readFileSync(join(cwd, "story.txt"), "utf-8")).toBe(content);
}

function strReplace(cwd: string, old_str: string, new_str: string) {
	return executeTool(
		collectTools(registerFileTools).get("StrReplace"),
		{ path: "story.txt", old_str, new_str },
		cwd,
	);
}

describe("file tools", () => {
	it("lists directory contents including hidden files", async () => {
		const cwd = tempDir("pi-grok-cli-files-");
		writeFileSync(join(cwd, ".hidden"), "secret", "utf-8");
		writeFileSync(join(cwd, "visible.txt"), "visible", "utf-8");

		const result = await executeTool(
			collectTools(registerFileTools).get("LS"),
			{ path: "." },
			cwd,
		);

		expect(firstText(result)).toContain(".hidden");
		expect(firstText(result)).toContain("visible.txt");
		expect(result.details).toEqual({ path: cwd });
	});

	it("reports filesystem errors for invalid file operations", async () => {
		const cwd = tempDir("pi-grok-cli-files-");
		mkdirSync(join(cwd, "dir"));
		writeFileSync(join(cwd, "blocked"), "not a directory", "utf-8");
		const tools = collectTools(registerFileTools);

		const lsResult = await executeTool(
			tools.get("LS"),
			{ path: "missing-dir" },
			cwd,
		);
		const readResult = await executeTool(
			tools.get("Read"),
			{ path: "dir" },
			cwd,
		);
		const writeResult = await executeTool(
			tools.get("Write"),
			{ path: "blocked/file.txt", content: "content" },
			cwd,
		);
		const replaceResult = await executeTool(
			tools.get("StrReplace"),
			{ path: "dir", old_str: "old", new_str: "new" },
			cwd,
		);
		const deleteResult = await executeTool(
			tools.get("Delete"),
			{ path: "dir" },
			cwd,
		);

		expect(firstText(lsResult).startsWith("LS error:")).toBe(true);
		expect(firstText(readResult).startsWith("Read error:")).toBe(true);
		expect(firstText(writeResult).startsWith("Write error:")).toBe(true);
		expect(firstText(replaceResult).startsWith("StrReplace error:")).toBe(true);
		expect(firstText(deleteResult).startsWith("Delete error:")).toBe(true);
		expect(writeResult.details).toEqual({
			path: join(cwd, "blocked", "file.txt"),
			bytesWritten: 0,
		});
		expect(replaceResult.details).toEqual({
			path: join(cwd, "dir"),
			replacements: 0,
		});
		expect(deleteResult.details).toEqual({
			path: join(cwd, "dir"),
			deleted: false,
		});
	});

	it("writes a nested file and reads a requested line window", async () => {
		const cwd = tempDir("pi-grok-cli-files-");
		const tools = collectTools(registerFileTools);

		const writeResult = await executeTool(
			tools.get("Write"),
			{ path: "nested/notes.txt", content: "alpha\nbeta\ngamma\ndelta" },
			cwd,
		);

		expect(firstText(writeResult)).toBe(
			"Successfully wrote 22 bytes to nested/notes.txt",
		);
		expect(writeResult.details).toEqual({
			path: join(cwd, "nested/notes.txt"),
			bytesWritten: 22,
		});

		const readResult = await executeTool(
			tools.get("Read"),
			{ path: "nested/notes.txt", offset: 1, limit: 2 },
			cwd,
		);

		expect(firstText(readResult)).toBe(
			"2\tbeta\n3\tgamma\n\n[Showing lines 2-3 of 4 total lines. Use offset to see more.]",
		);
		expect(readResult.details).toEqual({
			path: join(cwd, "nested/notes.txt"),
			totalLines: 4,
		});
	});

	it("reports missing files without throwing", async () => {
		const cwd = tempDir("pi-grok-cli-files-");
		const result = await executeTool(
			collectTools(registerFileTools).get("Read"),
			{ path: "missing.txt" },
			cwd,
		);

		expect(firstText(result)).toBe(
			`File not found: ${join(cwd, "missing.txt")}`,
		);
		expect(result.details).toEqual({
			path: join(cwd, "missing.txt"),
			exists: false,
			totalLines: 0,
		});
	});

	it("replaces every exact string occurrence", async () => {
		const cwd = tempDir("pi-grok-cli-files-");
		writeFileSync(join(cwd, "story.txt"), "red blue red", "utf-8");

		const result = await strReplace(cwd, "red", "green");

		expect(firstText(result)).toBe("Replaced 2 occurrence(s) in story.txt");
		expectStoryState(result, cwd, 2, "green blue green");
	});

	it("leaves files unchanged when the replacement string is absent", async () => {
		const cwd = tempDir("pi-grok-cli-files-");
		writeFileSync(join(cwd, "story.txt"), "red blue red", "utf-8");

		const result = await strReplace(cwd, "purple", "green");

		expect(firstText(result)).toBe('String not found in story.txt: "purple"');
		expectStoryState(result, cwd, 0, "red blue red");
	});

	it("deletes existing files and reports missing files", async () => {
		const cwd = tempDir("pi-grok-cli-files-");
		writeFileSync(join(cwd, "remove.txt"), "delete me", "utf-8");
		const tools = collectTools(registerFileTools);

		const deletedResult = await executeTool(
			tools.get("Delete"),
			{ path: "remove.txt" },
			cwd,
		);

		expect(firstText(deletedResult)).toBe("Successfully deleted remove.txt");
		expect(deletedResult.details).toEqual({
			path: join(cwd, "remove.txt"),
			deleted: true,
		});
		expect(existsSync(join(cwd, "remove.txt"))).toBe(false);

		const missingResult = await executeTool(
			tools.get("Delete"),
			{ path: "remove.txt" },
			cwd,
		);

		expect(firstText(missingResult)).toBe(
			`File not found: ${join(cwd, "remove.txt")}`,
		);
		expect(missingResult.details).toEqual({
			path: join(cwd, "remove.txt"),
			deleted: false,
		});
	});

	it("renders file tool calls and result states", () => {
		const tools = collectTools(registerFileTools);

		expect(renderToolCall(tools.get("LS"), { path: "." })).toBe("LS .");
		expect(
			renderToolCall(tools.get("Read"), {
				path: "notes.txt",
				offset: 5,
				limit: 10,
			}),
		).toBe("Read notes.txt (from 5, 10 lines)");
		expect(renderToolCall(tools.get("StrReplace"), { path: "notes.txt" })).toBe(
			"StrReplace notes.txt",
		);
		expect(renderToolCall(tools.get("Delete"), { path: "notes.txt" })).toBe(
			"Delete notes.txt",
		);
		expect(
			renderToolResult(tools.get("Read"), {
				content: [{ type: "text", text: "missing" }],
				details: { exists: false, totalLines: 0 },
			}),
		).toBe("File not found");
		expect(
			renderToolResult(tools.get("StrReplace"), {
				content: [{ type: "text", text: "no replacement" }],
				details: { replacements: 0 },
			}),
		).toBe("No replacements");
		expect(
			renderToolResult(tools.get("Delete"), {
				content: [{ type: "text", text: "not deleted" }],
				details: { deleted: false },
			}),
		).toBe("Not deleted");
		expect(
			renderToolResult(
				tools.get("LS"),
				{
					content: [{ type: "text", text: "full listing" }],
					details: { path: "/tmp/project" },
				},
				{ expanded: true, isPartial: false },
			),
		).toBe("full listing");
		expect(
			renderToolResult(
				tools.get("Write"),
				{
					content: [{ type: "text", text: "writing" }],
					details: { bytesWritten: 10 },
				},
				{ expanded: false, isPartial: true },
			),
		).toBe("Running...");
	});
});
