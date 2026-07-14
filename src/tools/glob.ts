import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  type FindToolDetails,
  type FindToolInput,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent';
import ignore from 'ignore';
import { minimatch } from 'minimatch';
import { normalizePath, recordFrom, stringFrom } from './rendering.js';

const DEFAULT_GLOB_LIMIT = 500;

type IgnoreScope = {
  root: string;
  matcher: ReturnType<typeof ignore>;
};

type Candidate = {
  absolutePath: string;
  outputPath: string;
  mtimeMs: number;
};

type GlobResult = {
  content: [{ type: 'text'; text: string }];
  details: FindToolDetails | undefined;
};

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return error.code;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Operation aborted');
}

function compareCandidates(left: Candidate, right: Candidate) {
  const timeDifference = right.mtimeMs - left.mtimeMs;
  if (timeDifference !== 0) return timeDifference;
  if (left.outputPath < right.outputPath) return -1;
  if (left.outputPath > right.outputPath) return 1;
  return 0;
}

function outputPath(cwd: string, absolutePath: string) {
  const workspaceRelative = relative(cwd, absolutePath);
  const outsideWorkspace =
    workspaceRelative === '..' ||
    workspaceRelative.startsWith(`..${sep}`) ||
    isAbsolute(workspaceRelative);
  return outsideWorkspace ? absolutePath : normalizePath(workspaceRelative);
}

function ignoredByScopes(absolutePath: string, directory: boolean, scopes: IgnoreScope[]) {
  return scopes.reduce((ignored, scope) => {
    const scopedPath = normalizePath(relative(scope.root, absolutePath));
    if (!scopedPath || scopedPath === '..' || scopedPath.startsWith('../')) return ignored;
    const result = scope.matcher.test(directory ? `${scopedPath}/` : scopedPath);
    if (result.unignored) return false;
    if (result.ignored) return true;
    return ignored;
  }, false);
}

async function scopesForDirectory(directory: string, scopes: IgnoreScope[], signal?: AbortSignal) {
  throwIfAborted(signal);
  const contents = await readFile(join(directory, '.gitignore'), 'utf8').catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  if (contents === undefined) return scopes;
  return [...scopes, { root: directory, matcher: ignore().add(contents) }];
}

export function normalizeGlobArgs(value: unknown): FindToolInput {
  const input = recordFrom(value);
  return {
    pattern: stringFrom(input?.pattern) ?? stringFrom(input?.glob_pattern) ?? '',
    path: stringFrom(input?.path) ?? stringFrom(input?.target_directory),
    limit: typeof input?.limit === 'number' ? input.limit : undefined,
  };
}

export async function executeGlob(
  input: FindToolInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<GlobResult> {
  const searchRoot = resolve(cwd, input.path ?? '.');
  const limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.max(1, Math.floor(input.limit))
      : DEFAULT_GLOB_LIMIT;
  const state = { totalMatches: 0, candidates: [] as Candidate[] };

  throwIfAborted(signal);
  const rootStats = await lstat(searchRoot).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') throw new Error(`Path not found: ${searchRoot}`);
    throw error;
  });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Not a directory: ${searchRoot}`);
  }

  const visit = async (directory: string, inheritedScopes: IgnoreScope[]): Promise<void> => {
    throwIfAborted(signal);
    const scopes = await scopesForDirectory(directory, inheritedScopes, signal);
    throwIfAborted(signal);
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      throwIfAborted(signal);
      const stats = await lstat(absolutePath).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      });
      if (!stats || stats.isSymbolicLink()) continue;

      if (stats.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        if (ignoredByScopes(absolutePath, true, scopes)) continue;
        await visit(absolutePath, scopes);
        continue;
      }
      if (!stats.isFile() || ignoredByScopes(absolutePath, false, scopes)) continue;

      const searchRelative = normalizePath(relative(searchRoot, absolutePath));
      if (!minimatch(searchRelative, input.pattern, { dot: true })) continue;
      state.totalMatches += 1;
      state.candidates.push({
        absolutePath,
        outputPath: outputPath(cwd, absolutePath),
        mtimeMs: stats.mtimeMs,
      });
      state.candidates.sort(compareCandidates);
      if (state.candidates.length > limit + 1) state.candidates.pop();
    }
  };

  await visit(searchRoot, []);
  throwIfAborted(signal);
  if (state.totalMatches === 0) {
    return { content: [{ type: 'text', text: 'No files found' }], details: undefined };
  }

  const rawOutput = state.candidates
    .sort(compareCandidates)
    .slice(0, limit)
    .map((candidate) => candidate.outputPath)
    .join('\n');
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  const details: FindToolDetails = {};
  const notices: string[] = [];
  if (state.totalMatches > limit) {
    details.resultLimitReached = limit;
    notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  throwIfAborted(signal);
  return {
    content: [
      {
        type: 'text',
        text:
          notices.length === 0
            ? truncation.content
            : `${truncation.content}\n\n[${notices.join('. ')}]`,
      },
    ],
    details: Object.keys(details).length === 0 ? undefined : details,
  };
}
