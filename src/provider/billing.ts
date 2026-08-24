import { getBaseUrl } from '../auth/oauth.js';

export interface MonthlyUsage {
  monthlyLimit: number;
  used: number;
  billingPeriodEnd: string;
}

export interface WeeklyUsage {
  creditUsagePercent: number;
  billingPeriodEnd: string;
}

export interface BillingUsage {
  tier?: string;
  monthly: MonthlyUsage;
  weekly?: WeeklyUsage;
}

const RESET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});

const LOCAL_TIME_ZONE = RESET_FORMATTER.resolvedOptions().timeZone;

const billingHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  'x-xai-token-auth': 'xai-grok-cli',
  accept: 'application/json',
});

function parseMonthlyUsage(payload: unknown): MonthlyUsage {
  if (!payload || typeof payload !== 'object') throw new Error('invalid billing payload');
  const config = (payload as Record<string, unknown>).config;
  if (!config || typeof config !== 'object') throw new Error('invalid billing payload');
  const monthlyLimit = ((config as Record<string, unknown>).monthlyLimit as Record<string, unknown>)
    ?.val;
  const used = ((config as Record<string, unknown>).used as Record<string, unknown>)?.val;
  const billingPeriodEnd = (config as Record<string, unknown>).billingPeriodEnd;
  if (
    typeof monthlyLimit !== 'number' ||
    !Number.isFinite(monthlyLimit) ||
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    typeof billingPeriodEnd !== 'string' ||
    !Number.isFinite(new Date(billingPeriodEnd).getTime())
  ) {
    throw new Error('invalid billing payload');
  }
  return { monthlyLimit, used, billingPeriodEnd };
}

function parseWeeklyUsage(payload: unknown): WeeklyUsage | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const config = (payload as Record<string, unknown>).config;
  if (!config || typeof config !== 'object') return undefined;
  const currentPeriod = (config as Record<string, unknown>).currentPeriod as
    | Record<string, unknown>
    | undefined;
  if (currentPeriod?.type !== 'USAGE_PERIOD_TYPE_WEEKLY') return undefined;
  const billingPeriodEnd = (config as Record<string, unknown>).billingPeriodEnd;
  if (
    typeof billingPeriodEnd !== 'string' ||
    !Number.isFinite(new Date(billingPeriodEnd).getTime())
  ) {
    return undefined;
  }
  const raw = (config as Record<string, unknown>).creditUsagePercent;
  const creditUsagePercent =
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
  return { creditUsagePercent, billingPeriodEnd };
}

async function fetchSettingsTier(
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(`${getBaseUrl()}/settings`, { headers, signal });
  if (!response.ok) return undefined;
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object') return undefined;
  const tier = (payload as Record<string, unknown>).subscription_tier_display;
  return typeof tier === 'string' && tier.length > 0 ? tier : undefined;
}

export async function fetchBillingUsage(
  token: string,
  signal?: AbortSignal,
): Promise<BillingUsage> {
  const headers = billingHeaders(token);
  const monthlyResponse = await fetch(`${getBaseUrl()}/billing`, { headers, signal });
  if (!monthlyResponse.ok) throw new Error(`billing endpoint returned ${monthlyResponse.status}`);
  const monthly = parseMonthlyUsage(await monthlyResponse.json());

  const [weekly, tier] = await Promise.all([
    fetchWeeklyUsage(headers, signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return undefined;
    }),
    fetchSettingsTier(headers, signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      return undefined;
    }),
  ]);
  return { monthly, weekly, ...(tier ? { tier } : {}) };
}

async function fetchWeeklyUsage(
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<WeeklyUsage | undefined> {
  const response = await fetch(`${getBaseUrl()}/billing?format=credits`, { headers, signal });
  if (!response.ok) return undefined;
  return parseWeeklyUsage(await response.json());
}

function formatReset(iso: string): string {
  const parts = RESET_FORMATTER.formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = part('hour') === '24' ? '00' : part('hour');
  return `${part('month')} ${part('day')}, ${hour}:${part('minute')} ${part('timeZoneName')} ${LOCAL_TIME_ZONE}`;
}

const detail = (label: string, value: string) => `   ${label.padEnd(11)}${value}`;

export function formatQuota(usage: BillingUsage | undefined): string[] {
  if (!usage) {
    return [
      '  Usage:',
      '    no billing data available — run /login grok-cli or set GROK_CLI_OAUTH_TOKEN',
    ];
  }

  const tier = usage.tier ? ` (${usage.tier})` : '';
  if (!usage.weekly) {
    return [`Weekly Limit${tier}`, '    weekly usage unavailable'];
  }
  return [
    `Weekly Limit${tier}`,
    detail('Used', `${Math.round(usage.weekly.creditUsagePercent)}%`),
    detail('Reset', formatReset(usage.weekly.billingPeriodEnd)),
  ];
}
