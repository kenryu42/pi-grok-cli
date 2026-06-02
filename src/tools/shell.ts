import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MAX_OUTPUT_CHARS,
	numberDetail,
	renderResultText,
	renderRunning,
	text,
} from "./rendering.js";

const execFileAsync = promisify(execFile);

export function registerShellTool(pi: ExtensionAPI) {
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
}
