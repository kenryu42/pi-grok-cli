import { execFile } from 'node:child_process';
import { promises as fs, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  execWithRgFallback,
  hasRipgrep,
  MAX_OUTPUT_BYTES,
  numberDetail,
  recordFrom,
  renderResultText,
  renderRunning,
  stringFrom,
  text,
  toolError,
  truncateChars,
  truncateLines,
} from './rendering.js';

const execFileAsync = promisify(execFile);

type GrepArgs = { pattern: string; path?: string; include?: string };
type GlobArgs = { pattern: string; path?: string };

function globToRegExp(pattern: string) {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*' && pattern[i + 2] === '/') {
      source += '(?:.*/)?';
      i += 2;
    } else if (char === '*' && next === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function normalizePath(filePath: string) {
  return filePath.replaceAll('\\', '/');
}

function sortByModifiedNewest(files: string[]) {
  return files.sort((a, b) => {
    const delta = statSync(b).mtimeMs - statSync(a).mtimeMs;
    if (delta !== 0) return delta;
    return a.localeCompare(b);
  });
}

async function listFilesRecursive(searchPath: string, signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) throw new Error('The operation was aborted');
  const stats = await fs.stat(searchPath);
  if (stats.isFile()) return [searchPath];
  if (!stats.isDirectory()) return [];

  return (
    await Promise.all(
      (
        await fs.readdir(searchPath, { withFileTypes: true })
      ).map((entry) => {
        const entryPath = join(searchPath, entry.name);
        if (entry.isDirectory()) return listFilesRecursive(entryPath, signal);
        if (entry.isFile()) return [entryPath];
        return [];
      }),
    )
  ).flat();
}

export function registerSearchTools(pi: ExtensionAPI) {
  const GrepParams = Type.Object({
    pattern: Type.String({
      description: 'Regex pattern to search for in file contents',
    }),
    path: Type.Optional(
      Type.String({
        description: 'Directory or file to search. Defaults to current working directory.',
      }),
    ),
    include: Type.Optional(
      Type.String({
        description: 'Glob pattern to filter which files are searched (e.g. *.ts, **/*.md)',
      }),
    ),
  });

  pi.registerTool({
    name: 'Grep',
    label: 'Grep',
    description:
      'Search for a regex pattern in file contents. Returns matching lines with file path and line number. Use the include parameter to filter by file type.',
    parameters: GrepParams,

    prepareArguments(args) {
      const input = recordFrom(args);
      if (!input) return args as GrepArgs;
      return {
        ...input,
        include: stringFrom(input.include) ?? stringFrom(input.glob_filter),
      } as GrepArgs;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const searchPath = resolve(ctx.cwd, params.path ?? '.');

      try {
        const rgArgs = ['-n', '-H', '--no-heading', '--color=never'];
        if (params.include) rgArgs.push('--glob', params.include);
        rgArgs.push('--', params.pattern, searchPath);

        const grepArgs = ['-r', '-n', '-H', '--color=never'];
        if (params.include) grepArgs.push(`--include=${params.include}`);
        grepArgs.push('--', params.pattern, searchPath);

        const stdout = await execWithRgFallback(rgArgs, grepArgs, {
          cwd: ctx.cwd,
          signal,
        });

        const lines = stdout.trim().split('\n').filter(Boolean);
        if (lines.length === 0) {
          return {
            content: [{ type: 'text', text: 'No matches found' }],
            details: { matchCount: 0 },
          };
        }

        return {
          content: [{ type: 'text', text: truncateChars(truncateLines(lines)) }],
          details: { matchCount: lines.length },
        };
      } catch (error: unknown) {
        return toolError(error, 'Grep', { matchCount: 0 });
      }
    },
    renderCall(args, theme) {
      const path = args.path ? theme.fg('muted', ` in ${args.path}`) : '';
      const include = args.include ? theme.fg('dim', ` [${args.include}]`) : '';
      return text(
        theme.fg('toolTitle', theme.bold('Grep ')) +
          theme.fg('accent', `"${args.pattern}"`) +
          path +
          include,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const running = renderRunning(isPartial);
      if (running) return running;
      const matchCount = numberDetail(result, 'matchCount');
      return renderResultText(
        result,
        expanded,
        matchCount === 0
          ? theme.fg('dim', 'No matches')
          : theme.fg('muted', `${matchCount} match(es)`),
      );
    },
  });

  const GlobParams = Type.Object({
    pattern: Type.String({
      description: 'Glob pattern to match files (e.g. **/*.ts, src/**/*.json)',
    }),
    path: Type.Optional(
      Type.String({
        description: 'Directory to search within. Defaults to current working directory.',
      }),
    ),
  });

  pi.registerTool({
    name: 'Glob',
    label: 'Glob',
    description:
      'Find files matching a glob pattern. Returns a list of matching file paths sorted by modification time (newest first).',
    parameters: GlobParams,

    prepareArguments(args) {
      const input = recordFrom(args);
      if (!input) return args as GlobArgs;
      return {
        ...input,
        pattern: stringFrom(input.pattern) ?? stringFrom(input.glob_pattern),
      } as GlobArgs;
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const searchPath = resolve(ctx.cwd, params.path ?? '.');

      try {
        let files: string[];

        if (await hasRipgrep()) {
          const result = await execFileAsync(
            'rg',
            ['--files', '--color=never', '--glob', params.pattern, searchPath],
            { cwd: ctx.cwd, maxBuffer: MAX_OUTPUT_BYTES, signal },
          );
          files = result.stdout.trim().split('\n').filter(Boolean);
        } else {
          const normalizedPattern = normalizePath(params.pattern);
          const matcher = globToRegExp(normalizedPattern);
          const matchesFile = normalizedPattern.includes('/')
            ? (file: string) => matcher.test(normalizePath(relative(ctx.cwd, file)))
            : (file: string) => matcher.test(basename(file));
          files = (await listFilesRecursive(searchPath, signal)).filter(matchesFile);
        }
        files = sortByModifiedNewest(files);

        if (files.length === 0) {
          return {
            content: [{ type: 'text', text: 'No files found' }],
            details: { fileCount: 0 },
          };
        }

        return {
          content: [{ type: 'text', text: truncateChars(truncateLines(files)) }],
          details: { fileCount: files.length },
        };
      } catch (error: unknown) {
        const err = error as { code?: unknown; stderr?: string };
        if (err.code === 1 && !err.stderr) {
          return {
            content: [{ type: 'text', text: 'No files found' }],
            details: { fileCount: 0 },
          };
        }
        return toolError(error, 'Glob', { fileCount: 0 });
      }
    },
    renderCall(args, theme) {
      const path = args.path ? theme.fg('muted', ` in ${args.path}`) : '';
      return text(
        theme.fg('toolTitle', theme.bold('Glob ')) + theme.fg('accent', args.pattern) + path,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const running = renderRunning(isPartial);
      if (running) return running;
      const fileCount = numberDetail(result, 'fileCount');
      return renderResultText(
        result,
        expanded,
        fileCount === 0 ? theme.fg('dim', 'No files') : theme.fg('muted', `${fileCount} file(s)`),
      );
    },
  });
}
