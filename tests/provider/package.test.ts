import { existsSync, globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

describe('npm package manifest', () => {
  it('declares a pi package entry point', () => {
    expect(packageJson.name).toBe('pi-grok-cli');
    expect(packageJson.keywords).toContain('pi-package');
    expect(packageJson.pi?.extensions).toEqual(['./src/index.ts']);
    expect(packageJson.main).toBe('./src/index.ts');
    expect(packageJson.files).toEqual(['README.md', 'src', 'tsconfig.json']);
  });

  it('runs publish checks before packing', () => {
    expect(packageJson.scripts?.test).toBe('vitest run --reporter=agent');
    expect(packageJson.scripts?.coverage).toBe('vitest run --reporter=agent --coverage');
    expect(packageJson.scripts?.typecheck).toBe('tsc -p tsconfig.check.json');
    expect(packageJson.scripts?.prepack).toBe(
      'bun run test && bun run coverage && bun run typecheck',
    );
    expect(packageJson.scripts?.knip).toBe('knip --production');
    expect(packageJson.devDependencies?.vitest).toBeDefined();
    expect(packageJson.devDependencies?.['@vitest/coverage-v8']).toBeDefined();
    expect(existsSync(new URL('../../vitest.config.ts', import.meta.url))).toBe(true);
  });

  it('declares direct runtime dependencies needed by the source entrypoint', () => {
    expect(packageJson.dependencies?.jiti).toBeDefined();
    expect(packageJson.dependencies?.typebox).toBeDefined();
  });
});

describe('repository layout', () => {
  it('keeps the extension entrypoint at src/index.ts', () => {
    expect(existsSync(new URL('../../src/index.ts', import.meta.url))).toBe(true);
  });

  it('contains the expected domain source files', () => {
    expect(globSync('src/**/*.ts').sort()).toEqual([
      'src/auth/oauth.ts',
      'src/index.ts',
      'src/models/catalog.ts',
      'src/payload/sanitize.ts',
      'src/provider/billing.ts',
      'src/provider/register.ts',
      'src/provider/stream.ts',
      'src/provider/toolScope.ts',
      'src/provider/usage.ts',
      'src/shared/errors.ts',
      'src/tools/files.ts',
      'src/tools/register.ts',
      'src/tools/rendering.ts',
      'src/tools/search.ts',
      'src/tools/shell.ts',
      'src/tools/webSearch.ts',
      'src/tools/webSearchDelegate.ts',
    ]);
  });

  it('does not keep top-level helper compatibility wrappers', () => {
    for (const file of ['errors.ts', 'models.ts', 'oauth.ts', 'sanitize.ts']) {
      expect(existsSync(new URL(`../../src/${file}`, import.meta.url))).toBe(false);
    }
  });
});
