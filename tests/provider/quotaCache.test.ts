import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BillingUsage } from '../../src/provider/billing.js';
import {
  formatCachedQuota,
  isCachedQuotaFresh,
  loadQuotaCache,
  removeQuotaUsage,
  saveQuotaUsage,
} from '../../src/provider/quotaCache.js';
import { getQuotaCachePath } from '../../src/storage.js';
import { useTempHome } from '../stateTestHelpers.js';

const setupHome = useTempHome();
const usage = (used: number, weekly = 60): BillingUsage => ({
  monthly: {
    monthlyLimit: 2000,
    used,
    billingPeriodEnd: '2026-08-01T00:00:00.000Z',
  },
  weekly: {
    creditUsagePercent: weekly,
    billingPeriodEnd: '2026-07-20T00:00:00.000Z',
  },
});

describe('Grok CLI quota cache', () => {
  it('starts empty without creating a file and rejects malformed cache data', () => {
    setupHome();

    expect(loadQuotaCache()).toEqual({ version: 1, accounts: {} });
    expect(existsSync(getQuotaCachePath())).toBe(false);

    mkdirSync(dirname(getQuotaCachePath()), { recursive: true });
    writeFileSync(getQuotaCachePath(), JSON.stringify({ version: 2, accounts: {} }));
    expect(loadQuotaCache()).toEqual({ version: 1, accounts: {} });

    writeFileSync(
      getQuotaCachePath(),
      JSON.stringify({
        version: 1,
        accounts: {
          'grok-cli': {
            updatedAt: 'not-a-date',
            monthly: { monthlyLimit: 2000, used: '300', billingPeriodEnd: 'bad' },
          },
        },
      }),
    );
    expect(loadQuotaCache()).toEqual({ version: 1, accounts: {} });
  });

  it('atomically stores provider usage and serializes concurrent updates', async () => {
    const home = setupHome();
    const updatedAt = '2026-07-15T10:30:00.000Z';

    await Promise.all([
      saveQuotaUsage('grok-cli', usage(300), updatedAt),
      saveQuotaUsage('grok-cli-2', usage(900, 25), updatedAt),
    ]);

    expect(loadQuotaCache()).toEqual({
      version: 1,
      accounts: {
        'grok-cli': { updatedAt, ...usage(300) },
        'grok-cli-2': { updatedAt, ...usage(900, 25) },
      },
    });
    expect(
      JSON.parse(readFileSync(getQuotaCachePath(), 'utf8')).accounts['grok-cli-2'].monthly.used,
    ).toBe(900);
    expect(
      existsSync(`${getQuotaCachePath()}.${process.pid}.tmp`) ||
        existsSync(`${getQuotaCachePath()}.tmp`),
    ).toBe(false);
    expect(getQuotaCachePath()).toContain(`${home}/.pi/grok-cli/`);
  });

  it('removes only the requested provider entry', async () => {
    setupHome();
    await saveQuotaUsage('grok-cli', usage(300), '2026-07-15T10:30:00.000Z');
    await saveQuotaUsage('grok-cli-2', usage(900), '2026-07-15T10:30:00.000Z');

    await removeQuotaUsage('grok-cli-2');

    expect(Object.keys(loadQuotaCache().accounts)).toEqual(['grok-cli']);
  });

  it('runs a queued update after the previous update fails', async () => {
    setupHome();
    const invalid = Object.defineProperty({}, 'monthly', {
      get() {
        throw new Error('invalid usage');
      },
    }) as BillingUsage;

    const failed = saveQuotaUsage('grok-cli', invalid);
    const recovered = saveQuotaUsage('grok-cli-2', usage(900));

    await expect(failed).rejects.toThrow('invalid usage');
    await expect(recovered).resolves.toBeUndefined();
    expect(loadQuotaCache().accounts['grok-cli-2']?.monthly.used).toBe(900);
  });

  it('formats fresh, stale, and weekly-unavailable usage explicitly as consumed quota', () => {
    expect(
      formatCachedQuota(
        { updatedAt: '2026-07-15T10:22:00.000Z', ...usage(300) },
        Date.parse('2026-07-15T10:30:00.000Z'),
      ),
    ).toBe('Monthly 300 / 2,000 used · Weekly 60% used · 8m ago');

    expect(
      formatCachedQuota(
        {
          updatedAt: '2026-07-15T08:30:00.000Z',
          monthly: usage(300).monthly,
        },
        Date.parse('2026-07-15T10:30:00.000Z'),
      ),
    ).toBe('Monthly 300 / 2,000 used · Weekly unavailable · stale · 2h ago');
  });

  it('treats quota as stale exactly thirty minutes after its update', () => {
    const entry = { updatedAt: '2026-07-15T10:00:00.000Z', ...usage(300) };

    expect(isCachedQuotaFresh(entry, Date.parse('2026-07-15T10:29:59.999Z'))).toBe(true);
    expect(isCachedQuotaFresh(entry, Date.parse('2026-07-15T10:30:00.000Z'))).toBe(false);
    expect(formatCachedQuota(entry, Date.parse('2026-07-15T10:30:00.000Z'))).toContain('stale');
  });
});
