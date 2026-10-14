import { CodexAppServerClient } from './app-server-client.js';
import type { Logger } from '../../utils/logger.js';

export interface SubscriptionWindow {
  usedPercent: number;
  remainingPercent: number;
  durationMinutes: number | null;
  resetsAt: string | null;
}
export interface SubscriptionUsage {
  checkedAt: string | null;
  stale: boolean;
  warning?: string;
  buckets: Array<{
    id: string;
    name: string;
    plan: string | null;
    primary: SubscriptionWindow | null;
    secondary: SubscriptionWindow | null;
  }>;
  resetCredits: number | null;
}

function window(raw: any): SubscriptionWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) return null;
  const usedPercent = Math.min(100, Math.max(0, raw.usedPercent));
  const timestamp = typeof raw.resetsAt === 'number' ? raw.resetsAt * 1000 : NaN;
  const date = new Date(timestamp);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    durationMinutes:
      typeof raw.windowDurationMins === 'number' && raw.windowDurationMins > 0 ? raw.windowDurationMins : null,
    resetsAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
  };
}

/** Allowlist quota metadata; never expose account IDs, identity, or reset-credit IDs. */
export function parseSubscriptionUsage(raw: any, checkedAt: string): SubscriptionUsage {
  const entries: any[] =
    raw?.rateLimitsByLimitId && typeof raw.rateLimitsByLimitId === 'object'
      ? Object.values(raw.rateLimitsByLimitId)
      : raw?.rateLimits
        ? [raw.rateLimits]
        : [];
  const buckets = entries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, i) => ({
      id: typeof entry.limitId === 'string' ? entry.limitId : `quota-${i}`,
      name: typeof entry.limitName === 'string' && entry.limitName ? entry.limitName : 'Codex',
      plan: typeof entry.planType === 'string' ? entry.planType : null,
      primary: window(entry.primary),
      secondary: window(entry.secondary),
    }));
  if (!buckets.length || !buckets.some((bucket) => bucket.primary || bucket.secondary))
    throw new Error('No quota windows');
  const count = raw?.rateLimitResetCredits?.availableCount;
  return { checkedAt, stale: false, buckets, resetCredits: Number.isSafeInteger(count) && count >= 0 ? count : null };
}

interface Client {
  call(method: string): Promise<any>;
  close(): Promise<void>;
}
export function createSubscriptionUsageReader(
  factory: (logger: Logger) => Client = (logger) => new CodexAppServerClient(logger),
) {
  let snapshot: SubscriptionUsage | undefined;
  let lastAttempt = 0;
  let inFlight: Promise<SubscriptionUsage> | undefined;
  return async (logger: Logger, refresh = false): Promise<SubscriptionUsage> => {
    if (inFlight) return inFlight;
    if (snapshot && Date.now() - lastAttempt < (refresh ? 10000 : 3600000)) return snapshot;
    lastAttempt = Date.now();
    inFlight = (async () => {
      const client = factory(logger);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([
          client.call('account/rateLimits/read'),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Quota timeout')), 15000);
          }),
        ]);
        snapshot = parseSubscriptionUsage(raw, new Date().toISOString());
      } catch {
        snapshot = {
          ...(snapshot || { checkedAt: null, buckets: [], resetCredits: null }),
          stale: true,
          warning: snapshot?.checkedAt
            ? '额度刷新失败，保留上次查询结果。'
            : '暂未获取到额度，请确认本机 Codex 已通过 ChatGPT 登录。',
        };
      } finally {
        clearTimeout(timer);
        await client.close().catch(() => {});
      }
      return snapshot!;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}
export const getSubscriptionUsage = createSubscriptionUsageReader();
