import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROK_SHIM_TOOL_NAMES, registerGrokTools } from '../../src/tools/register.js';
import * as webSearchDelegate from '../../src/tools/webSearchDelegate.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Grok tool registration', () => {
  it('registers shim tools with renderers', () => {
    vi.spyOn(webSearchDelegate, 'isPiWebAccessInstalled').mockReturnValue(false);
    const toolNames: string[] = [];

    registerGrokTools({
      registerTool(tool: { name: string; renderCall?: unknown; renderResult?: unknown }) {
        toolNames.push(tool.name);
        expect(tool.renderCall).toBeTypeOf('function');
        expect(tool.renderResult).toBeTypeOf('function');
      },
      on() {},
    } as unknown as ExtensionAPI);

    expect(toolNames.sort()).toEqual([...GROK_SHIM_TOOL_NAMES].sort());
    expect(toolNames).not.toContain('WebSearch');
  });

  it('registers WebSearch when pi-web-access is installed', () => {
    vi.spyOn(webSearchDelegate, 'isPiWebAccessInstalled').mockReturnValue(true);
    const toolNames: string[] = [];

    registerGrokTools({
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      on() {},
    } as unknown as ExtensionAPI);

    expect(toolNames).toContain('WebSearch');
  });
});
