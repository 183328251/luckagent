import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistentCodexExecutor } from '../src/engines/codex/persistent-executor.js';
import { sharedClaudeInstructions } from '../src/engines/codex/instructions.js';
const log = { info() {}, warn() {}, error() {}, debug() {} } as any;
const sid = '11111111-2222-3333-4444-555555555555';
class Client extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  goal: any = null;
  respond = vi.fn();
  async close() {}
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method))
      return {
        thread: { id: method === 'thread/fork' ? 'fork-thread' : (params.threadId ?? sid) },
        model: 'actual-model',
      };
    if (method === 'turn/start') {
      this.notify('turn/started', { threadId: params.threadId, turn: { id: 'turn-1' } });
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'turn/interrupt') {
      this.notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } });
      return {};
    }
    if (method === 'thread/goal/set') {
      this.goal = { objective: params.objective ?? this.goal?.objective, status: params.status, tokensUsed: 0 };
      return { goal: this.goal };
    }
    if (method === 'thread/goal/get') return { goal: this.goal };
    if (method === 'thread/goal/clear') {
      this.goal = null;
      return {};
    }
    return {};
  }
  notify(method: string, params: any) {
    this.emit('notification', { method, params });
  }
}
let root: string;
let client: Client;
let runtime: PersistentCodexExecutor;
const options = (prompt = 'hello', id?: string) => ({
  prompt,
  cwd: root,
  sessionId: id,
  outputsDir: path.join(root, 'outputs'),
  abortController: new AbortController(),
  apiContext: { botName: 'test', chatId: 'chat' },
});
const tick = () => new Promise((r) => setTimeout(r, 0));
async function collect(handle: any) {
  const items = [];
  for await (const item of handle.stream) items.push(item);
  return items;
}
function done(id = sid, text = 'DONE') {
  client.notify('item/completed', { threadId: id, item: { id: 'answer', type: 'agentMessage', text } });
  client.notify('thread/tokenUsage/updated', {
    threadId: id,
    tokenUsage: { last: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }, modelContextWindow: 475000 },
  });
  client.notify('turn/completed', { threadId: id, turn: { id: 'turn-1', status: 'completed', durationMs: 100 } });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persistent-'));
  vi.stubEnv('SESSION_STORE_DIR', root);
  client = new Client();
  runtime = new PersistentCodexExecutor({ name: 'test', codex: {}, claude: {} } as any, log, client as any);
});
afterEach(async () => {
  await runtime.shutdown();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
describe('persistent Codex runtime', () => {
  it('emits actual model, last-call usage and zero cost without killing the persistent thread after a reply', async () => {
    const handle = runtime.startExecution(options());
    const output = collect(handle);
    await tick();
    done();
    const messages = await output;
    expect(messages.at(-1)).toMatchObject({
      result: 'DONE',
      total_cost_usd: 0,
      modelUsage: { 'actual-model': { inputTokens: 100, outputTokens: 5, contextWindow: 475000 } },
    });
    handle.finish();
    expect(client.calls.some((c) => c.method === 'turn/interrupt')).toBe(false);
  });
  it('reuses the loaded thread and steers an automatic goal turn', async () => {
    const first = runtime.startExecution(options());
    const collected = collect(first);
    await tick();
    done();
    await collected;
    client.notify('turn/started', { threadId: sid, turn: { id: 'auto-turn' } });
    const next = runtime.startExecution(options('new user input', sid));
    const result = collect(next);
    await tick();
    expect(client.calls.at(-1)).toMatchObject({ method: 'turn/steer', params: { expectedTurnId: 'auto-turn' } });
    client.notify('item/completed', { threadId: sid, item: { id: 'answer2', type: 'agentMessage', text: 'steered' } });
    client.notify('turn/completed', { threadId: sid, turn: { id: 'auto-turn', status: 'completed' } });
    expect((await result).at(-1).result).toBe('steered');
    expect(client.calls.filter((c) => c.method === 'thread/resume')).toHaveLength(0);
  });
  it('routes continuation results after the user turn to autonomous delivery', async () => {
    const handle = runtime.startExecution(options());
    const collected = collect(handle);
    await tick();
    done();
    await collected;
    const callback = vi.fn();
    runtime.on('autonomous-result', callback);
    client.notify('turn/started', { threadId: sid, turn: { id: 'turn-1' } });
    done();
    expect(callback).toHaveBeenCalledOnce();
  });
  it('does not let an old completion close a newer turn', async () => {
    const handle = runtime.startExecution(options());
    const collected = collect(handle);
    await tick();
    client.notify('turn/completed', { threadId: sid, turn: { id: 'older-turn', status: 'completed' } });
    done();
    expect((await collected).at(-1).result).toBe('DONE');
  });
  it('uses explicit user provenance for goal set/pause/resume/clear and persists status', async () => {
    await runtime.goal(options(), 'set', 'finish report', 5000);
    expect(client.calls.at(-1)).toMatchObject({
      method: 'thread/goal/set',
      params: { origin: 'user', tokenBudget: 5000, objective: 'finish report' },
    });
    await runtime.goal(options('', sid), 'pause');
    await runtime.goal(options('', sid), 'resume');
    await runtime.goal(options('', sid), 'clear');
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'codex-work-test.json'), 'utf8'));
    expect(saved.goals).toEqual([]);
  });
  it('forks background work and allows a main thread turn while it runs', async () => {
    const callback = vi.fn();
    runtime.on('background-result', callback);
    const job = runtime.startBackground(options('', sid), 'background work');
    await tick();
    await tick();
    expect(client.calls.some((c) => c.method === 'thread/fork')).toBe(true);
    const handle = runtime.startExecution(options('main', sid));
    const collected = collect(handle);
    await tick();
    done();
    await collected;
    expect(runtime.listBackground('chat')[0].status).toBe('running');
    done('fork-thread', 'background done');
    await tick();
    expect(callback).toHaveBeenCalledOnce();
    expect(runtime.listBackground('chat')[0]).toMatchObject({
      id: job.id,
      status: 'completed',
      result: 'background done',
    });
  });
  it('scopes cancellation to the original chat and keeps stopped jobs stopped', async () => {
    const job = runtime.startBackground(options(), 'work');
    await tick();
    await expect(runtime.stopBackground(job.id, 'other-chat')).rejects.toThrow('不存在');
    await runtime.stopBackground(job.id, 'chat');
    await tick();
    expect(runtime.listBackground('chat')[0].status).toBe('stopped');
  });
  it('fails an active stream on disconnection and releases listeners on shutdown', async () => {
    const opts = options();
    const handle = runtime.startExecution(opts);
    const collected = collect(handle);
    await tick();
    client.emit('disconnected', new Error('app-server exited'));
    expect((await collected).at(-1).is_error).toBe(true);
    expect((runtime as any).scopes.size).toBe(0);
  });
  it('maps native subagent activity without duplicate task identities', async () => {
    const events: any[] = [];
    const handle = runtime.startExecution({ ...options(), onTeamEvent: (e) => events.push(e) });
    const output = collect(handle);
    await tick();
    client.notify('item/started', {
      threadId: sid,
      item: { type: 'subAgentActivity', kind: 'started', agentPath: '/root/reviewer' },
    });
    client.notify('item/completed', {
      threadId: sid,
      item: { type: 'subAgentActivity', kind: 'started', agentPath: '/root/reviewer', agentThreadId: 'child-thread' },
    });
    client.notify('item/completed', {
      threadId: sid,
      item: { type: 'subAgentActivity', kind: 'completed', agentPath: '/root/reviewer', agentThreadId: 'child-thread' },
    });
    expect((runtime as any).scopes.get(sid).teamState.tasks).toHaveLength(1);
    expect(events.some((e) => e.kind === 'task_completed')).toBe(true);
    done();
    await output;
  });

  it('cancels even when the turn-start acknowledgement arrives after the abort', async () => {
    const original = client.call.bind(client);
    let acknowledge: ((value: any) => void) | undefined;
    vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
      if (method === 'turn/start')
        return new Promise((resolve) => {
          acknowledge = resolve;
        });
      return original(method, params);
    });
    const opts = options();
    const handle = runtime.startExecution(opts);
    const output = collect(handle);
    await tick();
    opts.abortController.abort();
    expect((await output).at(-1).subtype).toBe('error_cancelled');
    client.notify('turn/started', { threadId: sid, turn: { id: 'late-turn' } });
    acknowledge!({ turn: { id: 'late-turn' } });
    await tick();
    expect(client.calls.some((c) => c.method === 'turn/interrupt' && c.params.turnId === 'late-turn')).toBe(true);
  });

  it('restores the bot default model after a session model override is cleared', async () => {
    const original = client.call.bind(client);
    vi.spyOn(client, 'call').mockImplementation(async (method, params) =>
      method === 'config/read' ? { config: { model: 'actual-model' } } : original(method, params),
    );
    const first = runtime.startExecution({ ...options(), model: 'temporary-model' });
    const firstOutput = collect(first);
    await tick();
    done();
    await firstOutput;
    const second = runtime.startExecution(options('reset model', sid));
    const secondOutput = collect(second);
    await tick();
    done();
    await secondOutput;
    expect(client.calls.filter((c) => c.method === 'turn/start').map((c) => c.params.model)).toEqual([
      'temporary-model',
      'actual-model',
    ]);
  });

  it('collects unattended goal answers one question at a time', async () => {
    const handle = runtime.startExecution(options());
    const output = collect(handle);
    await tick();
    done();
    await output;
    const notices = vi.fn();
    runtime.on('question', notices);
    client.emit('request', {
      id: 9,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: sid,
        questions: [
          { id: 'q1', question: 'Choose', options: [{ label: 'One' }, { label: 'Two' }] },
          { id: 'q2', question: 'Name', options: [] },
        ],
      },
    });
    expect(runtime.answerPending('other-chat', '1')).toBe(false);
    expect(runtime.answerPending('chat', '2')).toBe(true);
    expect(client.respond).not.toHaveBeenCalled();
    expect(runtime.answerPending('chat', 'Alice')).toBe(true);
    expect(client.respond).toHaveBeenCalledWith(9, {
      answers: { q1: { answers: ['Two'] }, q2: { answers: ['Alice'] } },
    });
  });

  it('does not silently grant approvals', () => {
    client.emit('request', { id: 42, method: 'item/permissions/requestApproval', params: { threadId: sid } });
    expect(client.respond).toHaveBeenCalledWith(42, { permissions: {}, scope: 'turn' });
  });
  it('loads parent common instructions without rewriting the bot instructions', () => {
    const child = path.join(root, 'bot');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'SHARED_RULE');
    fs.writeFileSync(path.join(child, 'CLAUDE.md'), 'BOT_RULE');
    expect(sharedClaudeInstructions(child)).toContain('SHARED_RULE');
    expect(fs.readFileSync(path.join(child, 'CLAUDE.md'), 'utf8')).toBe('BOT_RULE');
  });
});
