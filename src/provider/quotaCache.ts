import { existsSync, readFileSync } from 'node:fs';
import { getQuotaCachePath, writeFileAtomic } from '../storage.js';
import type { BillingUsage, MonthlyUsage, WeeklyUsage } from './billing.js';

export interface CachedQuota extends BillingUsage {
  updatedAt: string;
}

export interface QuotaCache {
  version: 1;
  accounts: Record<string, CachedQuota>;
}

const QUOTA_FRESHNESS_MS = 30 * 60_000;

const emptyCache = (): QuotaCache => ({ version: 1, accounts: {} });

function isDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function isMonthlyUsage(value: unknown): value is MonthlyUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const monthly = value as Record<string, unknown>;
  return (
    typeof monthly.monthlyLimit === 'number' &&
    Number.isFinite(monthly.monthlyLimit) &&
    typeof monthly.used === 'number' &&
    Number.isFinite(monthly.used) &&
    isDate(monthly.billingPeriodEnd)
  );
}

function isWeeklyUsage(value: unknown): value is WeeklyUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const weekly = value as Record<string, unknown>;
  return (
    typeof weekly.creditUsagePercent === 'number' &&
    Number.isFinite(weekly.creditUsagePercent) &&
    isDate(weekly.billingPeriodEnd)
  );
}

function parseCachedQuota(value: unknown): CachedQuota | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (!isDate(entry.updatedAt) || !isMonthlyUsage(entry.monthly)) return undefined;
  if (entry.weekly !== undefined && !isWeeklyUsage(entry.weekly)) return undefined;
  return {
    updatedAt: entry.updatedAt,
    monthly: entry.monthly,
    ...(entry.weekly ? { weekly: entry.weekly } : {}),
  };
}

export function loadQuotaCache(path = getQuotaCachePath()): QuotaCache {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCache();
    const cache = raw as Record<string, unknown>;
    if (
      cache.version !== 1 ||
      !cache.accounts ||
      typeof cache.accounts !== 'object' ||
      Array.isArray(cache.accounts)
    ) {
      return emptyCache();
    }
    return {
      version: 1,
      accounts: Object.fromEntries(
        Object.entries(cache.accounts).flatMap(([provider, value]) => {
          const entry = parseCachedQuota(value);
          return entry ? [[provider, entry]] : [];
        }),
      ),
    };
  } catch {
    return emptyCache();
  }
}

const cacheUpdates = new Map<string, Promise<void>>();

async function updateQuotaCache(
  update: (cache: QuotaCache) => boolean,
  path = getQuotaCachePath(),
) {
  const previous = cacheUpdates.get(path) ?? Promise.resolve();
  const next = previous.then(() => {
    const cache = loadQuotaCache(path);
    if (!update(cache)) return;
    writeFileAtomic(path, `${JSON.stringify(cache, null, 2)}\n`, 0o600);
  });
  cacheUpdates.set(path, next);
  try {
    await next;
  } finally {
    if (cacheUpdates.get(path) === next) cacheUpdates.delete(path);
  }
}

export function saveQuotaUsage(
  provider: string,
  usage: BillingUsage,
  updatedAt = new Date().toISOString(),
  path = getQuotaCachePath(),
) {
  return updateQuotaCache((cache) => {
    cache.accounts[provider] = {
      updatedAt,
      monthly: { ...usage.monthly },
      ...(usage.weekly ? { weekly: { ...usage.weekly } } : {}),
    };
    return true;
  }, path);
}

export function removeQuotaUsage(provider: string, path = getQuotaCachePath()) {
  return updateQuotaCache((cache) => {
    if (!existsSync(path) || !cache.accounts[provider]) return false;
    delete cache.accounts[provider];
    return true;
  }, path);
}

function formatAge(updatedAt: string, now: number) {
  const age = Math.max(0, now - new Date(updatedAt).getTime());
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

export function isCachedQuotaFresh(entry: CachedQuota, now = Date.now()) {
  return Math.max(0, now - new Date(entry.updatedAt).getTime()) < QUOTA_FRESHNESS_MS;
}

export function formatCachedQuota(entry: CachedQuota, now = Date.now()) {
  return [
    `Monthly ${entry.monthly.used.toLocaleString()} / ${entry.monthly.monthlyLimit.toLocaleString()} used`,
    entry.weekly
      ? `Weekly ${Math.round(entry.weekly.creditUsagePercent)}% used`
      : 'Weekly unavailable',
    ...(!isCachedQuotaFresh(entry, now) ? ['stale'] : []),
    formatAge(entry.updatedAt, now),
  ].join(' · ');
}
