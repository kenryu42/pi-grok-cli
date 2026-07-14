import { getBaseUrl } from '../auth/oauth.js';

interface MonthlyUsage {
  monthlyLimit: number;
  used: number;
  billingPeriodEnd: string;
}

interface WeeklyUsage {
  creditUsagePercent: number;
  billingPeriodEnd: string;
}

interface BillingUsage {
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
  // Endpoint omits creditUsagePercent at fresh-period start (0% usage); default to 0.
  const raw = (config as Record<string, unknown>).creditUsagePercent;
  const creditUsagePercent = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return { creditUsagePercent, billingPeriodEnd };
}

export async function fetchBillingUsage(token: string): Promise<BillingUsage> {
  const headers = billingHeaders(token);
  const monthlyResponse = await fetch(`${getBaseUrl()}/billing`, { headers });
  if (!monthlyResponse.ok) throw new Error(`billing endpoint returned ${monthlyResponse.status}`);
  const monthly = parseMonthlyUsage(await monthlyResponse.json());

  const weekly = await fetchWeeklyUsage(headers).catch(() => undefined);
  return { monthly, weekly };
}

async function fetchWeeklyUsage(headers: Record<string, string>): Promise<WeeklyUsage | undefined> {
  const response = await fetch(`${getBaseUrl()}/billing?format=credits`, { headers });
  if (!response.ok) return undefined;
  return parseWeeklyUsage(await response.json());
}

function formatReset(iso: string): string {
  const parts = RESET_FORMATTER.formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = part('hour') === '24' ? '00' : part('hour');
  return `${part('month')} ${part('day')}, ${hour}:${part('minute')} ${part('timeZoneName')} ${LOCAL_TIME_ZONE}`;
}

const detail = (label: string, value: string) => `      ${label.padEnd(9)}  ${value}`;

export function formatQuota(usage: BillingUsage | undefined): string[] {
  if (!usage) {
    return [
      '  Usage:',
      '    no billing data available — run /login grok-cli or set GROK_CLI_OAUTH_TOKEN',
    ];
  }

  const monthlyPercent = Math.round((usage.monthly.used / usage.monthly.monthlyLimit) * 100);
  const lines = [
    '  Usage:',
    '    Monthly',
    detail(
      'Credits',
      `${usage.monthly.used.toLocaleString()} / ${usage.monthly.monthlyLimit.toLocaleString()} used  ${monthlyPercent}%`,
    ),
    detail(
      'Remaining',
      `${(usage.monthly.monthlyLimit - usage.monthly.used).toLocaleString()} credits`,
    ),
    detail('Reset', formatReset(usage.monthly.billingPeriodEnd)),
  ];

  if (usage.weekly) {
    lines.push(
      '',
      '    Weekly',
      detail('Limit', `${Math.round(usage.weekly.creditUsagePercent)}% used`),
      detail('Reset', formatReset(usage.weekly.billingPeriodEnd)),
    );
  }

  return lines;
}
