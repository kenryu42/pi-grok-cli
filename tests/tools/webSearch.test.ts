import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGrokTools } from '../../src/tools/register.js';
import { registerWebSearchTool } from '../../src/tools/webSearch.js';
import * as webSearchDelegate from '../../src/tools/webSearchDelegate.js';
import {
  clearWebSearchDelegateForTests,
  PI_WEB_SEARCH_TOOL,
  setWebSearchDelegateForTests,
} from '../../src/tools/webSearchDelegate.js';
import {
  collectTools,
  executeTool,
  firstText,
  renderToolCall,
  renderToolResult,
} from './toolTestHelpers.js';

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

  it('normalizes delegated queries', async () => {
    setWebSearchDelegateForTests(async (_id, params) => ({
      content: [{ type: 'text', text: JSON.stringify(params) }],
      details: {},
    }));

    const tools = collectTools(registerWebSearchTool);
    const result = await executeTool(
      tools.get('WebSearch'),
      {
        query: '   ',
        queries: [' first query ', ' ', 'second query'],
        numResults: 3,
      },
      '/tmp',
    );

    expect(firstText(result)).toBe(
      JSON.stringify({
        queries: ['first query', 'second query'],
        numResults: 3,
      }),
    );
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

  describe('renderCall', () => {
    const tools = collectTools(registerWebSearchTool);
    const ws = tools.get('WebSearch');

    it('shows (no query) when query list is empty', () => {
      expect(renderToolCall(ws, { queries: [] })).toContain('(no query)');
    });

    it('shows (no query) with no query or queries param', () => {
      expect(renderToolCall(ws, {})).toContain('(no query)');
    });

    it('truncates a single long query', () => {
      const long = 'a'.repeat(61);
      const line = renderToolCall(ws, { query: long });
      expect(line).toContain('...');
      expect(line).not.toContain(long);
    });

    it('shows query count and list for multiple queries', () => {
      const line = renderToolCall(ws, { queries: ['q1', 'q2', 'q3'] });
      expect(line).toContain('3 queries');
      expect(line).toContain('"q1"');
      expect(line).toContain('"q2"');
      expect(line).toContain('"q3"');
    });

    it('shows truncation indicator for more than 5 queries', () => {
      const queries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      const line = renderToolCall(ws, { queries });
      expect(line).toContain('7 queries');
      expect(line).toContain('... and 2 more');
    });
  });

  describe('renderResult', () => {
    const tools = collectTools(registerWebSearchTool);
    const ws = tools.get('WebSearch');

    it('shows running state when partial', () => {
      const result = {
        content: [{ type: 'text', text: 'loading...' }],
        details: {},
      };
      expect(renderToolResult(ws, result, { expanded: false, isPartial: true })).toBe('Running...');
    });

    it('shows error message when details contain error', () => {
      const result = {
        content: [{ type: 'text', text: 'something broke' }],
        details: { error: 'API key is invalid' },
      };
      const rendered = renderToolResult(ws, result);
      expect(rendered).toContain('Error:');
      expect(rendered).toContain('API key is invalid');
    });

    it('shows source count when totalResults is present', () => {
      const result = {
        content: [{ type: 'text', text: 'synthesized answer' }],
        details: { totalResults: 12 },
      };
      expect(renderToolResult(ws, result)).toBe('12 sources\nsynthesized answer');
    });

    it('shows search complete when no totalResults', () => {
      const result = {
        content: [{ type: 'text', text: 'answer' }],
        details: {},
      };
      expect(renderToolResult(ws, result)).toBe('search complete\nanswer');
    });

    it('shows expanded content with summary prefix', () => {
      const result = {
        content: [{ type: 'text', text: 'the full search answer' }],
        details: { totalResults: 3 },
      };
      const rendered = renderToolResult(ws, result, {
        expanded: true,
        isPartial: false,
      });
      expect(rendered).toContain('3 sources');
      expect(rendered).toContain('the full search answer');
    });

    it('truncates long expanded text', () => {
      const longText = 'x'.repeat(801);
      const result = {
        content: [{ type: 'text', text: longText }],
        details: { totalResults: 1 },
      };
      const rendered = renderToolResult(ws, result, {
        expanded: true,
        isPartial: false,
      });
      expect(rendered).toContain('...');
      expect(rendered).not.toContain(longText);
    });
  });

  describe('tool_call interceptor', () => {
    function getHandler() {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      registerWebSearchTool({
        registerTool() {},
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
          handlers.set(event, handler);
        },
      } as unknown as ExtensionAPI);
      const handler = handlers.get('tool_call');
      if (!handler) throw new Error('tool_call handler not registered');
      return handler;
    }

    it('blocks web_search for Grok CLI models', () => {
      const result = getHandler()(
        { toolName: PI_WEB_SEARCH_TOOL },
        { model: { provider: 'grok-cli' } },
      ) as { block?: boolean; reason?: string } | undefined;

      expect(result?.block).toBe(true);
      expect(result?.reason).toContain('web_search is disabled for Grok CLI');
    });

    it('allows web_search for non-Grok CLI models', () => {
      const result = getHandler()(
        { toolName: PI_WEB_SEARCH_TOOL },
        { model: { provider: 'openai' } },
      );

      expect(result).toBeUndefined();
    });

    it('does not block other tools for Grok CLI', () => {
      const result = getHandler()(
        { toolName: 'some_other_tool' },
        { model: { provider: 'grok-cli' } },
      );

      expect(result).toBeUndefined();
    });

    it('does not block web_search when model context is missing', () => {
      const result = getHandler()({ toolName: PI_WEB_SEARCH_TOOL }, {});

      expect(result).toBeUndefined();
    });
  });
});
