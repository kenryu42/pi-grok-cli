#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

const CONFIG_PATH = 'scripts/comment-lint.json';
const FIX_SKILL_PATH = '.agents/skills/fix-comment-lint/SKILL.md';

const HASHBANG = /^#!/;
const KNIP_INTERNAL_TAG = /^\/\*\* @internal \*\/$/;
const TYPESCRIPT_REFERENCE = /^\/\/\/ <reference (?:types|path|lib)="[^"]+" \/>$/;
const LINT_SUPPRESSION_WITH_REASON =
  /^\/\/ oxlint-disable-next-line [\w@/-]+(?:, *[\w@/-]+)* -- \S/;
const JSX_LINT_SUPPRESSION_WITH_REASON =
  /^\/\* oxlint-disable-next-line [\w@/-]+(?:, *[\w@/-]+)* -- \S.* \*\/$/;
const EXPECTED_TYPE_ERROR_WITH_REASON = /^\/\/ @ts-expect-error \S/;
const JSX_EXPECTED_TYPE_ERROR_WITH_REASON = /^\/\* @ts-expect-error \S.* \*\/$/;
const COMMENTS_ALLOWED_WITHOUT_ENTRY = [
  HASHBANG,
  KNIP_INTERNAL_TAG,
  TYPESCRIPT_REFERENCE,
  LINT_SUPPRESSION_WITH_REASON,
  JSX_LINT_SUPPRESSION_WITH_REASON,
  EXPECTED_TYPE_ERROR_WITH_REASON,
  JSX_EXPECTED_TYPE_ERROR_WITH_REASON,
];

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const SAY_IT_IN_CODE = `Make the code say it with a clearer name, a named value or a type, and delete the comment. Only the maintainer adds entries to ${CONFIG_PATH}, for facts about external tools the code cannot express. Fix each one by following ${FIX_SKILL_PATH}.`;
const FIX_STALE_ENTRIES = `A stale entry's comment is gone, edited, moved to another file or hidden by a syntax error. Fix each one by following ${FIX_SKILL_PATH}.`;

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const isExcluded = (path) =>
  config.exclude.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((path) => SOURCE_FILE.test(path) && !isExcluded(path) && existsSync(path))
  .toSorted()
  .map((path) => {
    const text = readFileSync(path, 'utf8');
    return { path, text, parsed: parseSync(path, text) };
  });

const commentsByPath = new Map(
  files.map((file) => [
    file.path,
    file.parsed.comments.map((comment) => ({
      path: file.path,
      line: file.text.slice(0, comment.start).split('\n').length,
      column: comment.start - file.text.lastIndexOf('\n', comment.start - 1),
      text: file.text.slice(comment.start, comment.end),
    })),
  ]),
);
const unparsableFiles = files.flatMap((file) =>
  file.parsed.errors.slice(0, 1).map((error) => ({ path: file.path, message: error.message })),
);
const disallowedComments = [...commentsByPath.values()]
  .flat()
  .filter(
    (comment) =>
      !COMMENTS_ALLOWED_WITHOUT_ENTRY.some((pattern) => pattern.test(comment.text)) &&
      !config.allow[comment.path]?.includes(comment.text),
  );
const staleEntries = Object.entries(config.allow).flatMap(([path, texts]) =>
  texts
    .filter((text) => !commentsByPath.get(path)?.some((comment) => comment.text === text))
    .map((text) => ({ path, text })),
);

const firstLine = (text) => text.split('\n')[0];
const report = [
  ...unparsableFiles.map((file) => `${file.path}  cannot be parsed: ${file.message}`),
  ...disallowedComments.map(
    (comment) => `${comment.path}:${comment.line}:${comment.column}  ${firstLine(comment.text)}`,
  ),
  ...(disallowedComments.length > 0 ? [SAY_IT_IN_CODE] : []),
  ...staleEntries.map(
    (entry) => `${CONFIG_PATH}  stale entry for ${entry.path}: ${firstLine(entry.text)}`,
  ),
  ...(staleEntries.length > 0 ? [FIX_STALE_ENTRIES] : []),
];
if (report.length > 0) {
  console.error(report.join('\n'));
  process.exit(1);
}
