import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGrokTools } from '../../src/tools/register.js';
import { registerWebSearchTool } from '../../src/tools/webSearch.js';
import * as webSearchDelegate from '../../src/tools/webSearchDelegate.js';
import {
  clearWebSearchDelegateForTests,
  setWebSearchDelegateForTests,
} from '../../src/tools/webSearchDelegate.js';
import { collectTools, executeTool, firstText, renderToolCall } from './toolTestHelpers.js';

afterEach(() => {
  clearWebSearchDelegateForTests();
});

describe('WebSearch tool', () => {
  it('registers WebSearch with renderers', () => {
    const names: string[] = [];
    registerWebSearchTool({
      registerTool(tool: { name: string; renderCall?: unknown; renderResult?: unknown }) {
        names.push(tool.name);
        expect(tool.renderCall).toBeTypeOf('function');
        expect(tool.renderResult).toBeTypeOf('function');
      },
      on() {},
    } as unknown as ExtensionAPI);

    expect(names).toContain('WebSearch');
  });

  it('delegates execute to captured web_search', async () => {
    setWebSearchDelegateForTests(async (_id, params) => ({
      content: [{ type: 'text', text: `delegated:${JSON.stringify(params)}` }],
      details: { delegated: true },
    }));

    const tools = collectTools(registerWebSearchTool);
    const result = await executeTool(tools.get('WebSearch'), { query: 'pi extensions' }, '/tmp');
    expect(firstText(result)).toBe('delegated:{"query":"pi extensions"}');
    expect(result.details).toEqual({ delegated: true });
  });

  it('reports missing pi-web-access when delegate was never captured', async () => {
    vi.spyOn(webSearchDelegate, 'ensureWebSearchDelegate').mockResolvedValue(undefined);
    vi.spyOn(webSearchDelegate, 'getWebSearchDelegate').mockReturnValue(undefined);
    vi.spyOn(webSearchDelegate, 'getWebSearchLoadError').mockReturnValue(
      'pi-web-access is not installed. Run: pi install npm:pi-web-access',
    );

    const tools = collectTools(registerWebSearchTool);
    const result = await executeTool(tools.get('WebSearch'), { query: 'test' }, '/tmp');
    expect(firstText(result)).toMatch(/pi-web-access|pi install npm:pi-web-access/i);

    vi.restoreAllMocks();
  });

  it('registerGrokTools skips WebSearch when pi-web-access is not installed', () => {
    vi.spyOn(webSearchDelegate, 'isPiWebAccessInstalled').mockReturnValue(false);
    const names: string[] = [];
    registerGrokTools({
      registerTool(tool: { name: string }) {
        names.push(tool.name);
      },
      on() {},
    } as unknown as ExtensionAPI);
    expect(names).not.toContain('WebSearch');
    vi.restoreAllMocks();
  });

  it('renderCall shows WebSearch title', () => {
    const tools = collectTools(registerWebSearchTool);
    const line = renderToolCall(tools.get('WebSearch'), { query: 'hello world' });
    expect(line).toContain('WebSearch');
    expect(line).toContain('hello world');
  });
});
