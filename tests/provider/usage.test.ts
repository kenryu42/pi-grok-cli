import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { AccountRoute } from '../../src/provider/accountRouting.js';
import { fetchBillingUsage } from '../../src/provider/billing.js';
import { saveQuotaUsageWhen } from '../../src/provider/quotaCache.js';
import { registerUsageCommand } from '../../src/provider/usage.js';

vi.mock('../../src/provider/billing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/provider/billing.js')>()),
  fetchBillingUsage: vi.fn(),
}));

vi.mock('../../src/provider/quotaCache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/provider/quotaCache.js')>()),
  saveQuotaUsageWhen: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchBillingUsage);
const mockedSave = vi.mocked(saveQuotaUsageWhen);

function commandHarness(resolveRoute: () => Promise<AccountRoute>): {
  notify: ReturnType<typeof vi.fn>;
  run: () => Promise<void>;
} {
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
    resolveRoute,
  );
  const notify = vi.fn();
  return {
    notify,
    run: async () => {
      await commands.get('grok-cli-usage')?.handler('', {
        modelRegistry: {
          getAll: () => [{ provider: 'grok-cli', id: 'grok-build' }],
        },
        ui: { notify },
      } as unknown as ExtensionCommandContext);
    },
  };
}

describe('Grok CLI usage command', () => {
  it('shows the account-route error with the empty quota state', async () => {
    const { notify, run } = commandHarness(async () => {
      throw new Error('Account 1 needs login.');
    });

    await run();

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('no billing data available'),
      'info',
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Account 1 needs login.'), 'info');
  });

  it('renders the weekly limit with the subscription tier and used percent', async () => {
    mockedFetch.mockResolvedValueOnce({
      tier: 'X Premium',
      monthly: {
        monthlyLimit: 0,
        used: 0,
        billingPeriodEnd: '2026-09-01T00:00:00.000Z',
      },
      weekly: {
        creditUsagePercent: 0,
        billingPeriodEnd: '2026-08-18T00:19:56.260346+00:00',
      },
    });
    mockedSave.mockResolvedValue(true);
    const { notify, run } = commandHarness(async () => ({
      accountId: 'account-1',
      revision: 0,
      token: 'token',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      source: 'vault',
    }));

    await run();

    const output = notify.mock.calls.filter(([, kind]) => kind === 'info').at(-1)?.[0] as string;
    expect(output).toContain('Weekly Limit (X Premium)');
    expect(output).toContain('Used       0%');
    expect(output).toContain('Reset      Aug 18');
  });
});
