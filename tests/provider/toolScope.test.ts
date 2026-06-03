import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncGrokTools } from '../../src/provider/toolScope.js';
import * as webSearchDelegate from '../../src/tools/webSearchDelegate.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function syncForGrokCli(piWebAccessInstalled: boolean) {
  vi.spyOn(webSearchDelegate, 'isPiWebAccessInstalled').mockReturnValue(piWebAccessInstalled);
  const setActiveTools = vi.fn();
  syncGrokTools(
    {
      getActiveTools: () => ['read', 'web_search', 'bash'],
      setActiveTools,
    },
    'grok-cli',
  );
  return setActiveTools.mock.calls[0][0] as string[];
}

describe('syncGrokTools', () => {
  it('drops web_search and enables WebSearch for grok-cli when pi-web-access is installed', () => {
    const next = syncForGrokCli(true);
    expect(next).not.toContain('web_search');
    expect(next).toContain('WebSearch');
    expect(next).toContain('read');
  });

  it('does not add WebSearch for grok-cli when pi-web-access is not installed', () => {
    const next = syncForGrokCli(false);
    expect(next).not.toContain('web_search');
    expect(next).not.toContain('WebSearch');
    expect(next).toContain('Grep');
  });

  it('removes Grok shims and leaves web_search available for other providers', () => {
    const setActiveTools = vi.fn();
    syncGrokTools(
      {
        getActiveTools: () => ['read', 'web_search', 'Grep', 'WebSearch'],
        setActiveTools,
      },
      'openai',
    );

    expect(setActiveTools).toHaveBeenCalledWith(['read', 'web_search']);
  });

  it('restores suppressed tools after a provider round-trip', () => {
    vi.spyOn(webSearchDelegate, 'isPiWebAccessInstalled').mockReturnValue(true);
    const activeTools = ['read', 'web_search', 'bash'];
    const pi = {
      getActiveTools: () => activeTools,
      setActiveTools(nextTools: string[]) {
        activeTools.splice(0, activeTools.length, ...nextTools);
      },
    };

    syncGrokTools(pi, 'grok-cli');
    expect(activeTools).not.toContain('web_search');
    expect(activeTools).toContain('WebSearch');

    syncGrokTools(pi, 'openai');
    expect(activeTools).toContain('web_search');
    expect(activeTools).not.toContain('WebSearch');
  });
});
