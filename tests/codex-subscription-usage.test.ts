import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionUsageReader, parseSubscriptionUsage } from '../src/engines/codex/subscription-usage.js';
const raw = {
  accountId: 'private-account',
  rateLimits: {
    limitId: 'codex',
    planType: 'plus',
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1791960145 },
    secondary: null,
  },
  rateLimitResetCredits: { availableCount: 3, credits: [{ id: 'private-credit' }] },
};
describe('subscription quota display', () => {
  it('returns only safe display fields and preserves missing windows', () => {
    const result = parseSubscriptionUsage(raw, '2026-10-14T00:00:00Z');
    expect(result.buckets[0].primary?.remainingPercent).toBe(90);
    expect(result.buckets[0].secondary).toBeNull();
    expect(result.resetCredits).toBe(3);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('supports multiple buckets and unknown reset count', () => {
    const result = parseSubscriptionUsage(
      { rateLimitsByLimitId: { x: raw.rateLimits, y: { ...raw.rateLimits, limitId: 'other' } } },
      'now',
    );
    expect(result.buckets).toHaveLength(2);
    expect(result.resetCredits).toBeNull();
  });
  it('deduplicates queries and caches snapshots, without consuming reset credits', async () => {
    const call = vi.fn().mockResolvedValue(raw);
    const close = vi.fn().mockResolvedValue(undefined);
    const reader = createSubscriptionUsageReader(() => ({ call, close }));
    await Promise.all([reader({} as any), reader({} as any)]);
    await reader({} as any, true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('account/rateLimits/read');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('retains last successful result when refresh fails and masks errors', async () => {
    vi.useFakeTimers();
    try {
      const call = vi.fn().mockResolvedValueOnce(raw).mockRejectedValueOnce(new Error('secret-token'));
      const reader = createSubscriptionUsageReader(() => ({ call, close: async () => {} }));
      const good = await reader({} as any);
      vi.advanceTimersByTime(1800000);
      await reader({} as any);
      expect(call).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1800001);
      const stale = await reader({} as any);
      expect(stale.stale).toBe(true);
      expect(stale.checkedAt).toBe(good.checkedAt);
      expect(stale.buckets).toEqual(good.buckets);
      expect(JSON.stringify(stale)).not.toContain('secret-token');
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not invent zero usage when windows are missing', () => {
    expect(() => parseSubscriptionUsage({ rateLimits: {} }, 'now')).toThrow();
  });
});
