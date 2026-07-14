import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentHarness, type AgentTool, InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { registerFileTools } from '../../src/tools/files.js';
import { createReadShim } from '../../src/tools/read.js';
import { registerSearchTools } from '../../src/tools/search.js';
import { registerShellTool } from '../../src/tools/shell.js';
import { tempDir } from './toolTestHelpers.js';

function getDefinition(register: (pi: ExtensionAPI) => void, name: string) {
  const definitions = new Map<string, ToolDefinition>();
  register({
    registerTool(definition: ToolDefinition) {
      definitions.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI);
  const definition = definitions.get(name);
  if (!definition) throw new Error(`${name} was not registered`);
  return definition;
}

function bridgeDefinition(definition: ToolDefinition, cwd: string): AgentTool {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    execute(toolCallId, params, signal, onUpdate) {
      return definition.execute(toolCallId, params, signal, onUpdate, { cwd } as ExtensionContext);
    },
  } as AgentTool;
}

async function executeThroughPi(
  definition: ToolDefinition,
  args: Record<string, unknown>,
  cwd: string,
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(definition.name, args), { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  const environment = new NodeExecutionEnv({ cwd });
  const harness = new AgentHarness({
    env: environment,
    session: await new InMemorySessionRepo().create(),
    models,
    model: faux.getModel(),
    tools: [bridgeDefinition(definition, cwd)],
  });
  const results: {
    isError: boolean;
    result: { content: { type: string; text?: string }[] };
  }[] = [];
  harness.subscribe((event) => {
    if (event.type === 'tool_execution_end') results.push(event);
  });

  await harness.prompt('Run the requested tool.');
  await environment.cleanup();
  models.deleteProvider(faux.provider.id);

  const result = results[0];
  if (!result) throw new Error('No tool result was emitted');
  return result;
}

function resultText(result: Awaited<ReturnType<typeof executeThroughPi>>) {
  return result.result.content.find((content) => content.type === 'text')?.text ?? '';
}

describe('native adapter error-state integration', () => {
  it('marks a delegated Write filesystem failure as isError', async () => {
    const cwd = tempDir('pi-grok-cli-native-integration-');
    writeFileSync(join(cwd, 'blocked'), 'not a directory', 'utf8');

    const result = await executeThroughPi(
      getDefinition(registerFileTools, 'Write'),
      { path: 'blocked/file.txt', content: 'content' },
      cwd,
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/EEXIST|not a directory/i);
  });

  it('marks a StrReplace operational filesystem failure as isError', async () => {
    const cwd = tempDir('pi-grok-cli-native-integration-');
    mkdirSync(join(cwd, 'directory'));

    const result = await executeThroughPi(
      getDefinition(registerFileTools, 'StrReplace'),
      { path: 'directory', old_str: 'old', new_str: 'new' },
      cwd,
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/directory|EISDIR/i);
  });

  it('marks a nonzero delegated Shell command as isError with native text', async () => {
    const cwd = tempDir('pi-grok-cli-native-integration-');

    const result = await executeThroughPi(
      getDefinition(registerShellTool, 'Shell'),
      { command: 'printf problem >&2; exit 7' },
      cwd,
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/problem.*exited with code 7/is);
  });

  it('keeps successful delegated calls as isError false', async () => {
    const cwd = tempDir('pi-grok-cli-native-integration-');

    const result = await executeThroughPi(
      getDefinition(registerFileTools, 'Write'),
      { path: 'success.txt', content: 'content' },
      cwd,
    );

    expect(result.isError).toBe(false);
    expect(resultText(result)).toContain('Successfully wrote');
  });
});

describe('uppercase shim agent-loop integration', () => {
  it('executes every local uppercase shim with Cursor aliases through Pi', async () => {
    const cwd = tempDir('pi-grok-cli-native-integration-');
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'story.txt'), 'alpha needle\n', 'utf8');
    writeFileSync(join(cwd, 'delete-me.txt'), 'delete', 'utf8');
    const cases: {
      args: Record<string, unknown>;
      expected: RegExp;
      name: string;
      register: (pi: ExtensionAPI) => void;
    }[] = [
      {
        name: 'Read',
        register: (pi) => pi.registerTool(createReadShim()),
        args: { file_path: 'src/story.txt' },
        expected: /alpha needle/,
      },
      {
        name: 'Write',
        register: registerFileTools,
        args: { file_path: 'written.txt', contents: 'written' },
        expected: /Successfully wrote/,
      },
      {
        name: 'Edit',
        register: registerFileTools,
        args: { path: 'src/story.txt', old_string: 'alpha', new_string: 'beta' },
        expected: /Successfully replaced/,
      },
      {
        name: 'StrReplace',
        register: registerFileTools,
        args: { path: 'src/story.txt', old_string: 'needle', new_string: 'match' },
        expected: /Replaced 1 occurrence/,
      },
      {
        name: 'LS',
        register: registerFileTools,
        args: { path: 'src' },
        expected: /story\.txt/,
      },
      {
        name: 'Grep',
        register: registerSearchTools,
        args: { query: 'match', path: 'src', include: '*.txt' },
        expected: /story\.txt.*match/s,
      },
      {
        name: 'Glob',
        register: registerSearchTools,
        args: { glob_pattern: '*.txt', target_directory: 'src' },
        expected: /src\/story\.txt/,
      },
      {
        name: 'Shell',
        register: registerShellTool,
        args: { cmd: 'printf shell-ready' },
        expected: /shell-ready/,
      },
      {
        name: 'Delete',
        register: registerFileTools,
        args: { path: 'delete-me.txt' },
        expected: /Successfully deleted/,
      },
    ];

    for (const testCase of cases) {
      const result = await executeThroughPi(
        getDefinition(testCase.register, testCase.name),
        testCase.args,
        cwd,
      );
      expect(result.isError, testCase.name).toBe(false);
      expect(resultText(result), testCase.name).toMatch(testCase.expected);
    }
  });
});
