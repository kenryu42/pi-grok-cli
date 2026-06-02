import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	booleanDetail,
	detailRecord,
	fileError,
	fileNotFound,
	MAX_OUTPUT_CHARS,
	numberDetail,
	renderResultSummary,
	stringDetail,
	type ToolError,
	text,
} from "./rendering.js";

const execFileAsync = promisify(execFile);

type ToolTheme = {
	bold: (text: string) => string;
	fg: (name: "accent" | "toolTitle", text: string) => string;
};

function renderPathToolCall(
	toolName: string,
	filePath: string,
	theme: ToolTheme,
) {
	return text(
		theme.fg("toolTitle", theme.bold(`${toolName} `)) +
			theme.fg("accent", filePath),
	);
}

export function registerFileTools(pi: ExtensionAPI) {
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
			return renderPathToolCall("LS", args.path, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderResultSummary(
				result,
				expanded,
				isPartial,
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
			return renderResultSummary(
				result,
				expanded,
				isPartial,
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
			return renderPathToolCall("Write", args.path, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderResultSummary(
				result,
				expanded,
				isPartial,
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
			return renderPathToolCall("StrReplace", args.path, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderResultSummary(
				result,
				expanded,
				isPartial,
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
			return renderPathToolCall("Delete", args.path, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			return renderResultSummary(
				result,
				expanded,
				isPartial,
				booleanDetail(result, "deleted")
					? theme.fg("muted", "Deleted")
					: theme.fg("error", "Not deleted"),
			);
		},
	});
}
