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
    expect(packageJson.files).toEqual(['README.md', 'SECURITY.md', 'src', 'tsconfig.json']);
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

  it('declares the Pi runtime version required by web search delegation', () => {
    expect(packageJson.peerDependencies?.['@earendil-works/pi-ai']).toBe('>=0.80.0');
    expect(packageJson.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('>=0.80.0');
    expect(packageJson.peerDependencies?.['@earendil-works/pi-tui']).toBe('>=0.80.0');
    expect(packageJson.peerDependencies?.['pi-web-access']).toBe('>=0.13.0');
    expect(packageJson.dependencies?.jiti).toBeUndefined();
    expect(packageJson.dependencies?.typebox).toBeUndefined();
    expect(packageJson.dependencies?.ignore).toBe('7.0.5');
    expect(packageJson.dependencies?.minimatch).toBe('10.2.5');
  });
});

describe('repository layout', () => {
  it('keeps the extension entrypoint at src/index.ts', () => {
    expect(existsSync(new URL('../../src/index.ts', import.meta.url))).toBe(true);
  });

  it('contains the expected domain source files', () => {
    expect(globSync('src/**/*.ts').sort()).toEqual([
      'src/auth/config.ts',
      'src/auth/grokCredentials.ts',
      'src/auth/oauth.ts',
      'src/imagine/aspect.ts',
      'src/imagine/auth.ts',
      'src/imagine/config.ts',
      'src/imagine/generate.ts',
      'src/imagine/parseArgs.ts',
      'src/imagine/preview.ts',
      'src/imagine/register.ts',
      'src/imagine/save.ts',
      'src/imagine/tool.ts',
      'src/imagine/workflow.ts',
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
      'src/tools/glob.ts',
      'src/tools/read.ts',
      'src/tools/register.ts',
      'src/tools/rendering.ts',
      'src/tools/search.ts',
      'src/tools/shell.ts',
      'src/tools/webSearch.ts',
      'src/tools/webSearchDelegate.ts',
      'src/vision/cache.ts',
      'src/vision/config.ts',
      'src/vision/describe.ts',
      'src/vision/register.ts',
    ]);
  });

  it('does not keep top-level helper compatibility wrappers', () => {
    for (const file of ['errors.ts', 'models.ts', 'oauth.ts', 'sanitize.ts']) {
      expect(existsSync(new URL(`../../src/${file}`, import.meta.url))).toBe(false);
    }
  });
});
