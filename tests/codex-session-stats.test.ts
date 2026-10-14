import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCodexSessionStats, withCodexSessionStats } from '../src/engines/codex/session-stats.js';
import { StreamProcessor } from '../src/engines/claude/stream-processor.js';
import { buildCard } from '../src/feishu/card-builder.js';
import { buildCardV2 } from '../src/feishu/card-builder-v2.js';

const sid = '11111111-2222-3333-4444-555555555555';
let root: string;
let file: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stats-'));
  const dir = path.join(root, 'sessions/2026/10/14');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, `rollout-2026-10-14T00-00-00-${sid}.jsonl`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function write(records: unknown[]) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const start = { type: 'event_msg', payload: { type: 'task_started', model_context_window: 475000 } };
const context = { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } };
const tokens = (total: number) => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      model_context_window: 475000,
      total_token_usage: { total_tokens: 9999999 },
      last_token_usage: {
        input_tokens: total - 60,
        cached_input_tokens: total - 120,
        output_tokens: 60,
        total_tokens: total,
      },
    },
  },
});

describe('Codex runtime stats and card footer', () => {
  it('reads the actual default model and last-call usage, without double-counting cached tokens', async () => {
    write([start, context, tokens(30620)]);
    const stats = await readCodexSessionStats(sid, root);
    expect(stats.model).toBe('gpt-6.1-sol');
    expect(stats.contextWindow).toBe(475000);
    const result = withCodexSessionStats({ type: 'result', subtype: 'success', result: 'done' }, stats);
    expect(result.total_cost_usd).toBe(0);
    expect(result.modelUsage?.['gpt-6.1-sol']).toMatchObject({ inputTokens: 30560, outputTokens: 60 });
    const state = new StreamProcessor('test').processMessage(result);
    expect(state.totalTokens).toBe(30620);
    const completed = { ...state, sessionCostUsd: state.costUsd };
    for (const build of [buildCard, buildCardV2]) {
      const card = build(completed);
      expect(card).toContain('ctx: 30.6k/475k (6%)');
      expect(card).toContain('$0.00');
      expect(card).toContain('gpt-6.1-sol');
    }
  });
  it('uses the latest resumed turn, including lower usage after compaction', async () => {
    write([start, context, tokens(200000), start, context, tokens(30620)]);
    const stats = await readCodexSessionStats(sid, root);
    expect(stats.usage?.total_tokens).toBe(30620);
  });
  it('never displays the previous turn occupancy after a new turn fails before inference', async () => {
    write([start, context, tokens(200000), start, context]);
    const stats = await readCodexSessionStats(sid, root);
    expect(stats.usage).toBeUndefined();
    const result = withCodexSessionStats({ type: 'result', subtype: 'error_during_execution' }, stats);
    expect(result.modelUsage?.['gpt-6.1-sol'].contextWindow).toBe(0);
  });
  it('prefers the actual runtime model over the requested model', async () => {
    write([start, context, tokens(30620)]);
    const result = withCodexSessionStats(
      {
        type: 'result',
        modelUsage: { requested: { inputTokens: 1, outputTokens: 1, contextWindow: 100, costUSD: 2 } },
      },
      await readCodexSessionStats(sid, root),
    );
    expect(Object.keys(result.modelUsage!)).toEqual(['gpt-6.1-sol']);
  });
  it('keeps successful replies and zero cost when metadata is unavailable', async () => {
    expect(await readCodexSessionStats(sid, root)).toEqual({});
    const result = withCodexSessionStats({ type: 'result', subtype: 'success', result: 'done' }, {});
    expect(result.result).toBe('done');
    expect(result.total_cost_usd).toBe(0);
    expect(result.modelUsage).toBeUndefined();
  });
  it('ignores malformed records and reads valid metadata', async () => {
    write([start, context, tokens(30620)]);
    fs.appendFileSync(file, '{"type":"event_msg","payload":{"type":"token_count"');
    expect((await readCodexSessionStats(sid, root)).usage?.total_tokens).toBe(30620);
  });
  it('rejects arbitrary session paths', async () => {
    expect(await readCodexSessionStats('../../secret', root)).toEqual({});
  });
});
