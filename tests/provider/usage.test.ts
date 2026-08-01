import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerUsageCommand } from '../../src/provider/usage.js';

describe('Grok CLI usage command', () => {
  it('shows the account-route error with the empty quota state', async () => {
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    >();
    registerUsageCommand(
      {
        registerCommand(name, command) {
          commands.set(name, command);
        },
      } as Pick<ExtensionAPI, 'registerCommand'>,
      async () => {
        throw new Error('Account 1 needs login.');
      },
    );
    const notify = vi.fn();

    await commands.get('grok-cli-usage')?.handler('', {
      modelRegistry: {
        getAll: () => [{ provider: 'grok-cli', id: 'grok-build' }],
      },
      ui: { notify },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('no billing data available'),
      'info',
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Account 1 needs login.'), 'info');
  });
});
