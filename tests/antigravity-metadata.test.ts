import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAntigravityCatalogReader, parseAntigravityCatalog } from '../src/engines/antigravity/model-catalog.js';
import { createAntigravityUsageReader, parseAntigravityUsage } from '../src/engines/antigravity/subscription-usage.js';
const native = {
  sessionId: 's',
  models: { availableModels: [{ modelId: 'legacy', name: 'Legacy' }] },
  configOptions: [
    {
      category: 'model',
      currentValue: 'gemini',
      options: [
        { value: 'gemini', name: 'Gemini' },
        { value: 'gemini', name: 'Duplicate' },
      ],
    },
    { category: 'thought_level', options: [{ value: 'high' }] },
  ],
  modes: { availableModes: [{ id: 'default', name: 'Default' }] },
  _meta: { antigravity: { tier: { name: 'Google AI Pro', id: 'private-tier' } } },
  email: 'private@example.test',
  token: 'private',
};
const quota = () => ({
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini',
          buckets: [
            { window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-11-24T14:00:00Z' },
            { window: '5h', remaining_fraction: 0.8, reset_time: '2026-11-17T19:00:00Z' },
          ],
        },
      ],
    },
  },
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('Antigravity admin metadata', () => {
  it('returns native picker metadata without account identity and secret data', () => {
    expect(parseAntigravityCatalog(native)).toEqual({
      models: [{ id: 'gemini', displayName: 'Gemini', reasoningEfforts: ['high'] }],
      modes: [{ id: 'default', name: 'Default' }],
      plan: 'Google AI Pro',
    });
  });
  it('deduplicates probes, closes temporary sessions and preserves stale models without claiming authenticated', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-catalog-'));
    vi.stubEnv('SESSION_STORE_DIR', root);
    const client = Object.assign(new EventEmitter(), {
      capabilities: { sessionCapabilities: { close: {} } },
      version: '1.5.10',
      start: vi.fn(async () => {}),
      call: vi.fn(async (method: string) => (method === 'session/new' ? native : {})),
      close: vi.fn(async () => {}),
    });
    const factory = vi.fn(() => client as any);
    const read = createAntigravityCatalogReader(factory);
    try {
      const [a, b] = await Promise.all([read({} as any), read({} as any)]);
      expect(a).toBe(b);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(a.authenticated).toBe(true);
      expect(client.call).toHaveBeenCalledWith('session/close', { sessionId: 's' });
      vi.useFakeTimers();
      vi.advanceTimersByTime(6000);
      client.call.mockRejectedValueOnce(new Error('Authentication required'));
      const stale = await read({} as any, true);
      expect(stale).toMatchObject({ source: 'cache', authenticated: false, models: a.models });
      expect(client.close).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('parses native quota groups, time windows and rejects model-generated usage', () => {
    const parsed = parseAntigravityUsage(quota());
    expect(parsed.buckets[0].primary).toMatchObject({ durationMinutes: 300, remainingPercent: 80 });
    expect(parsed.buckets[0].secondary).toMatchObject({ durationMinutes: 10080, remainingPercent: 75 });
    expect(() => parseAntigravityUsage({ status: 'SUCCESS', response: '99% remaining' })).toThrow();
    const invalid = quota();
    invalid.command.data.groups[0].buckets[0].remaining_fraction = 2;
    invalid.command.data.groups[0].buckets[1].remaining_fraction = NaN;
    expect(() => parseAntigravityUsage(invalid)).toThrow();
  });
  it('retains a stale quota snapshot on refresh failure', async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce(parseAntigravityUsage(quota()))
      .mockRejectedValueOnce(new Error('network'));
    const read = createAntigravityUsageReader(query);
    const first = await read();
    vi.advanceTimersByTime(10001);
    const stale = await read(true);
    expect(stale.stale).toBe(true);
    expect(stale.buckets).toEqual(first.buckets);
  });
});
