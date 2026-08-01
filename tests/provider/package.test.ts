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
    expect(packageJson.files).toEqual([
      'CONFIGURATION.md',
      'README.md',
      'SECURITY.md',
      'src',
      'tsconfig.json',
    ]);
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

  it('declares the Pi runtime version required by dashboard auth', () => {
    expect(packageJson.peerDependencies?.['@earendil-works/pi-ai']).toBe('>=0.80.9');
    expect(packageJson.peerDependencies?.['@earendil-works/pi-coding-agent']).toBe('>=0.80.9');
    expect(packageJson.peerDependencies?.['@earendil-works/pi-tui']).toBe('>=0.80.9');
    expect(packageJson.dependencies).toBeUndefined();
    expect(packageJson.devDependencies?.['@types/proper-lockfile']).toBeUndefined();
  });
});

describe('repository layout', () => {
  it('keeps the extension entrypoint at src/index.ts', () => {
    expect(existsSync(new URL('../../src/index.ts', import.meta.url))).toBe(true);
  });

  it('contains the expected domain source files', () => {
    expect(globSync('src/**/*.ts').sort()).toEqual([
      'src/auth/config.ts',
      'src/auth/oauth.ts',
      'src/config.ts',
      'src/imagine/aspect.ts',
      'src/imagine/auth.ts',
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
      'src/provider/accountMigration.ts',
      'src/provider/accountRouting.ts',
      'src/provider/accountVault.ts',
      'src/provider/accounts.ts',
      'src/provider/billing.ts',
      'src/provider/dashboard/server.ts',
      'src/provider/modelMigration.ts',
      'src/provider/quotaCache.ts',
      'src/provider/register.ts',
      'src/provider/requestOwnership.ts',
      'src/provider/rotation.ts',
      'src/provider/sessionAccountSelection.ts',
      'src/provider/stream.ts',
      'src/provider/usage.ts',
      'src/shared/errors.ts',
      'src/storage.ts',
    ]);
  });

  it('does not keep top-level helper compatibility wrappers', () => {
    for (const file of ['errors.ts', 'models.ts', 'oauth.ts', 'sanitize.ts']) {
      expect(existsSync(new URL(`../../src/${file}`, import.meta.url))).toBe(false);
    }
  });

  it('uses the exact Pi loader alias for OpenAI Responses streaming', () => {
    const source = readFileSync(new URL('../../src/provider/register.ts', import.meta.url), 'utf8');

    expect(source).toContain(
      "import { streamSimpleOpenAIResponses } from '@earendil-works/pi-ai/compat';",
    );
    expect(source).not.toContain('@earendil-works/pi-ai/api/openai-responses');
  });
});
