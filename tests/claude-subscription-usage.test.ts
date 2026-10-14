import { describe, it, expect, vi } from 'vitest';
import { parseClaudeUsage, createClaudeUsageReader } from '../src/engines/claude/subscription-usage.js';
const text =
  'Opus 5.5 · Claude Pro\nCurrent session\n17% 17% used\nResets 1:30pm (Asia/Shanghai)\nCurrent week (all models)\n41% 41% used\nResets Oct 18 at 7am (Asia/Shanghai)\nSkills % of usage\n/private-skill 70%';
const now = new Date('2026-10-14T03:00:00Z');
describe('Claude subscription quota', () => {
  it('extracts quota windows and safe plan metadata, ignoring skill usage', () => {
    const r = parseClaudeUsage(text, now);
    expect(r.buckets[0].primary).toMatchObject({
      usedPercent: 17,
      remainingPercent: 83,
      resetsAt: '2026-10-14T05:30:00.000Z',
    });
    expect(r.buckets[0].secondary?.resetsAt).toBe('2026-10-17T23:00:00.000Z');
    expect(JSON.stringify(r)).not.toContain('private-skill');
  });
  it('handles missing windows and does not guess unknown timezones', () => {
    const r = parseClaudeUsage(text.split('Current week')[0].replace('Asia/Shanghai', 'America/New_York'), now);
    expect(r.buckets[0].secondary).toBeNull();
    expect(r.buckets[0].primary?.resetsAt).toBeNull();
    expect(() => parseClaudeUsage('Scanning local sessions…', now)).toThrow();
  });
  it('handles next-day and year boundary reset dates', () => {
    expect(parseClaudeUsage(text, new Date('2026-10-14T06:00:00Z')).buckets[0].primary?.resetsAt).toBe(
      '2026-10-15T05:30:00.000Z',
    );
    expect(
      parseClaudeUsage(text.replace('Oct 18', 'Jan 2'), new Date('2026-12-31T00:00:00Z')).buckets[0].secondary
        ?.resetsAt,
    ).toBe('2027-01-01T23:00:00.000Z');
  });
  it('deduplicates and caches, preserving previous results on failure', async () => {
    vi.useFakeTimers();
    try {
      const query = vi
        .fn()
        .mockResolvedValueOnce(parseClaudeUsage(text, now))
        .mockRejectedValueOnce(new Error('private-token'));
      const read = createClaudeUsageReader(query);
      await Promise.all([read(), read()]);
      await read(true);
      expect(query).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1800000);
      await read();
      expect(query).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1800001);
      const r = await read();
      expect(r.stale).toBe(true);
      expect(r.buckets[0].primary?.usedPercent).toBe(17);
      expect(JSON.stringify(r)).not.toContain('private-token');
    } finally {
      vi.useRealTimers();
    }
  });
});
