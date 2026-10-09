---
name: fix-comment-lint
description: 'Use in this repository when `bun run lint:comments` or `bun run check` reports a comment, a stale entry in `scripts/comment-lint.json`, or a file it cannot parse, and before writing a code comment here. Moves what each comment says into code, a test, or the PR description instead of deleting it and losing it.'
---

# Fixing Comment Lint Failures

`bun run lint:comments`, part of `bun run check`, rejects code comments. The lazy fix, deleting the comment, loses what it said. For each reported comment, decide which kind it is and move what it says to where that kind belongs. The project's agent instructions govern where they are stricter.

## Each Reported Comment

- **Narration** that restates the code, and **commented-out code**: delete it. The code already says the first, and git keeps the second.
- **An explanation of surprising behavior in this repository's own code**: make the code say it with a clearer name, a named value or local boolean, or a type, then delete the comment. Prefer naming a value or condition inside the function over extracting a single-use helper just to carry a name.
- **A claimed constraint** ("do not remove", "IMPORTANT", "must", a justification for a workaround): leave the code's behavior as it is, and check the claim before trusting it. Read `git blame -L <start>,<end> <file>` and the commit it points to, run `git log -p -S '<distinctive fragment>' -- <file>`, and search the tests for one that pins it. A constraint you confirm gets a test or a type when that is cheap: remove the workaround, see the new test or type check fail, then restore it. Otherwise, or when you cannot confirm or rule it out, state the claim and what you found in the PR description. The comment goes either way.
- **A fact about an external tool** (git, a shell, the OS, the runtime, a framework or library) that code cannot express: remove it from the code, and put the fact and its source (documentation link, version, or commit) in the PR description. Only the maintainer adds entries to the `allow` map in `scripts/comment-lint.json`; never add one or change its text.

## Allowed Directives

The check accepts these comments without an `allow` entry:

- a `#!` hashbang on the first line of an executable script (the OS reads it);
- a bare `/** @internal */` with nothing else in it, on an export that only tests use (Knip reads this tag);
- `/// <reference types="…" />`, with `types`, `path` or `lib`;
- `// oxlint-disable-next-line <rules> -- <reason>`, with comma-separated rule names and a non-empty reason;
- `// @ts-expect-error <reason>`, with a non-empty reason.

Inside JSX, write the last two as `{/* oxlint-disable-next-line <rules> -- <reason> */}` and `{/* @ts-expect-error <reason> */}`. Before writing a lint suppression, check whether the rule is catching a real bug. If it is, fix the code instead.

## Other Failures

- `cannot be parsed`: fix the syntax error first, then rerun before acting on anything else reported for that file. The check misses comments after the error, so a stale entry for that file may be false.
- `stale entry for <path>`: the entry's exact text is no longer a comment in `<path>`. If the check also reports that comment in `<path>` with edited text, restore the entry's exact text. If it reports the entry's exact text in another file, you moved the comment or renamed its file: keep the comment and the entry, and stop and ask the maintainer to move the entry. Otherwise the comment is gone: delete the entry from `scripts/comment-lint.json`.

## Never Dodge The Check

- Do not move comment text into strings or string constants.
- Do not edit `scripts/lint-comments.mjs` to let a comment through.
- Do not add paths to the `exclude` list in `scripts/comment-lint.json`; it is for generated output, and only the maintainer changes it.

## Finish

Run `bun run lint:comments` until it passes, then run `bun run check` once as the final check.
