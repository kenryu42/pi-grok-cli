## Comments

- Do not write code comments. Say it in code: a clearer name, a named value, a type.
- Only these directives are allowed: a `#!` hashbang on a file's first line, a bare
  `/** @internal */`, `/// <reference … />`, `// oxlint-disable-next-line <rules> -- <reason>` and
  `// @ts-expect-error <reason>`, with the last two written as `{/* … */}` inside JSX.
- A fact about an external tool that code cannot express stays only when the maintainer adds it to
  the `allow` map in `scripts/comment-lint.json`. Never add entries there or to its `exclude` list
  yourself. Deleting an entry whose comment is gone is fine.
- `bun run lint:comments`, part of `bun run check`, enforces this. To fix a failure, follow
  `.agents/skills/fix-comment-lint/SKILL.md`.
