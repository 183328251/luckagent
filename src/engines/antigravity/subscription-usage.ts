import { execFile } from 'node:child_process';
import type { SubscriptionUsage, SubscriptionWindow } from '../codex/subscription-usage.js';
import { resolveAntigravityPath } from './executor.js';

/** Native /usage is a CLI command, not an agent prompt. Parse its structured quota data only. */
export function parseAntigravityUsage(raw: any, checkedAt = new Date().toISOString()): SubscriptionUsage {
  if (raw?.status !== 'SUCCESS' || raw?.command?.name !== 'usage' || !Array.isArray(raw.command.data?.groups))
    throw new Error('No native quota data');
  const buckets = raw.command.data.groups.flatMap((group: any, index: number) => {
    if (typeof group?.name !== 'string' || !Array.isArray(group.buckets)) return [];
    const window = (kind: string): SubscriptionWindow | null => {
      const bucket = group.buckets.find((b: any) => b.window === kind);
      if (
        typeof bucket?.remaining_fraction !== 'number' ||
        !Number.isFinite(bucket.remaining_fraction) ||
        bucket.remaining_fraction < 0 ||
        bucket.remaining_fraction > 1
      )
        return null;
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
      return {
        usedPercent: (1 - bucket.remaining_fraction) * 100,
        remainingPercent: bucket.remaining_fraction * 100,
        durationMinutes: kind === 'weekly' ? 10080 : 300,
        resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      };
    };
    const primary = window('5h'),
      secondary = window('weekly');
    return primary || secondary
      ? [{ id: `antigravity-${index}`, name: group.name, plan: null, primary, secondary }]
      : [];
  });
  if (!buckets.length) throw new Error('No quota windows');
  return { checkedAt, stale: false, buckets, resetCredits: null };
}
export function queryAntigravityUsage(): Promise<SubscriptionUsage> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveAntigravityPath(),
      ['--print', '/usage', '--output-format', 'json'],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error('Antigravity quota query failed'));
          return;
        }
        try {
          resolve(parseAntigravityUsage(JSON.parse(stdout)));
        } catch {
          reject(new Error('Antigravity returned no native quota data'));
        }
      },
    );
  });
}
export function createAntigravityUsageReader(query = queryAntigravityUsage) {
  let snapshot: SubscriptionUsage | undefined;
  let lastAttempt = 0;
  let inFlight: Promise<SubscriptionUsage> | undefined;
  return async (refresh = false): Promise<SubscriptionUsage> => {
    if (inFlight) return inFlight;
    if (snapshot && Date.now() - lastAttempt < (refresh ? 10000 : 3600000)) return snapshot;
    lastAttempt = Date.now();
    inFlight = (async () => {
      try {
        snapshot = await query();
      } catch {
        snapshot = {
          ...(snapshot || { checkedAt: null, buckets: [], resetCredits: null }),
          stale: true,
          warning: snapshot?.checkedAt
            ? 'Antigravity 额度刷新失败，保留上次结果。'
            : '暂未获取到 Antigravity 额度，请确认本机 CLI 已登录。',
        };
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
export const getAntigravityUsage = createAntigravityUsageReader();
