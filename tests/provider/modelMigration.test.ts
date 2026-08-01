import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateSavedModelProviders } from '../../src/provider/modelMigration.js';
import { writeTestJson } from '../stateTestHelpers.js';

const tempDirs: string[] = [];

function paths() {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-grok-model-migration-'));
  tempDirs.push(agentDir);
  return {
    agentDir,
    cwd: join(agentDir, 'project'),
    sessions: join(agentDir, 'sessions', 'project'),
  };
}

afterEach(() => {
  tempDirs.splice(0).forEach((path) => {
    rmSync(path, { recursive: true, force: true });
  });
});

describe('saved model provider migration', () => {
  it('rewrites released settings without changing session data', async () => {
    const target = paths();
    writeTestJson(join(target.agentDir, 'settings.json'), {
      defaultProvider: 'grok-cli-2',
      defaultModel: 'grok-build',
      enabledModels: ['grok-cli-2/grok-build', 'grok-cli/grok-build', 'openai/gpt-5'],
    });
    const sessionPath = join(target.sessions, 'session.jsonl');
    mkdirSync(target.sessions, { recursive: true });
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: 'model_change',
        provider: 'grok-cli-10',
        modelId: 'grok-build',
      })}\n`,
    );

    await expect(migrateSavedModelProviders(target.agentDir, target.cwd)).resolves.toEqual({
      migrated: true,
    });
    expect(JSON.parse(readFileSync(join(target.agentDir, 'settings.json'), 'utf8'))).toEqual({
      defaultProvider: 'grok-cli',
      defaultModel: 'grok-build',
      enabledModels: ['grok-cli/grok-build', 'openai/gpt-5'],
    });
    expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toMatchObject({
      provider: 'grok-cli-10',
    });
    await expect(migrateSavedModelProviders(target.agentDir, target.cwd)).resolves.toEqual({
      migrated: false,
    });
  });

  it('does not parse or replace malformed session data', async () => {
    const target = paths();
    mkdirSync(target.sessions, { recursive: true });
    writeFileSync(join(target.sessions, 'session.jsonl'), '{ malformed\n');

    const result = await migrateSavedModelProviders(target.agentDir, target.cwd);

    expect(result).toEqual({ migrated: false });
    expect(readFileSync(join(target.sessions, 'session.jsonl'), 'utf8')).toBe('{ malformed\n');
  });
});
